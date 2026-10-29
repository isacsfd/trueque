import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalizeSql,
  compareObjectManifest,
  dedupeObjects,
  parseDatabaseTarget,
  parseDatabaseRole,
  pendingMigrations,
  planManifestRefresh,
  staleManifestEntries,
  unexpectedRuntimeFunctions,
  validateDatabaseTargetSeparation,
  validateRoleMemberships,
  validateRoleSeparation,
} from "./migration-safety.mjs";

describe("migration preflight validation", () => {
  it("extracts only the URL role without exposing connection components", () => {
    expect(
      parseDatabaseRole("postgresql://iub_schema_migrator@db.example.test/library"),
    ).toBe("iub_schema_migrator");
  });

  it("rejects a runtime role reused for migration", () => {
    expect(() =>
      validateRoleSeparation({
        expectedMigrationRole: "iub_schema_migrator",
        actualMigrationRole: "iub_schema_migrator",
        runtimeRoles: ["iub_schema_migrator", "iub_admin_runtime"],
      }),
    ).toThrow(/different PostgreSQL roles/);
  });

  it("accepts only the documented separated login roles", () => {
    expect(() =>
      validateRoleSeparation({
        expectedMigrationRole: "iub_schema_migrator",
        actualMigrationRole: "iub_schema_migrator",
        runtimeRoles: ["iub_public_runtime", "iub_admin_runtime"],
      }),
    ).not.toThrow();
    expect(() =>
      validateRoleSeparation({
        expectedMigrationRole: "iub_schema_migrator",
        actualMigrationRole: "iub_schema_migrator",
        runtimeRoles: ["owner", "iub_admin_runtime"],
      }),
    ).toThrow(/runtime URLs must use/i);
  });

  it("normalizes Neon pooled and direct URLs for target comparison", () => {
    const pooled = parseDatabaseTarget("postgresql://iub_public_runtime@ep-demo-pooler.c-2.us-east-2.aws.neon.tech/library");
    const direct = parseDatabaseTarget("postgresql://iub_schema_migrator@ep-demo.c-2.us-east-2.aws.neon.tech/library");
    expect(pooled).toBe(direct);
    expect(() => validateDatabaseTargetSeparation(direct, ["another-host/library"])).toThrow(/same database target/);
  });

  it("accepts only a contiguous, checksum-matching migration prefix", () => {
    const local = [
      { version: "0001_core", checksum: "a" },
      { version: "0002_guards", checksum: "b" },
      { version: "0003_grants", checksum: "c" },
    ];
    expect(pendingMigrations(local, [{ version: "0001_core", checksum: "a" }])).toEqual(local.slice(1));
    expect(() => pendingMigrations(local, [{ version: "0009_unknown", checksum: "x" }])).toThrow(/unknown migration/);
    expect(() => pendingMigrations(local, [{ version: "0001_core", checksum: "bad" }])).toThrow(/Checksum mismatch/);
    expect(() => pendingMigrations(local, [{ version: "0002_guards", checksum: "b" }])).toThrow(/contiguous prefix/);
  });

  it("detects unexpected and missing PostgreSQL objects", () => {
    const expected = [
      { object_type: "relation", object_name: "r:exchange_requests" },
      { object_type: "routine", object_name: "reserve_copy(bigint, bigint, bytea, uuid)" },
    ];
    const diff = compareObjectManifest(
      [expected[0]!, { object_type: "relation", object_name: "r:unexpected" }],
      expected,
    );
    expect(diff.unexpected.map((object) => object.object_name)).toEqual(["r:unexpected"]);
    expect(diff.missing.map((object) => object.object_name)).toEqual([
      "reserve_copy(bigint, bigint, bytea, uuid)",
    ]);
  });

  it("forgets manifest rows replaced by a reviewed migration", () => {
    const actual = [
      { object_type: "relation", object_name: "r:copies" },
      { object_type: "relation", object_name: "i:copies_new_idx" },
    ];
    const manifest = [
      { object_type: "relation", object_name: "r:copies" },
      { object_type: "relation", object_name: "i:superseded_idx" },
    ];
    expect(staleManifestEntries(actual, manifest)).toEqual([
      { object_type: "relation", object_name: "i:superseded_idx" },
    ]);
  });
});

