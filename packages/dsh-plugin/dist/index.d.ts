import { type KernlClientConfig } from './client.js';
import type { CordisContextLike } from './contracts.js';
export * from './client.js';
export type { CordisContextLike, JsonObject, JsonValue } from './contracts.js';
/** Stable Cordis diagnostic name for the Kernl service provider. */
export declare const name = "kernl-service";
/**
 * Publish the stateless Kernl HTTP client as `ctx.kernl`.
 *
 * `ctx.provide` is itself a Cordis effect, so provider removal, HMR, or config
 * replacement removes the service and unloads consumers that inject it.
 */
export declare function apply(ctx: CordisContextLike, config?: KernlClientConfig): void;
