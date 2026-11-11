import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalizeSql } from "./migration-safety.mjs";

const required = [
  "DATABASE_URL",
  "DATABASE_ADMIN_URL",
  "DATABASE_MIGRATION_URL",
  "DATABASE_MIGRATION_ROLE",
  "ADMIN_USERS",
  "SESSION_SECRET",
  "PARTICIPANT_DATA_KEY",
  "PARTICIPANT_IDENTITY_HMAC_KEY",
  "PRIVACY_NOTICE_VERSION",
  "PRIVATE_STORAGE_DRIVER",
];

const expectedHashes = new Map([
  ["0001_initial_schema.sql", "cf4b22182eb763005f67ff56d03cc3726b95b2800813ccb443cfa363fc0a0a6a"],
  ["0002_corrective_schema.sql", "251ebb6946a06783afb3891006e7b146f04f7af866c5d49460bc796b401a688c"],
  ["0003_runtime_privileges.sql", "7bfbb4ad542bce617b1f186b0995d9768469bf28501bbe32afb9c8be63c65c67"],
  ["0004_p0_integrity.sql", "365c1346d481d9287666b384dd928e58367df870890190fe0d968229bc81fd87"],
  ["0005_participant_api.sql", "156be0a75a0c93d783964dd4131f76cfc190c99c6a37c66210849c384baf8b66"],
  ["0006_inventory_import.sql", "f9339387e9bf0ff6d5dc4be92763cb6e1cba2232a226a76bd2b916ba3e1e230e"],
  ["0007_institutional_containment.sql", "5dd8a5e2743c9c998e15aacab2e3748d2fb4d42853271fe8d08968b17e6b6cd6"],
  ["0008_containment_request_compat.sql", "49ec4788d6d811d24b85207911d6e7329f0d2094353ffe3a4e322423be79fbf9"],
  ["0009_offered_book_photos.sql", "752b6adfe8d4cfd3602bc0d86de60a3e3dd91bc34087c77810d329a3d4a03d8e"],
  ["0010_inventory_batches.sql", "22c1b23a0a573a569deda86229a72530345aaaa0599e94df82b397e62df2aa1a"],
  ["0011_admin_accounts_and_request_guard.sql", "47383d1c3412c4a9d9040f3faba685a697d5fd698a826e5d255b8564e81c230c"],
  ["0012_admin_credentials.sql", "1b2ace6bcaf044b4bd2b7bbe1b1722b608614145dbab52395d8df69d7b909dc0"],
  ["0013_admin_password_login.sql", "8aece82863a1a0f82d8d9511a5cc4294d1ccca7882ca94baab89e6491fc7c068"],
  ["0014_admin_runtime_grants.sql", "9a9063e3c3267fae1d283c071f68a248ac52e96c5aaa4730a52d10dfd43daf85"],
  ["0015_release_expired_reservations.sql", "96f83e238ee1e2d1eb6ee144bb37e3dc81556154a09df97fa7cd73fb7f2fc5db"],
  ["0016_reservation_lifecycle.sql", "063a55670efdf920d265c204e8e3c077091c9e5579a45f4cc90af18211694e90"],
  ["0017_public_request_status.sql", "488b22670cb6bdd252b709ec92afcf1e900dd8264c799be06c4d2cbcf7a301e7"],
  ["0018_plan_exchange_delivery.sql", "b93a61e2f35365f81bdb7f214f3a4c99a2835b74c795888a1abaf0af3a789bb6"],
  ["0019_secure_public_status.sql", "7631936b8624b8b74018cfea25250f2813172fa8eff5952a5df24d2102be1078"],
  ["0020_inventory_integrity_repair.sql", "a39612982728bf78e0bcfed62c2f8de8a614d74c0d88541aa1fb6fb8e7f18343"],
  ["0021_admin_workbench_indexes.sql", "67e185fd6434bccc64f9f94ac1abeea65f578b8f4236ba1c66e57930e1967d90"],
  ["0022_inventory_registration.sql", "cba5105674b6e1c3499a37bccd3b8df8d8fd86dc24933034e2c2588526820089"],
  ["0023_inventory_batch_autopublish.sql", "09b24d5c96101658d650cd3c7cf874dbcc2f90a3722a4007d5e935e83a8cc93e"],
  ["0024_loans.sql", "f7ca7edec3a6d493e953a1a51870ff49239997fafdeb32c16ea9c1e662188021"],
  ["0025_loan_reactivation.sql", "af6f692e7c394152ff84dfd4af835d314e2f186ee163a371b3dd85dfe3602155"],
  ["0026_migration_chain_compat.sql", "d20ce93713cc72dde58a39ffdd64d738def54b0a47f5cc4cea0553631e621427"],
]);

const missing = required.filter((name) => !process.env[name]?.trim());
const storageErrors = [];
const driver = process.env.PRIVATE_STORAGE_DRIVER?.trim().toLowerCase();
if (driver === "local" || driver === "simulated") {
  storageErrors.push(
    `PRIVATE_STORAGE_DRIVER=${driver} is not durable in Netlify Functions; configure an approved private object storage adapter.`,
  );
}
const hashErrors = [];
const { createHash } = await import("node:crypto");

for (const [file, expected] of expectedHashes) {
  const raw = await readFile(resolve(process.cwd(), "db/migrations", file), "utf8");
  const actual = createHash("sha256").update(canonicalizeSql(raw), "utf8").digest("hex");
  if (actual !== expected) hashErrors.push(`${file}: ${actual}`);
}

console.log(JSON.stringify({
  environment: "staging",
  requiredVariables: Object.fromEntries(required.map((name) => [name, process.env[name]?.trim() ? "present" : "missing"])),
  migrationHashes: hashErrors.length === 0 ? "ok" : "mismatch",
  hashErrors,
  storage: storageErrors.length === 0 ? "ok" : "invalid",
  storageErrors,
}, null, 2));

if (missing.length > 0 || hashErrors.length > 0 || storageErrors.length > 0) {
  console.error("Staging preflight failed. Nothing was connected or deployed.");
  process.exitCode = 1;
} else {
  console.log("Staging preflight passed. The environment is ready for db:migrate:apply and deploy.");
}
