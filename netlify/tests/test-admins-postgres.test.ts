// @vitest-environment node
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const credentialsPath = process.env.TEST_ADMIN_CREDENTIALS_FILE
  || join(homedir(), "trueque-test-admin-credentials.json");
const databaseUrl = process.env.IUB_TEST_DATABASE_URL;
const hasCredentials = existsSync(credentialsPath);
const state = vi.hoisted(() => ({
  adminClient: null as Client | null,
  publicClient: null as Client | null,
}));

vi.mock("../lib/database.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/database.ts")>();
  const execute = async (client: Client, text: string, values: readonly unknown[]) => {
    try {
      const result = await client.query(text, [...values]);
      return result.rows as Record<string, unknown>[];
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
        throw new actual.DatabaseQueryError(code);
      }
      throw error;
    }
  };
  let adminQueue: Promise<void> = Promise.resolve();
  const run = (client: Client | null, text: string, values: readonly unknown[]) => {
    if (!client) return Promise.reject(new actual.DatabaseUnavailableError());
    if (client === state.adminClient) {
      const next = adminQueue.then(() => execute(client, text, values), () => execute(client, text, values));
      adminQueue = next.then(() => undefined, () => undefined);
      return next;
    }
    return execute(client, text, values);
  };
  return {
    ...actual,
    query: (text: string, values: readonly unknown[] = []) => run(state.publicClient, text, values),
    queryAdmin: (text: string, values: readonly unknown[] = []) => run(state.adminClient, text, values),
  };
});

import sessionHandler from "../functions/admin-session.ts";
import accountsHandler from "../functions/admin-accounts.ts";
import statsHandler from "../functions/admin-stats.ts";
import workbenchHandler from "../functions/admin-workbench.ts";
import actionHandler from "../functions/admin-action.ts";

interface Credentials {
  sessionSecret: string;
  adminUsers: Array<{ username: string; passwordHash: string; actorUserId: number }>;
  accounts: Array<{ role: string; username: string; password: string; actorUserId: number }>;
}

