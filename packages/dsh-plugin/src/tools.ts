import type { KernlClient } from './client.js'
import {
  isJsonObject,
  type CordisContextLike,
  type DshToolDefinition,
  type DshToolsLike,
  type JsonObject,
  type JsonValue,
  type ToolExecutionLike,
} from './contracts.js'

/** Stable Cordis diagnostic name for the model-facing tool consumer. */
export const name = 'kernl-tools'

/** Hard dependencies keep this consumer pending until both services exist. */
export const inject = ['tools', 'kernl'] as const

const TOOL_NAMES = [
  'kernl_validate_change',
  'kernl_compile_plan',
  'kernl_claim_task',
  'kernl_record_result',
  'kernl_verify',
] as const

/** The complete intentionally bounded Kernl tool surface. */
export type KernlToolName = typeof TOOL_NAMES[number]

/** Deployment-only behavior for the registered tools. */
export interface KernlToolsConfig {
  /**
   * End the current DSH turn after one successful Kernl call. This is false in
   * the bundle and exists only to make the opt-in live integration smoke a
   * one-request, one-tool run.
   */
  readonly concludeTurnAfterSuccess?: boolean
}

/** Invalid model-supplied arguments rejected before the Kernl API is called. */
export class KernlToolArgsError extends Error {
  readonly code = 'INVALID_ARGS'

  constructor(message: string) {
    super(message)
    this.name = 'KernlToolArgsError'
  }
}

/** Register the five least-authority Kernl operations on `ctx.tools`. */
export function apply(ctx: CordisContextLike, input?: KernlToolsConfig): void {
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.get !== 'function') {
    throw new TypeError('kernl-tools requires a Cordis context with get()')
  }
  const tools = requireTools(ctx.get('tools'))
  const kernl = requireKernl(ctx.get('kernl'))
  const config = resolveConfig(input)

  for (const definition of definitions(kernl, config)) tools.register(definition)
  ctx.provide('kernlTools', Object.freeze({ names: Object.freeze([...TOOL_NAMES]) }))
}

/** Build fresh definitions for one active Kernl provider instance. */
export function definitions(
  kernl: KernlClient,
  config: Readonly<Required<KernlToolsConfig>> = { concludeTurnAfterSuccess: false },
): DshToolDefinition[] {
  return [
    definition(
      'kernl_validate_change',
      'Validate an architecture change and its capability bindings before any implementation task starts.',
      (request, signal) => kernl.validateChange(request, signal),
      config.concludeTurnAfterSuccess,
    ),
    definition(
      'kernl_compile_plan',
      'Compile a validated architecture change into a bounded task DAG with explicit dependencies and write scopes.',
      (request, signal) => kernl.compilePlan(request, signal),
      config.concludeTurnAfterSuccess,
    ),
    definition(
      'kernl_claim_task',
      'Ask Kernl to claim one control-plane task. This adapter grants no worker identity, capability, or write authority.',
      (request, signal) => kernl.claimTask(request, signal),
      config.concludeTurnAfterSuccess,
    ),
    definition(
      'kernl_record_result',
      'Record one task result and its evidence. This does not approve or promote the run.',
      (request, signal) => kernl.recordResult(request, signal),
      config.concludeTurnAfterSuccess,
    ),
    definition(
      'kernl_verify',
      'Run or read deterministic verification for a Kernl run or task.',
      (request, signal) => kernl.verify(request, signal),
      config.concludeTurnAfterSuccess,
    ),
  ]
}

function definition(
  toolName: KernlToolName,
  description: string,
  invoke: (request: JsonObject, signal?: AbortSignal) => Promise<JsonValue>,
  concludeTurnAfterSuccess: boolean,
): DshToolDefinition {
  return {
    name: toolName,
    description,
    parameters: {
      type: 'object',
      properties: {
        request: {
          type: 'object',
          additionalProperties: true,
          description: 'Route-specific Kernl request object. It is forwarded unchanged and validated by Kernl.',
        },
      },
      required: ['request'],
      additionalProperties: false,
    },
    output: {
      // DSH's raw ToolDefinition contract uses an annotation-only schema for
      // unconstrained lossless JSON. `type: "json"` is authoring DSL syntax
      // and is rejected when a structural definition is registered directly.
      schema: {},
      render(_args: unknown, value: JsonValue) {
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    async execute(args: unknown, execution: ToolExecutionLike) {
      const value = await invoke(extractRequest(args), execution.signal)
      if (concludeTurnAfterSuccess) {
        if (typeof execution.concludeTurn !== 'function') {
          throw new TypeError('concludeTurnAfterSuccess requires the current DSH ToolRunContext')
        }
        execution.concludeTurn()
      }
      return value
    },
  }
}

function resolveConfig(input: KernlToolsConfig | undefined): Readonly<Required<KernlToolsConfig>> {
  const config = input ?? {}
  if (!isJsonObject(config)) throw new TypeError('kernl-tools config must be an object')
  const unknown = Object.keys(config).filter(key => key !== 'concludeTurnAfterSuccess')
  if (unknown.length > 0) throw new TypeError(`kernl-tools config contains unknown field: ${unknown.join(', ')}`)
  const concludeTurnAfterSuccess = config.concludeTurnAfterSuccess ?? false
  if (typeof concludeTurnAfterSuccess !== 'boolean') {
    throw new TypeError('kernl-tools config.concludeTurnAfterSuccess must be a boolean')
  }
  return Object.freeze({ concludeTurnAfterSuccess })
}

function extractRequest(args: unknown): JsonObject {
  if (!isJsonObject(args)) throw new KernlToolArgsError('arguments must be an object')
  const keys = Object.keys(args)
  if (keys.length !== 1 || keys[0] !== 'request') {
    throw new KernlToolArgsError('arguments must contain only the required request object')
  }
  if (!isJsonObject(args.request)) throw new KernlToolArgsError('request must be a JSON object')
  return args.request
}

function requireTools(value: unknown): DshToolsLike {
  if (!isObjectLike(value) || typeof value.register !== 'function') {
    throw new TypeError('kernl-tools requires ctx.tools.register()')
  }
  return value as unknown as DshToolsLike
}

function requireKernl(value: unknown): KernlClient {
  if (!isObjectLike(value)) throw new TypeError('kernl-tools requires the ctx.kernl service')
  for (const method of ['validateChange', 'compilePlan', 'claimTask', 'recordResult', 'verify'] as const) {
    if (typeof value[method] !== 'function') {
      throw new TypeError(`ctx.kernl is missing ${method}()`)
    }
  }
  return value as unknown as KernlClient
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}
