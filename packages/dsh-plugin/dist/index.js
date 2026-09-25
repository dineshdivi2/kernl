import { createKernlClient } from './client.js';
export * from './client.js';
/** Stable Cordis diagnostic name for the Kernl service provider. */
export const name = 'kernl-service';
/**
 * Publish the stateless Kernl HTTP client as `ctx.kernl`.
 *
 * `ctx.provide` is itself a Cordis effect, so provider removal, HMR, or config
 * replacement removes the service and unloads consumers that inject it.
 */
export function apply(ctx, config) {
    if (ctx === null || typeof ctx !== 'object' || typeof ctx.provide !== 'function') {
        throw new TypeError('kernl-service requires a Cordis context with provide()');
    }
    ctx.provide('kernl', createKernlClient(config));
}
