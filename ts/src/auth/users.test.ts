import { describe, it, expect, beforeEach } from "bun:test";
import { 
  createAdmin,
  signSession,
  validateSession,
  noteFailure,
  isThrottled,
  admitPreAuthAttempt,
  admitPreAuthWork,
  clearScraperMemo,
  memoHit,
  memoize,
  cookie,
  resetThrottleWindow
} from "./users.ts";
import type { StoredConfig, User } from "./shared.ts";
import { Role, defaultStoredConfig } from "../config/schema.ts";

// Helper to create a StoredConfig with required methods
function createTestStore(): StoredConfig & { 
  user(username: string): User | undefined; 
  superuser(): User | undefined 
} {
  const store = defaultStoredConfig();
  // Create a new object with the store properties plus the methods
  return {
    ...store,
    user: (username: string) => store.users.find(u => u.username === username) || undefined,
    superuser: () => store.users.find(u => u.role === Role.Superuser) || undefined
  } as StoredConfig & { 
    user(username: string): User | undefined; 
    superuser(): User | undefined 
  };
}

describe("user store operations", () => {
  let admin: Admin;
  let store: StoredConfig & { 
    user(username: string): User | undefined; 
    superuser(): User | undefined 
  };

  beforeEach(() => {
    admin = createAdmin(false);
    store = createTestStore();
    // Add a test user
    const { hashPassword } = require("./tokens.ts");
    const hashed = hashPassword("testpass");
    store.users = [
      { 
        username: "testuser", 
        password_hash: hashed, 
        role: Role.User 
      },
      { 
        username: "superuser", 
        password_hash: hashPassword("adminpass"), 
        role: Role.Superuser 
      }
    ];
  });

  describe("Admin creation", () => {
    it("should create admin with random signing key", () => {
      expect(admin.signingKey.length).toBe(32);
      expect(typeof admin.trustProxy).toBe("boolean");
      expect(admin.throttle.windowStart).toBeGreaterThanOrEqual(0);
      expect(admin.throttle.failures).toBe(0);
      expect(admin.scraperMemo.size).toBe(0);
    });

    it("should create admin with trustProxy setting", () => {
      const trustedAdmin = createAdmin(true);
      expect(trustedAdmin.trustProxy).toBe(true);
      const untrustedAdmin = createAdmin(false);
      expect(untrustedAdmin.trustProxy).toBe(false);
    });
  });

  describe("session token operations", () => {
    it("should sign and validate session tokens", () => {
      const expiry = Math.floor(Date.now() / 1000) + 3600;
      const username = "testuser";
      const { hashPassword } = require("./tokens.ts");
      const passwordHash = hashPassword("testpass");
      
      const token = signSession(admin, expiry, username, passwordHash);
      const validated = validateSession(admin, token, store);
      
      expect(validated).toBe(username);
    });

    it("should reject expired tokens", () => {
      const expiry = Math.floor(Date.now() / 1000) - 10; // expired
      const username = "testuser";
      const { hashPassword } = require("./tokens.ts");
      const passwordHash = hashPassword("testpass");
      
      const token = signSession(admin, expiry, username, passwordHash);
      const validated = validateSession(admin, token, store);
      
      expect(validated).toBeUndefined();
    });

    it("should reject tokens for unknown users", () => {
      const expiry = Math.floor(Date.now() / 1000) + 3600;
      const username = "unknown";
      const { hashPassword } = require("./tokens.ts");
      const passwordHash = hashPassword("testpass");
      
      const token = signSession(admin, expiry, username, passwordHash);
      const validated = validateSession(admin, token, store);
      
      expect(validated).toBeUndefined();
    });

    it("should invalidate tokens when password changes", () => {
      const expiry = Math.floor(Date.now() / 1000) + 3600;
      const username = "testuser";
      const { hashPassword } = require("./tokens.ts");
      const oldHash = hashPassword("oldpass");
      const newHash = hashPassword("newpass");
      
      // Sign with old password
      const token = signSession(admin, expiry, username, oldHash);
      
      // Update password in store
      store.users = store.users.map(u => 
        u.username === username 
          ? { ...u, password_hash: newHash } 
          : u
      );
      
      const validated = validateSession(admin, token, store);
      expect(validated).toBeUndefined();
    });
  });

  describe("throttle operations", () => {
    it("should track failures and throttle after limit", () => {
      expect(isThrottled(admin)).toBe(false);
      
      // Record failures up to limit
      for (let i = 0; i < THROTTLE_MAX_FAILURES; i++) {
        const throttled = noteFailure(admin);
        expect(throttled).toBe(i === THROTTLE_MAX_FAILURES - 1);
      }
      
      // Should be throttled now
      expect(isThrottled(admin)).toBe(true);
    });

    it("should reset throttle window after expiry", () => {
      // Record some failures
      for (let i = 0; i < 5; i++) {
        noteFailure(admin);
      }
      
      expect(isThrottled(admin)).toBe(false); // Not throttled yet
      
      // Manually set window to old time
      admin.throttle.windowStart = Math.floor(Date.now() / 1000) - 70; // 70 seconds ago
      
      // Should reset window and clear failures
      resetThrottleWindow(admin.throttle);
      expect(admin.throttle.windowStart).toBeGreaterThan(Date.now() / 1000 - 10);
      expect(admin.throttle.failures).toBe(0);
    });

    it("should prevent new attempts when throttled", () => {
      // Exhaust throttle
      for (let i = 0; i < THROTTLE_MAX_FAILURES; i++) {
        noteFailure(admin);
      }
      
      expect(admitPreAuthAttempt(admin)).toBe(false);
      expect(isThrottled(admin)).toBe(true);
    });
  });

  describe("pre-auth work admission", () => {
    it("should admit work when not throttled", () => {
      const work = () => "work result";
      const result = admitPreAuthWork(admin, work);
      expect(result).toBe("work result");
    });

    it("should reject work when throttled", () => {
      // Exhaust throttle
      for (let i = 0; i < THROTTLE_MAX_FAILURES; i++) {
        noteFailure(admin);
      }
      
      const work = () => "should not run";
      const result = admitPreAuthWork(admin, work);
      expect(result).toBeNull();
      expect(isThrottled(admin)).toBe(true);
    });
  });

  describe("scraper memo operations", () => {
    it("should memoize and hit scraper credentials", () => {
      const cred = "user:pass";
      const username = "testuser";
      
      // Initially no hit
      expect(memoHit(admin, cred)).toBeUndefined();
      
      // Memoize the credential
      memoize(admin, cred, username);
      
      // Should now hit
      const hitUser = memoHit(admin, cred);
      expect(hitUser).toBe(username);
    });

    it("should return different users for different credentials", () => {
      const cred1 = "user1:pass1";
      const cred2 = "user2:pass2";
      const username1 = "user1";
      const username2 = "user2";
      
      memoize(admin, cred1, username1);
      memoize(admin, cred2, username2);
      
      expect(memoHit(admin, cred1)).toBe(username1);
      expect(memoHit(admin, cred2)).toBe(username2);
    });

    it("should clear memo on user changes", () => {
      const cred = "testuser:pass";
      const username = "testuser";
      
      memoize(admin, cred, username);
      expect(memoHit(admin, cred)).toBe(username);
      
      clearScraperMemo(admin);
      expect(memoHit(admin, cred)).toBeUndefined();
    });
  });

  describe("cookie operations", () => {
    it("should create cookie with correct attributes", () => {
      const token = "testtoken";
      const headers = {};
      const cookieStr = cookie(admin, headers, token, 3600);
      
      expect(cookieStr).toContain(`flock_session=${token}`);
      expect(cookieStr).toContain("HttpOnly");
      expect(cookieStr).toContain("SameSite=Strict");
      expect(cookieStr).toContain("Path=/");
      expect(cookieStr).toContain("Max-Age=3600");
      // Should not have Secure flag without trustProxy and https
      expect(cookieStr).not.toContain("Secure");
    });

    it("should add Secure flag when trustProxy and https", () => {
      const trustedAdmin = createAdmin(true);
      const headers = { "x-forwarded-proto": "https" };
      const token = "testtoken";
      const cookieStr = cookie(trustedAdmin, headers, token, 3600);
      
      expect(cookieStr).toContain("Secure");
    });

    it("should not add Secure flag without https", () => {
      const trustedAdmin = createAdmin(true);
      const headers = { "x-forwarded-proto": "http" };
      const token = "testtoken";
      const cookieStr = cookie(trustedAdmin, headers, token, 3600);
      
      expect(cookieStr).not.toContain("Secure");
    });
  });
});

// RFC 7914 test vectors for PBKDF2 (re-exported from tokens)
describe("PBKDF2 test vectors (RFC 7914) - from users.ts", () => {
  it("should match RFC 7914 test vectors", () => {
    // Import the re-exported function
    const { pbkdf2Sha256 } = require("./users.ts");
    
    // Test vector 1
    const dk1 = pbkdf2Sha256(
      new Uint8Array(Buffer.from("passwd")),
      new Uint8Array(Buffer.from("salt")),
      1
    );
    const hex1 = Array.from(dk1)
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
    expect(hex1).toBe("55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc");
    
    // Test vector 2
    const dk2 = pbkdf2Sha256(
      new Uint8Array(Buffer.from("Password")),
      new Uint8Array(Buffer.from("NaCl")),
      80_000
    );
    const hex2 = Array.from(dk2)
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
    expect(hex2).toBe("4ddcd8f60b98be21830cee5ef22701f9641a4418d04c0414aeff08876b34ab56");
  });
});