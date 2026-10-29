import { createHash } from "node:crypto";

/**
 * Best-effort, per-instance login throttling.
 *
 * Netlify Functions do not provide a shared counter store in this deployment.
 * This limiter raises the cost of a burst against one warm instance, but it is
 * not a distributed or durable protection. Edge/WAF or an identity provider
 * remains required for production-grade rate limiting.
 */

interface WindowState {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, WindowState>();
const MAX_TRACKED_BUCKETS = 10_000;

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function windowMs(): number {
  return positiveInteger("LOGIN_RATE_LIMIT_WINDOW_SECONDS", 900) * 1000;
}

function identityLimit(): number {
  return positiveInteger("LOGIN_RATE_LIMIT_MAX_ATTEMPTS", 10);
}

function addressLimit(): number {
  return positiveInteger("LOGIN_RATE_LIMIT_IP_MAX_ATTEMPTS", 60);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function bucketKey(scope: string, value: string): string {
  return `${scope}:${digest(value)}`;
}

function prune(now: number): void {
  for (const [key, state] of buckets) {
    if (state.resetAt <= now) buckets.delete(key);
  }
  if (buckets.size > MAX_TRACKED_BUCKETS) {
    const overflow = buckets.size - MAX_TRACKED_BUCKETS;
    let removed = 0;
    for (const key of buckets.keys()) {
      buckets.delete(key);
      removed += 1;
      if (removed >= overflow) break;
    }
  }
}

export function clientAddress(request: Request): string {
  const netlifyAddress = request.headers.get("x-nf-client-connection-ip")?.trim();
  if (netlifyAddress) return netlifyAddress;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || "unknown";
}

export interface LoginRateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export function checkLoginRateLimit(
  username: string,
  address: string,
  now = Date.now(),
): LoginRateLimitDecision {
  prune(now);
  const identity = buckets.get(bucketKey("login-identity", `${username}|${address}`));
  const source = buckets.get(bucketKey("login-address", address));
  const identityBlocked = Boolean(identity && identity.count >= identityLimit());
  const sourceBlocked = Boolean(source && source.count >= addressLimit());
  if (!identityBlocked && !sourceBlocked) {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  const resetAt = Math.max(identity?.resetAt ?? 0, source?.resetAt ?? 0);
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
  };
}

export function recordLoginFailure(username: string, address: string, now = Date.now()): void {
  prune(now);
  const duration = windowMs();
  for (const key of [
    bucketKey("login-identity", `${username}|${address}`),
    bucketKey("login-address", address),
  ]) {
    const current = buckets.get(key);
    if (!current || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + duration });
    } else {
      current.count += 1;
    }
  }
  prune(now);
}

export function clearLoginFailures(username: string, address: string): void {
  buckets.delete(bucketKey("login-identity", `${username}|${address}`));
}

/** Test-only reset; never exposed through an HTTP route. */
export function resetLoginRateLimitForTests(): void {
  buckets.clear();
}
