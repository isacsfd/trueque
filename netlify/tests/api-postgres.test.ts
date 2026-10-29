// @vitest-environment node
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSessionToken, hashPassword } from "../lib/auth.ts";

process.env.ALLOW_LEGACY_REQUEST_INTAKE = "true";
const databaseUrl = process.env.IUB_TEST_DATABASE_URL;
const state = vi.hoisted(() => ({
  publicClient: null as Client | null,
  adminClient: null as Client | null,
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
      const next = adminQueue.then(
        () => execute(client, text, values),
        () => execute(client, text, values),
      );
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

import catalogHandler from "../functions/catalog.ts";
import requestsHandler from "../functions/requests.ts";
import reserveHandler from "../functions/requests-reserve.ts";
import statusHandler from "../functions/requests-status.ts";
import sessionHandler from "../functions/admin-session.ts";
import workbenchHandler from "../functions/admin-workbench.ts";
import accountsHandler from "../functions/admin-accounts.ts";
import statsHandler from "../functions/admin-stats.ts";
import adminEvidenceHandler from "../functions/admin-evidence.ts";
import batchesListHandler from "../functions/admin-batches-list.ts";
import actionHandler from "../functions/admin-action.ts";

function roleUrl(base: string, role: string): string {
  const url = new URL(base);
  url.username = role;
  url.password = "";
  return url.toString();
}

async function jsonRequest(url: string, method: string, body?: unknown, cookie?: string, marker = false): Promise<Request> {
  return new Request(url, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...(marker ? { "X-IUB-Admin": "1" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function login(username: string): Promise<string> {
  const response = await sessionHandler(
    await jsonRequest("https://example.test/api/admin/session", "POST", { username, password: "staging-password-long" }),
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  expect(cookie).toBeTruthy();
  return cookie as string;
}

async function action(cookie: string, body: Record<string, unknown>) {
  return actionHandler(
    await jsonRequest("https://example.test/api/admin/action", "POST", {
      ...body,
      idempotencyKey: body.idempotencyKey ?? crypto.randomUUID(),
    }, cookie, true),
  );
}

describe.skipIf(!databaseUrl)("API + PostgreSQL full lifecycle", () => {
  const runId = Date.now().toString(36);
  let migrator: Client;
  let adminClient: Client;
  let publicClient: Client;
  let copyId = "";
  let copyId2 = "";
  let managerId = "";
  let authorizerId = "";
  let managerCookie = "";
  let authorizerCookie = "";
  let requestCode = "";
  let accessToken = "";
  let requestId = "";

  beforeAll(async () => {
    migrator = new Client({ connectionString: databaseUrl });
    adminClient = new Client({ connectionString: roleUrl(databaseUrl as string, "iub_admin_runtime") });
    publicClient = new Client({ connectionString: roleUrl(databaseUrl as string, "iub_public_runtime") });
    await Promise.all([migrator.connect(), adminClient.connect(), publicClient.connect()]);
    state.publicClient = publicClient;
    state.adminClient = adminClient;

    const managerHash = hashPassword("staging-password-long");
    const authorizerHash = hashPassword("staging-password-long");
    vi.stubEnv("SESSION_SECRET", "integration-session-secret-with-at-least-32-bytes");
    vi.stubEnv("PARTICIPANT_DATA_KEY", Buffer.alloc(32, 1).toString("base64"));
    vi.stubEnv("PARTICIPANT_IDENTITY_HMAC_KEY", Buffer.alloc(32, 2).toString("base64"));
    vi.stubEnv("PARTICIPANT_DATA_KEY_VERSION", "1");
    vi.stubEnv("PARTICIPANT_HMAC_KEY_VERSION", "1");
    vi.stubEnv("PRIVACY_NOTICE_VERSION", `notice-${runId}`);

    await migrator.query(
      `INSERT INTO public.privacy_notices (version, content_sha256, approved_at)
       VALUES ($1, $2, clock_timestamp())`,
      [`notice-${runId}`, Buffer.alloc(32, 3)],
    );
    const publisher = await migrator.query(
      "INSERT INTO public.publishers (name, normalized_name) VALUES ($1, $2) RETURNING id",
      [`Editorial ${runId}`, `editorial-${runId}`],
    );
    const genre = await migrator.query(
      "INSERT INTO public.genres (name, normalized_name) VALUES ($1, $2) RETURNING id",
      [`Genero ${runId}`, `genero-${runId}`],
    );
    const bib = await migrator.query(
      "INSERT INTO public.bibliographic_records (title, author, publisher_id, genre_id) VALUES ($1, $2, $3, $4) RETURNING id",
      [`Catalogo ${runId}`, "Autor", Number(publisher.rows[0].id), Number(genre.rows[0].id)],
    );
    const copy = await migrator.query(
      `INSERT INTO public.copies (bibliographic_record_id, inventory_code, physical_condition, availability, provenance_type)
       VALUES ($1, $2, 'good', 'available', 'preexisting') RETURNING id`,
      [Number(bib.rows[0].id), `IUB-${runId}`],
    );
    copyId = String(copy.rows[0].id);

    const bib2 = await migrator.query(
      "INSERT INTO public.bibliographic_records (title, author, publisher_id, genre_id) VALUES ($1, $2, $3, $4) RETURNING id",
      [`Catalogo 2 ${runId}`, "Autor 2", Number(publisher.rows[0].id), Number(genre.rows[0].id)],
    );
    const copy2 = await migrator.query(
      `INSERT INTO public.copies (bibliographic_record_id, inventory_code, physical_condition, availability, provenance_type)
       VALUES ($1, $2, 'good', 'available', 'preexisting') RETURNING id`,
      [Number(bib2.rows[0].id), `IUB-2-${runId}`],
    );
    copyId2 = String(copy2.rows[0].id);

    async function actor(name: string, roleKey: string, permissions: string[]): Promise<string> {
      const user = await migrator.query(
        "INSERT INTO public.app_users (identity_issuer, identity_subject) VALUES ('https://test', $1) RETURNING id",
        [`${runId}-${name}`],
      );
      const role = await migrator.query(
        "INSERT INTO public.roles (role_key, display_name) VALUES ($1, $1) RETURNING id",
        [`${runId}_${roleKey}`],
      );
      const userId = String(user.rows[0].id);
      const roleId = Number(role.rows[0].id);
      await migrator.query("INSERT INTO public.user_roles (user_id, role_id) VALUES ($1, $2)", [userId, roleId]);
      for (const permission of permissions) {
        await migrator.query(
          "INSERT INTO public.role_permissions (role_id, permission_id) SELECT $1, id FROM public.permissions WHERE permission_key = $2",
          [roleId, permission],
        );
      }
      return userId;
    }

    managerId = await actor("manager", "manager", [
      "requests.review", "exchange.plan", "delivery.schedule", "delivery.confirm",
      "reception.evaluate", "cataloging.validate", "custody.transfer", "inventory.admit", "inventory.enable",
      "exchange.start", "exchange.complete", "exchange.cancel", "account.manage", "stats.read",
    ]);
    authorizerId = await actor("authorizer", "authorizer", ["cataloging.authorize"]);
    await migrator.query(
      `INSERT INTO public.reservation_policy (policy_id, duration_seconds, updated_by)
       VALUES (1, 3600, $1)
       ON CONFLICT (policy_id) DO UPDATE SET duration_seconds = EXCLUDED.duration_seconds`,
      [Number(managerId)],
    );

    vi.stubEnv("ADMIN_USERS", JSON.stringify([
      { username: "manager", passwordHash: managerHash, actorUserId: Number(managerId) },
      { username: "authorizer", passwordHash: authorizerHash, actorUserId: Number(authorizerId) },
    ]));
    managerCookie = await login("manager");
    authorizerCookie = await login("authorizer");
  }, 30_000);

  afterAll(async () => {
    await Promise.allSettled([migrator?.end(), adminClient?.end(), publicClient?.end()]);
    vi.unstubAllEnvs();
  });

  it("runs the participant and administrative lifecycle through the API", async () => {
    const catalogResponse = await catalogHandler(await jsonRequest("https://example.test/api/catalog", "GET"));
    expect(catalogResponse.status).toBe(200);
    expect((await catalogResponse.json()).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ copyId, title: `Catalogo ${runId}` }),
    ]));

    const createdResponse = await requestsHandler(await jsonRequest("https://example.test/api/requests", "POST", {
      copyId,
      participantName: `Participante ${runId}`,
      participantEmail: `participant-${runId}@example.test`,
      participantDocument: `DOC-${runId}`,
      offeredTitle: `Ofrecido ${runId}`,
      offeredAuthor: "Autora",
      offeredCondition: "good",
      consent: true,
      idempotencyKey: crypto.randomUUID(),
    }));
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();
    requestId = created.requestId;
    requestCode = created.requestCode;
    accessToken = created.accessToken;
    expect(JSON.stringify(created)).not.toContain("Participante");
    expect(JSON.stringify(created)).not.toContain("example.test");

    const reserved = await reserveHandler(await jsonRequest("https://example.test/api/requests/reserve", "POST", {
      requestId,
      copyId,
      accessToken,
      idempotencyKey: crypto.randomUUID(),
    }));
    expect(reserved.status).toBe(201);

    for (const next of [
      { action: "request.review", requestId },
      { action: "request.approve", requestId, reason: "Aprobación de prueba API PostgreSQL" },
      { action: "exchange.plan", requestId, receiptCode: `REC-${runId}`, planningKey: crypto.randomUUID() },
    ]) {
      const response = await action(managerCookie, next);
      expect(response.status).toBe(200);
    }

    const workbenchResponse = await workbenchHandler(await jsonRequest("https://example.test/api/admin/workbench", "GET", undefined, managerCookie));
    expect(workbenchResponse.status).toBe(200);
    let workbench = await workbenchResponse.json();
    let item = workbench.items.find((candidate: { requestCode: string }) => candidate.requestCode === requestCode);
    expect(item).toBeTruthy();
    expect(item.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ newStatus: "approved", reason: "Aprobación de prueba API PostgreSQL" }),
    ]));

    const accountsResponse = await accountsHandler(await jsonRequest("https://example.test/api/admin/accounts", "GET", undefined, managerCookie));
    expect(accountsResponse.status).toBe(200);
    const accountsBody = await accountsResponse.json();
    expect(accountsBody.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ identitySubject: `${runId}-manager`, isActive: true }),
    ]));
    expect(JSON.stringify(accountsBody)).not.toMatch(/passwordHash|SESSION_SECRET/);

    const createAccountResponse = await accountsHandler(await jsonRequest("https://example.test/api/admin/accounts", "POST", {
      action: "create",
      identityIssuer: "integration",
      identitySubject: `created-${runId}`,
      email: `created-${runId}@example.test`,
    }, managerCookie, true));
    expect(createAccountResponse.status).toBe(200);

    const statsResponse = await statsHandler(await jsonRequest("https://example.test/api/admin/stats?months=3", "GET", undefined, managerCookie));
    expect(statsResponse.status).toBe(200);
    const statsBody = await statsResponse.json();
    expect(statsBody.range).toEqual({ months: 3 });
    const copyCount = await migrator.query("SELECT count(*)::int AS count FROM public.copies");
    const requestCount = await migrator.query("SELECT count(*)::int AS count FROM public.exchange_requests");
    expect(statsBody.inventory.totalCopies).toBe(copyCount.rows[0].count);
    expect(Object.values(statsBody.requests as Record<string, number>).reduce((total, value) => total + Number(value), 0)).toBe(requestCount.rows[0].count);
    expect(statsBody.trends.requests.length).toBeGreaterThan(0);

    const dropoff = await action(managerCookie, {
      action: "delivery.schedule", exchangeId: item.exchangeId, deliveryType: "offered_book_dropoff",
    });
    expect(dropoff.status).toBe(200);

    workbench = await (await workbenchHandler(await jsonRequest("https://example.test/api/admin/workbench", "GET", undefined, managerCookie))).json();
    item = workbench.items.find((candidate: { requestCode: string }) => candidate.requestCode === requestCode);
    const dropoffDelivery = item.deliveries.find((delivery: { type: string }) => delivery.type === "offered_book_dropoff");
    const confirmDropoff = await action(managerCookie, {
      action: "delivery.confirm", deliveryId: dropoffDelivery.id,
      receiptReference: `dropoff-${runId}`, idempotencyKey: dropoffDelivery.idempotencyKey,
    });
    expect(confirmDropoff.status).toBe(200);

    for (const next of [
      { action: "reception.custody", receptionId: item.receptionId, location: "Shelf", custodian: "Custodio", evidenceReference: `custody-${runId}` },
      { action: "reception.evaluate", receptionId: item.receptionId, outcome: "accepted", assessedCondition: "good", rationale: "ok", evidenceReference: `eval-${runId}` },
      { action: "cataloging.prepare", receptionId: item.receptionId, title: `Catalogado ${runId}`, author: "Autora", validationKey: crypto.randomUUID() },
    ]) {
      const response = await action(managerCookie, next);
      expect(response.status).toBe(200);
    }

    workbench = await (await workbenchHandler(await jsonRequest("https://example.test/api/admin/workbench", "GET", undefined, managerCookie))).json();
    item = workbench.items.find((candidate: { requestCode: string }) => candidate.requestCode === requestCode);
    const authorizeCataloging = await action(authorizerCookie, {
      action: "cataloging.authorize", catalogingId: item.catalogingId, authorizationKey: crypto.randomUUID(),
    });
    expect(authorizeCataloging.status).toBe(200);

    for (const next of [
      { action: "admission.authorize", receptionId: item.receptionId },
    ]) {
      const response = await action(managerCookie, next);
      expect(response.status).toBe(200);
      const result = await response.json();
      item.admissionId = result.result.authorize_inventory_admission;
    }
    for (const next of [
      { action: "admission.admit", admissionId: item.admissionId, inventoryCode: `IUB-REC-${runId}`, location: "Shelf" },
      { action: "admission.enable", admissionId: item.admissionId },
      { action: "exchange.start", exchangeId: item.exchangeId },
      { action: "delivery.schedule", exchangeId: item.exchangeId, deliveryType: "institutional_copy_handover" },
    ]) {
      const response = await action(managerCookie, next);
      expect(response.status).toBe(200);
    }

    workbench = await (await workbenchHandler(await jsonRequest("https://example.test/api/admin/workbench", "GET", undefined, managerCookie))).json();
    item = workbench.items.find((candidate: { requestCode: string }) => candidate.requestCode === requestCode);
    const handover = item.deliveries.find((delivery: { type: string }) => delivery.type === "institutional_copy_handover");
    expect((await action(managerCookie, {
      action: "delivery.confirm", deliveryId: handover.id,
      receiptReference: `handover-${runId}`, idempotencyKey: handover.idempotencyKey,
    })).status).toBe(200);
    expect((await action(managerCookie, {
      action: "exchange.complete", exchangeId: item.exchangeId, completionKey: crypto.randomUUID(),
    })).status).toBe(200);

    const statusResponse = await statusHandler(await jsonRequest("https://example.test/api/requests/status", "POST", {
      code: requestCode, token: accessToken,
    }));
    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({ status: "completed" });

    const final = await migrator.query(
      `SELECT c.availability FROM public.copies c
       JOIN public.inventory_admissions a ON a.copy_id = c.id
       JOIN public.receptions r ON r.id = a.reception_id
       JOIN public.exchanges e ON e.offered_reception_id = r.id
       JOIN public.exchange_requests q ON q.id = e.request_id
       WHERE q.request_code = $1`,
      [requestCode],
    );
    expect(final.rows[0].availability).toBe("available");
  }, 60_000);

  it("runs the physical-return cancellation flow through the API", async () => {
    const createdResponse = await requestsHandler(await jsonRequest("https://example.test/api/requests", "POST", {
      copyId: copyId2,
      participantName: `Cancelacion ${runId}`,
      participantEmail: `cancel-${runId}@example.test`,
      participantDocument: `CANCEL-${runId}`,
      offeredTitle: `Ofrecido cancel ${runId}`,
      offeredAuthor: "Autora",
      offeredCondition: "good",
      consent: true,
      idempotencyKey: crypto.randomUUID(),
    }));
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();
    const cancelRequestCode = created.requestCode;
    const cancelToken = created.accessToken;
    expect((await reserveHandler(await jsonRequest("https://example.test/api/requests/reserve", "POST", {
      requestId: created.requestId,
      copyId: copyId2,
      accessToken: cancelToken,
      idempotencyKey: crypto.randomUUID(),
    }))).status).toBe(201);

    for (const next of [
      { action: "request.review", requestId: created.requestId },
      { action: "request.approve", requestId: created.requestId, reason: "Aprobación de prueba API PostgreSQL" },
      { action: "exchange.plan", requestId: created.requestId, receiptCode: `REC-CANCEL-${runId}`, planningKey: crypto.randomUUID() },
    ]) {
      expect((await action(managerCookie, next)).status).toBe(200);
    }

    let workbench = await (await workbenchHandler(await jsonRequest("https://example.test/api/admin/workbench", "GET", undefined, managerCookie))).json();
    let item = workbench.items.find((candidate: { requestCode: string }) => candidate.requestCode === cancelRequestCode);
    expect(item).toBeTruthy();

    expect((await action(managerCookie, {
      action: "delivery.schedule", exchangeId: item.exchangeId, deliveryType: "offered_book_dropoff",
    })).status).toBe(200);
    workbench = await (await workbenchHandler(await jsonRequest("https://example.test/api/admin/workbench", "GET", undefined, managerCookie))).json();
    item = workbench.items.find((candidate: { requestCode: string }) => candidate.requestCode === cancelRequestCode);
    const dropoff = item.deliveries.find((delivery: { type: string }) => delivery.type === "offered_book_dropoff");
    expect((await action(managerCookie, {
      action: "delivery.confirm", deliveryId: dropoff.id,
      receiptReference: `dropoff-cancel-${runId}`, idempotencyKey: dropoff.idempotencyKey,
    })).status).toBe(200);
    expect((await action(managerCookie, {
      action: "reception.custody", receptionId: item.receptionId,
      location: "Shelf", custodian: "Custodio", evidenceReference: `custody-cancel-${runId}`,
    })).status).toBe(200);

    const cancellationKey = crypto.randomUUID();
    expect((await action(managerCookie, {
      action: "exchange.cancel", exchangeId: item.exchangeId,
      cancellationKey, reason: "cancelación de prueba",
    })).status).toBe(200);

    workbench = await (await workbenchHandler(await jsonRequest("https://example.test/api/admin/workbench", "GET", undefined, managerCookie))).json();
    item = workbench.items.find((candidate: { requestCode: string }) => candidate.requestCode === cancelRequestCode);
    expect(item.exchangeStatus).toBe("cancellation_pending");
    expect(item.receptionStatus).toBe("return_pending");
    const returnDelivery = item.deliveries.find((delivery: { type: string }) => delivery.type === "offered_book_return");
    expect(returnDelivery.status).toBe("scheduled");
    expect((await action(managerCookie, {
      action: "delivery.confirm", deliveryId: returnDelivery.id,
      receiptReference: `return-cancel-${runId}`, idempotencyKey: returnDelivery.idempotencyKey,
    })).status).toBe(200);

    workbench = await (await workbenchHandler(await jsonRequest("https://example.test/api/admin/workbench", "GET", undefined, managerCookie))).json();
    item = workbench.items.find((candidate: { requestCode: string }) => candidate.requestCode === cancelRequestCode);
    expect((await action(managerCookie, {
      action: "exchange.cancel", exchangeId: item.exchangeId,
      cancellationKey: item.cancellationKey, reason: "devolución confirmada",
    })).status).toBe(200);

    const statusResponse = await statusHandler(await jsonRequest("https://example.test/api/requests/status", "POST", {
      code: cancelRequestCode, token: cancelToken,
    }));
    expect(await statusResponse.json()).toMatchObject({ status: "cancelled" });
    const state = await migrator.query(
      `SELECT r.status AS reception_status,
              (SELECT count(*)::int FROM public.inventory_admissions a WHERE a.reception_id = r.id) AS admissions
       FROM public.receptions r
       JOIN public.exchanges e ON e.offered_reception_id = r.id
       JOIN public.exchange_requests q ON q.id = e.request_id
       WHERE q.request_code = $1`,
      [cancelRequestCode],
    );
    expect(state.rows[0]).toEqual({ reception_status: "returned", admissions: 0 });
  }, 60_000);

  it("rejects login for an inactive administrative actor", async () => {
    const inactiveSubject = `inactive-${runId}`;
    const inactive = await migrator.query(
      `INSERT INTO public.app_users (identity_issuer, identity_subject, is_active)
       VALUES ('integration', $1, FALSE) RETURNING id`,
      [inactiveSubject],
    );
    const inactiveId = Number(inactive.rows[0].id);
    vi.stubEnv("ADMIN_USERS", JSON.stringify([{
      username: inactiveSubject,
      passwordHash: hashPassword("inactive-password-long"),
      actorUserId: inactiveId,
    }]));

    const response = await sessionHandler(await jsonRequest("https://example.test/api/admin/session", "POST", {
      username: inactiveSubject,
      password: "inactive-password-long",
    }));
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();

    const token = createSessionToken({
      username: inactiveSubject,
      actorUserId: inactiveId,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });
    const existingSession = await sessionHandler(new Request("https://example.test/api/admin/session", {
      method: "GET",
      headers: { cookie: `iub_admin_session=${encodeURIComponent(token)}` },
    }));
    expect(existingSession.status).toBe(401);
  });

  it("revokes an existing session across administrative endpoints after deactivation", async () => {
    await migrator.query("UPDATE public.app_users SET is_active = FALSE WHERE id = $1", [Number(managerId)]);

    const requests = [
      await workbenchHandler(await jsonRequest("https://example.test/api/admin/workbench", "GET", undefined, managerCookie)),
      await statsHandler(await jsonRequest("https://example.test/api/admin/stats", "GET", undefined, managerCookie)),
      await accountsHandler(await jsonRequest("https://example.test/api/admin/accounts", "GET", undefined, managerCookie)),
      await adminEvidenceHandler(await jsonRequest("https://example.test/api/admin/evidence?id=1", "GET", undefined, managerCookie)),
      await batchesListHandler(await jsonRequest("https://example.test/api/admin/batches/list", "GET", undefined, managerCookie)),
      await actionHandler(await jsonRequest("https://example.test/api/admin/action", "POST", {
        action: "request.review",
        requestId: 1,
      }, managerCookie, true)),
    ];
    expect(requests.map((response) => response.status)).toEqual([401, 401, 401, 401, 401, 401]);
  });
});
