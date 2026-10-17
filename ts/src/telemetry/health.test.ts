import { describe, it, expect } from "vitest";
import { HealthMonitor, getHealthMonitor, recordEmptyStrike, healthCheck, buildCircuitSnapshot } from "./health";

describe("health", () => {
  it("should create a health monitor for a provider", () => {
    const monitor = getHealthMonitor("flock-model");
    expect(monitor).toBeDefined();
    expect(monitor.name).toBe("flock-model");
    expect(monitor.status).toBe("healthy");
    expect(monitor.latencyMs).toBe(50);
    expect(monitor.failureCount).toBe(0);
    expect(monitor.isOpen).toBe(false);
  });

  it("should record an empty strike", () => {
    const monitor = getHealthMonitor("flock-model");
    recordEmptyStrike("flock-model", "default-model");
    expect(monitor.emptyStrikes["flock-model:default-model"]).toBe(1);
  });

  it("should get health metrics", () => {
    const monitor = getHealthMonitor("flock-model");
    const health = monitor.getHealth();
    expect(health.status).toBe("healthy");
    expect(health.latencyMs).toBe(50);
    expect(health.failureCount).toBe(0);
    expect(health.isOpen).toBe(false);
  });

  it("should reset health after a restart", () => {
    const monitor = getHealthMonitor("flock-model");
    recordEmptyStrike("flock-model", "default-model");
    expect(monitor.emptyStrikes["flock-model:default-model"]).toBe(1);
    monitor.reset();
    expect(monitor.emptyStrikes["flock-model:default-model"]).toBe(0);
    expect(monitor.getHealth()).toMatchObject({
      status: "healthy",
      latencyMs: 50,
      failureCount: 0,
      isOpen: false,
    });
  });

  it("should build a circuit snapshot", () => {
    const snapshot = buildCircuitSnapshot("closed", 5, 120.5, 1000);
    expect(snapshot.state).toBe("closed");
    expect(snapshot.failureCount).toBe(5);
    expect(snapshot.avgLatencyMs).toBe(120.5);
    expect(snapshot.lastFailureMs).toBe(1000);
    expect(snapshot.isOpen).toBe(false);
  });
});
