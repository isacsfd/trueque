#!/usr/bin/env node
/**
 * Provision the two local test administrators (SP and AD) in a disposable
 * PostgreSQL database. Secrets are written only to a file outside the repo.
 *
 * Usage:
 *   TEST_ADMIN_DATABASE_URL=postgresql://... node scripts/provision-test-admins.mjs
 *   TEST_ADMIN_DATABASE_URL=postgresql://... node scripts/provision-test-admins.mjs --rotate
 *
 * The database host must be local and the database name must identify a test
 * database. No remote database is accepted.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "pg";

const SP_PERMISSIONS = [
  "account.manage",
  "requests.review",
  "offered_books.review",
  "inventory.batches.import",
  "inventory.batches.confirm",
  "inventory.batches.read",
  "stats.read",
  "inventory.admit",
  "inventory.enable",
  "exchange.plan",
  "exchange.start",
  "exchange.complete",
  "exchange.cancel",
  "delivery.schedule",
  "delivery.confirm",
  "reception.evaluate",
  "reception.return",
  "custody.transfer",
  "cataloging.validate",
  "cataloging.authorize",
  "participants.read_contact",
  "privacy.withdraw",
  "reservations.configure",
  "reservations.expire",
];
const AD_PERMISSIONS = ["requests.review"];
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "postgres"]);

function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

function parseArgs() {
  return { rotate: process.argv.includes("--rotate") };
}

function outputPath() {
  return process.env.TEST_ADMIN_OUTPUT_PATH?.trim()
    || join(homedir(), "trueque-test-admin-credentials.json");
}

async function main() {
  const url = process.env.TEST_ADMIN_DATABASE_URL?.trim();
  if (!url) {
    throw new Error("TEST_ADMIN_DATABASE_URL is required.");
  }
  const parsed = new URL(url);
  if (!LOCAL_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(`Refusing non-local database host: ${parsed.hostname}`);
  }
  if (!/test|disposable|audit/i.test(parsed.pathname)) {
    throw new Error("The database name must identify a test/disposable database.");
  }

  const { rotate } = parseArgs();
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('trueque:provision-test-admins', 0))",
    );

    const existing = await client.query(
      `SELECT id, identity_subject FROM public.app_users
       WHERE identity_issuer = 'local-test' AND identity_subject IN ('test-sp','test-ad')
       ORDER BY identity_subject`,
    );
    if (existing.rows.length > 0 && !rotate) {
      throw new Error(
        "Test administrators already exist. Use --rotate to issue new credentials and roles.",
      );
    }

    const requiredPermissions = [...new Set([...SP_PERMISSIONS, ...AD_PERMISSIONS])];
    const available = await client.query(
      "SELECT permission_key FROM public.permissions WHERE permission_key = ANY($1::text[])",
      [requiredPermissions],
    );
    const availableKeys = new Set(available.rows.map((row) => row.permission_key));
    const missing = requiredPermissions.filter((key) => !availableKeys.has(key));
    if (missing.length > 0) {
      throw new Error(`Missing permissions in the target database: ${missing.join(", ")}`);
    }

    async function ensureRole(roleKey, displayName, permissions) {
      const role = await client.query(
        `INSERT INTO public.roles (role_key, display_name, description)
         VALUES ($1, $2, $3)
         ON CONFLICT (role_key) DO UPDATE SET display_name = EXCLUDED.display_name,
           description = EXCLUDED.description
         RETURNING id`,
        [roleKey, displayName, "Identidad de pruebas local; no usar en producción."],
      );
      const roleId = Number(role.rows[0].id);
      await client.query("DELETE FROM public.role_permissions WHERE role_id = $1", [roleId]);
      await client.query(
        `INSERT INTO public.role_permissions (role_id, permission_id)
         SELECT $1, id FROM public.permissions WHERE permission_key = ANY($2::text[])`,
        [roleId, permissions],
      );
      return roleId;
    }

    const spRoleId = await ensureRole(
      "local_test_sp",
      "Pruebas SP - Superadministrador",
      SP_PERMISSIONS,
    );
    const adRoleId = await ensureRole(
      "local_test_ad",
      "Pruebas AD - Administrador",
      AD_PERMISSIONS,
    );

    async function ensureUser(subject, email) {
      const user = await client.query(
        `INSERT INTO public.app_users
           (identity_issuer, identity_subject, email, email_normalized, is_active)
         VALUES ('local-test', $1, $2, lower($2), TRUE)
         ON CONFLICT (identity_issuer, identity_subject)
         DO UPDATE SET is_active = TRUE
         RETURNING id`,
        [subject, email],
      );
      return Number(user.rows[0].id);
    }

    const spId = await ensureUser("test-sp", "test-sp@example.invalid");
    const adId = await ensureUser("test-ad", "test-ad@example.invalid");
    if (spId === adId) throw new Error("SP and AD must be different actors.");

    await client.query(
      "DELETE FROM public.user_roles WHERE user_id = ANY($1::bigint[])",
      [[spId, adId]],
    );
    await client.query(
      "INSERT INTO public.user_roles (user_id, role_id) VALUES ($1,$2),($3,$4)",
      [spId, spRoleId, adId, adRoleId],
    );

    const spPassword = randomBytes(32).toString("base64url");
    const adPassword = randomBytes(32).toString("base64url");
    const sessionSecret = randomBytes(48).toString("base64url");
    const output = {
      generatedAt: new Date().toISOString(),
      issuer: "local-test",
      warning: "LOCAL TEST ONLY. Never use these credentials in staging or production.",
      sessionSecret,
      adminUsers: [
        { username: "test-sp", passwordHash: hashPassword(spPassword), actorUserId: spId },
        { username: "test-ad", passwordHash: hashPassword(adPassword), actorUserId: adId },
      ],
      accounts: [
        {
          role: "SP",
          username: "test-sp",
          password: spPassword,
          actorUserId: spId,
          roleKey: "local_test_sp",
          permissions: SP_PERMISSIONS,
        },
        {
          role: "AD",
          username: "test-ad",
          password: adPassword,
          actorUserId: adId,
          roleKey: "local_test_ad",
          permissions: AD_PERMISSIONS,
        },
      ],
    };

    await client.query("COMMIT");
    const target = outputPath();
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.tmp-${randomBytes(6).toString("hex")}`;
    await writeFile(temporary, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rm(target, { force: true });
    await rename(temporary, target);
    await chmod(target, 0o600).catch(() => undefined);
    if (process.platform === "win32") {
      try {
        const me = execFileSync("whoami", { encoding: "utf8" }).trim();
        execFileSync("icacls", [target, "/inheritance:r", "/grant:r", `${me}:(F)`], { stdio: "ignore" });
      } catch {
        // Best effort; the operator must verify ACLs on Windows.
      }
    }

    console.log(JSON.stringify({
      ok: true,
      output: target,
      accounts: output.accounts.map(({ role, username, actorUserId, roleKey, permissions }) => ({
        role, username, actorUserId, roleKey, permissions,
      })),
      note: "Passwords are only in the output file. Do not commit or log it.",
    }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Provisioning failed.");
  process.exitCode = 1;
});
