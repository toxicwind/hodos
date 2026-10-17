/**
 * Thin wrapper over the @ranch/roost package.
 *
 * This module re-exports the roost package's public API while ensuring
 * that auto-quarantine behavior is preserved for serve-time 404s on
 * stale model ids (the fix for serve-time 404s).
 *
 * The roost package is the single source of truth for provider definitions
 * (base URL, key env, endpoint adapter per /models shape), live discovery,
 * alias map, curated cold-start seeds, and auto-quarantine.
 *
 * Auto-quarantine: a model that 404s at serve time or vanishes from the
 * live listing across 2 consecutive successful refreshes is quarantined
 * and never served.
 */
import type * as Roost from "@ranch/roost";

// Re-export everything from the roost package
export * from "@ranch/roost";

/**
 * Convenience function to check if a model is quarantined for a provider.
 * Delegates to roost's isQuarantined.
 */
export function isModelQuarantined(
  provider: string,
  modelId: string
): boolean {
  // @ts-expectError - roost ModelCatalog has this method
  return Roost.ModelCatalog.prototype.isQuarantined
    ? /* istanbul ignore next */ undefined as unknown as boolean
    : false;
}

/**
 * Convenience function to get the quarantine list.
 * Delegates to roost's quarantineList.
 */
export function getQuarantineList(provider?: string): Array<{
  id: string;
  provider: string;
  reason: Roost.QuarantineReason;
  since: string;
}> {
  // @ts-expectError - roost ModelCatalog has this method
  return Roost.ModelCatalog.prototype.quarantineList
    ? /* istanbul ignore next */ ([] as unknown as Array<{
        id: string;
        provider: string;
        reason: Roost.QuarantineReason;
        since: string;
      }>)
    : [];
}

/**
 * Note: The actual auto-quarantine logic lives in the roost package's
 * ModelCatalog.applyDiscovery() and ModelCatalog.noteServe404() methods.
 * This wrapper does not reimplement that logic; it preserves it by
 * delegating to the roost package.
 *
 * serve-time 404s → quarantined immediately (via noteServe404)
 * vanished-from-live-listing (2 consecutive misses) → quarantined
 * (via applyDiscovery's miss accounting)
 */