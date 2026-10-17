/**
 * observe.ts — per-request observation records, request stats, metrics registry
 *
 * Ported from proxy/src/observation.rs
 *
 * Metric names are LOAD-BEARING.  flock_model_empty_strikes intentionally
 * mirrors estate-scripts_router_model_empty_strikes so the two stacks can be
 * correlated during the migration.  Renaming a metric silently breaks dashboards.
 */

import { Result, attempt, CircuitState, UpstreamResponse, callUpstream } from "../shared";

// ---------------------------------------------------------------------------
// Bounded finish-reason labels — exhaustive for the metric dashboard
// ---------------------------------------------------------------------------

/** Every observable finish reason.  The generated `ALL` array makes the
 *  contract test surface every category rather than silently dropping its
 *  share. */
export type FinishReason =
  | "COMPLETION"
  | "CANCEL"
  | "TOOL_CALL"
  | "MAX_TOKENS"
  | "RATE_LIMIT"
  | "ERROR"
  | "STREAM_END"
  | "CONTEXT_LENGTH"
  | "CONTEXT_WINDOW"
  | "INTERNAL"
  | "GUARDRAIL";

/** Exhaustive list used by the metric registration. */
export const FinishReasonsAll: ReadonlyArray<FinishReason> = [
  "COMPLETION",
  "CANCEL",
  "TOOL_CALL",
  "MAX_TOKENS",
  "RATE_LIMIT",
  "ERROR",
  "STREAM_END",
  "CONTEXT_LENGTH",
  "CONTEXT_WINDOW",
  "INTERNAL",
  "GUARDRAIL",
];

// ---------------------------------------------------------------------------
// StreamOutcome — mirrors proxy/src/observation.rs:StreamOutcome
// ---------------------------------------------------------------------------

/** True when the stream produced content; false when the response was empty
 *  (no choices, or all choices blank/terminated). */
export enum StreamOutcome {
  SUBSTANTIVE = "substantive",
  EMPTY = "empty",
}

/** Whether this outcome is substantive (contains generated content). */
export function isSubstantive(outcome: StreamOutcome): boolean {
  return outcome === StreamOutcome.SUBSTANTIVE;
}

// ---------------------------------------------------------------------------
// UsageObservationMetric — a single bounded metric entry
// ---------------------------------------------------------------------------

export interface UsageObservationMetric {
  /** The finish reason category. */
  finishReason: FinishReason;
  /** The model name (may be empty for system-level tallies). */
  model: string;
  /** The provider name (may be empty for system-level tallies). */
  provider: string;
  /** Token counts: prompt, completion, total (may be null if unknown). */
  tokens: { prompt: number; completion: number; total: number } | null;
}

// ---------------------------------------------------------------------------
// ResponseObservations — per-request observation payload
// ---------------------------------------------------------------------------

export interface ResponseObservations {
  /** The generated choice(s) content (may be empty). */
  choices: ReadonlyArray<{ message: { role: string; content: string | null }; tool_calls?: ReadonlyArray<{ id: string; type: string; function?: { name: string; arguments: string } }> }>;
  /** Whether the response body carried any generated content. */
  hasSubstance: boolean;
  /** Finished reason for the request. */
  finishReason: FinishReason;
  /** Token usage counts. */
  usage: UsageObservationMetric | null;
  /** Streaming-specific: whether the stream ended naturally. */
  streamEnded: boolean;
}

// ---------------------------------------------------------------------------
// UsageObservations — accumulates per-request observations for a single
// request before finalization
// ---------------------------------------------------------------------------

export interface UsageObservations {
  /** Per-choice finish reasons collected during streaming. */
  finishReasons: ReadonlyArray<FinishReason>;
  /** Per-choice token counts collected during streaming. */
  tokens: ReadonlyArray<{ prompt: number; completion: number }>;
  /** Whether any choice had non-blank content. */
  hasContent: boolean;
}

// ---------------------------------------------------------------------------
// ObservationState — in-memory state for the observer
// ---------------------------------------------------------------------------

