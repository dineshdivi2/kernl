/**
 * Opt-in guard for the live DeepSeek smoke. It is exported for a one-off
 * profile overlay and is deliberately absent from the shipped bundle patch.
 */
/** Stable Cordis diagnostic name for the opt-in live smoke guard. */
export const name = 'kernl-live-smoke-guard';
/** Wait for the real registry and completed Kernl tool registration. */
export const inject = ['tools', 'kernlTools'];
const ALLOWED_TOOL = 'kernl_validate_change';
/**
 * Enforce one model request and one successful Kernl dispatch. Any other tool
 * is hidden from the Agent and denied again at execution as defense in depth.
 */
export function apply(ctx) {
    if (ctx === null || typeof ctx !== 'object' || typeof ctx.get !== 'function' || typeof ctx.on !== 'function') {
        throw new TypeError('kernl-live-smoke-guard requires a Cordis context with get() and on()');
    }
    const tools = ctx.get('tools');
    if (tools === undefined || typeof tools.guard !== 'function') {
        throw new TypeError('kernl-live-smoke-guard requires ctx.tools.guard()');
    }
    let modelRequests = 0;
    let toolAttempts = 0;
    let successfulResults = 0;
    tools.guard((execution) => {
        if (execution.name !== ALLOWED_TOOL)
            return `live smoke permits only ${ALLOWED_TOOL}`;
        toolAttempts += 1;
        return toolAttempts > 1 ? 'live smoke permits only one Kernl tool invocation' : undefined;
    });
    ctx.on('agent/session-start', ({ agent }) => {
        if (agent?.ctx?.tools === undefined || typeof agent.ctx.tools.restrict !== 'function') {
            throw new TypeError('kernl-live-smoke-guard requires agent.ctx.tools.restrict()');
        }
        agent.ctx.tools.restrict({ allow: [ALLOWED_TOOL] });
    });
    ctx.on('agent/request', async (_payload, next) => {
        modelRequests += 1;
        if (modelRequests > 1)
            throw new Error('live smoke permits only one model request');
        return next();
    });
    ctx.on('tools/result', (execution, result) => {
        if (execution.name === ALLOWED_TOOL && result.isError === false)
            successfulResults += 1;
    });
    ctx.on('agent/turn-stopping', () => {
        if (modelRequests !== 1 || toolAttempts !== 1 || successfulResults !== 1) {
            throw new Error(`live smoke expected modelRequests=1 toolAttempts=1 successfulResults=1; got ${modelRequests}/${toolAttempts}/${successfulResults}`);
        }
        console.log('KERNL_DSH_LIVE_SMOKE_OK modelRequests=1 toolAttempts=1 successfulResults=1');
    });
}
