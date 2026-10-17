/**
 * flock/ts/policy — bun test suite.
 *
 * Covers: Elo rating math + bench-prior seeding semantics, quarantine
 * circuit policy, warm-standby auth behavior, health analytics aggregation.
 */
import { describe, test, expect } from "bun:test";
import { EloEngine, MemoryEloStore, loadBenchPriors, BASE_ELO } from "./elo.ts";
import {
  CircuitPolicy,
  QUARANTINE_BASE_S,
  type HealingEvent,
} from "./circuit.ts";
import { WarmStandby } from "./warm-standby.ts";
import { PolicyHealthDB } from "./health.ts";

// ---------------------------------------------------------------------------
// elo.ts
// ---------------------------------------------------------------------------
describe("elo", () => {
  test("outcome updates: +16 win, -8 ratelimit, -32 fail, floor 100", () => {
    const e = new EloEngine();
    e.recordOutcome("p", 200, 100);
    expect(e.get("p")).toBe(BASE_ELO + 16);
    e.recordOutcome("p", 429, 100);
    expect(e.get("p")).toBe(BASE_ELO + 16 - 8);
    e.recordOutcome("p", 500, 100);
    expect(e.get("p")).toBe(BASE_ELO + 16 - 8 - 32);
    for (let i = 0; i < 100; i++) e.recordOutcome("p", 500, 100);
    expect(e.get("p")).toBe(100);
  });

  test("latency EMA: first success seeds, alpha 0.2 blends", () => {
    const e = new EloEngine();
    e.recordOutcome("p", 200, 1000);
    expect(e.latencyEma("p")).toBe(1000);
    e.recordOutcome("p", 200, 2000);
    expect(e.latencyEma("p")).toBeCloseTo(1000 * 0.8 + 2000 * 0.2, 6);
    // failures do not move the EMA
    e.recordOutcome("p", 500, 9999);
    expect(e.latencyEma("p")).toBeCloseTo(1200, 6);
  });

  test("candidateScore penalizes chronic slowness", () => {
    const e = new EloEngine();
    e.recordOutcome("fast", 200, 100);
    e.recordOutcome("slow", 200, 17000);
    expect(e.candidateScore("fast")).toBeGreaterThan(e.candidateScore("slow"));
    // 17s EMA -> -340pts
    expect(e.candidateScore("slow")).toBeCloseTo(e.get("slow") - 340, 0);
  });

  test("startup seeding: stored values restore protected, priors fill memory-only", () => {
    const store = new MemoryEloStore();
    store.save("learned", 1150);
    const e = new EloEngine(store);
    const r = e.applyBenchPriors(["learned", "fresh"], { learned: 1100, fresh: 1080 }, 1, "test", true);
    expect(r.restored).toEqual(["learned"]);
    expect(r.reseeded).toEqual(["fresh"]);
    expect(e.get("learned")).toBe(1150);
    expect(e.get("fresh")).toBe(1080);
    // in-memory-only: the fresh prior must NOT be in the store
    expect(store.load()["fresh"]).toBeUndefined();
    expect(e.isPersisted("learned")).toBe(true);
    expect(e.isPersisted("fresh")).toBe(false);
  });

  test("hot-reload: persisted and live-touched providers never re-seed", () => {
    const store = new MemoryEloStore();
    const e = new EloEngine(store);
    e.applyBenchPriors(["a", "b", "c"], { a: 1100, b: 1080, c: 1070 }, 1, "v1", true);
    // "a" learns from live traffic
    e.recordOutcome("a", 200, 100);
    // "b" stays untouched at its prior
    const r = e.applyBenchPriors(["a", "b", "c"], { a: 1111, b: 1099, c: 1099 }, 2, "v2", false);
    expect(r.reloaded).toBe(true);
    expect(e.get("a")).toBe(1100 + 16); // live value kept
    expect(e.get("b")).toBe(1099); // untouched -> re-seeded
    expect(e.get("c")).toBe(1099); // untouched -> re-seeded
    // same mtime -> no reload
    const r2 = e.applyBenchPriors(["a"], { a: 1200 }, 2, "v2", false);
    expect(r2.reloaded).toBe(false);
  });

  test("hot-reload protects a restored value that numerically equals the prior", () => {
    const store = new MemoryEloStore();
    store.save("p", 1100);
    const e = new EloEngine(store);
    e.applyBenchPriors(["p"], { p: 1100 }, 1, "v1", true);
    const r = e.applyBenchPriors(["p"], { p: 9999 }, 2, "v2", false);
    expect(e.get("p")).toBe(1100); // NOT 9999
    expect(r.reseeded).toEqual([]);
  });

  test("loadBenchPriors fails open on missing file", () => {
    const r = loadBenchPriors("/tmp/policy-build/nope-missing.json");
    expect(r.priors).toEqual({});
    expect(r.source).toBe("missing");
  });
});