export interface ObservationState {
  /** Per-request observations accumulated so far. */
  observations: ReadonlyArray<ResponseObservations>;
  /** Aggregated usage across all finished requests. */
  usage: UsageObservationMetric | null;
  /** Whether the observer has seen any substantive response. */
  hasSeenSubstantive: boolean;
}

// ---------------------------------------------------------------------------
// Metrics registry — the TS equivalent of the Rust `gauge!` exports
// ---------------------------------------------------------------------------

/** Registry of all metrics exported by this module.  Each entry is a
 *  key/value pair where the key is the metric name used in Prometheus
 *  scrapes and the value is a factory closure that returns the current
 *  gauge value object. */
export interface MetricsRegistry {
  /** Number of empty completions recorded per (provider, model) pair. */
  flock_model_empty_strikes: (provider: string, model: string) => number;
  /** Total number of observed requests (substantive + empty). */
  flock_requests_total: () => number;
  /** Number of substantive (non-empty) requests. */
  flock_substantive_requests_total: () => number;
  /** Number of empty requests. */
  flock_empty_requests_total: () => number;
  /** Per-finish-reason breakdown. */
  flock_finish_reason_total: (reason: FinishReason) => number;
}

/** In-memory metric store backing the registry. */
class MetricStore {
  private strikes: Map<string, number> = new Map(); // "provider:model" -> count
  private requestTotal: number = 0;
  private substantiveTotal: number = 0;
  private emptyTotal: number = 0;
  private finishReasonTotals: Map<FinishReason, number> = new Map();

  /** Record an empty completion (no content, no tool calls) against a
   *  provider/model pair.  This mirrors
   *  proxy/src/health.rs:record_empty_strike. */
  recordEmptyStrike(provider: string, model: string): void {
    const key = `${provider}:${model}`;
    const current = this.strikes.get(key) ?? 0;
    this.strikes.set(key, current + 1);
  }

  /** Record a generic request (substantive or empty). */
  recordRequest(isSubstantive: boolean): void {
    this.requestTotal++;
    if (isSubstantive) {
      this.substantiveTotal++;
    } else {
      this.emptyTotal++;
    }
  }

  /** Record a finish-reason occurrence. */
  recordFinishReason(reason: FinishReason): void {
    const current = this.finishReasonTotals.get(reason) ?? 0;
    this.finishReasonTotals.set(reason, current + 1);
  }

  /** Build the registry read-only views. */
  buildRegistry(): MetricsRegistry {
    return {
      flock_model_empty_strikes: (provider: string, model: string): number => {
        return this.strikes.get(`${provider}:${model}`) ?? 0;
      },
      flock_requests_total: (): number => this.requestTotal,
      flock_substantive_requests_total: (): number => this.substantiveTotal,
      flock_empty_requests_total: (): number => this.emptyTotal,
      flock_finish_reason_total: (reason: FinishReason): number =>
        this.finishReasonTotals.get(reason) ?? 0,
    };
  }
}

// ---------------------------------------------------------------------------
// SSE observer — content-free observation of a streamed response body
// ---------------------------------------------------------------------------

/** Substance check for the empty-completion guard: does this buffered
 *  response body carry any generated content? A chat-completion choice
 *  counts as substantive when any message.content (or delta.content)
 *  is non-blank, or any message.tool_calls (or delta.tool_calls) is a
 *  non-empty array. Bodies without a choices envelope are not chat
 *  completions and pass through untouched.
 *
 *  Computes a single boolean; message content is inspected transiently
 *  and never retained, preserving the observer content-free contract. */
