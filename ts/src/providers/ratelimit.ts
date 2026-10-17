/**
 * Per-key sliding window rate limiter.
 *
 * Tracks request timestamps per key within a sliding window.
 * Allows request if count within window < capacity (requests per window).
 *
 * This is a standalone rate limiter that can be used to check if a key
 * is available before making a request, complementary to the Pool which
 * handles key rotation and reservation.
 */
import type { ProviderDef } from "./catalog";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Windowed counter for a single key. */
type KeyCounter = {
  key: string;
  /** Requests per window (e.g., 60 for 60 RPM). */
  capacity: number;
  /** Window size in milliseconds. */
  windowMs: number;
  /** Timestamps of requests within the window. */
  timestamps: number[];
};

/** Global store of key counters. */
const keyCounters = new Map<string, KeyCounter>();

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reset all tracked key counters (for test isolation).
 */
export function resetAllCounters(): void {
  keyCounters.clear();
}

/**
 * Check if a key is allowed to make a request.
 * Returns true if allowed, false if rate limited.
 *
 * @param key - The key identifier (e.g., API key or provider name)
 * @param rpm - Requests per minute allowed for this key
 * @param windowMs - Window size in milliseconds (default 60_000 for 60s)
 * @returns true if request is allowed
 */
export function keyAllows(
  key: string,
  rpm: number,
  windowMs: number = 60_000
): boolean {
  if (rpm <= 0) return true; // No limit
  
  let counter = keyCounters.get(key);
  if (!counter) {
    counter = {
      key,
      capacity: rpm,
      windowMs,
      timestamps: [],
    };
    keyCounters.set(key, counter);
  }

  const now = Date.now();
  
  // Remove timestamps outside the window
  while (
    counter.timestamps.length > 0 &&
    now - counter.timestamps[0] >= counter.windowMs
  ) {
    counter.timestamps.shift();
  }

  // Check if we're under the limit
  if (counter.timestamps.length < counter.capacity) {
    counter.timestamps.push(now);
    return true;
  } else {
    return false;
  }
}

/**
 * Get the current usage for a key (number of requests in window).
 */
export function keyUsage(
  key: string,
  windowMs: number = 60_000
): number {
  const counter = keyCounters.get(key);
  if (!counter) return 0;

  const now = Date.now();
  
  // Count timestamps within the window
  let count = 0;
  for (let i = counter.timestamps.length - 1; i >= 0; i--) {
    if (now - counter.timestamps[i] < windowMs) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

/**
 * Get the number of requests allowed in the current window.
 */
export function keyRemaining(
  key: string,
  rpm: number,
  windowMs: number = 60_000
): number {
  const used = keyUsage(key, windowMs);
  return Math.max(0, rpm - used);
}

/**
 * Reset the rate limit counter for a key (e.g., after a key change).
 */
export function resetKey(key: string): void {
  keyCounters.delete(key);
}

/**
 * Get all tracked keys (for debugging/monitoring).
 */
export function trackedKeys(): string[] {
  return Array.from(keyCounters.keys());
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider-specific helper (if needed by other modules)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a provider's key is allowed based on the provider's config.
 * This uses the first enabled key's effective RPM.
 */
export function providerAllows(
  provider: ProviderDef,
  keyIndex: number = 0
): boolean {
  const key = provider.keys[keyIndex];
  if (!key || !key.enabled) return false;
  
  // Use the key's rpm if set, otherwise fall back to provider default
  const effectiveRpm = key.rpm || provider.defaultRpm || 60;
  
  // Check if we have key material (key or keyEnv with value)
  const hasKeyMaterial = key.key && key.key.trim() !== "" 
    || key.keyEnv && key.keyEnv.trim() !== "";
  
  if (!hasKeyMaterial) return false;
  
  // Create a temporary key object for keyAllows
  // Use the key's key or keyEnv value as the identifier
  const keyIdentifier = key.key || key.keyEnv || "";
  
  return keyAllows(keyIdentifier, effectiveRpm);
}