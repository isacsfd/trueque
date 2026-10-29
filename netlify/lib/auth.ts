import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { ApiError } from "./http.ts";
import { queryAdmin } from "./database.ts";

const COOKIE_NAME = "iub_admin_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const SESSION_SECRET_MIN_BYTES = 32;

export interface AdminUser {
  username: string;
  passwordHash: string;
  actorUserId: number;
}

export interface AdminSession {
  username: string;
  actorUserId: number;
  expiresAt: number;
  sessionVersion?: number;
}

interface SessionPayload {
  sub: string;
  actor: number;
  exp: number;
  sv: number;
}

function parseAdminUsers(): AdminUser[] {
  const raw = process.env.ADMIN_USERS?.trim();
  const users: AdminUser[] = [];

  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ApiError(503, "admin_not_configured", "La administración no está configurada.");
    }
    if (!Array.isArray(parsed)) {
      throw new ApiError(503, "admin_not_configured", "La administración no está configurada.");
    }
    for (const entry of parsed) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        typeof (entry as Record<string, unknown>).username !== "string" ||
        typeof (entry as Record<string, unknown>).passwordHash !== "string" ||
        typeof (entry as Record<string, unknown>).actorUserId !== "number"
      ) {
        throw new ApiError(503, "admin_not_configured", "La administración no está configurada.");
      }
      const candidate = entry as { username: string; passwordHash: string; actorUserId: number };
      if (!candidate.username || !candidate.passwordHash || !Number.isSafeInteger(candidate.actorUserId) || candidate.actorUserId <= 0) {
        throw new ApiError(503, "admin_not_configured", "La administración no está configurada.");
      }
      users.push(candidate);
    }
  } else {
    const username = process.env.ADMIN_USERNAME?.trim();
    const passwordHash = process.env.ADMIN_PASSWORD_HASH?.trim();
    const actorUserId = Number(process.env.ADMIN_ACTOR_USER_ID);
    if (!username || !passwordHash || !Number.isSafeInteger(actorUserId) || actorUserId <= 0) {
      throw new ApiError(503, "admin_not_configured", "La administración no está configurada.");
    }
    users.push({ username, passwordHash, actorUserId });
  }

  if (users.length === 0) {
    throw new ApiError(503, "admin_not_configured", "La administración no está configurada.");
  }
  const usernames = new Set<string>();
  const actorIds = new Set<number>();
  for (const user of users) {
    if (usernames.has(user.username) || actorIds.has(user.actorUserId)) {
      throw new ApiError(503, "admin_not_configured", "La administración no está configurada.");
    }
    usernames.add(user.username);
    actorIds.add(user.actorUserId);
  }
  return users;
}

export function verifyLegacyAdminPassword(username: string, password: string): boolean {
  try {
    const user = parseAdminUsers().find((candidate) => candidate.username === username);
    return Boolean(user && verifyPassword(password, user.passwordHash));
  } catch {
    return false;
  }
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [algorithm, saltHex, hashHex] = encoded.split("$");
  if (algorithm !== "scrypt" || !saltHex || !hashHex) return false;

  try {
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    if (salt.length < 8 || expected.length !== 64) return false;
    const actual = scryptSync(password, salt, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function sessionSecret(): Buffer {
  const raw = process.env.SESSION_SECRET?.trim() ?? "";
  const secret = Buffer.from(raw, "utf8");
  if (secret.length < SESSION_SECRET_MIN_BYTES) {
    throw new ApiError(503, "admin_not_configured", "La administración no está configurada.");
  }
  return secret;
}

function sign(value: string): string {
  return createHmac("sha256", sessionSecret()).update(value).digest("base64url");
}

export function createSessionToken(session: AdminSession): string {
  const payload: SessionPayload = {
    sub: session.username,
    actor: session.actorUserId,
    exp: session.expiresAt,
    sv: session.sessionVersion ?? 0,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

export function readSessionToken(token: string): AdminSession | null {
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;
  const expected = sign(encoded);
  const supplied = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (supplied.length !== expectedBuffer.length || !timingSafeEqual(supplied, expectedBuffer)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SessionPayload;
    if (
      typeof payload.sub !== "string" ||
      !Number.isSafeInteger(payload.actor) ||
      !Number.isSafeInteger(payload.exp) ||
      payload.exp <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return { username: payload.sub, actorUserId: payload.actor, expiresAt: payload.exp, sessionVersion: Number.isSafeInteger(payload.sv) ? payload.sv : 0 };
  } catch {
    return null;
  }
}

function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    cookies.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()));
  }
  return cookies;
}

export function readAdminSession(request: Request): AdminSession | null {
  const token = parseCookies(request.headers.get("cookie")).get(COOKIE_NAME);
  if (!token) return null;
  return readSessionToken(token);
}

export function requireAdmin(request: Request): AdminSession {
  const session = readAdminSession(request);
  if (!session) {
    throw new ApiError(401, "unauthorized", "Inicia sesión para continuar.");
  }
  return session;
}

export async function loginAdmin(
  username: string,
  password: string,
  secure: boolean,
): Promise<{ session: AdminSession; cookie: string }> {
  let credential: { user_id: string; login_name: string; password_hash: string; session_version: number } | undefined;
  try {
    const rows = await queryAdmin<{
      user_id: string;
      login_name: string;
      password_hash: string;
      session_version: number;
    }>(
      `SELECT c.user_id, c.login_name, c.password_hash, c.session_version
       FROM public.admin_credentials c
       JOIN public.app_users u ON u.id = c.user_id
       WHERE lower(c.login_name) = lower($1) AND u.is_active
       LIMIT 1`,
      [username],
    );
    credential = rows[0];
  } catch {
    credential = undefined;
  }

  if (credential) {
    if (!verifyPassword(password, credential.password_hash)) {
      throw new ApiError(401, "invalid_credentials", "Usuario o contraseña incorrectos.");
    }
    await queryAdmin(
      "UPDATE public.admin_credentials SET last_login_at = now(), updated_at = now() WHERE user_id = $1",
      [Number(credential.user_id)],
    ).catch(() => undefined);
    const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
    const session: AdminSession = {
      username: credential.login_name,
      actorUserId: Number(credential.user_id),
      expiresAt,
      sessionVersion: credential.session_version,
    };
    return { session, cookie: sessionCookie(session, secure) };
  }

  const users = parseAdminUsers();
  const user = users.find((candidate) => candidate.username === username);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    throw new ApiError(401, "invalid_credentials", "Usuario o contraseña incorrectos.");
  }

  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const session: AdminSession = { username: user.username, actorUserId: user.actorUserId, expiresAt, sessionVersion: 0 };
  return { session, cookie: sessionCookie(session, secure) };
}

function sessionCookie(session: AdminSession, secure: boolean): string {
  const token = createSessionToken(session);
  return [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/api/admin",
    `Max-Age=${SESSION_TTL_SECONDS}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=0`;
}
