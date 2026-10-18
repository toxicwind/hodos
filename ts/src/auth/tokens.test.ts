import { describe, it, expect } from "bun:test";
import { 
  signSession, 
  parseAndValidateToken, 
  verifyPassword, 
  hashPassword, 
  pwFragment,
  cookieToken,
  identify,
  pbkdf2Sha256
} from "./tokens.ts";
import type { StoredConfig, User } from "./shared.ts";
import { Role, defaultStoredConfig } from "../config/schema.ts";

// Helper to create a StoredConfig with user method
function createTestStore(): StoredConfig & { user(username: string): User | undefined } {
  const store = defaultStoredConfig();
  // Create a new object with the store properties plus the user method
  return {
    ...store,
    user: (username: string) => store.users.find(u => u.username === username) || undefined
  } as StoredConfig & { user(username: string): User | undefined };
}

describe("token validation", () => {
  it("should hash and verify passwords correctly", () => {
    const password = "testpass123";
    const hashed = hashPassword(password);
    
    expect(typeof hashed).toBe("string");
    expect(hashed).toMatch(/^pbkdf2-sha256\d+\$[0-9a-f]+\$[0-9a-f]+$/);
    
    expect(verifyPassword(password, hashed)).toBe(true);
    expect(verifyPassword("wrongpass", hashed)).toBe(false);
  });

  it("should generate correct pw fragment", () => {
    const password = "testpass123";
    const hashed = hashPassword(password);
    const fragment = pwFragment(hashed);
    
    expect(typeof fragment).toBe("string");
    expect(fragment.length).toBe(8);
    expect(/^[0-9a-f]+$/.test(fragment)).toBe(true);
  });

  it("should sign and validate session tokens correctly", () => {
    const password = "testpass123";
    const hashed = hashPassword(password);
    const expiry = Math.floor(Date.now() / 1000) + 3600; // 1 hour in future
    const username = "testuser";
    
    const token = signSession(expiry, username, hashed);
    expect(typeof token).toBe("string");
    expect(token.split(".").length).toBe(4);
    
    const store = createTestStore();
    store.users = [{ username, password_hash: hashed, role: Role.User }];
    
    const result = parseAndValidateToken(token, store);
    expect(result).toEqual({ ok: true, username });
  });

  it("should reject expired tokens", () => {
    const password = "testpass123";
    const hashed = hashPassword(password);
    const expiry = Math.floor(Date.now() / 1000) - 10; // 10 seconds ago
    const username = "testuser";
    
    const token = signSession(expiry, username, hashed);
    
    const store = createTestStore();
    store.users = [{ username, password_hash: hashed, role: Role.User }];
    
    const result = parseAndValidateToken(token, store);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("token expired");
  });

  it("should reject tokens with invalid signature", () => {
    const password = "testpass123";
    const hashed = hashPassword(password);
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const username = "testuser";
    
    // Create token with wrong password hash
    const wrongHashed = hashPassword("wrongpass");
    const token = signSession(expiry, username, wrongHashed);
    
    const store = createTestStore();
    store.users = [{ username, password_hash: hashed, role: Role.User }];
    
    const result = parseAndValidateToken(token, store);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid token signature");
  });

  it("should reject tokens for unknown users", () => {
    const password = "testpass123";
    const hashed = hashPassword(password);
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const username = "unknownuser";
    
    const token = signSession(expiry, username, hashed);
    
    const store = createTestStore();
    store.users = [{ username: "otheruser", password_hash: hashed, role: Role.User }];
    
    const result = parseAndValidateToken(token, store);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("unknown user");
  });

  it("should invalidate sessions when password changes", () => {
    const oldPassword = "oldpass";
    const newPassword = "newpass";
    const oldHashed = hashPassword(oldPassword);
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const username = "testuser";
    
    // Create token with old password
    const token = signSession(expiry, username, oldHashed);
    
    const store = createTestStore();
    store.users = [{ username, password_hash: hashPassword(newPassword), role: Role.User }];
    
    const result = parseAndValidateToken(token, store);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("password changed; session invalidated");
  });

  it("should extract cookie from headers", () => {
    const token = "testtoken123";
    const headers = { 
      cookie: `flock_session=${token}; path=/; other=value`,
      "user-agent": "test"
    };
    
    const extracted = cookieToken(headers);
    expect(extracted).toBe(token);
  });

  it("should return null for missing cookie", () => {
    const headers = { 
      cookie: "other=value",
      "user-agent": "test"
    };
    
    const extracted = cookieToken(headers);
    expect(extracted).toBeNull();
  });

  it("should identify user from cookie", () => {
    const password = "testpass123";
    const hashed = hashPassword(password);
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const username = "testuser";
    
    const token = signSession(expiry, username, hashed);
    const headers = { cookie: `flock_session=${token}` };
    
    const store = createTestStore();
    store.users = [{ username, password_hash: hashed, role: Role.User }];
    
    const user = identify(headers, store);
    expect(user).toBe(username);
  });

  it("should identify user from Bearer token", () => {
    const password = "testpass123";
    const hashed = hashPassword(password);
    const username = "testuser";
    
    const cred = `${username}:${password}`;
    const headers = { authorization: `Bearer ${cred}` };
    
    const store = createTestStore();
    store.users = [{ username, password_hash: hashed, role: Role.User }];
    
    const user = identify(headers, store);
    expect(user).toBe(username);
  });

  it("should identify user from Basic auth", () => {
    const password = "testpass123";
    const hashed = hashPassword(password);
    const username = "testuser";
    
    const cred = `${username}:${password}`;
    const b64cred = Buffer.from(cred).toString("base64");
    const headers = { authorization: `Basic ${b64cred}` };
    
    const store = createTestStore();
    store.users = [{ username, password_hash: hashed, role: Role.User }];
    
    const user = identify(headers, store);
    expect(user).toBe(username);
  });

  it("should return null for invalid credentials", () => {
    const headers = { authorization: "Bearer user:wrongpass" };
    
    const store = createTestStore();
    store.users = [{ username: "user", password_hash: hashPassword("correctpass"), role: Role.User }];
    
    const user = identify(headers, store);
    expect(user).toBeNull();
  });
});

// RFC 7914 test vectors for PBKDF2
describe("PBKDF2 test vectors (RFC 7914)", () => {
  it("should match RFC 7914 test vectors", () => {
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