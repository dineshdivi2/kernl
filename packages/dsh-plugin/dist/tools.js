import { isJsonObject, } from './contracts.js';
/** Stable Cordis diagnostic name for the model-facing tool consumer. */
export const name = 'kernl-tools';
/** Hard dependencies keep this consumer pending until both services exist. */
export const inject = ['tools', 'kernl'];
const TOOL_NAMES = [
    'kernl_validate_change',
    'kernl_compile_plan',
    'kernl_claim_task',
    'kernl_record_result',
    'kernl_verify',
];
/** Invalid model-supplied arguments rejected before the Kernl API is called. */
export class KernlToolArgsError extends Error {
    code = 'INVALID_ARGS';
    constructor(message) {
        super(message);
        this.name = 'KernlToolArgsError';
    }
}
/** Register the five least-authority Kernl operations on `ctx.tools`. */
export function apply(ctx, input) {
    if (ctx === null || typeof ctx !== 'object' || typeof ctx.get !== 'function') {
        throw new TypeError('kernl-tools requires a Cordis context with get()');
    }
    const tools = requireTools(ctx.get('tools'));
    const kernl = requireKernl(ctx.get('kernl'));
    const config = resolveConfig(input);
    for (const definition of definitions(kernl, config))
        tools.register(definition);
    ctx.provide('kernlTools', Object.freeze({ names: Object.freeze([...TOOL_NAMES]) }));
}
/** Build fresh definitions for one active Kernl provider instance. */
export function definitions(kernl, config = { concludeTurnAfterSuccess: false }) {
    return [
        definition('kernl_validate_change', 'Validate an architecture change and its capability bindings before any implementation task starts.', (request, signal) => kernl.validateChange(request, signal), config.concludeTurnAfterSuccess),
        definition('kernl_compile_plan', 'Compile a validated architecture change into a bounded task DAG with explicit dependencies and write scopes.', (request, signal) => kernl.compilePlan(request, signal), config.concludeTurnAfterSuccess),
        definition('kernl_claim_task', 'Ask Kernl to claim one control-plane task. This adapter grants no worker identity, capability, or write authority.', (request, signal) => kernl.claimTask(request, signal), config.concludeTurnAfterSuccess),
        definition('kernl_record_result', 'Record one task result and its evidence. This does not approve or promote the run.', (request, signal) => kernl.recordResult(request, signal), config.concludeTurnAfterSuccess),
        definition('kernl_verify', 'Run or read deterministic verification for a Kernl run or task.', (request, signal) => kernl.verify(request, signal), config.concludeTurnAfterSuccess),
    ];
}
function definition(toolName, description, invoke, concludeTurnAfterSuccess) {
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
            render(_args, value) {
                return [{ type: 'text', text: JSON.stringify(value) }];
            },
        },
        async execute(args, execution) {
            const value = await invoke(extractRequest(args), execution.signal);
            if (concludeTurnAfterSuccess) {
                if (typeof execution.concludeTurn !== 'function') {
                    throw new TypeError('concludeTurnAfterSuccess requires the current DSH ToolRunContext');
                }
                execution.concludeTurn();
            }
            return value;
        },
    };
}
function resolveConfig(input) {
    const config = input ?? {};
    if (!isJsonObject(config))
        throw new TypeError('kernl-tools config must be an object');
    const unknown = Object.keys(config).filter(key => key !== 'concludeTurnAfterSuccess');
    if (unknown.length > 0)
        throw new TypeError(`kernl-tools config contains unknown field: ${unknown.join(', ')}`);
    const concludeTurnAfterSuccess = config.concludeTurnAfterSuccess ?? false;
    if (typeof concludeTurnAfterSuccess !== 'boolean') {
        throw new TypeError('kernl-tools config.concludeTurnAfterSuccess must be a boolean');
    }
    return Object.freeze({ concludeTurnAfterSuccess });
}
function extractRequest(args) {
    if (!isJsonObject(args))
        throw new KernlToolArgsError('arguments must be an object');
    const keys = Object.keys(args);
    if (keys.length !== 1 || keys[0] !== 'request') {
        throw new KernlToolArgsError('arguments must contain only the required request object');
    }
    if (!isJsonObject(args.request))
        throw new KernlToolArgsError('request must be a JSON object');
    return args.request;
}
function requireTools(value) {
    if (!isObjectLike(value) || typeof value.register !== 'function') {
        throw new TypeError('kernl-tools requires ctx.tools.register()');
    }
    return value;
}
function requireKernl(value) {
    if (!isObjectLike(value))
        throw new TypeError('kernl-tools requires the ctx.kernl service');
    for (const method of ['validateChange', 'compilePlan', 'claimTask', 'recordResult', 'verify']) {
        if (typeof value[method] !== 'function') {
            throw new TypeError(`ctx.kernl is missing ${method}()`);
        }
    }
    return value;
}
function isObjectLike(value) {
    return value !== null && (typeof value === 'object' || typeof value === 'function');
}
