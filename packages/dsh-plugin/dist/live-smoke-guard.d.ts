/**
 * Opt-in guard for the live DeepSeek smoke. It is exported for a one-off
 * profile overlay and is deliberately absent from the shipped bundle patch.
 */
/** Stable Cordis diagnostic name for the opt-in live smoke guard. */
export declare const name = "kernl-live-smoke-guard";
/** Wait for the real registry and completed Kernl tool registration. */
export declare const inject: readonly ["tools", "kernlTools"];
interface EventContextLike {
    get(name: string): unknown;
    on<TArgs extends unknown[]>(event: string, listener: (...args: TArgs) => unknown): () => void;
}
/**
 * Enforce one model request and one successful Kernl dispatch. Any other tool
 * is hidden from the Agent and denied again at execution as defense in depth.
 */
export declare function apply(ctx: EventContextLike): void;
export {};
