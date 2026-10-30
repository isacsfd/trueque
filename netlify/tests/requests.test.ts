// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseQueryError, query } from "../lib/database.ts";
import handler from "../functions/requests.ts";
import statusHandler from "../functions/requests-status.ts";

vi.mock("../lib/database.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/database.ts")>();
  return { ...actual, query: vi.fn(), queryAdmin: vi.fn() };
});

function createRequest(body: unknown): Request {
  return new Request("https://example.test/api/requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validBody = {
  copyId: "10",
  participantName: "Ana Pérez",
  participantEmail: "ana@example.test",
  participantDocument: "12345678",
  offeredTitle: "Libro ofrecido",
  offeredAuthor: "Autora",
  offeredCondition: "good",
  consent: true,
  idempotencyKey: "11111111-1111-4111-8111-111111111111",
};

describe("participant request API", () => {
  beforeEach(() => {
    vi.stubEnv("ALLOW_LEGACY_REQUEST_INTAKE", "true");
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  function configureCrypto(): void {
    vi.stubEnv("PARTICIPANT_DATA_KEY", Buffer.alloc(32, 1).toString("base64"));
    vi.stubEnv("PARTICIPANT_IDENTITY_HMAC_KEY", Buffer.alloc(32, 2).toString("base64"));
    vi.stubEnv("PARTICIPANT_DATA_KEY_VERSION", "1");
    vi.stubEnv("PARTICIPANT_HMAC_KEY_VERSION", "1");
    vi.stubEnv("PRIVACY_NOTICE_VERSION", "notice-2026-01");
  }

  it("creates a request without returning or logging personal data", async () => {
    configureCrypto();
    vi.mocked(query).mockResolvedValue([
      { request_id: "55", request_code: "IUB-2026-ABCD1234", participant_id: "9", privacy_consent_id: "3" },
    ]);

    const response = await handler(createRequest(validBody));
    const text = await response.text();

    expect(response.status).toBe(201);
    expect(text).not.toContain("Ana Pérez");
    expect(text).not.toContain("ana@example.test");
    expect(text).not.toContain("12345678");
    expect(JSON.parse(text)).toMatchObject({ requestId: "55", requestCode: "IUB-2026-ABCD1234" });

    const params = vi.mocked(query).mock.calls[0]?.[1] as unknown[];
    const payload = JSON.parse(String(params[1])) as Record<string, unknown>;
    expect(JSON.stringify(payload)).not.toContain("Ana Pérez");
    expect(payload.participant).toMatchObject({ identityFingerprint: expect.any(String) });
  });

  it("keeps legacy intake closed unless explicitly enabled", async () => {
    vi.stubEnv("ALLOW_LEGACY_REQUEST_INTAKE", "false");
    const response = await handler(createRequest(validBody));
    expect(response.status).toBe(410);
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects a missing consent before calling the database", async () => {
    configureCrypto();
    const response = await handler(createRequest({ ...validBody, consent: false }));
    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it("accepts an absent ISBN and rejects a malformed one", async () => {
    configureCrypto();
    vi.mocked(query).mockResolvedValue([
      { request_id: "56", request_code: "IUB-2026-ISBN0001", participant_id: "9", privacy_consent_id: "3" },
    ]);
    const absent = await handler(createRequest({ ...validBody, offeredIsbn: "   " }));
    expect(absent.status).toBe(201);

    vi.mocked(query).mockClear();
    const invalid = await handler(createRequest({ ...validBody, offeredIsbn: "978-3-16-148410-1" }));
    expect(invalid.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it("accepts a valid ISBN and forwards its normalized value", async () => {
    configureCrypto();
    vi.mocked(query).mockResolvedValue([
      { request_id: "57", request_code: "IUB-2026-ISBN0002", participant_id: "9", privacy_consent_id: "3" },
    ]);

    const response = await handler(createRequest({ ...validBody, offeredIsbn: "978-3-16-148410-0" }));

    expect(response.status).toBe(201);
    const params = vi.mocked(query).mock.calls[0]?.[1] as unknown[];
    const payload = JSON.parse(String(params[1])) as { offeredBook: { isbn: string; isbnNormalized: string } };
    expect(payload.offeredBook).toMatchObject({
      isbn: "978-3-16-148410-0",
      isbnNormalized: "9783161484100",
    });
  });

  it("maps a missing privacy notice to a clear service error", async () => {
    configureCrypto();
    vi.mocked(query).mockRejectedValueOnce(new DatabaseQueryError("P0002"));
    const response = await handler(createRequest(validBody));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("privacy_notice_unavailable");
  });

  it("looks up a request by code without a password or access token", async () => {
    vi.mocked(query).mockResolvedValue([
      {
        request_code: "IUB-2026-ABCD1234",
        status: "under_review",
        created_at: "2026-10-28T20:00:00Z",
        offered_title: "Libro ofrecido",
        offered_author: "Autora",
        requested_title: "Libro institucional",
        requested_author: "Autora institucional",
        requested_inventory_code: "INV-001",
        reservation_status: "active",
        reservation_expires_at: "2026-10-28T21:00:00Z",
        exchange_status: null,
        exchange_completed_at: null,
        reception_status: null,
      },
    ]);
    const request = new Request("https://example.test/api/requests/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "iub-2026-abcd1234" }),
    });
    const response = await statusHandler(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      requestCode: "IUB-2026-ABCD1234",
      status: "under_review",
      requestedTitle: "Libro institucional",
      offeredTitle: "Libro ofrecido",
      reservationStatus: "active",
    });
    expect(vi.mocked(query).mock.calls[0]?.[0]).toContain("get_public_request_status");
    expect(vi.mocked(query).mock.calls[0]?.[1]).toEqual(["IUB-2026-ABCD1234"]);
  });

  it("returns the generic not-found message for an unknown code", async () => {
    vi.mocked(query).mockResolvedValue([]);
    const request = new Request("https://example.test/api/requests/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "IUB-2026-FFFFFFFF" }),
    });
    const response = await statusHandler(request);
    expect(response.status).toBe(404);
    const body = await response.json() as { error: { message: string } };
    expect(body.error.message).toBe(
      "No encontramos una solicitud con ese código. Verifica los datos e inténtalo nuevamente.",
    );
  });

  it("rejects a malformed code without querying the database", async () => {
    const request = new Request("https://example.test/api/requests/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "ABC" }),
    });
    const response = await statusHandler(request);
    expect(response.status).toBe(400);
    expect(vi.mocked(query)).not.toHaveBeenCalled();
  });
});
