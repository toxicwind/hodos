/**
 * Port of herd/internal/astmatrix/ratelimit_test.go (Go) to bun:test.
 */
import { describe, expect, test } from "bun:test";
import {
  PerProviderRateLimiter,
  newRateLimiter,
  parseRateLimitReset,
  parseRetryAfter,
} from "../src/ratelimit.ts";

describe("PerProviderRateLimiter construction", () => {
  test("defaults", () => {
    const rl = newRateLimiter();
    expect(rl).toBeDefined();
    expect(rl.windowDuration).toBe(60_000);
    expect(rl.maxRequests).toBe(200);
    expect(rl.minBackoff).toBe(5_000);
    expect(rl.maxBackoff).toBe(120_000);
    expect(rl.backoffFactor).toBe(2.0);
    expect(rl.gpuThrottlePct).toBe(90.0);
  });
});

describe("canRequest / record limits", () => {
  test("initially true", () => {
    expect(newRateLimiter().canRequest("test-provider")).toBe(true);
  });

  test("false when over limit", () => {
    const rl = newRateLimiter();
    rl.maxRequests = 2;
    rl.windowDuration = 3_600_000; // freeze the rolling window
    expect(rl.canRequest("p")).toBe(true);
    rl.recordRequest("p");
    expect(rl.canRequest("p")).toBe(true);
    rl.recordRequest("p");
    expect(rl.canRequest("p")).toBe(false);
  });

  test("passes after window expiry", async () => {
    const rl = newRateLimiter();
    rl.maxRequests = 1;
    rl.windowDuration = 30;
    rl.recordRequest("p");
    expect(rl.canRequest("p")).toBe(false); // immediately blocked
    await Bun.sleep(40);
    expect(rl.canRequest("p")).toBe(true);
  });
});

describe("429 backoff", () => {
  test("record429 sets backoff", () => {
    const rl = newRateLimiter();
    rl.minBackoff = 3_600_000; // will never expire in test
    rl.record429("p", 0);
    expect(rl.canRequest("p")).toBe(false);
  });

  test("respects server retry-after", () => {
    const rl = newRateLimiter();
    rl.minBackoff = 5;
    rl.record429("p", 100); // server says 100ms
    const remaining = rl.getBackoffRemaining("p");
    // Full jitter: sleep = random(0, max(minBackoff, retryAfter))
    expect(remaining).toBeLessThanOrEqual(105); // +slop for test timing
  });

  test("minBackoff floor with jitter", () => {
    const rl = newRateLimiter();
    rl.minBackoff = 50;
    rl.record429("p", 5); // server says 5ms < minBackoff
    const remaining = rl.getBackoffRemaining("p");
    expect(remaining).toBeLessThanOrEqual(55);
  });

  test("maxBackoff cap", () => {
    const rl = newRateLimiter();
    rl.minBackoff = 10;
    rl.maxBackoff = 100;
    rl.backoffFactor = 10.0;
    rl.record429("p", 0); // 10ms * 10 = 100ms, capped
    expect(rl.getBackoffRemaining("p")).toBeLessThanOrEqual(150);
  });

  test("exponential growth", async () => {
    const rl = newRateLimiter();
    rl.minBackoff = 10;
    rl.maxBackoff = 60_000;
    rl.backoffFactor = 2.0;

    rl.record429("p", 0); // 10ms * 2 = 20ms base
    const dur1 = rl.getBackoffDuration("p");
    expect(dur1).toBeGreaterThanOrEqual(15);
    expect(dur1).toBeLessThanOrEqual(25);

    const remaining = rl.getBackoffRemaining("p");
    await Bun.sleep(remaining + 10);
    expect(rl.canRequest("p")).toBe(true);

    rl.record429("p", 0); // preserved 20ms * 2 = 40ms base
    const dur2 = rl.getBackoffDuration("p");
    expect(dur2).toBeGreaterThanOrEqual(30);
    expect(dur2).toBeLessThanOrEqual(50);
  });

  test("retry-after preserves exponential state", async () => {
    const rl = newRateLimiter();
    rl.minBackoff = 10;
    rl.maxBackoff = 60_000;
    rl.backoffFactor = 2.0;

    rl.record429("p", 5); // server 5ms, minBackoff 10ms floor
    const b1 = rl.getBackoffRemaining("p");
    await Bun.sleep(b1 + 5);

    rl.record429("p", 0); // preserved minBackoff * 2 = 20ms
    const b2 = rl.getBackoffRemaining("p");
    expect(b2).toBeLessThanOrEqual(25);
    expect(rl.getBackoffDuration("p")).toBeGreaterThanOrEqual(15);
  });
});

