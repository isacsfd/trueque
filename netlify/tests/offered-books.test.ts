// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireAdmin } from "../lib/auth.ts";
import { DatabaseQueryError, query, queryAdmin } from "../lib/database.ts";
import { LocalEvidenceStorage } from "../lib/evidence-storage.ts";
import { MAX_EVIDENCE_BYTES } from "../lib/evidence-validation.ts";
import adminEvidenceHandler from "../functions/admin-evidence.ts";
import evidenceHandler from "../functions/evidence.ts";
import uploadHandler from "../functions/offered-books-evidence.ts";

vi.mock("../lib/auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/auth.ts")>();
  return { ...actual, requireAdmin: vi.fn() };
});
vi.mock("../lib/database.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/database.ts")>();
  return { ...actual, query: vi.fn(), queryAdmin: vi.fn() };
});

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const token = "a".repeat(40);
const key = "11111111-1111-4111-8111-111111111111";

function uploadRequest(file: File, slot = "cover"): Request {
  const form = new FormData();
  form.set("submissionId", "1");
  form.set("slot", slot);
  form.set("idempotencyKey", key);
  form.set("file", file);
  return new Request("https://example.test/api/offered-books/evidence", {
    method: "POST",
    headers: { "X-Submission-Token": token },
    body: form,
  });
}

describe("private evidence API", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "trueque-evidence-"));
    vi.stubEnv("EVIDENCE_STORAGE_DIR", directory);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it("stores a validated image and returns only evidence metadata", async () => {
    vi.mocked(query).mockImplementation(async (_sql, params) => [
      { evidence_id: "7", storage_key: String(params?.[3] ?? "") },
    ]);

    const response = await uploadHandler(uploadRequest(new File([png], "cover.png", { type: "image/png" })));
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ evidenceId: "7", slot: "cover", mime: "image/png" });
    expect(body).not.toHaveProperty("storage_key");
    expect(await readdir(directory)).toHaveLength(1);
  });

  it("keeps each upload in an isolated object and records its SHA-256 digest", async () => {
    const digests: string[] = [];
    vi.mocked(query).mockImplementation(async (_sql, params) => {
      digests.push(Buffer.from(params?.[6] as Buffer).toString("hex"));
      return [{ evidence_id: String(digests.length), storage_key: String(params?.[3] ?? "") }];
    });

    const first = await uploadHandler(uploadRequest(new File([png], "a.png", { type: "image/png" })));
    const second = await uploadHandler(uploadRequest(new File([png], "b.png", { type: "image/png" })));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const expected = createHash("sha256").update(png).digest("hex");
    expect(digests).toEqual([expected, expected]);

    const files = await readdir(directory);
    expect(files).toHaveLength(2);
    expect(new Set(files).size).toBe(2);

    await new LocalEvidenceStorage(directory).delete(files[0]!);
    expect(await readdir(directory)).toEqual([files[1]]);
  });

  it("removes the private object when the database registration fails", async () => {
    vi.mocked(query).mockRejectedValueOnce(new Error("database unavailable"));
    const response = await uploadHandler(uploadRequest(new File([png], "cover.png", { type: "image/png" })));
    expect(response.status).toBe(500);
    expect(await readdir(directory)).toHaveLength(0);
  });

  it("rejects a read without the draft token and does not query storage", async () => {
    const response = await evidenceHandler(new Request("https://example.test/api/evidence?id=7"));
    expect(response.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects SVG/text disguised as an image and does not touch the database", async () => {
    const file = new File([Buffer.from("<svg></svg>")], "cover.png", { type: "image/png" });
    const response = await uploadHandler(uploadRequest(file));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Solo se aceptan");
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects files above 4 MB", async () => {
    const file = new File([Buffer.alloc(MAX_EVIDENCE_BYTES + 1)], "huge.png", { type: "image/png" });
    const response = await uploadHandler(uploadRequest(file));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("4 MB");
  });

  it("deletes a private file after the database soft delete", async () => {
    const storage = new LocalEvidenceStorage(directory);
    await storage.put("existing.jpg", png);
    vi.mocked(query).mockResolvedValue([{ storage_key: "existing.jpg" }]);

    const response = await uploadHandler(new Request(
      "https://example.test/api/offered-books/evidence?id=7",
      { method: "DELETE", headers: { "X-Submission-Token": token } },
    ));
    expect(response.status).toBe(204);
    expect(await readdir(directory)).toHaveLength(0);
  });

  it("serves evidence to the draft token without a public URL", async () => {
    const storage = new LocalEvidenceStorage(directory);
    await storage.put("existing.png", png);
    vi.mocked(query).mockResolvedValue([
      { id: "7", storage_key: "existing.png", detected_mime: "image/png" },
    ]);

    const response = await evidenceHandler(new Request(
      "https://example.test/api/evidence?id=7",
      { headers: { "X-Submission-Token": token } },
    ));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(png));
  });

  it("requires the admin review permission for admin evidence access", async () => {
    const storage = new LocalEvidenceStorage(directory);
    await storage.put("existing.png", png);
    vi.mocked(requireAdmin).mockReturnValue({ username: "reviewer", actorUserId: 9, expiresAt: 9999999999 });
    vi.mocked(queryAdmin)
      .mockResolvedValueOnce([{ assert_actor_permission: null }])
      .mockResolvedValueOnce([{ id: "7", storage_key: "existing.png", detected_mime: "image/png" }]);

    const response = await adminEvidenceHandler(new Request("https://example.test/api/admin/evidence?id=7"));
    expect(response.status).toBe(200);
    expect(queryAdmin).toHaveBeenCalledWith(
      expect.stringContaining("assert_actor_permission"),
      [9],
    );
  });

  it("returns 403 when the admin lacks the review permission", async () => {
    vi.mocked(requireAdmin).mockReturnValue({ username: "viewer", actorUserId: 9, expiresAt: 9999999999 });
    vi.mocked(queryAdmin).mockRejectedValueOnce(new DatabaseQueryError("42501"));

    const response = await adminEvidenceHandler(new Request("https://example.test/api/admin/evidence?id=7"));
    expect(response.status).toBe(403);
  });
});
