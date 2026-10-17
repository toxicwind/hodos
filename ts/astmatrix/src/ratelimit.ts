/**
 * astmatrix-ts — per-provider rate limiting with exponential backoff.
 * Port of herd/internal/astmatrix/ratelimit.go (Go) to Bun/TypeScript.
 *
 * Tracks request rates per provider and implements exponential backoff
 * when 429s are received from upstream APIs (notably NVIDIA NIM which
 * returns 429 with no body when rate-limited).
 *
 * Note: Bun is single-threaded — no mutex needed (Go's sync.Mutex elided).
 */
import { execFileSync } from "node:child_process";

export class PerProviderRateLimiter {
  // per-provider state
  private requestTimestamps = new Map<string, number[]>(); // rolling window (epoch ms)
  private backoffUntil = new Map<string, number>(); // epoch ms; provider prohibited until then
  private backoffDuration = new Map<string, number>(); // current backoff ms (exponential)
  private rateLimitCount = new Map<string, number>(); // consecutive 429 count

  // GPU memory pressure (nvidia-smi) — when VRAM is tight, NIM may throttle
  private lastGpuCheck = 0;
  private gpuFreeMB = 0;
  private gpuTotalMB = 0;

  // configuration (ms)
  windowDuration = 60_000; // rolling window (default: 60s)
  maxRequests = 200; // max requests per window (higher limit for non-NVIDIA)
  minBackoff = 5_000; // initial backoff (default: 5s)
  maxBackoff = 120_000; // max backoff (default: 120s)
  backoffFactor = 2.0; // exponential factor (default: 2.0)
  gpuThrottlePct = 90.0; // GPU mem threshold % that triggers backoff

  /** True if the provider can accept a request right now. */
  canRequest(provider: string): boolean {
    const now = Date.now();

    // Check active backoff
    const until = this.backoffUntil.get(provider);
    if (until !== undefined) {
      if (now < until) return false;
      // backoff expired naturally — keep backoffDuration so exponential
      // growth persists across consecutive 429s
      this.backoffUntil.delete(provider);
    }

    // Prune old timestamps
    const cutoff = now - this.windowDuration;
    const ts = this.requestTimestamps.get(provider);
    if (ts) this.requestTimestamps.set(provider, ts.filter((t) => t > cutoff));

    // Check if within limit
    if ((this.requestTimestamps.get(provider)?.length ?? 0) >= this.maxRequests) return false;

    // Check GPU memory pressure for NVIDIA NIM (cached, 10s TTL)
    if (provider === "nvidia") {
      if (now - this.lastGpuCheck > 10_000) this.checkGpuMemory();
      if (this.gpuTotalMB > 0) {
        const freePct = (this.gpuFreeMB / this.gpuTotalMB) * 100.0;
        if (freePct < 100.0 - this.gpuThrottlePct) return false;
      }
    }
    return true;
  }

  /** Record that a request was made to the provider. */
  recordRequest(provider: string): void {
    const ts = this.requestTimestamps.get(provider) ?? [];
    ts.push(Date.now());
    this.requestTimestamps.set(provider, ts);
  }

  /** Record a 429 with optional retry-after duration (ms). */
  record429(provider: string, retryAfterMs: number): void {
    this.rateLimitCount.set(provider, (this.rateLimitCount.get(provider) ?? 0) + 1);

    let backoff: number;
    if (retryAfterMs > 0) {
      backoff = retryAfterMs;
      if (backoff < this.minBackoff) backoff = this.minBackoff;
      // Don't reset backoffDuration to minBackoff — preserve existing
      // exponential backoff state
      if ((this.backoffDuration.get(provider) ?? 0) <= 0) {
        this.backoffDuration.set(provider, this.minBackoff);
      }
    } else {
      let existing = this.backoffDuration.get(provider) ?? 0;
      if (existing <= 0) existing = this.minBackoff;
      backoff = existing * this.backoffFactor;
      if (backoff > this.maxBackoff) backoff = this.maxBackoff;
      this.backoffDuration.set(provider, backoff);
    }

    // Full jitter (AWS/GCF best practice): sleep = random(0, backoff)
    const jitter = Math.floor(Math.random() * backoff);
    this.backoffUntil.set(provider, Date.now() + jitter);
  }

  /** Reset backoff for a provider after a successful request. */
  recordSuccess(provider: string): void {
    this.backoffUntil.delete(provider);
    this.backoffDuration.delete(provider);
    this.rateLimitCount.set(provider, 0);
  }

  /** Run nvidia-smi to get current VRAM stats. */
  private checkGpuMemory(): void {
    this.lastGpuCheck = Date.now();
    try {
      const out = execFileSync(
        "nvidia-smi",
        ["--query-gpu=memory.free,memory.total", "--format=csv,noheader,nounits"],
        { timeout: 5000, encoding: "utf8" },
      );
      const parts = out.trim().split(",");
      if (parts.length < 2) return;
      const free = parseInt(parts[0].trim(), 10);
      const total = parseInt(parts[1].trim(), 10);
      if (!isNaN(free) && !isNaN(total) && total > 0) {
        this.gpuFreeMB = free;
        this.gpuTotalMB = total;
      }
    } catch {
      // nvidia-smi missing or failed — leave previous values
    }
  }

  /** Remaining backoff for a provider (ms), 0 when none. */
  getBackoffRemaining(provider: string): number {
    const until = this.backoffUntil.get(provider);
    if (until !== undefined) {
      const remaining = until - Date.now();
      if (remaining > 0) return remaining;
    }
    return 0;
  }

  getGPUFreeMB(): number {
    return this.gpuFreeMB;
  }

  /** Test hook: current exponential backoff duration (ms) for a provider. */
  getBackoffDuration(provider: string): number {
    return this.backoffDuration.get(provider) ?? 0;
  }

  /** Test hook: raw request timestamps for a provider. */
  getTimestamps(provider: string): number[] {
    return [...(this.requestTimestamps.get(provider) ?? [])];
  }
}

/** Factory with NVIDIA-NIM-sensible defaults. */
export function newRateLimiter(): PerProviderRateLimiter {
  return new PerProviderRateLimiter();
}

/** Parse Retry-After: seconds ("60") or HTTP-date. Returns ms. */
export function parseRetryAfter(val: string): number {
  if (!val) return 0;
  const seconds = parseInt(val.trim(), 10);
  if (!isNaN(seconds) && seconds > 0 && /^\d+$/.test(val.trim())) {
    return seconds * 1000;
  }
  const t = Date.parse(val);
  if (!isNaN(t)) {
    const dur = t - Date.now();
    if (dur > 0) return dur;
  }
  return 0;
}

/** Parse X-RateLimit-Reset: epoch seconds or ms. Returns ms until reset. */
export function parseRateLimitReset(val: string): number {
  if (!val) return 0;
  const ts = parseInt(val.trim(), 10);
  if (isNaN(ts)) return 0;
  const t = ts > 1e12 ? ts : ts * 1000;
  const dur = t - Date.now();
  return dur > 0 ? dur : 0;
}
