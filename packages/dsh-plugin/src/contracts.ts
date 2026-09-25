/** A lossless JSON value accepted at the Kernl/DSH process boundary. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

/** A JSON object used for every Kernl API request. */
export type JsonObject = { [key: string]: JsonValue }

/** Minimal Cordis context used by the self-contained out-of-tree bundle. */
export interface CordisContextLike {
  /** Read one service without importing its implementation package. */
  get(name: string): unknown
  /** Publish a service as an effect owned by the calling plugin fiber. */
  provide(name: string, value: unknown): () => void
  /** Register an unmanaged resource with its plugin-lifetime disposer. */
  effect?(effect: () => (() => void | Promise<void>)): unknown
}

/** Cancellation information DSH supplies to a tool implementation. */
export interface ToolExecutionLike {
  readonly signal: AbortSignal
  /** Current DSH exposes this terminal marker; optional keeps fake contexts small. */
  concludeTurn?(): void
}

/** One text content block rendered into the durable DSH tool result. */
export interface TextContentBlock {
  readonly type: 'text'
  readonly text: string
}

/** Structural tool definition accepted by the current DSH tool registry. */
export interface DshToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: unknown, value: JsonValue): TextContentBlock[]
  }
  execute(args: unknown, execution: ToolExecutionLike): Promise<JsonValue>
}

/** Structural subset of `ctx.tools` used by this bundle. */
export interface DshToolsLike {
  register(definition: DshToolDefinition): () => void
  execute?(request: {
    readonly callId: string
    readonly name: string
    readonly arguments: unknown
    readonly signal: AbortSignal
  }): Promise<{ readonly isError: boolean; readonly value?: JsonValue; readonly content?: unknown }>
}

/** True only for ordinary object literals with a JSON object root. */
export function isJsonObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Require a JSON object and return it without widening its identity. */
export function requireJsonObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) throw new TypeError(`${label} must be a JSON object`)
  return value
}
