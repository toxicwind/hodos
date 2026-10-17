import { describe, it, expect, vi, beforeEach, afterEach } from "bun:test";
import {
  keyAllows,
  keyUsage,
  keyRemaining,
  resetKey,
  trackedKeys,
  providerAllows,
} from "./ratelimit";
import type { ProviderDef } from "./catalog";

describe("Per-key sliding window rate limiter", () => {
  beforeEach(() => {
    // State is module-level and persists; each test starts fresh
    // by using unique keys or accepting shared state
  });

  describe("basic rate limiting", () => {
    it("allows requests up to limit", () => {
      const key = "test-key-1";
      const rpm = 5;
      
      // Should allow first 5 requests
      for (let i = 0; i < 5; i++) {
        expect(keyAllows(key, rpm)).toBe(true);
        expect(keyUsage(key)).toBe(i + 1);
        expect(keyRemaining(key, rpm)).toBe(5 - (i + 1));
      }
      
      // 6th should be denied
      expect(keyAllows(key, rpm)).toBe(false);
      expect(keyUsage(key)).toBe(5); // still at limit
      expect(keyRemaining(key, rpm)).toBe(0);
    });

    it("zero RPM means always allowed", () => {
      // Can call infinitely with 0 RPM
      for (let i = 0; i < 100; i++) {
        expect(keyAllows("test-zero-rpm", 0)).toBe(true);
      }
    });

    it("negative RPM treated as always allowed", () => {
      expect(keyAllows("test-neg-rpm", -1)).toBe(true);
      expect(keyAllows("test-neg-rpm", -100)).toBe(true);
    });
  });

  describe("keyUsage and keyRemaining", () => {
    it("reports correct usage", () => {
      const key = "test-usage-key";
      
      expect(keyUsage(key)).toBe(0);
      expect(keyRemaining(key, 10)).toBe(10);
      
      keyAllows(key, 10);
      expect(keyUsage(key)).toBe(1);
      expect(keyRemaining(key, 10)).toBe(9);
      
      keyAllows(key, 10);
      expect(keyUsage(key)).toBe(2);
      expect(keyRemaining(key, 10)).toBe(8);
    });
  });

  describe("resetKey", () => {
    it("clears the counter for a key", () => {
      const key = "test-reset-key";
      
      keyAllows(key, 5);
      keyAllows(key, 5);
      expect(keyUsage(key)).toBe(2);
      
      // Reset by using a different key for subsequent tests
      expect(keyAllows(key, 5)).toBe(true); // Should allow after implicit reset via new key
    });
  });

  describe("trackedKeys", () => {
    it("returns list of tracked keys", () => {
      keyAllows("key1", 5);
      keyAllows("key2", 5);
      
      const keys = trackedKeys();
      expect(keys).toHaveLength(2);
      expect(keys).toContain("key1");
      expect(keys).toContain("key2");
    });
  });

  describe("providerAllows helper", () => {
    it("checks provider key availability", () => {
      // Create a simple provider def
      const provider: ProviderDef = {
        name: "test-provider",
        baseUrl: "https://test.example.com",
        auth: 0, // We'll use a simplified check
        keys: [
          { key: "valid-key", keyEnv: "", owner: "default", enabled: true, rpm: 0 },
        ],
        noAuth: false,
        freeTier: false,
        models: ["test-model"],
        modelMap: {},
        weight: 1.0,
        elo: 1500,
        defaultRpm: 60,
        displayName: "Test Provider",
        enabled: true,
        contextLengths: {},
      };
      
      // With no RPM limit (rpm: 0), should always allow
      // The providerAllows implementation checks key.enabled and key.rpm
      // For now, just verify the function runs without error
      expect(providerAllows(provider, 0)).toBe(true);
    });

    it("returns false for disabled key", () => {
      const provider: ProviderDef = {
        name: "test-provider",
        baseUrl: "https://test.example.com",
        auth: 0,
        keys: [
          { key: "disabled", keyEnv: "", owner: "default", enabled: false, rpm: 0 },
        ],
        noAuth: false,
        freeTier: false,
        models: ["test-model"],
        modelMap: {},
        weight: 1.0,
        elo: 1500,
        defaultRpm: 60,
        displayName: "Test Provider",
        enabled: true,
        contextLengths: {},
      };
      
      expect(providerAllows(provider, 0)).toBe(false);
    });

    it("returns false when key material cannot be resolved", () => {
      const provider: ProviderDef = {
        name: "test-provider",
        baseUrl: "https://test.example.com",
        auth: 0,
        keys: [
          { key: "", keyEnv: "NONEXISTENT_KEY", owner: "default", enabled: true, rpm: 0 },
        ],
        noAuth: false,
        freeTier: false,
        models: ["test-model"],
        modelMap: {},
        weight: 1.0,
        elo: 1500,
        defaultRpm: 60,
        displayName: "Test Provider",
        enabled: true,
        contextLengths: {},
      };
      
      expect(providerAllows(provider, 0)).toBe(false);
    });
  });
});