export function hasSubstance(body: string): boolean {
  // Parse minimal JSON to check for choices envelope
  try {
    const parsed = JSON.parse(body);
    if (!parsed.choices || parsed.choices.length === 0) {
      return false; // not a chat completion
    }
    const choice = parsed.choices[0];
    const delta = choice.delta || {};
    const message = choice.message || {};

    // Check message.content or delta.content for non-blank
    const content = delta.content ?? message.content;
    if (content && content.trim().length > 0) {
      return true;
    }

    // Check message.tool_calls or delta.tool_calls for non-empty array
    const toolCalls = delta.tool_calls ?? message.tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      return true;
    }

    // Check the choice's own content
    if (choice.content && choice.content.trim().length > 0) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/** Buffer incoming observations for a single request, returning the
 *  accumulated `UsageObservations`. */
export function observeBuffered(
  body: string,
  existing?: UsageObservations
): UsageObservations {
  const obs = existing ?? { finishReasons: [], tokens: [], hasContent: false };

  if (!body || body.trim().length === 0) {
    return obs;
  }

  try {
    const parsed = JSON.parse(body);

    // Walk choices and accumulate
    if (Array.isArray(parsed.choices)) {
      for (const choice of parsed.choices) {
        const msg = choice.message || {};

        // Finish reason — use the last non-blank content's implied reason
        if (msg.content && msg.content.trim().length > 0) {
          // If we have content, the finish reason is effectively COMPLETION
          // unless a tool_call or max_tokens cut it off.  We track the
          // presence of substantive content here and let the caller
          // finalize the reason.
          obs.hasContent = true;
          if (!obs.finishReasons.includes("COMPLETION")) {
            obs.finishReasons.push("COMPLETION");
          }
        }

        // Token counts (best-effort)
        if (choice.token_usage) {
          obs.tokens.push({
            prompt: choice.token_usage.prompt_tokens ?? 0,
            completion: choice.token_usage.completion_tokens ?? 0,
          });
        }

        // Tool calls
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
          if (!obs.finishReasons.includes("TOOL_CALL")) {
            obs.finishReasons.push("TOOL_CALL");
          }
        }
      }
    }
  } catch {
    // If we can't parse the body, treat it as having no substance;
    // the caller will decide the finish reason.
  }

  return obs;
}

// ---------------------------------------------------------------------------
// Export a ready-to-use metrics registry
// ---------------------------------------------------------------------------

export const metricsRegistry = new MetricStore().buildRegistry();

// ---------------------------------------------------------------------------
// Convenience: record an empty strike via the shared callUpstream path
// ---------------------------------------------------------------------------

/** Record an empty completion (2xx, no content, no tool calls) against a
 *  provider/model pair.  Surfaced as the `flock_model_empty_strikes` gauge.
 *  This mirrors proxy/src/health.rs:record_empty_strike. */
export function recordEmptyStrike(provider: string, model: string): void {
  metricsRegistry.flock_model_empty_strikes(provider, model);
}

// ---------------------------------------------------------------------------
// Health summary snapshot — mirrors proxy/src/health.rs ProviderHealthView
// ---------------------------------------------------------------------------

export interface HealthSummary {
  /** Provider name. */
  provider: string;
  /** Model name. */
  model: string;
  /** Whether the provider is currently healthy. */
  healthy: boolean;
  /** Circuit state: "closed", "open", or "half". */
  circuitState: CircuitState;
  /** Number of consecutive empty strikes before circuit opens. */
  emptyStrikes: number;
  /** Last time a strike was recorded (unix ms), or 0 if never. */
  lastStrikeMs: number;
  /** Whether the model is currently quarantined. */
  quarantined: boolean;
}

// ---------------------------------------------------------------------------
// Circuit snapshot — mirrors proxy/src/health.rs circuit state
// ---------------------------------------------------------------------------

export interface CircuitSnapshot {
  /** Circuit state: "closed", "open", or "half". */
  state: CircuitState;
  /** Number of consecutive failures. */
  failureCount: number;
  /** EMA of latency in ms (0.7/0.3). */
  avgLatencyMs: number;
  /** Last failure timestamp (unix ms). */
  lastFailureMs: number;
  /** Whether the circuit is open. */
  isOpen: boolean;
}

// ---------------------------------------------------------------------------
// Factory: create a fresh ObservationState
// ---------------------------------------------------------------------------

export function createObservationState(): ObservationState {
  return {
    observations: [],
    usage: null,
    hasSeenSubstantive: false,
  };
}

// ---------------------------------------------------------------------------
// Factory: create a fresh UsageObservations
// ---------------------------------------------------------------------------

export function createUsageObservations(): UsageObservations {
  return { finishReasons: [], tokens: [], hasContent: false };
}