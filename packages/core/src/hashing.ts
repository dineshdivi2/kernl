import { createHash } from 'node:crypto'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

function normalizeJson(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Cannot canonicalize non-finite number at ${path}`)
    }
    return Object.is(value, -0) ? 0 : value
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeJson(item, `${path}[${index}]`))
  }

  if (typeof value === 'object') {
    const result: Record<string, JsonValue> = {}
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key]
      if (child === undefined) continue
      result[key] = normalizeJson(child, `${path}.${key}`)
    }
    return result
  }

  throw new TypeError(`Cannot canonicalize ${typeof value} at ${path}`)
}

/** Recursively sorts object keys while retaining array order. */
export function canonicalize(value: unknown): JsonValue {
  return normalizeJson(value, '$')
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function digestJson(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}

export function timingSafeDigestEqual(left: unknown, right: unknown): boolean {
  return digestJson(left) === digestJson(right)
}