describe("SQL canonicalization", () => {
  it("normalizes CRLF, lone CR and a UTF-8 BOM without changing SQL text", () => {
    expect(canonicalizeSql("SELECT 1;\r\nSELECT 2;\rSELECT 3;")).toBe("SELECT 1;\nSELECT 2;\nSELECT 3;");
    expect(canonicalizeSql("\uFEFFSELECT 1;\r\n")).toBe("SELECT 1;\n");
    expect(canonicalizeSql("SELECT 1;  \n")).toBe("SELECT 1;  \n");
    expect(canonicalizeSql(canonicalizeSql("A\r\nB"))).toBe("A\nB");
  });

  it("keeps the versioned SQL files in LF and their canonical hashes stable", async () => {
    const expected = new Map([
      ["0001_initial_schema.sql", "cf4b22182eb763005f67ff56d03cc3726b95b2800813ccb443cfa363fc0a0a6a"],
      ["0002_corrective_schema.sql", "251ebb6946a06783afb3891006e7b146f04f7af866c5d49460bc796b401a688c"],
      ["0003_runtime_privileges.sql", "7bfbb4ad542bce617b1f186b0995d9768469bf28501bbe32afb9c8be63c65c67"],
      ["0004_p0_integrity.sql", "365c1346d481d9287666b384dd928e58367df870890190fe0d968229bc81fd87"],
      ["0005_participant_api.sql", "156be0a75a0c93d783964dd4131f76cfc190c99c6a37c66210849c384baf8b66"],
      ["0006_inventory_import.sql", "f9339387e9bf0ff6d5dc4be92763cb6e1cba2232a226a76bd2b916ba3e1e230e"],
    ]);

    for (const [file, hash] of expected) {
      const text = await readFile(resolve(process.cwd(), "db/migrations", file), "utf8");
      expect(text, `${file} must not contain CR characters`).not.toContain("\r");
      const actual = createHash("sha256").update(canonicalizeSql(text), "utf8").digest("hex");
      expect(actual, `${file} canonical hash`).toBe(hash);
    }
  });

  it("declares LF line endings for SQL in .gitattributes", async () => {
    const attributes = await readFile(resolve(process.cwd(), ".gitattributes"), "utf8");
    expect(attributes).toMatch(/^\* text=auto eol=lf$/m);
    expect(attributes).toMatch(/^\*\.sql\s+text eol=lf$/m);
  });
});

describe("manifest reconciliation planning", () => {
  it("deduplicates objects by type and name", () => {
    expect(dedupeObjects([
      { object_type: "relation", object_name: "r:copies" },
      { object_type: "relation", object_name: "r:copies" },
      { object_type: "routine", object_name: "reserve_copy()" },
    ])).toEqual([
      { object_type: "relation", object_name: "r:copies" },
      { object_type: "routine", object_name: "reserve_copy()" },
    ]);
  });

  it("attributes baseline objects to the migration that created them", () => {
    const actual = [
      { object_type: "relation", object_name: "r:copies" },
      { object_type: "relation", object_name: "r:exchange_requests" },
      { object_type: "routine", object_name: "reserve_copy()" },
    ];
    const manifest = [
      { object_type: "relation", object_name: "r:copies" },
      { object_type: "relation", object_name: "r:superseded" },
    ];

    const plan = planManifestRefresh(actual, manifest, {
      version: "0002_corrective_schema",
      baselineObjects: [actual[0]!, actual[1]!],
      baselineVersion: "0001_initial_schema",
    });

    expect(plan.stale).toEqual([{ object_type: "relation", object_name: "r:superseded" }]);
    expect(plan.inserts).toEqual([
      { object_type: "relation", object_name: "r:exchange_requests", introduced_by: "0001_initial_schema" },
      { object_type: "routine", object_name: "reserve_copy()", introduced_by: "0002_corrective_schema" },
    ]);
  });

  it("requires a baseline version when baseline objects are supplied", () => {
    expect(() => planManifestRefresh([], [], {
      version: "0002_corrective_schema",
      baselineObjects: [{ object_type: "relation", object_name: "r:copies" }],
    })).toThrow(/baseline version/i);
  });
});