// ---------------------------------------------------------------------------
// circuit.ts
// ---------------------------------------------------------------------------
describe("circuit", () => {
  test("3 consecutive failures open with base backoff", () => {
    const c = new CircuitPolicy();
    c.recordOutcome("p", "m", 500, 1000);
    c.recordOutcome("p", "m", 500, 1001);
    expect(c.circuitState("p")).toBe("closed");
    c.recordOutcome("p", "m", 500, 1002);
    expect(c.circuitState("p")).toBe("open");
    const info = c.circuitInfo("p", 1002);
    expect(info.quarantine_level).toBe(1);
    expect(info.backoff_s).toBe(QUARANTINE_BASE_S);
    expect(c.circuitOk("p", 1002)).toBe(false);
  });

  test("401/402 dead key opens after a single attempt (3x counting)", () => {
    const c = new CircuitPolicy();
    c.recordOutcome("p", "m", 401, 1000);
    expect(c.circuitState("p")).toBe("open");
    expect(c.consecutiveFailures("p")).toBe(3);
  });

  test("429s count but never open the circuit", () => {
    const c = new CircuitPolicy();
    for (let i = 0; i < 10; i++) c.recordOutcome("p", "m", 429, 1000 + i);
    expect(c.circuitState("p")).toBe("closed");
    expect(c.consecutiveFailures("p")).toBe(10);
  });

  test("expired backoff half-opens; probe success closes", () => {
    const c = new CircuitPolicy();
    c.recordOutcome("p", "m", 500, 1000);
    c.recordOutcome("p", "m", 500, 1000);
    c.recordOutcome("p", "m", 500, 1000);
    expect(c.circuitOk("p", 1000 + QUARANTINE_BASE_S + 1)).toBe(true);
    expect(c.circuitState("p")).toBe("half");
    c.recordOutcome("p", "m", 200, 1061);
    expect(c.circuitState("p")).toBe("closed");
    expect(c.consecutiveFailures("p")).toBe(0);
  });

  test("backoff doubles per quarantine level", () => {
    const c = new CircuitPolicy();
    c.recordOutcome("p", "m", 500, 1000);
    c.recordOutcome("p", "m", 500, 1000);
    c.recordOutcome("p", "m", 500, 1000); // level 1 -> 60s
    c.escalateQuarantine("p", "probe failed", 1000);
    const info = c.circuitInfo("p", 1000);
    expect(info.quarantine_level).toBe(2);
    expect(info.backoff_s).toBe(QUARANTINE_BASE_S * 2);
  });

  test("recordProbe moves circuits without Elo side effects", () => {
    const events: HealingEvent[] = [];
    const c = new CircuitPolicy({ onHealing: (e) => events.push(e) });
    c.recordProbe("p", false, "warm-standby http_500", 1000);
    c.recordProbe("p", false, "warm-standby http_500", 1001);
    c.recordProbe("p", false, "warm-standby http_500", 1002);
    expect(c.circuitState("p")).toBe("open");
    expect(events.some((e) => e.event === "circuit_opened")).toBe(true);
    // success on half closes
    c.halfOpen("p");
    c.recordProbe("p", true, "", 2000);
    expect(c.circuitState("p")).toBe("closed");
    expect(events.some((e) => e.event === "circuit_recovered")).toBe(true);
  });

  test("laneDead: 6+ failures no success within 10 min; success resets", () => {
    const c = new CircuitPolicy();
    // 429s never open the circuit but count toward laneDead
    for (let i = 0; i < 6; i++) c.recordOutcome("p", "m", 429, 1000 + i);
    expect(c.laneDead("p", 1100)).toBe(true);
    expect(c.circuitState("p")).toBe("closed");
    c.recordOutcome("p", "m", 200, 1101);
    expect(c.laneDead("p", 1102)).toBe(false);
    // expiry 10 min after the LAST failure (t=1005 in this loop)
    for (let i = 0; i < 6; i++) c.recordOutcome("q", "m", 504, 1000 + i);
    expect(c.laneDead("q", 1000 + 599)).toBe(true);
    expect(c.laneDead("q", 1005 + 601)).toBe(false);
  });

  test("entitlement 404 benches the model id once, re-admits on relist", () => {
    let catalogHas = false;
    const c = new CircuitPolicy({ catalogServes: () => catalogHas });
    c.recordOutcome("p", "dead-model", 404, 1000);
    expect(c.isEntitlementDead("p", "dead-model")).toBe(true);
    expect(c.isEntitlementDead("p", "other-model")).toBe(false);
    // provider itself only took a +1 strike — still closed
    expect(c.circuitState("p")).toBe("closed");
    catalogHas = true;
    expect(c.isEntitlementDead("p", "dead-model")).toBe(false);
  });

  test("flap tracker benches after 3 empty strikes, decays after window", () => {
    const c = new CircuitPolicy();
    c.recordEmpty("p", "m", 1000);
    c.recordEmpty("p", "m", 1001);
    expect(c.flapBanned("p", "m", 1002)).toBe(false);
    c.recordEmpty("p", "m", 1002);
    expect(c.flapBanned("p", "m", 1003)).toBe(true);
    expect(c.flapBanned("p", "m", 1003 + 601)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// warm-standby.ts
// ---------------------------------------------------------------------------
describe("warm-standby", () => {
  test("attaches Bearer key for keyed providers, skips when key missing", async () => {
    const seen: Record<string, string>[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        seen.push(Object.fromEntries(req.headers.entries()));
        return Response.json({ object: "list", data: [] });
      },
    });
    const base = `http://127.0.0.1:${server.port}/v1`;
    try {
      const outcomes: [string, boolean, string][] = [];
      process.env.TAWNY_TEST_KEY = "sekrit";
      const warm = new WarmStandby(
        [
          { name: "keyed", base, keyEnv: "TAWNY_TEST_KEY" },
          { name: "keyless-skipped", base, keyEnv: "TAWNY_MISSING_KEY" },
          { name: "open", base },
        ],
        { onProbe: (p, ok, err) => outcomes.push([p, ok, err]) },
      );
      await warm.tick();
      const byName = Object.fromEntries(outcomes.map(([p, ok, err]) => [p, { ok, err }]));
      expect(byName["keyed"].ok).toBe(true);
      expect(byName["open"].ok).toBe(true);
      // keyed-but-keyless is skipped, never probed (no 401 strike)
      expect(byName["keyless-skipped"]).toBeUndefined();
      const authd = seen.find((h) => h["authorization"] === "Bearer sekrit");
      expect(authd).toBeDefined();
    } finally {
      delete process.env.TAWNY_TEST_KEY;
      server.stop(true);
    }
  });

  test("failed probe reports ok=false with error", async () => {
    const outcomes: [string, boolean, string][] = [];
    const warm = new WarmStandby(
      [{ name: "dead", base: "http://127.0.0.1:1/v1" }],
      { probeTimeoutMs: 500, onProbe: (p, ok, err) => outcomes.push([p, ok, err]) },
    );
    await warm.tick();
    expect(outcomes.length).toBe(1);
    expect(outcomes[0][1]).toBe(false);
    expect(outcomes[0][2].length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// health.ts
// ---------------------------------------------------------------------------
describe("health", () => {
  test("provider summary aggregates windows: success rate, latency, rate limits", () => {
    const db = new PolicyHealthDB(":memory:");
    db.recordRequest("p", "m1", 200, 100);
    db.recordRequest("p", "m1", 200, 300);
    db.recordRequest("p", "m2", 500, 50);
    db.recordRequest("p", "m2", 429, 10);
    const s = db.getProviderSummary();
    expect(s["p"].successes).toBe(2);
    expect(s["p"].failures).toBe(1);
    expect(s["p"].success_rate).toBeCloseTo(2 / 3, 3);
    expect(s["p"].rate_limited).toBe(1);
    expect(s["p"].avg_latency_ms).not.toBeNull();
  });

  test("latency percentiles read successful requests only", () => {
    const db = new PolicyHealthDB(":memory:");
    for (let i = 1; i <= 10; i++) db.recordRequest("p", "m", 200, i * 10);
    db.recordRequest("p", "m", 500, 99999);
    const pct = db.getLatencyPercentiles();
    expect(pct["p"].n).toBe(10);
    expect(pct["p"].p50_ms).toBe(60);
    expect(pct["p"].p95_ms).toBe(100);
  });

  test("sticky affinity round-trips", () => {
    const db = new PolicyHealthDB(":memory:");
    expect(db.stickyGet("s1")).toEqual([null, null]);
    db.stickySet("s1", "p", "m");
    expect(db.stickyGet("s1")).toEqual(["p", "m"]);
  });

  test("healing feed records circuit transitions", () => {
    const db = new PolicyHealthDB(":memory:");
    db.recordHealing("p", "m", "circuit_opened", "closed", "open", "3 failures");
    const rows = db.recentHealing("p") as { event: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0].event).toBe("circuit_opened");
  });

  test("elo_state round-trips through the EloStore adapter", () => {
    const db = new PolicyHealthDB(":memory:");
    const store = db.asEloStore();
    store.save("p", 1123.5);
    expect(store.load()["p"]).toBe(1123.5);
    const e = new EloEngine(store);
    const r = e.applyBenchPriors(["p", "q"], { p: 1000, q: 1080 }, 1, "test", true);
    expect(e.get("p")).toBe(1123.5);
    expect(r.restored).toEqual(["p"]);
    expect(r.reseeded).toEqual(["q"]);
  });
});
