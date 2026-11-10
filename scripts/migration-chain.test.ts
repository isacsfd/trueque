import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalizeSql, pendingMigrations } from "./migration-safety.mjs";

const migrationDirectory = resolve(process.cwd(), "db/migrations");

async function localMigrations() {
  const files = (await readdir(migrationDirectory))
    .filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file))
    .sort();
  return Promise.all(files.map(async (file) => {
    const text = canonicalizeSql(await readFile(resolve(migrationDirectory, file), "utf8"));
    return {
      version: file.replace(/\.sql$/, ""),
      checksum: createHash("sha256").update(text, "utf8").digest("hex"),
    };
  }));
}

describe("canonical migration chain", () => {
  it("ends at the reviewed bridge and keeps required later migrations", async () => {
    const migrations = await localMigrations();
    const versions = migrations.map(({ version }) => version);

    expect(versions.at(-1)).toBe("0026_migration_chain_compat");
    for (const required of [
      "0010_inventory_batches",
      "0021_admin_workbench_indexes",
      "0022_inventory_registration",
      "0023_inventory_batch_autopublish",
      "0024_loans",
      "0025_loan_reactivation",
    ]) {
      expect(versions).toContain(required);
    }
    expect(versions.indexOf("0010_inventory_batches"))
      .toBeLessThan(versions.indexOf("0023_inventory_batch_autopublish"));
  });

  it("plans a valid staging prefix as one contiguous additive block", async () => {
    const migrations = await localMigrations();
    const stagingLedger = migrations.filter(({ version }) => version <= "0005_participant_api");
    const pending = pendingMigrations(migrations, stagingLedger);

    expect(pending[0]?.version).toBe("0006_inventory_import");
    expect(pending.at(-1)?.version).toBe("0026_migration_chain_compat");
    expect(pending).toHaveLength(migrations.length - stagingLedger.length);
    expect(pending.some(({ version }) => version === "0023_inventory_batch_autopublish")).toBe(true);
  });

  it("rejects inconsistent ledgers before applying any migration", async () => {
    const migrations = await localMigrations();
    const byVersion = new Map(migrations.map(({ version, checksum }) => [version, checksum]));
    const staging = migrations.filter(({ version }) => version <= "0005_participant_api");

    const gap = [staging[0]!, migrations.find(({ version }) => version === "0010_inventory_batches")!];
    expect(() => pendingMigrations(migrations, gap)).toThrow(/contiguous prefix/);

    const duplicate = [...staging, staging.at(-1)!];
    expect(() => pendingMigrations(migrations, duplicate)).toThrow(/duplicate migration version/);

    const checksumMismatch = staging.slice(0, -1).concat({
      version: "0005_participant_api",
      checksum: `${byVersion.get("0005_participant_api")}0`,
    });
    expect(() => pendingMigrations(migrations, checksumMismatch)).toThrow(/Checksum mismatch/);

    expect(() => pendingMigrations(migrations, [
      { version: "9999_unknown", checksum: "x" },
    ])).toThrow(/unknown migration/);
  });
});
