import { type CordisContextLike, type JsonObject } from './contracts.js';
/** Stable diagnostic name for the one-off real-DSH smoke probe. */
export declare const name = "kernl-smoke-probe";
/** The probe is deliberately not part of the default bundle patch. */
export declare const inject: readonly ["tools", "kernl", "kernlTools", "appExit"];
interface SmokeConfig {
    readonly request?: JsonObject;
}
/** Execute one registered tool, request graceful app exit, and prove unload. */
export declare function apply(ctx: CordisContextLike, config?: SmokeConfig): void;
export {};
