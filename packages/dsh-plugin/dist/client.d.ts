import { type JsonObject, type JsonValue } from './contracts.js';
/** User-configurable, non-secret Kernl API connection values. */
export interface KernlClientConfig {
    readonly baseUrl?: string;
    readonly routePrefix?: string;
    readonly requestTimeoutMs?: number;
    readonly maxResponseBytes?: number;
}
/** Validated values used by the HTTP client. */
export interface ResolvedKernlClientConfig {
    readonly baseUrl: string;
    readonly routePrefix: string;
    readonly requestTimeoutMs: number;
    readonly maxResponseBytes: number;
}
/** The five operations the DSH adapter may ask Kernl to perform. */
export interface KernlClient {
    readonly config: ResolvedKernlClientConfig;
    validateChange(request: JsonObject, signal?: AbortSignal): Promise<JsonValue>;
    compilePlan(request: JsonObject, signal?: AbortSignal): Promise<JsonValue>;
    claimTask(request: JsonObject, signal?: AbortSignal): Promise<JsonValue>;
    recordResult(request: JsonObject, signal?: AbortSignal): Promise<JsonValue>;
    verify(request: JsonObject, signal?: AbortSignal): Promise<JsonValue>;
}
/** Structured failure returned by the local Kernl API adapter. */
export declare class KernlApiError extends Error {
    readonly code: string;
    readonly status: number | undefined;
    readonly details: JsonValue | undefined;
    constructor(code: string, message: string, options?: {
        status?: number;
        details?: JsonValue;
        cause?: unknown;
    });
}
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
/** Validate config at plugin load so a bad deployment never partially mounts. */
export declare function resolveKernlClientConfig(input: unknown): ResolvedKernlClientConfig;
/** Create the stateless HTTP implementation behind `ctx.kernl`. */
export declare function createKernlClient(input: KernlClientConfig | undefined, fetchImplementation?: FetchLike): KernlClient;
export {};
