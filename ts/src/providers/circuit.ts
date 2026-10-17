/**
 * Circuit breaker — AstMatrix's `circuit.go` semantics, native TypeScript port.
 *
 * Ported from proxy/src/circuit.rs with fidelity to:
 * - Closed allows everything; `maxFailures` consecutive failures open the circuit
 *   for `timeoutMs`; a half-open trial needs `halfOpenMax` consecutive successes
 *   to close, and a single failure re-opens.
 * - Defaults match AstMatrix (5 failures, 30s timeout) with the GenPark correction
 *   of 2 half-open successes (1 is too twitchy, 3 sluggish).
 * - GenPark single-probe isolation: while half-open, exactly ONE probe is
 *   admitted at a time. Concurrent callers are rejected until the in-flight probe
 *   records its outcome.
 * - Every strategy consults the breaker, and only genuinely retryable failures
 *   count (see MIGRATION.md).
 */
import type { CircuitSnapshot } from "./circuit";

// ─────────────────────────────────────────────────────────────────────────────
// Types (matching CONTRACT.md)
// ─────────────────────────────────────────────────────────────────────────────

export type CircuitState = "closed" | "open" | "half";

export interface CircuitSnapshot {
  state: number; // 0 closed, 1 half-open, 2 open
  failures: number;
  lastFailureUnix: number; // 0 = none
  consecutiveSuccesses: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal implementation
// ─────────────────────────────────────────────────────────────────────────────

type InternalCircuitState = "Closed" | "HalfOpen" | "Open";

interface CircuitBreaker {
  state: InternalCircuitState;
  failures: number;
  lastFailure: number | null; // epoch ms
  lastFailureUnix: number;
  consecutiveSuccesses: number;
  maxFailures: number;
  timeoutMs: number;
  halfOpenMax: number;
  probeInflight: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Global circuit breaker map
// ─────────────────────────────────────────────────────────────────────────────

const circuits = new Map<string, CircuitBreaker>();

function getOrCreateBreaker(
  name: string,
  factory: () => CircuitBreaker
): CircuitBreaker {
  let breaker = circuits.get(name);
  if (!breaker) {
    breaker = factory();
    circuits.set(name, breaker);
  }
  return breaker;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API (matching CONTRACT.md)
// ─────────────────────────────────────────────────────────────────────────────

/** Record a successful request for `name`. */
export function recordSuccess(name: string): void {
  const breaker = getOrCreateBreaker(name, astmatrixDefaults);
  breaker.probeInflight = false;
  switch (breaker.state) {
    case "Closed":
      breaker.failures = 0;
      break;
    case "HalfOpen":
      breaker.consecutiveSuccesses += 1;
      if (breaker.consecutiveSuccesses >= breaker.halfOpenMax) {
        breaker.state = "Closed";
        breaker.failures = 0;
        breaker.consecutiveSuccesses = 0;
      }
      break;
    case "Open":
      // Nothing to do
      break;
  }
}

/** Record a failure for `name`. */
export function recordFailure(
  name: string,
  status: number,
  retryAfterMs: number | null
): void {
  const breaker = getOrCreateBreaker(name, astmatrixDefaults);
  breaker.probeInflight = false;
  switch (breaker.state) {
    case "Closed":
      breaker.failures += 1;
      if (breaker.failures >= breaker.maxFailures) {
        openBreaker(breaker, Date.now());
      }
      break;
    case "HalfOpen":
      openBreaker(breaker, Date.now());
      break;
    case "Open":
      // Nothing to do
      break;
  }
}

/** Get the circuit snapshot for `name`. */
export function circuitOf(name: string): CircuitSnapshot {
  const breaker = getOrCreateBreaker(name, astmatrixDefaults);
  return snapshot(breaker);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper functions (ported from circuit.rs)
// ─────────────────────────────────────────────────────────────────────────────

function astmatrixDefaults(): CircuitBreaker {
  return {
    state: "Closed",
    failures: 0,
    lastFailure: null,
    lastFailureUnix: 0,
    consecutiveSuccesses: 0,
    maxFailures: 5,
    timeoutMs: 30_000,
    halfOpenMax: 2,
    probeInflight: false,
  };
}

function openBreaker(breaker: CircuitBreaker, nowUnix: number): void {
  breaker.state = "Open";
  breaker.lastFailure = nowUnix;
  breaker.lastFailureUnix = nowUnix;
  breaker.consecutiveSuccesses = 0;
}

function snapshot(breaker: CircuitBreaker): CircuitSnapshot {
  return {
    state: breaker.state === "Closed" ? 0 : breaker.state === "HalfOpen" ? 1 : 2,
    failures: breaker.failures,
    lastFailureUnix: breaker.lastFailureUnix,
    consecutiveSuccesses: breaker.consecutiveSuccesses,
  };
}

/** Force-open for operator intervention (not in AstMatrix; additive). */
export function forceOpen(name: string, nowUnix: number = Date.now()): void {
  const breaker = getOrCreateBreaker(name, astmatrixDefaults);
  openBreaker(breaker, nowUnix);
}

/** Allow a request through the circuit breaker for `name`. */
export function allow(name: string): boolean {
  const breaker = getOrCreateBreaker(name, astmatrixDefaults);
  return allowInternal(breaker);
}

function allowInternal(breaker: CircuitBreaker): boolean {
  switch (breaker.state) {
    case "Closed":
      return true;
    case "Open": {
      if (
        breaker.lastFailure !== null &&
        Date.now() - breaker.lastFailure >= breaker.timeoutMs
      ) {
        breaker.state = "HalfOpen";
        breaker.consecutiveSuccesses = 0;
        breaker.probeInflight = true;
        return true;
      }
      return false;
    }
    case "HalfOpen":
      if (breaker.probeInflight) {
        return false;
      } else {
        breaker.probeInflight = true;
        return true;
      }
  }
}

/** Release a held probe lease without recording an outcome. */
export function releaseProbe(name: string): void {
  const breaker = getOrCreateBreaker(name, astmatrixDefaults);
  breaker.probeInflight = false;
}

/** Snapshot for persistence. */
export function snapshotBreaker(name: string): CircuitSnapshot {
  const breaker = circuits.get(name);
  if (!breaker) {
    // Return default snapshot for unknown breaker
    return snapshot(astmatrixDefaults());
  }
  return snapshot(breaker);
}

/** Restore from a persisted snapshot. */
export function restoreBreaker(
  name: string,
  snap: CircuitSnapshot,
  nowUnix: number = Date.now()
): void {
  let breaker = circuits.get(name);
  if (!breaker) {
    breaker = astmatrixDefaults();
    circuits.set(name, breaker);
  }
  restoreInternal(breaker, snap, nowUnix);
}

function restoreInternal(
  breaker: CircuitBreaker,
  snap: CircuitSnapshot,
  nowUnix: number
): void {
  breaker.failures = snap.failures;
  breaker.consecutiveSuccesses = snap.consecutiveSuccesses;
  breaker.lastFailureUnix = snap.lastFailureUnix;
  if (snap.lastFailureUnix > 0) {
    const age = nowUnix - snap.lastFailureUnix;
    breaker.lastFailure = nowUnix - age;
  } else {
    breaker.lastFailure = null;
  }
  breaker.state =
    snap.state === 0 ? "Closed" : snap.state === 1 ? "HalfOpen" : "Open";
  breaker.probeInflight = false;
}