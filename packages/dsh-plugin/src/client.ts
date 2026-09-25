import { isJsonObject, type JsonObject, type JsonValue } from './contracts.js'

const DEFAULT_BASE_URL = 'http://127.0.0.1:43120'
const DEFAULT_ROUTE_PREFIX = '/api/dsh'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576
const MAX_TIMEOUT_MS = 300_000
const MAX_RESPONSE_BYTES = 5_242_880

/** User-configurable, non-secret Kernl API connection values. */
export interface KernlClientConfig {
  readonly baseUrl?: string
  readonly routePrefix?: string
  readonly requestTimeoutMs?: number
  readonly maxResponseBytes?: number
}

/** Validated values used by the HTTP client. */
export interface ResolvedKernlClientConfig {
  readonly baseUrl: string
  readonly routePrefix: string
  readonly requestTimeoutMs: number
  readonly maxResponseBytes: number
}

/** The five operations the DSH adapter may ask Kernl to perform. */
export interface KernlClient {
  readonly config: ResolvedKernlClientConfig
  validateChange(request: JsonObject, signal?: AbortSignal): Promise<JsonValue>
  compilePlan(request: JsonObject, signal?: AbortSignal): Promise<JsonValue>
  claimTask(request: JsonObject, signal?: AbortSignal): Promise<JsonValue>
  recordResult(request: JsonObject, signal?: AbortSignal): Promise<JsonValue>
  verify(request: JsonObject, signal?: AbortSignal): Promise<JsonValue>
}

/** Structured failure returned by the local Kernl API adapter. */
export class KernlApiError extends Error {
  readonly code: string
  readonly status: number | undefined
  readonly details: JsonValue | undefined

  constructor(
    code: string,
    message: string,
    options: { status?: number; details?: JsonValue; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'KernlApiError'
    this.code = code
    this.status = options.status
    this.details = options.details
  }
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

const ROUTES = {
  validateChange: 'validate-change',
  compilePlan: 'compile-plan',
  claimTask: 'claim-task',
  recordResult: 'record-result',
  verify: 'verify',
} as const

/** Validate config at plugin load so a bad deployment never partially mounts. */
export function resolveKernlClientConfig(input: unknown): ResolvedKernlClientConfig {
  const config = input === undefined ? {} : input
  if (!isJsonObject(config)) throw new TypeError('kernl-service config must be an object')

  const allowed = new Set(['baseUrl', 'routePrefix', 'requestTimeoutMs', 'maxResponseBytes'])
  const unknown = Object.keys(config).filter(key => !allowed.has(key))
  if (unknown.length > 0) {
    throw new TypeError(`kernl-service config contains unknown field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`)
  }

  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL
  if (typeof baseUrl !== 'string') throw new TypeError('kernl-service config.baseUrl must be a string')
  let parsedBase: URL
  try {
    parsedBase = new URL(baseUrl)
  } catch {
    throw new TypeError('kernl-service config.baseUrl must be an absolute HTTP(S) URL')
  }
  if (parsedBase.protocol !== 'http:' && parsedBase.protocol !== 'https:') {
    throw new TypeError('kernl-service config.baseUrl must use http: or https:')
  }
  if (parsedBase.username !== '' || parsedBase.password !== '') {
    throw new TypeError('kernl-service config.baseUrl must not contain credentials')
  }
  if (parsedBase.search !== '' || parsedBase.hash !== '') {
    throw new TypeError('kernl-service config.baseUrl must not contain a query or fragment')
  }

  const routePrefix = config.routePrefix ?? DEFAULT_ROUTE_PREFIX
  if (typeof routePrefix !== 'string' || !routePrefix.startsWith('/')) {
    throw new TypeError('kernl-service config.routePrefix must start with /')
  }
  if (routePrefix.includes('?') || routePrefix.includes('#') || routePrefix.includes('..')) {
    throw new TypeError('kernl-service config.routePrefix must not contain query, fragment, or parent traversal')
  }
  const normalizedPrefix = routePrefix === '/' ? '' : routePrefix.replace(/\/+$/, '')

  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS
  if (typeof requestTimeoutMs !== 'number'
    || !Number.isInteger(requestTimeoutMs)
    || requestTimeoutMs <= 0
    || requestTimeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError(`kernl-service config.requestTimeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`)
  }

  const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  if (typeof maxResponseBytes !== 'number'
    || !Number.isInteger(maxResponseBytes)
    || maxResponseBytes <= 0
    || maxResponseBytes > MAX_RESPONSE_BYTES) {
    throw new TypeError(`kernl-service config.maxResponseBytes must be an integer from 1 to ${MAX_RESPONSE_BYTES}`)
  }

  parsedBase.pathname = parsedBase.pathname.replace(/\/+$/, '') || '/'
  return Object.freeze({
    baseUrl: parsedBase.toString(),
    routePrefix: normalizedPrefix,
    requestTimeoutMs,
    maxResponseBytes,
  })
}

/** Create the stateless HTTP implementation behind `ctx.kernl`. */
export function createKernlClient(
  input: KernlClientConfig | undefined,
  fetchImplementation: FetchLike = globalThis.fetch,
): KernlClient {
  if (typeof fetchImplementation !== 'function') {
    throw new TypeError('kernl-service requires a Fetch-compatible implementation')
  }
  const config = resolveKernlClientConfig(input)

  const post = async (route: string, request: JsonObject, callerSignal?: AbortSignal): Promise<JsonValue> => {
    const endpoint = endpointFor(config, route)
    const timeoutSignal = AbortSignal.timeout(config.requestTimeoutMs)
    const signal = callerSignal === undefined
      ? timeoutSignal
      : AbortSignal.any([callerSignal, timeoutSignal])

    let response: Response
    try {
      response = await fetchImplementation(endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-kernl-dsh-contract': '1',
        },
        body: JSON.stringify(request),
        signal,
      })
    } catch (error) {
      if (callerSignal?.aborted === true) {
        throw new KernlApiError('REQUEST_ABORTED', 'Kernl API request was cancelled', { cause: error })
      }
      if (timeoutSignal.aborted) {
        throw new KernlApiError('REQUEST_TIMEOUT', `Kernl API request exceeded ${config.requestTimeoutMs}ms`, { cause: error })
      }
      throw new KernlApiError('TRANSPORT_ERROR', 'Kernl API request failed before a response was received', { cause: error })
    }

    const declaredLength = response.headers.get('content-length')
    if (declaredLength !== null) {
      const length = Number(declaredLength)
      if (Number.isFinite(length) && length > config.maxResponseBytes) {
        throw new KernlApiError('RESPONSE_TOO_LARGE', 'Kernl API response exceeded the configured size limit', {
          status: response.status,
        })
      }
    }

    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > config.maxResponseBytes) {
      throw new KernlApiError('RESPONSE_TOO_LARGE', 'Kernl API response exceeded the configured size limit', {
        status: response.status,
      })
    }

