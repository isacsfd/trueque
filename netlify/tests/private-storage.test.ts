// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LocalEvidenceStorage,
  SimulatedObjectStorage,
  getBatchStorage,
  getEvidenceStorage,
  isHostedFunctionRuntime,
  newEvidenceStorageKey,
  newUniqueObjectKey,
  resolvePrivateStorageDriver,
} from "../lib/evidence-storage.ts";
import {
  collectRetentionCandidates,
  planRetention,
  removeOrphans,
  retentionPolicy,
} from "../lib/storage-retention.ts";

const day = 86_400_000;

describe("private storage adapters", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "trueque-storage-"));
    vi.stubEnv("EVIDENCE_STORAGE_DIR", directory);
    vi.stubEnv("BATCH_STORAGE_DIR", directory);
    vi.stubEnv("PRIVATE_STORAGE_DRIVER", "local");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it("round-trips private objects and does not reuse a partial write", async () => {
    const storage = new LocalEvidenceStorage(directory);
    const first = Buffer.from("evidence-bytes");
    await storage.put("evidence-1.png", first);

    expect(await storage.get("evidence-1.png")).toEqual(first);
    expect(await storage.head("evidence-1.png")).toMatchObject({ key: "evidence-1.png", size: first.length });
    expect((await storage.list()).map((object) => object.key)).toEqual(["evidence-1.png"]);

    await storage.delete("evidence-1.png");
    expect(await storage.list()).toEqual([]);
    await expect(storage.get("evidence-1.png")).rejects.toThrow();
    await expect(storage.delete("evidence-1.png")).resolves.toBeUndefined();
  });

  it("rejects keys that escape the storage root", async () => {
    const storage = new LocalEvidenceStorage(directory);
    for (const key of ["../secret", "sub/dir/file.png", "..", "", "a".repeat(121)]) {
      await expect(storage.put(key, Buffer.from("x"))).rejects.toThrow(/Invalid private storage key/);
    }
  });

  it("simulates write and delete failures so callers can retry", async () => {
    const storage = new SimulatedObjectStorage();
    storage.failNextPut = true;
    await expect(storage.put("evidence-a.png", Buffer.from("a"))).rejects.toThrow(/write failure/);
    expect(await storage.list()).toEqual([]);

    await storage.put("evidence-a.png", Buffer.from("a"));
    storage.failNextDelete = true;
    await expect(storage.delete("evidence-a.png")).rejects.toThrow(/delete failure/);
    expect((await storage.list()).map((object) => object.key)).toEqual(["evidence-a.png"]);
  });

  it("generates unpredictable keys without leaking file names or owners", () => {
    const one = newEvidenceStorageKey("image/jpeg");
    const two = newEvidenceStorageKey("image/jpeg");
    expect(one).toMatch(/^evidence-[0-9a-f-]{36}\.jpg$/);
    expect(two).not.toBe(one);
    expect(one).not.toContain("cover");
    expect(newUniqueObjectKey("batch", "xlsx")).toMatch(/^batch-[0-9a-f-]{36}\.xlsx$/);
  });

  it("selects simulated storage only outside hosted functions", () => {
    vi.stubEnv("PRIVATE_STORAGE_DRIVER", "simulated");
    expect(getEvidenceStorage()).toBeInstanceOf(SimulatedObjectStorage);
    expect(getBatchStorage()).toBeInstanceOf(SimulatedObjectStorage);
  });

  it("fails closed for provider drivers without an approved adapter", () => {
    for (const driver of ["r2", "s3", "gcs", "blobs", "netlify-blobs", "unknown"]) {
      vi.stubEnv("PRIVATE_STORAGE_DRIVER", driver);
      expect(() => getEvidenceStorage()).toThrow(/not implemented|Unknown private storage driver/);
    }
  });

  it("fails closed instead of writing to the ephemeral Netlify filesystem", () => {
    vi.stubEnv("NETLIFY", "true");
    expect(isHostedFunctionRuntime()).toBe(true);
    expect(resolvePrivateStorageDriver()).toBe("local");
    expect(() => getEvidenceStorage()).toThrow(/not durable in Netlify Functions/);

    vi.stubEnv("PRIVATE_STORAGE_DRIVER", "");
    expect(resolvePrivateStorageDriver()).toBe("unconfigured");
    expect(() => getBatchStorage()).toThrow(/PRIVATE_STORAGE_DRIVER is required/);

    vi.stubEnv("PRIVATE_STORAGE_DRIVER", "simulated");
    expect(() => getEvidenceStorage()).toThrow(/simulated private storage driver cannot run/);
  });

  it("allows local storage in netlify dev", () => {
    vi.stubEnv("NETLIFY", "true");
    vi.stubEnv("NETLIFY_DEV", "true");
    expect(isHostedFunctionRuntime()).toBe(false);
    expect(getEvidenceStorage()).toBeInstanceOf(LocalEvidenceStorage);
  });

  it("plans orphan and expired retention without deleting referenced objects", async () => {
    const storage = new SimulatedObjectStorage();
    await storage.put("evidence-orphan.png", Buffer.from("orphan"));
    await storage.put("evidence-referenced.png", Buffer.from("referenced"));
    await storage.put("batch-referenced.xlsx", Buffer.from("batch"));

    const candidates = await collectRetentionCandidates(storage, {
      evidenceKeys: ["evidence-referenced.png"],
      batchKeys: ["batch-referenced.xlsx"],
    });
    const now = new Date();
    for (const candidate of candidates) {
      if (candidate.key !== "evidence-orphan.png") candidate.lastModified = new Date(now.getTime() - 120 * day);
    }

    const policy = {
      orphanGraceDays: 0,
      evidenceRetentionDays: 90,
      batchRetentionDays: 30,
    };
    const plan = planRetention(candidates, policy, now);
    expect(plan.orphanKeys).toEqual(["evidence-orphan.png"]);
    expect(plan.expiredReferencedKeys).toEqual(["batch-referenced.xlsx", "evidence-referenced.png"]);
    expect(plan.retainedKeys).toEqual([]);
    expect(plan.requiresInstitutionalApproval).toBe(true);

    const dryRun = await removeOrphans(storage, plan, { dryRun: true });
    expect(dryRun).toEqual({ deleted: [], failed: [] });
    expect(await storage.list()).toHaveLength(3);

    const applied = await removeOrphans(storage, plan, { dryRun: false });
    expect(applied.deleted).toEqual(["evidence-orphan.png"]);
    expect((await storage.list()).map((object) => object.key)).toEqual([
      "batch-referenced.xlsx",
      "evidence-referenced.png",
    ]);
  });

  it("keeps recent unreferenced objects during the orphan grace period", () => {
    const now = new Date();
    const plan = planRetention(
      [
        { key: "evidence-new.png", size: 1, lastModified: new Date(now.getTime() - 60_000), referenced: false, kind: "evidence" },
        { key: "evidence-old.png", size: 1, lastModified: new Date(now.getTime() - 2 * day), referenced: false, kind: "evidence" },
      ],
      { orphanGraceDays: 1, evidenceRetentionDays: 0, batchRetentionDays: 0 },
      now,
    );
    expect(plan.orphanKeys).toEqual(["evidence-old.png"]);
    expect(plan.retainedKeys).toEqual(["evidence-new.png"]);
    expect(plan.requiresInstitutionalApproval).toBe(false);
  });

  it("records failed deletions instead of aborting the whole cleanup", async () => {
    const storage = new SimulatedObjectStorage();
    await storage.put("evidence-a.png", Buffer.from("a"));
    await storage.put("evidence-b.png", Buffer.from("b"));
    const plan = {
      orphanKeys: ["evidence-a.png", "evidence-b.png"],
      expiredReferencedKeys: [],
      retainedKeys: [],
      requiresInstitutionalApproval: false,
    };
    storage.failNextDelete = true;
    const result = await removeOrphans(storage, plan, { dryRun: false });
    expect(result.failed).toEqual(["evidence-a.png"]);
    expect(result.deleted).toEqual(["evidence-b.png"]);
  });

  it("parses retention settings defensively", () => {
    expect(retentionPolicy({})).toEqual({ orphanGraceDays: 1, evidenceRetentionDays: 0, batchRetentionDays: 0 });
    expect(retentionPolicy({ STORAGE_ORPHAN_GRACE_DAYS: "-1", EVIDENCE_RETENTION_DAYS: "90", BATCH_RETENTION_DAYS: "x" }))
      .toEqual({ orphanGraceDays: 1, evidenceRetentionDays: 90, batchRetentionDays: 0 });
  });
});