function jsonRequest(path: string, method: string, body?: unknown, cookie?: string, marker = false): Request {
  return new Request(`https://example.test${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...(marker ? { "X-IUB-Admin": "1" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe.skipIf(!databaseUrl || !hasCredentials)("provisioned SP/AD test administrators", () => {
  let credentials: Credentials;
  let migrator: Client;
  let admin: Client;
  let publicClient: Client;
  let spCookie = "";
  let adCookie = "";

  beforeAll(async () => {
    credentials = JSON.parse(await readFile(credentialsPath, "utf8")) as Credentials;
    vi.stubEnv("ADMIN_USERS", JSON.stringify(credentials.adminUsers));
    vi.stubEnv("SESSION_SECRET", credentials.sessionSecret);
    vi.stubEnv("ALLOW_LEGACY_REQUEST_INTAKE", "true");

    migrator = new Client({ connectionString: databaseUrl });
    const adminUrl = new URL(databaseUrl!);
    adminUrl.username = "iub_admin_runtime";
    adminUrl.password = "";
    admin = new Client({ connectionString: adminUrl.toString() });
    const publicUrl = new URL(databaseUrl!);
    publicUrl.username = "iub_public_runtime";
    publicUrl.password = "";
    publicClient = new Client({ connectionString: publicUrl.toString() });
    await Promise.all([migrator.connect(), admin.connect(), publicClient.connect()]);
    state.adminClient = admin;
    state.publicClient = publicClient;

    async function login(username: string, password: string): Promise<string> {
      const response = await sessionHandler(jsonRequest("/api/admin/session", "POST", { username, password }));
      expect(response.status).toBe(200);
      return response.headers.get("set-cookie")?.split(";")[0] ?? "";
    }
    spCookie = await login("test-sp", credentials.accounts.find((a) => a.role === "SP")!.password);
    adCookie = await login("test-ad", credentials.accounts.find((a) => a.role === "AD")!.password);
  }, 30_000);

  afterAll(async () => {
    await Promise.allSettled([migrator?.end(), admin?.end(), publicClient?.end()]);
    vi.unstubAllEnvs();
  });

  it("keeps distinct active actors and explicit permissions", async () => {
    const users = await migrator.query(
      `SELECT u.id, u.identity_subject, u.is_active, r.role_key,
              array_agg(p.permission_key ORDER BY p.permission_key) AS permissions
       FROM public.app_users u
       JOIN public.user_roles ur ON ur.user_id = u.id
       JOIN public.roles r ON r.id = ur.role_id
       JOIN public.role_permissions rp ON rp.role_id = r.id
       JOIN public.permissions p ON p.id = rp.permission_id
       WHERE u.identity_issuer = 'local-test'
       GROUP BY u.id, u.identity_subject, u.is_active, r.role_key
       ORDER BY u.id`,
    );
    expect(users.rows).toHaveLength(2);
    const sp = users.rows.find((row) => row.identity_subject === "test-sp");
    const ad = users.rows.find((row) => row.identity_subject === "test-ad");
    expect(sp.id).not.toBe(ad.id);
    expect(sp.is_active).toBe(true);
    expect(ad.is_active).toBe(true);
    expect(ad.permissions).toEqual(["requests.review"]);
    expect(sp.permissions).toEqual(expect.arrayContaining(["account.manage", "requests.review", "stats.read"]));
    expect(spCookie).not.toBe(adCookie);
  });

  it("enforces SP/AD separation on administrative endpoints", async () => {
    expect((await accountsHandler(jsonRequest("/api/admin/accounts", "GET", undefined, spCookie))).status).toBe(200);
    expect((await accountsHandler(jsonRequest("/api/admin/accounts", "GET", undefined, adCookie))).status).toBe(403);
    expect((await statsHandler(jsonRequest("/api/admin/stats", "GET", undefined, spCookie))).status).toBe(200);
    expect((await statsHandler(jsonRequest("/api/admin/stats", "GET", undefined, adCookie))).status).toBe(403);
    expect((await workbenchHandler(jsonRequest("/api/admin/workbench", "GET", undefined, adCookie))).status).toBe(200);
  });

  it("lets AD approve and reject with history and no inventory side effects", async () => {
    const run = Date.now().toString(36);
    const publisher = await migrator.query(
      "INSERT INTO public.publishers (name, normalized_name) VALUES ($1,$2) RETURNING id",
      [`SP/AD Pub ${run}`, `sp-ad-pub-${run}`],
    );
    const bib = await migrator.query(
      "INSERT INTO public.bibliographic_records (title, author, publisher_id) VALUES ($1,$2,$3) RETURNING id",
      [`SP/AD Title ${run}`, "Test Author", Number(publisher.rows[0].id)],
    );
    const copy = await migrator.query(
      `INSERT INTO public.copies (bibliographic_record_id, inventory_code, physical_condition, availability, provenance_type)
       VALUES ($1,$2,'good','available','preexisting') RETURNING id`,
      [Number(bib.rows[0].id), `SPAD-${run}`],
    );
    const copy2 = await migrator.query(
      `INSERT INTO public.copies (bibliographic_record_id, inventory_code, physical_condition, availability, provenance_type)
       VALUES ($1,$2,'good','available','preexisting') RETURNING id`,
      [Number(bib.rows[0].id), `SPAD2-${run}`],
    );
    const participant = await migrator.query(
      `INSERT INTO public.participants (full_name,email,email_normalized,identity_ciphertext,identity_fingerprint)
       VALUES ('Test Participant','test-participant@example.invalid','test-participant@example.invalid',$1,$2) RETURNING id`,
      [randomBytes(32), randomBytes(32)],
    );
    await migrator.query(
      `INSERT INTO public.privacy_notices (version,content_sha256,approved_at)
       VALUES ($1,$2,clock_timestamp())`,
      [`spad-notice-${run}`, Buffer.alloc(32, 3)],
    );
    const consent = await migrator.query(
      `INSERT INTO public.privacy_consents
       (participant_id,notice_version,purpose,consented_at,evidence_sha256,capture_channel,idempotency_key)
       VALUES ($1,$2,'book_exchange',clock_timestamp(),$3,'web',gen_random_uuid()) RETURNING id`,
      [Number(participant.rows[0].id), `spad-notice-${run}`, Buffer.alloc(32, 4)],
    );
    async function makeRequest(label: string, copyId: number): Promise<number> {
      const request = await migrator.query(
        `INSERT INTO public.exchange_requests
         (request_code,participant_id,requested_copy_id,status,privacy_notice_version,consented_at,privacy_consent_id)
         VALUES ($1,$2,$3,'under_review',$4,clock_timestamp(),$5) RETURNING id`,
        [`SPAD-${label}-${run}`, Number(participant.rows[0].id), copyId, `spad-notice-${run}`, Number(consent.rows[0].id)],
      );
      const requestId = Number(request.rows[0].id);
      await migrator.query(
        "INSERT INTO public.offered_books (request_id,title,author,declared_condition) VALUES ($1,$2,'Test Author','good')",
        [requestId, `Offered ${label}`],
      );
      return requestId;
    }

    const approvedId = await makeRequest("approve", Number(copy.rows[0].id));
    const approved = await actionHandler(jsonRequest("/api/admin/action", "POST", {
      action: "request.approve", requestId: approvedId, reason: "Aprobación de prueba AD",
    }, adCookie, true));
    expect(approved.status).toBe(200);
    const approvedState = await migrator.query(
      `SELECT r.status,
              (SELECT count(*)::int FROM public.receptions WHERE request_id=r.id) AS receptions,
              (SELECT count(*)::int FROM public.inventory_admissions a JOIN public.receptions rec ON rec.id=a.reception_id WHERE rec.request_id=r.id) AS admissions,
              (SELECT count(*)::int FROM public.inventory_movements m WHERE m.copy_id=r.requested_copy_id) AS movements
       FROM public.exchange_requests r WHERE r.id=$1`,
      [approvedId],
    );
    expect(approvedState.rows[0]).toEqual({ status: "approved", receptions: 0, admissions: 0, movements: 0 });

    const rejectedId = await makeRequest("reject", Number(copy2.rows[0].id));
    const rejected = await actionHandler(jsonRequest("/api/admin/action", "POST", {
      action: "request.reject", requestId: rejectedId, reason: "Denegación de prueba AD",
    }, adCookie, true));
    expect(rejected.status).toBe(200);
    const history = await migrator.query(
      "SELECT new_status, reason, changed_by FROM public.request_status_history WHERE request_id=$1",
      [rejectedId],
    );
    expect(history.rows[0]).toMatchObject({ new_status: "rejected", reason: "Denegación de prueba AD", changed_by: String(credentials.accounts.find((a) => a.role === "AD")!.actorUserId) });

    const missingReason = await actionHandler(jsonRequest("/api/admin/action", "POST", {
      action: "request.approve", requestId: approvedId,
    }, adCookie, true));
    expect(missingReason.status).toBe(400);
  }, 60_000);
});