describe("role membership and function allowlists", () => {
  const runtimeRoles = ["iub_public_runtime", "iub_admin_runtime"];
  const migrationRole = "iub_schema_migrator";

  it("rejects memberships held by a runtime role", () => {
    expect(() => validateRoleMemberships({
      memberships: [{
        member_name: "iub_public_runtime",
        granted_role: "pg_write_all_data",
        granted_super: false,
        granted_createrole: false,
        granted_createdb: false,
        granted_bypassrls: false,
      }],
      migrationRole,
      runtimeRoles,
    })).toThrow(/runtime role has a role membership/);
  });

  it("rejects a runtime role granted to another role", () => {
    expect(() => validateRoleMemberships({
      memberships: [{
        member_name: "someone_else",
        granted_role: "iub_admin_runtime",
        granted_super: false,
        granted_createrole: false,
        granted_createdb: false,
        granted_bypassrls: false,
      }],
      migrationRole,
      runtimeRoles,
    })).toThrow(/granted to another role/);
  });

  it("allows only the current database owner to hold runtime roles for Neon", () => {
    const membership = {
      member_name: "project_owner",
      granted_role: "iub_admin_runtime",
      granted_super: false,
      granted_createrole: false,
      granted_createdb: false,
      granted_bypassrls: false,
    };
    expect(() => validateRoleMemberships({
      memberships: [membership],
      migrationRole,
      runtimeRoles,
      databaseOwner: "project_owner",
    })).not.toThrow();
    expect(() => validateRoleMemberships({
      memberships: [{ ...membership, member_name: "other_role" }],
      migrationRole,
      runtimeRoles,
      databaseOwner: "project_owner",
    })).toThrow(/granted to another role/);
  });

  it("rejects privileged memberships of the migration role", () => {
    expect(() => validateRoleMemberships({
      memberships: [{
        member_name: "iub_schema_migrator",
        granted_role: "pg_write_all_data",
        granted_super: false,
        granted_createrole: false,
        granted_createdb: false,
        granted_bypassrls: false,
      }],
      migrationRole,
      runtimeRoles,
    })).toThrow(/privileged role membership/);
  });

  it("accepts the documented allowlists and reports extra functions", () => {
    expect(unexpectedRuntimeFunctions("iub_public_runtime", [
      "reserve_copy(bigint, bigint, bytea, uuid)",
    ])).toEqual([]);
    expect(unexpectedRuntimeFunctions("iub_public_runtime", [
      "public.reserve_copy(bigint,bigint,bytea,uuid)",
    ])).toEqual([]);
    expect(unexpectedRuntimeFunctions("iub_public_runtime", [
      "complete_exchange(bigint, uuid, bigint)",
    ])).toEqual(["complete_exchange(bigint,uuid,bigint)"]);
    expect(unexpectedRuntimeFunctions("iub_admin_runtime", [
      "schedule_delivery(bigint, text, timestamp with time zone, uuid, bigint)",
    ])).toEqual([]);
    expect(unexpectedRuntimeFunctions("iub_public_runtime", [
      "create_exchange_request(text, jsonb, uuid)",
      "get_request_status(text, bytea)",
    ])).toEqual([]);
    expect(unexpectedRuntimeFunctions("iub_admin_runtime", [
      "prepare_cataloging(bigint, text, text, text, text, bigint, uuid)",
    ])).toEqual([]);
    expect(unexpectedRuntimeFunctions("iub_admin_runtime", [
      "admin_list_accounts(bigint)",
      "admin_create_account(bigint,text,text,text)",
      "admin_set_account_active(bigint,bigint,boolean)",
      "admin_assign_role(bigint,bigint,bigint)",
      "admin_remove_role(bigint,bigint,bigint)",
    ])).toEqual([]);
  });
});
