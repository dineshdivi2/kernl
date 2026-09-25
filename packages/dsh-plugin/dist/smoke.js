import { isJsonObject } from './contracts.js';
/** Stable diagnostic name for the one-off real-DSH smoke probe. */
export const name = 'kernl-smoke-probe';
/** The probe is deliberately not part of the default bundle patch. */
export const inject = ['tools', 'kernl', 'kernlTools', 'appExit'];
/** Execute one registered tool, request graceful app exit, and prove unload. */
export function apply(ctx, config = {}) {
    const tools = ctx.get('tools');
    const appExit = ctx.get('appExit');
    if (tools === undefined || typeof tools.execute !== 'function') {
        throw new TypeError('kernl-smoke-probe requires ctx.tools.execute()');
    }
    if (typeof appExit !== 'function')
        throw new TypeError('kernl-smoke-probe requires ctx.appExit');
    if (config.request !== undefined && !isJsonObject(config.request)) {
        throw new TypeError('kernl-smoke-probe config.request must be a JSON object');
    }
    if (typeof ctx.effect !== 'function')
        throw new TypeError('kernl-smoke-probe requires ctx.effect()');
    ctx.effect(() => () => {
        console.log('KERNL_DSH_SMOKE_UNLOADED');
    });
    const request = config.request ?? { smoke: true };
    void tools.execute({
        callId: 'kernl-smoke-call',
        name: 'kernl_validate_change',
        arguments: { request },
        signal: new AbortController().signal,
    }).then((result) => {
        if (result.isError) {
            throw new Error(`kernl_validate_change returned a DSH tool failure: ${JSON.stringify(result.content ?? null)}`);
        }
        console.log(`KERNL_DSH_SMOKE_OK ${JSON.stringify(result.value ?? null)}`);
        appExit(0);
    }).catch((error) => {
        const message = error instanceof Error ? error.message : 'unknown smoke failure';
        console.error(`KERNL_DSH_SMOKE_FAILED ${message}`);
        appExit(1);
    });
}
