// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { query } from "../lib/database.ts";
import draftHandler from "../functions/offered-books.ts";
import statusHandler from "../functions/offered-books-status.ts";
import submitHandler from "../functions/offered-books-submit.ts";

vi.mock("../lib/database.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/database.ts")>();
  return { ...actual, query: vi.fn(), queryAdmin: vi.fn() };
});

const token = "draft-token-with-more-than-thirty-two-characters";
const submission = {
  submissionId: "8",
  status: "draft",
  workflowStatus: "draft",
  requestedCopyId: "10",
  requestId: null,
  requestCode: null,
  requestStatus: null,
  title: "Libro ofrecido",
  author: "Autora",
  publisher: "Editorial",
  genre: "Ensayo",
  isbn: null,
  isbnNormalized: null,
  declaredCondition: "good",
  observations: "Observaciones",
  submittedAt: null,
  reviewedAt: null,
  decisionReason: null,
  reviewNotes: null,
  evidence: [],
};

function jsonRequest(path: string, method: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://example.test${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("offered-book draft API", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("creates a draft and does not return the draft token", async () => {
    vi.mocked(query).mockResolvedValue([{ submission_id: "8", status: "draft" }]);
    const response = await draftHandler(jsonRequest("/api/offered-books", "POST", {
      copyId: "10",
      accessToken: token,
      title: "Libro ofrecido",
      author: "Autora",
      publisher: "Editorial",
      declaredCondition: "good",
      observations: "Observaciones",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
    }));
    const text = await response.text();

    expect(response.status).toBe(201);
    expect(text).not.toContain(token);
    expect(JSON.parse(text)).toEqual({ submissionId: "8", status: "draft" });
    const params = vi.mocked(query).mock.calls[0]?.[1] as unknown[];
    expect(params[1]).toBeInstanceOf(Buffer);
    expect((params[1] as Buffer).toString("hex")).not.toContain(token);
  });

  it("rejects an invalid ISBN before reaching the database", async () => {
    const response = await draftHandler(jsonRequest("/api/offered-books", "POST", {
      copyId: "10",
      accessToken: token,
      title: "Libro",
      author: "Autora",
      isbn: "978-3-16-148410-1",
      declaredCondition: "good",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
    }));
    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it("returns the draft state only with its opaque token", async () => {
    vi.mocked(query).mockResolvedValue([{ get_offered_book_submission: submission }]);
    const response = await statusHandler(new Request("https://example.test/api/offered-books/status?id=8", {
      headers: { "X-Submission-Token": token },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ submission: { submissionId: "8", status: "draft" } });
  });

  it("submits a draft without exposing personal data in the payload", async () => {
    vi.stubEnv("PARTICIPANT_DATA_KEY", Buffer.alloc(32, 1).toString("base64"));
    vi.stubEnv("PARTICIPANT_IDENTITY_HMAC_KEY", Buffer.alloc(32, 2).toString("base64"));
    vi.stubEnv("PARTICIPANT_DATA_KEY_VERSION", "1");
    vi.stubEnv("PARTICIPANT_HMAC_KEY_VERSION", "1");
    vi.stubEnv("PRIVACY_NOTICE_VERSION", "notice-2026-01");

    vi.mocked(query)
      .mockResolvedValueOnce([{ get_offered_book_submission: submission }])
      .mockResolvedValueOnce([{ request_id: "55", request_code: "IUB-2026-ABCD1234", participant_id: "9", privacy_consent_id: "3" }]);

    const response = await submitHandler(jsonRequest("/api/offered-books/submit", "POST", {
      submissionId: "8",
      accessToken: token,
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      participantName: "Ana Pérez",
      participantEmail: "ana@example.test",
      participantDocument: "12345678",
      consent: true,
    }));
    const text = await response.text();

    expect(response.status).toBe(201);
    expect(text).not.toContain("Ana Pérez");
    expect(text).not.toContain("ana@example.test");
    expect(text).not.toContain("12345678");
    expect(JSON.parse(text)).toMatchObject({ requestId: "55", requestCode: "IUB-2026-ABCD1234" });

    const secondParams = vi.mocked(query).mock.calls[1]?.[1] as unknown[];
    const payload = String(secondParams[3]);
    expect(payload).not.toContain("Ana Pérez");
    expect(payload).not.toContain("12345678");
  });

  it("rejects submission without consent before writing participant data", async () => {
    vi.mocked(query).mockResolvedValueOnce([{ get_offered_book_submission: submission }]);
    const response = await submitHandler(jsonRequest("/api/offered-books/submit", "POST", {
      submissionId: "8",
      accessToken: token,
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      participantName: "Ana Pérez",
      participantEmail: "ana@example.test",
      participantDocument: "12345678",
      consent: false,
    }));
    expect(response.status).toBe(400);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
