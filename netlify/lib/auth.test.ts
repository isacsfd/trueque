import { describe, expect, it, vi } from "vitest";
import {
  createSessionToken,
  hashPassword,
  loginAdmin,
  readAdminSession,
  readSessionToken,
  verifyPassword,
} from "./auth.ts";

describe("administrative session", () => {
  it("hashes and verifies passwords with scrypt", () => {
    const hash = hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
    expect(verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(verifyPassword("wrong password", hash)).toBe(false);
  });

  it("creates and verifies a signed session, rejecting tampering and expiry", () => {
    vi.stubEnv("SESSION_SECRET", "test-session-secret-with-at-least-32-bytes");
    const future = Math.floor(Date.now() / 1000) + 60;
    const token = createSessionToken({ username: "admin", actorUserId: 7, expiresAt: future });
    expect(readSessionToken(token)).toEqual({
      username: "admin",
      actorUserId: 7,
      expiresAt: future,
      sessionVersion: 0,
    });
    expect(readSessionToken(`${token}x`)).toBeNull();

    const expired = createSessionToken({
      username: "admin",
      actorUserId: 7,
      expiresAt: Math.floor(Date.now() / 1000) - 1,
    });
    expect(readSessionToken(expired)).toBeNull();
    vi.unstubAllEnvs();
  });

  it("fails closed when SESSION_SECRET is missing or too short", () => {
    vi.stubEnv("SESSION_SECRET", "");
    expect(() => createSessionToken({ username: "admin", actorUserId: 7, expiresAt: 9999999999 })).toThrow(/no está configurada/);
    vi.stubEnv("SESSION_SECRET", "short");
    expect(() => createSessionToken({ username: "admin", actorUserId: 7, expiresAt: 9999999999 })).toThrow(/no está configurada/);
    vi.unstubAllEnvs();
  });

  it("reads the HttpOnly session cookie and fails closed without it", () => {
    vi.stubEnv("SESSION_SECRET", "test-session-secret-with-at-least-32-bytes");
    const token = createSessionToken({
      username: "admin",
      actorUserId: 7,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });
    const request = new Request("https://example.test/api/admin/workbench", {
      headers: { cookie: `iub_admin_session=${encodeURIComponent(token)}` },
    });
    expect(readAdminSession(request)?.actorUserId).toBe(7);
    expect(readAdminSession(new Request("https://example.test/api/admin/workbench"))).toBeNull();
    vi.unstubAllEnvs();
  });

  it("rejects duplicate usernames or actor bindings in ADMIN_USERS", async () => {
    const hash = hashPassword("correct horse battery staple");
    vi.stubEnv("SESSION_SECRET", "test-session-secret-with-at-least-32-bytes");
    vi.stubEnv("ADMIN_USERS", JSON.stringify([
      { username: "admin", passwordHash: hash, actorUserId: 7 },
      { username: "admin", passwordHash: hash, actorUserId: 8 },
    ]));
    await expect(loginAdmin("admin", "correct horse battery staple", true)).rejects.toThrow(/no está configurada/);

    vi.stubEnv("ADMIN_USERS", JSON.stringify([
      { username: "admin", passwordHash: hash, actorUserId: 7 },
      { username: "other", passwordHash: hash, actorUserId: 7 },
    ]));
    await expect(loginAdmin("admin", "correct horse battery staple", true)).rejects.toThrow(/no está configurada/);
    vi.unstubAllEnvs();
  });

  it("rejects invalid credentials without revealing configuration", async () => {
    const hash = hashPassword("correct horse battery staple");
    vi.stubEnv("ADMIN_USERS", JSON.stringify([{ username: "admin", passwordHash: hash, actorUserId: 7 }]));
    vi.stubEnv("SESSION_SECRET", "test-session-secret-with-at-least-32-bytes");
    await expect(loginAdmin("admin", "wrong", true)).rejects.toThrow(/Usuario o contraseña/);
    const result = await loginAdmin("admin", "correct horse battery staple", true);
    expect(result.session.actorUserId).toBe(7);
    expect(result.cookie).toContain("HttpOnly");
    expect(result.cookie).toContain("SameSite=Strict");
    vi.unstubAllEnvs();
  });
});
