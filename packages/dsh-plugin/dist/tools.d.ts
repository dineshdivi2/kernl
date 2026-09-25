import type { KernlClient } from './client.js';
import { type CordisContextLike, type DshToolDefinition } from './contracts.js';
/** Stable Cordis diagnostic name for the model-facing tool consumer. */
export declare const name = "kernl-tools";
/** Hard dependencies keep this consumer pending until both services exist. */
export declare const inject: readonly ["tools", "kernl"];
declare const TOOL_NAMES: readonly ["kernl_validate_change", "kernl_compile_plan", "kernl_claim_task", "kernl_record_result", "kernl_verify"];
/** The complete intentionally bounded Kernl tool surface. */
export type KernlToolName = typeof TOOL_NAMES[number];
/** Deployment-only behavior for the registered tools. */
export interface KernlToolsConfig {
    /**
     * End the current DSH turn after one successful Kernl call. This is false in
     * the bundle and exists only to make the opt-in live integration smoke a
     * one-request, one-tool run.
     */
    readonly concludeTurnAfterSuccess?: boolean;
}
/** Invalid model-supplied arguments rejected before the Kernl API is called. */
export declare class KernlToolArgsError extends Error {
    readonly code = "INVALID_ARGS";
    constructor(message: string);
}
/** Register the five least-authority Kernl operations on `ctx.tools`. */
export declare function apply(ctx: CordisContextLike, input?: KernlToolsConfig): void;
/** Build fresh definitions for one active Kernl provider instance. */
export declare function definitions(kernl: KernlClient, config?: Readonly<Required<KernlToolsConfig>>): DshToolDefinition[];
export {};
