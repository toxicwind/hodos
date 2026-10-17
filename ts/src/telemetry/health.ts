/**
 * health.ts — health checks, circuit snapshots, and empty-strike tracking
 *
 * Ported from proxy/src/health.rs
 *
 * Metric names are LOAD-BEARING.  flock_model_empty_strikes intentionally
 * mirrors estate-scripts_router_model_empty_strikes so the two stacks can be
 * correlated during the migration.  Renaming a metric silently breaks dashboards.
 */

import { Result, attempt, CircuitState, UpstreamResponse, callUpstream } from "../shared";

// ---------------------------------------------------------------------------
// Health inner state
// ---------------------------------------------------------------------------

interface HealthInner {
  /** Current health status: "healthy" or "unhealthy". */
  status: "healthy" | "unhealthy";
  /** Latency in milliseconds (EMA-weighted). */
  latencyMs: number;
  /** Failure count since last reset. */
  failureCount: number;
  /** Whether the circuit is open. */
  isOpen: boolean;
  /** Last probe timestamp (unix ms). */
  lastProbeMs: number;
}

// ---------------------------------------------------------------------------
// Provider health view
// ---------------------------------------------------------------------------

interface ProviderHealthView {
  /** Name of the provider. */
  name: string;
  /** Current health status. */
  status: "healthy" | "unhealthy";
  /** Latency in ms. */
  latencyMs: number;
  /** Failure count. */
  failureCount: number;
  /** Circuit state: "closed" | "open" | "half". */
  circuitState: "closed" | "open" | "half";
  /** Empty-strike counter (per provider/model). */
  emptyStrikes: number;
}

// ---------------------------------------------------------------------------
// Circuit snapshot
// ---------------------------------------------------------------------------

interface CircuitSnapshot {
  /** Current circuit state. */
  state: "closed" | "open" | "half";
  /** Number of consecutive failures. */
  failureCount: number;
  /** EMA of latency in ms (0.7/0.3). */
  avgLatencyMs: number;
  /** Timestamp of last failure (unix ms). */
  lastFailureMs: number;
  /** Whether the circuit is currently open. */
  isOpen: boolean;
}

// ---------------------------------------------------------------------------
// Health monitor — tracks provider health and empty-strike counters
// ---------------------------------------------------------------------------

class HealthMonitor {
  private health: ProviderHealthView;
  private circuit: CircuitSnapshot;
  private emptyStrikes: Record<string, number> = {};

  constructor(
    name: string,
    initialLatencyMs: number = 50,
    initialFailureCount: number = 0
  ) {
    this.health = {
      name,
      status: "healthy",
      latencyMs: initialLatencyMs,
      failureCount: initialFailureCount,
      isOpen: false,
      lastProbeMs: 0,
    };
    this.circuit = {
      state: "closed",
      failureCount: 0,
      avgLatencyMs: initialLatencyMs,
      lastFailureMs: 0,
      isOpen: false,
    };
  }

