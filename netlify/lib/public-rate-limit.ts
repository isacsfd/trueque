import { clientAddress } from "./login-rate-limit.ts";

/**
 * Best-effort per-instance throttle for public endpoints.
 *
 * It is intentionally not described as a distributed control: Netlify
 * Functions do not provide a shared counter store in this deployment. Edge
 * rate limiting or a managed identity provider remains required for
 * production-grade abuse protection.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 20_000;

export interface PublicRateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

function prune(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  if (buckets.size <= MAX_BUCKETS) return;
  let remove = buckets.size - MAX_BUCKETS;
  for (const key of buckets.keys()) {
    buckets.delete(key);
    remove -= 1;
    if (remove <= 0) break;
  }
}

export function consumePublicRateLimit(
  request: Request,
  scope: string,
  maxRequests: number,
  windowSeconds: number,
  now = Date.now(),
): PublicRateLimitDecision {
  prune(now);
  const address = clientAddress(request);
  const key = `${scope}:${address}`;
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (current.count >= maxRequests) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    };
  }
  current.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

export function enforcePublicRateLimit(
  request: Request,
  scope: string,
  maxRequests: number,
  windowSeconds: number,
): Response | null {
  const decision = consumePublicRateLimit(request, scope, maxRequests, windowSeconds);
  return decision.allowed ? null : publicRateLimitResponse(decision);
}

export function publicRateLimitResponse(decision: PublicRateLimitDecision): Response {
  return new Response(JSON.stringify({
    error: {
      code: "too_many_requests",
      message: "Demasiadas solicitudes. Espera antes de volver a intentarlo.",
    },
  }), {
    status: 429,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "Retry-After": String(decision.retryAfterSeconds),
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** Test-only reset; never exposed through an HTTP route. */
export function resetPublicRateLimitForTests(): void {
  buckets.clear();
}