    let envelope: unknown
    try {
      envelope = JSON.parse(text)
    } catch {
      throw new KernlApiError('INVALID_RESPONSE', 'Kernl API returned non-JSON content', { status: response.status })
    }

    if (!isJsonObject(envelope) || typeof envelope.ok !== 'boolean') {
      throw new KernlApiError('INVALID_RESPONSE', 'Kernl API returned an invalid response envelope', { status: response.status })
    }

    if (envelope.ok === false) {
      const failure = envelope.error
      if (!isJsonObject(failure) || typeof failure.code !== 'string' || typeof failure.message !== 'string') {
        throw new KernlApiError('INVALID_RESPONSE', 'Kernl API returned an invalid error envelope', { status: response.status })
      }
      throw new KernlApiError(failure.code, failure.message, {
        status: response.status,
        ...(failure.details === undefined ? {} : { details: failure.details }),
      })
    }

    if (!Object.hasOwn(envelope, 'value')) {
      throw new KernlApiError('INVALID_RESPONSE', 'Kernl API success envelope omitted value', { status: response.status })
    }
    if (!response.ok) {
      throw new KernlApiError(`HTTP_${response.status}`, 'Kernl API returned an unsuccessful HTTP status', {
        status: response.status,
      })
    }
    return envelope.value as JsonValue
  }

  const client: KernlClient = {
    config,
    validateChange: (request, signal) => post(ROUTES.validateChange, request, signal),
    compilePlan: (request, signal) => post(ROUTES.compilePlan, request, signal),
    claimTask: (request, signal) => post(ROUTES.claimTask, request, signal),
    recordResult: (request, signal) => post(ROUTES.recordResult, request, signal),
    verify: (request, signal) => post(ROUTES.verify, request, signal),
  }
  return Object.freeze(client)
}

function endpointFor(config: ResolvedKernlClientConfig, route: string): URL {
  const endpoint = new URL(config.baseUrl)
  const basePath = endpoint.pathname === '/' ? '' : endpoint.pathname.replace(/\/+$/, '')
  endpoint.pathname = `${basePath}${config.routePrefix}/${route}`.replace(/\/{2,}/g, '/')
  endpoint.search = ''
  endpoint.hash = ''
  return endpoint
}
