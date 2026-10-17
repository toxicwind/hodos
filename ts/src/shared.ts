/**
 * flock TS router — shared primitives.
 * Exact mirror of CONTRACT.md primitives.
 */

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Never throws. Ports Rust's Result<T, E> honestly instead of faking it.
 */
export function attempt<T>(label: string, fn: () => T | Promise<T>): Promise<Result<T>> {
    try {
        const result = fn();
        return Promise.resolve(result instanceof Promise ? result.then(v => ({ ok: true, value: v })) : { ok: true, value: result });
    } catch (err) {
        return Promise.resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
}

/** Circuit breaker states. Do not invent new ones; the metrics name them. */
export type CircuitState = "closed" | "open" | "half";

export interface UpstreamResponse {
    status: number;
    headers: Record<string, string>;
    body: ReadableStream<Uint8Array> | null;
    latencyMs: number;
    provider: string;
    model: string;
}

/**
 * Every provider call goes through here. Never call fetch() directly.
 */
export function callUpstream(req: UpstreamRequest, signal: AbortSignal): Promise<UpstreamResponse> {
    // This is a stub - the actual implementation would be provided by the HTTP layer
    throw new Error("callUpstream not implemented");
}

export interface UpstreamRequest {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: any | null;
}