describe("success resets", () => {
  test("recordSuccess clears backoff", () => {
    const rl = newRateLimiter();
    rl.minBackoff = 3_600_000;
    rl.record429("p", 0);
    rl.recordSuccess("p");
    expect(rl.canRequest("p")).toBe(true);
  });

  test("getBackoffRemaining zero after reset", () => {
    const rl = newRateLimiter();
    rl.minBackoff = 3_600_000;
    rl.record429("p", 0);
    rl.recordSuccess("p");
    expect(rl.getBackoffRemaining("p")).toBe(0);
  });
});

describe("provider isolation", () => {
  test("rate isolation", () => {
    const rl = newRateLimiter();
    rl.maxRequests = 1;
    rl.windowDuration = 3_600_000;
    rl.recordRequest("nvidia");
    expect(rl.canRequest("nvidia")).toBe(false);
    expect(rl.canRequest("openrouter")).toBe(true);
  });

  test("backoff isolation", () => {
    const rl = newRateLimiter();
    rl.minBackoff = 3_600_000;
    rl.record429("nvidia", 0);
    expect(rl.canRequest("openrouter")).toBe(true);
  });
});

describe("recordRequest accounting", () => {
  test("increments count", () => {
    const rl = newRateLimiter();
    rl.windowDuration = 3_600_000;
    for (let i = 0; i < 5; i++) rl.recordRequest("p");
    expect(rl.getTimestamps("p")).toHaveLength(5);
  });

  test("prunes expired", async () => {
    const rl = newRateLimiter();
    rl.windowDuration = 50;
    rl.recordRequest("p");
    await Bun.sleep(60);
    rl.recordRequest("p");
    rl.canRequest("p"); // triggers prune
    expect(rl.getTimestamps("p")).toHaveLength(1);
  });
});

describe("parseRetryAfter", () => {
  test("seconds", () => {
    expect(parseRetryAfter("60")).toBe(60_000);
  });
  test("HTTP date", () => {
    const future = new Date(Date.now() + 30_000).toUTCString();
    const d = parseRetryAfter(future);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThanOrEqual(60_000);
  });
  test("empty", () => {
    expect(parseRetryAfter("")).toBe(0);
  });
  test("invalid", () => {
    expect(parseRetryAfter("not-a-date-or-number")).toBe(0);
  });
});

describe("parseRateLimitReset", () => {
  test("epoch seconds", () => {
    const future = Math.floor((Date.now() + 30_000) / 1000);
    const d = parseRateLimitReset(String(future));
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThanOrEqual(60_000);
  });
  test("epoch millis", () => {
    const future = Date.now() + 30_000;
    const d = parseRateLimitReset(String(future));
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThanOrEqual(60_000);
  });
  test("empty", () => {
    expect(parseRateLimitReset("")).toBe(0);
  });
  test("negative", () => {
    expect(parseRateLimitReset("-1")).toBe(0);
  });
});

describe("concurrency / edge", () => {
  test("concurrent requests don't corrupt state", async () => {
    const rl = newRateLimiter();
    await Promise.all([
      (async () => {
        for (let i = 0; i < 100; i++) {
          rl.recordRequest("p");
          rl.canRequest("p");
        }
      })(),
      (async () => {
        for (let i = 0; i < 100; i++) {
          rl.record429("p", 0);
          rl.recordSuccess("p");
        }
      })(),
    ]);
    // No assertion beyond "did not throw" — mirrors the Go test.
    expect(true).toBe(true);
  });
});