  /** Record a successful probe (resets failure count, updates latency). */
  async probe(): Promise<Result<HealthInner>> {
    const previousStatus = this.health.status;
    try {
      // Simulate a probe call – in reality this would call UpstreamResponse
      const response: UpstreamResponse = {
        status: 200,
        headers: { "content-type": "application/json" },
        body: null,
        latencyMs: Math.random() * 100,
        provider: this.health.name,
        model: "default-model",
      };

      // Update health status
      if (response.status >= 200 && response.status < 300) {
        this.health.status = "healthy";
        this.health.latencyMs = response.latencyMs;
      } else {
        this.health.status = "unhealthy";
        this.health.failureCount++;
      }

      // Update circuit state
      if (this.health.status !== "healthy") {
        this.circuit.isOpen = true;
        this.circuit.failureCount = this.health.failureCount;
        this.circuit.lastFailureMs = Date.now();
      } else {
        this.circuit.isOpen = false;
        this.circuit.failureCount = 0;
      }

      // Track empty strikes
      if (response.body && response.body.length > 0) {
        // Not an empty strike
      } else {
        // Count as empty strike
        const key = `${this.health.name}:${this.health.model}`;
        this.emptyStrikes[key] = (this.emptyStrikes[key] ?? 0) + 1;
      }

      return {
        ok: true,
        value: {
          name: "health",
          status: this.health.status,
          latencyMs: this.health.latencyMs,
          failureCount: this.health.failureCount,
          circuitState: this.circuit.state,
          emptyStrikes: this.emptyStrikes[key],
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Unknown error",
      };
    }
  }

  /** Get current health metrics. */
  getHealth(): HealthInner {
    return {
      status: this.health.status,
      latencyMs: this.health.latencyMs,
      failureCount: this.health.failureCount,
      isOpen: this.circuit.isOpen,
      lastProbeMs: this.circuit.lastProbeMs,
    };
  }

  /** Reset health after a restart (simulating boot restore). */
  reset(): void {
    this.health.status = "healthy";
    this.health.latencyMs = 50;
    this.health.failureCount = 0;
    this.circuit.isOpen = false;
    this.circuit.failureCount = 0;
    this.circuit.lastFailureMs = 0;
    this.emptyStrikes = {};
  }
}

// ---------------------------------------------------------------------------
// Global health registry – one monitor per provider
// ---------------------------------------------------------------------------

let monitors: Record<string, HealthMonitor> = {};

/** Get or create a health monitor for a given provider name. */
export function getHealthMonitor(name: string): HealthMonitor {
  if (!monitors[name]) {
    monitors[name] = new HealthMonitor(name);
  }
  return monitors[name];
}

/** List all registered health monitors. */
export function listHealthMonitors(): ReadonlyArray<string> {
  return Object.keys(monitors);
}

// ---------------------------------------------------------------------------
// Record an empty strike for a specific provider/model pair
// ---------------------------------------------------------------------------

export function recordEmptyStrike(provider: string, model: string): void {
  const monitor = getHealthMonitor(provider);
  if (monitor) {
    monitor.emptyStrikes[`${provider}:${model}`] = (monitor.emptyStrikes[`${provider}:${model}`] ?? 0) + 1;
  }
}

// ---------------------------------------------------------------------------
// Health check endpoint helper – matches proxy/src/health.rs health.rs
// ---------------------------------------------------------------------------

/**
 * Health check endpoint handler.
 * Returns a JSON object with health metrics for the given provider.
 *
 * Mirrors proxy/src/health.rs:health_check and the associated
 * circuit/snapshot logic.
 */
export function healthCheck(provider: string): Result<HealthInner, string> {
  const monitor = getHealthMonitor(provider);
  if (monitor.status !== "healthy") {
    return Result.failure(`Provider ${provider} is unhealthy: ${monitor.status}`);
  }

  return Result.ok({
    name: provider,
    status: monitor.status,
    latencyMs: monitor.latencyMs,
    failureCount: monitor.failureCount,
    circuitState: monitor.circuitState,
    emptyStrikes: monitor.emptyStrikes,
  });
}

// ---------------------------------------------------------------------------
// Circuit snapshot builder – mirrors proxy/src/health.rs circuit snapshot
// ---------------------------------------------------------------------------

export function buildCircuitSnapshot(
  state: "closed" | "open" | "half",
  failureCount: number,
  avgLatencyMs: number,
  lastFailureMs: number
): CircuitSnapshot {
  return {
    state,
    failureCount,
    avgLatencyMs,
    lastFailureMs,
    isOpen: state === "open",
  };
}

// ---------------------------------------------------------------------------
// Helper: compute EMA-like latency smoothing (0.7/0.3 weights)
// ---------------------------------------------------------------------------

function emaUpdate(current: number, alpha: number): number {
  return alpha * current + (1 - alpha) * prev;
}
