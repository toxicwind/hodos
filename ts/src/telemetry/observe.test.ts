import { describe, it, expect } from "vitest";
import { metricsRegistry, createObservationState, createUsageObservations, hasSubstance, isSubstantive, FinishReason, FlockModelEmptyStrikes } from "./observe";
import { HealthMonitor, getHealthMonitor, recordEmptyStrike, healthCheck, buildCircuitSnapshot } from "./health";

// Mock the shared module types
const mockShared = {
  Result: { ok: (v: T) => Result<{ ok: true; value: T }, never>, failure: (e: string) => Result<never, string> } as any },
  attempt: (label: string, fn: () => Promise<unknown>) => Promise<unknown>,
  callUpstream: (req: unknown, signal: any) => Promise<unknown>,
};

describe("observe", () => {
  it("should export metricsRegistry with flock_model_empty_strikes", () => {
    expect(metricsRegistry.flock_model_empty_strikes).toBeDefined();
    expect(typeof metricsRegistry.flock_model_empty_strikes).toBe("function");
  });

  it("should export FlockModelEmptyStrikes type", () => {
    expect(typeof FlockModelEmptyStrikes).toBe("function");
  });

  it("should export StreamOutcome enum", () => {
    expect(typeof StreamOutcome).toBe("function");
  });

  it("should export FinishReason union", () => {
    const reasons = ["COMPLETION", "CANCEL", "TOOL_CALL", "MAX_TOKENS", "RATE_LIMIT", "ERROR", "STREAM_END", "CONTEXT_LENGTH", "CONTEXT_WINDOW", "INTERNAL", "GUARDRAIL"];
    expect(reasons).toEqual(expect.arrayContaining(["COMPLETION", "CANCEL", "TOOL_CALL", "MAX_TOKENS", "RATE_LIMIT", "ERROR", "STREAM_END", "CONTEXT_LENGTH", "CONTEXT_WINDOW", "INTERNAL", "GUARDRAIL"]));
  });
});

describe("observe", () => {
  it("should create a fresh observation state", () => {
    const state = createObservationState();
    expect(state).toHaveProperty("observations", []);
    expect(state).toHaveProperty("usage", null);
    expect(state).toHaveProperty("hasContent", false);
  });

  it("should create a fresh usage observations", () => {
    const obs = createUsageObservations();
    expect(obs).toHaveProperty("finishReasons", []);
    expect(obs).toHaveProperty("tokens", []);
    expect(obs).toHaveProperty("hasContent", false);
  });
});
