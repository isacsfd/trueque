import type { EvidenceStorage, StoredObjectInfo } from "./evidence-storage.ts";

export interface RetentionPolicy {
  orphanGraceDays: number;
  evidenceRetentionDays: number;
  batchRetentionDays: number;
}

export interface RetentionCandidate extends StoredObjectInfo {
  referenced: boolean;
  kind: "evidence" | "batch";
}

export interface RetentionPlan {
  orphanKeys: string[];
  expiredReferencedKeys: string[];
  retainedKeys: string[];
  requiresInstitutionalApproval: boolean;
}

export function retentionPolicy(environment: NodeJS.ProcessEnv = process.env): RetentionPolicy {
  const days = (name: string, fallback: number): number => {
    const raw = environment[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  return {
    orphanGraceDays: days("STORAGE_ORPHAN_GRACE_DAYS", 1),
    evidenceRetentionDays: days("EVIDENCE_RETENTION_DAYS", 0),
    batchRetentionDays: days("BATCH_RETENTION_DAYS", 0),
  };
}

/**
 * Builds retention candidates by comparing storage keys with the references
 * persisted in PostgreSQL. A key that is not referenced may be an incomplete
 * upload or an orphan left by a failed database write.
 */
export async function collectRetentionCandidates(
  storage: EvidenceStorage,
  references: { evidenceKeys: Iterable<string>; batchKeys: Iterable<string> },
): Promise<RetentionCandidate[]> {
  const evidenceKeys = new Set(references.evidenceKeys);
  const batchKeys = new Set(references.batchKeys);
  const objects = await storage.list();
  return objects.map((object) => {
    const isBatch = batchKeys.has(object.key);
    return {
      ...object,
      referenced: isBatch || evidenceKeys.has(object.key),
      kind: isBatch ? "batch" : "evidence",
    };
  });
}

export function planRetention(
  candidates: RetentionCandidate[],
  policy: RetentionPolicy,
  now = new Date(),
): RetentionPlan {
  const orphanAgeLimit = policy.orphanGraceDays * 86_400_000;
  const orphanKeys: string[] = [];
  const expiredReferencedKeys: string[] = [];
  const retainedKeys: string[] = [];

  for (const candidate of candidates) {
    const age = now.getTime() - candidate.lastModified.getTime();
    if (!candidate.referenced) {
      if (age >= orphanAgeLimit) orphanKeys.push(candidate.key);
      else retainedKeys.push(candidate.key);
      continue;
    }

    const retentionDays = candidate.kind === "evidence"
      ? policy.evidenceRetentionDays
      : policy.batchRetentionDays;
    if (retentionDays > 0 && age >= retentionDays * 86_400_000) {
      expiredReferencedKeys.push(candidate.key);
    } else {
      retainedKeys.push(candidate.key);
    }
  }

  return {
    orphanKeys,
    expiredReferencedKeys,
    retainedKeys,
    requiresInstitutionalApproval: expiredReferencedKeys.length > 0,
  };
}

/**
 * Deletes only orphan objects after an explicit opt-in. Referenced objects are
 * never deleted by this helper; D-14 requires an institutional decision.
 */
export async function removeOrphans(
  storage: EvidenceStorage,
  plan: RetentionPlan,
  options: { dryRun: boolean },
): Promise<{ deleted: string[]; failed: string[] }> {
  if (options.dryRun) return { deleted: [], failed: [] };
  const deleted: string[] = [];
  const failed: string[] = [];
  for (const key of plan.orphanKeys) {
    try {
      await storage.delete(key);
      deleted.push(key);
    } catch {
      failed.push(key);
    }
  }
  return { deleted, failed };
}
