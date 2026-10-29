// @vitest-environment node
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const migrationNames = [
  "0001_initial_schema.sql",
  "0002_corrective_schema.sql",
  "0003_runtime_privileges.sql",
  "0004_p0_integrity.sql",
  "0005_participant_api.sql",
  "0006_inventory_import.sql",
  "0007_institutional_containment.sql",
  "0008_containment_request_compat.sql",
];

const digest = (byte: number) => Buffer.alloc(32, byte);

type CopyOptions = {
  label: string;
  provenance?: string;
  availability?: string;
  condition?: string;
  verified?: boolean;
};

async function migrationText(name: string): Promise<string> {
  return readFile(new URL(`./${name}`, import.meta.url), "utf8");
}

async function createDatabase(upTo = migrationNames.length): Promise<PGlite> {
  const database = new PGlite();
  await database.waitReady;
  await database.exec(`
    CREATE ROLE iub_schema_migrator LOGIN;
    CREATE ROLE iub_public_runtime LOGIN;
    CREATE ROLE iub_admin_runtime LOGIN;
    GRANT USAGE, CREATE ON SCHEMA public TO iub_schema_migrator;
    SET ROLE iub_schema_migrator;
  `);
  await database.exec("BEGIN");
  for (const name of migrationNames.slice(0, upTo)) {
    await database.exec(await migrationText(name));
  }
  await database.exec("COMMIT");
  await database.exec("RESET ROLE");
  return database;
}

describe("P0 institutional containment", () => {
  let database: PGlite;
  let sequence = 0;
  let verifierId: number;

  beforeEach(async () => {
    database = await createDatabase();
    const verifier = await database.query<{ id: string }>(
      `INSERT INTO public.app_users (identity_issuer, identity_subject)
       VALUES ('https://issuer.test', 'containment-verifier') RETURNING id`,
    );
    verifierId = Number(verifier.rows[0]!.id);
    await database.query(
      `INSERT INTO public.reservation_policy (policy_id, duration_seconds, updated_by)
       VALUES (1, 3600, $1) ON CONFLICT (policy_id) DO NOTHING`,
      [verifierId],
    );
  });

  afterEach(async () => {
    await database.close();
  });

  async function createBibliographic(label: string): Promise<number> {
    const publisher = await database.query<{ id: string }>(
      `INSERT INTO public.publishers (name, normalized_name)
       VALUES ($1, $2) RETURNING id`,
      [`Editorial ${label}`, `editorial-${label}`],
    );
    const genre = await database.query<{ id: string }>(
      `INSERT INTO public.genres (name, normalized_name)
       VALUES ($1, $2) RETURNING id`,
      [`Genero ${label}`, `genero-${label}`],
    );
    const bib = await database.query<{ id: string }>(
      `INSERT INTO public.bibliographic_records (title, author, publisher_id, genre_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [`Titulo ${label}`, `Autor ${label}`, Number(publisher.rows[0]!.id), Number(genre.rows[0]!.id)],
    );
    return Number(bib.rows[0]!.id);
  }

  async function createCopy(options: CopyOptions): Promise<number> {
    const suffix = `${++sequence}-${options.label}`;
    const bibId = await createBibliographic(suffix);
    const provenance = options.provenance ?? "institutional";
    const availability = options.availability ?? "unavailable";
    const condition = options.condition ?? "unassessed";
    const verified = options.verified ?? false;

    const result = await database.query<{ id: string }>(
      `INSERT INTO public.copies
        (bibliographic_record_id, inventory_code, physical_condition, availability,
         provenance_type, verified_at, verified_by, verification_reference)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        bibId,
        `COPY-${suffix}`,
        condition,
        availability,
        provenance,
        verified ? new Date() : null,
        verified ? verifierId : null,
        verified ? `evidence-${suffix}` : null,
      ],
    );
    return Number(result.rows[0]!.id);
  }

  async function createLegacyUnverifiedAvailable(label: string): Promise<number> {
    await database.exec(
      "ALTER TABLE public.copies DISABLE TRIGGER copies_institutional_eligibility_guard",
    );
    try {
      return await createCopy({
        label,
        availability: "available",
        condition: "unassessed",
        verified: false,
      });
    } finally {
      await database.exec(
        "ALTER TABLE public.copies ENABLE TRIGGER copies_institutional_eligibility_guard",
      );
    }
  }

  async function createRequest(copyId: number, label: string): Promise<{ requestId: number; accessHash: Buffer }> {
    const suffix = `${++sequence}-${label}`;
    const noticeVersion = "notice-containment";
    await database.query(
      `INSERT INTO public.privacy_notices (version, content_sha256, approved_at)
       VALUES ($1, $2, clock_timestamp()) ON CONFLICT (version) DO NOTHING`,
      [noticeVersion, digest(80)],
    );
    const participant = await database.query<{ id: string }>(
      `INSERT INTO public.participants
        (full_name_ciphertext, full_name_key_version, email_ciphertext, email_key_version,
         identity_ciphertext, identity_key_version)
       VALUES ($1, 1, $2, 1, $3, 1) RETURNING id`,
      [Buffer.from(`name-${suffix}`), Buffer.from(`email-${suffix}`), Buffer.from(`id-${suffix}`)],
    );
    const participantId = Number(participant.rows[0]!.id);
    const accessHash = digest(sequence % 250);
    await database.query(
      `INSERT INTO public.participant_document_fingerprints
        (participant_id, hmac_key_version, fingerprint) VALUES ($1, 1, $2)`,
      [participantId, digest((sequence + 20) % 250)],
    );
    const consent = await database.query<{ id: string }>(
      `INSERT INTO public.privacy_consents
        (participant_id, notice_version, purpose, consented_at, evidence_sha256,
         capture_channel, idempotency_key)
       VALUES ($1, $2, 'book_exchange', clock_timestamp(), $3, 'web', gen_random_uuid())
       RETURNING id`,
      [participantId, noticeVersion, digest((sequence + 40) % 250)],
    );
    const request = await database.query<{ id: string }>(
      `INSERT INTO public.exchange_requests
        (request_code, participant_id, requested_copy_id, privacy_consent_id,
         request_access_token_sha256, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, gen_random_uuid()) RETURNING id`,
      [`REQ-${suffix}`, participantId, copyId, Number(consent.rows[0]!.id), accessHash],
    );
    const requestId = Number(request.rows[0]!.id);
    await database.query(
      `INSERT INTO public.offered_books (request_id, title, author, declared_condition)
       VALUES ($1, $2, $3, 'good')`,
      [requestId, `Ofertado ${suffix}`, `Autor ofertado ${suffix}`],
    );
    return { requestId, accessHash };
  }

  async function reserve(copyId: number, requestId: number, accessHash: Buffer, key: string) {
    return database.query<{ reservation_id: string }>(
      "SELECT * FROM public.reserve_copy($1, $2, $3, $4)",
      [copyId, requestId, accessHash, key],
    );
  }

  it("withholds an unassessed institutional copy and rejects a direct availability flip", async () => {
    const copyId = await createCopy({ label: "unassessed" });

    const catalog = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.available_catalog WHERE copy_id = $1",
      [copyId],
    );
    expect(catalog.rows[0]?.count).toBe(0);

    await expect(
      database.query("UPDATE public.copies SET availability = 'available' WHERE id = $1", [copyId]),
    ).rejects.toThrow(/unverified institutional copy/);

    await expect(createRequest(copyId, "unassessed-request")).rejects.toThrow(
      /not enabled for an exchange request/,
    );

    const state = await database.query<{ availability: string; verified_at: string | null }>(
      "SELECT availability, verified_at FROM public.copies WHERE id = $1",
      [copyId],
    );
    expect(state.rows[0]).toEqual({ availability: "unavailable", verified_at: null });
  });

  it("rejects the participant intake function for an unverified institutional copy", async () => {
    const copyId = await createCopy({ label: "intake-unverified" });
    await database.query(
      `INSERT INTO public.privacy_notices (version, content_sha256, approved_at)
       VALUES ('notice-intake', $1, clock_timestamp())`,
      [digest(84)],
    );
    const hex = (byte: string) => byte.repeat(32);
    const payload = JSON.stringify({
      participant: {
        fullNameCiphertext: hex("aa"),
        fullNameKeyVersion: 1,
        emailCiphertext: hex("bb"),
        emailKeyVersion: 1,
        identityCiphertext: hex("cc"),
        identityKeyVersion: 1,
        identityFingerprint: hex("dd"),
        hmacKeyVersion: 1,
      },
      consent: { noticeVersion: "notice-intake", evidenceSha256: hex("ee") },
      request: { requestedCopyId: copyId, accessTokenSha256: hex("ff") },
      offeredBook: {
        title: "Ofertado",
        author: "Autor",
        declaredCondition: "good",
        isbn: null,
        isbnNormalized: null,
      },
    });

    await expect(
      database.query(
        "SELECT * FROM public.create_exchange_request($1, $2::jsonb, $3)",
        ["INTAKE-REJECT", payload, "10000000-0000-4000-8000-000000000107"],
      ),
    ).rejects.toThrow(/not enabled for an exchange request/);

    const counts = await database.query<{
      participants: number;
      consents: number;
      requests: number;
      offered: number;
    }>(`
      SELECT
        (SELECT count(*)::int FROM public.participants) AS participants,
        (SELECT count(*)::int FROM public.privacy_consents) AS consents,
        (SELECT count(*)::int FROM public.exchange_requests) AS requests,
        (SELECT count(*)::int FROM public.offered_books) AS offered
    `);
    expect(counts.rows[0]).toEqual({ participants: 0, consents: 0, requests: 0, offered: 0 });
  });

  it("allows a positively verified institutional copy and one reservation", async () => {
    const copyId = await createCopy({
      label: "verified",
      condition: "good",
      verified: true,
    });
    await database.query("UPDATE public.copies SET availability = 'available' WHERE id = $1", [copyId]);

    const first = await createRequest(copyId, "verified-first");
    const second = await createRequest(copyId, "verified-second");

    const catalog = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.available_catalog WHERE copy_id = $1",
      [copyId],
    );
    expect(catalog.rows[0]?.count).toBe(1);

    await expect(
      reserve(copyId, first.requestId, first.accessHash, "10000000-0000-4000-8000-000000000101"),
    ).resolves.toBeTruthy();
    await expect(
      reserve(copyId, second.requestId, second.accessHash, "10000000-0000-4000-8000-000000000102"),
    ).rejects.toThrow(/not available/);

    const state = await database.query<{
      availability: string;
      reservations: number;
      movements: number;
    }>(
      `SELECT c.availability,
              (SELECT count(*)::int FROM public.reservations r WHERE r.copy_id = c.id AND r.status = 'active') AS reservations,
              (SELECT count(*)::int FROM public.inventory_movements m WHERE m.copy_id = c.id) AS movements
       FROM public.copies c WHERE c.id = $1`,
      [copyId],
    );
    expect(state.rows[0]).toEqual({ availability: "reserved", reservations: 1, movements: 1 });
  });

  it("keeps non-institutional copies eligible and reservations working", async () => {
    const copyId = await createCopy({
      label: "preexisting",
      provenance: "preexisting",
      availability: "available",
      condition: "good",
    });
    const request = await createRequest(copyId, "preexisting-request");

    const catalog = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.available_catalog WHERE copy_id = $1",
      [copyId],
    );
    expect(catalog.rows[0]?.count).toBe(1);

    await expect(
      reserve(copyId, request.requestId, request.accessHash, "10000000-0000-4000-8000-000000000103"),
    ).resolves.toBeTruthy();
  });

  it("rejects a legacy unverified available copy at request and reservation gates", async () => {
    const copyId = await createLegacyUnverifiedAvailable("legacy");

    const catalog = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.available_catalog WHERE copy_id = $1",
      [copyId],
    );
    expect(catalog.rows[0]?.count).toBe(0);

    await expect(createRequest(copyId, "legacy-request")).rejects.toThrow(
      /not enabled for an exchange request/,
    );
    const reservationCount = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.reservations",
    );
    expect(reservationCount.rows[0]?.count).toBe(0);
  });

  it("rejects verification without evidence, unassessed verification and provenance changes", async () => {
    const copyId = await createCopy({ label: "evidence" });

    await expect(
      database.query(
        "UPDATE public.copies SET verified_at = clock_timestamp() WHERE id = $1",
        [copyId],
      ),
    ).rejects.toThrow(/requires an actor and an evidence reference/);

    await expect(
      database.query(
        `UPDATE public.copies
         SET verified_at = clock_timestamp(), verified_by = $2, verification_reference = 'evidence'
         WHERE id = $1`,
        [copyId, verifierId],
      ),
    ).rejects.toThrow(/unassessed physical condition/);

    const verified = await createCopy({
      label: "verified-provenance",
      condition: "good",
      verified: true,
    });
    await database.query("UPDATE public.copies SET availability = 'available' WHERE id = $1", [verified]);

    await expect(
      database.query(
        `UPDATE public.copies
         SET verified_at = NULL, verified_by = NULL, verification_reference = NULL
         WHERE id = $1`,
        [verified],
      ),
    ).rejects.toThrow(/unverified institutional copy/);

    await expect(
      database.query("UPDATE public.copies SET provenance_type = 'preexisting' WHERE id = $1", [verified]),
    ).rejects.toThrow(/provenance cannot be changed/);
  });

  it("does not expose blocked or retired copies and rejects their reservation", async () => {
    for (const availability of ["maintenance", "retired"]) {
      const copyId = await createCopy({
        label: `blocked-${availability}`,
        condition: "good",
        verified: true,
        availability,
      });
      const catalog = await database.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM public.available_catalog WHERE copy_id = $1",
        [copyId],
      );
      expect(catalog.rows[0]?.count).toBe(0);

      const request = await createRequest(copyId, `blocked-${availability}`);
      await expect(
        reserve(copyId, request.requestId, request.accessHash, `10000000-0000-4000-8000-00000000020${availability === "maintenance" ? "1" : "2"}`),
      ).rejects.toThrow(/not available/);
    }
  });

  it("rolls back a failed reservation without creating a second movement", async () => {
    const copyId = await createCopy({
      label: "rollback",
      condition: "good",
      verified: true,
    });
    await database.query("UPDATE public.copies SET availability = 'available' WHERE id = $1", [copyId]);
    const first = await createRequest(copyId, "rollback-first");
    const second = await createRequest(copyId, "rollback-second");

    await reserve(copyId, first.requestId, first.accessHash, "10000000-0000-4000-8000-000000000105");
    const before = await database.query<{ movements: number }>(
      "SELECT count(*)::int AS movements FROM public.inventory_movements",
    );

    await expect(
      reserve(copyId, second.requestId, second.accessHash, "10000000-0000-4000-8000-000000000106"),
    ).rejects.toThrow(/not available/);

    const after = await database.query<{ movements: number; reservations: number; availability: string }>(
      `SELECT
        (SELECT count(*)::int FROM public.inventory_movements) AS movements,
        (SELECT count(*)::int FROM public.reservations WHERE status = 'active') AS reservations,
        (SELECT availability FROM public.copies WHERE id = $1) AS availability`,
      [copyId],
    );
    expect(after.rows[0]).toEqual({
      movements: before.rows[0]?.movements,
      reservations: 1,
      availability: "reserved",
    });
  });

  it("keeps runtime roles least-privileged", async () => {
    await database.exec("SET ROLE iub_public_runtime");
    const catalog = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.available_catalog",
    );
    expect(catalog.rows[0]?.count).toBe(0);
    await expect(database.query("UPDATE public.copies SET availability = 'available'")).rejects.toThrow();
    await expect(database.query("SELECT public.inventory_copy_is_eligible(1)")).rejects.toThrow();
    await database.exec("RESET ROLE");

    const publicPrivileges = await database.query<{
      reserve_execute: boolean;
      copies_update: boolean;
    }>(`
      SELECT
        has_function_privilege('iub_public_runtime', 'public.reserve_copy(bigint,bigint,bytea,uuid)', 'EXECUTE') AS reserve_execute,
        has_table_privilege('iub_public_runtime', 'public.copies', 'UPDATE') AS copies_update
    `);
    expect(publicPrivileges.rows[0]).toEqual({ reserve_execute: true, copies_update: false });
  });

  it("is idempotent when the containment migration is re-applied", async () => {
    const before = await database.query<{ audit: number; copies: number }>(
      `SELECT
        (SELECT count(*)::int FROM public.audit_events) AS audit,
        (SELECT count(*)::int FROM public.copies) AS copies`,
    );
    await database.exec(await migrationText("0007_institutional_containment.sql"));
    const after = await database.query<{ audit: number; copies: number }>(
      `SELECT
        (SELECT count(*)::int FROM public.audit_events) AS audit,
        (SELECT count(*)::int FROM public.copies) AS copies`,
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("contains existing unverified copies without movements and records audit", async () => {
    const legacy = await createDatabase(6);
    try {
      const publisher = await legacy.query<{ id: string }>(
        `INSERT INTO public.publishers (name, normalized_name) VALUES ('Legacy', 'legacy') RETURNING id`,
      );
      const bib = await legacy.query<{ id: string }>(
        `INSERT INTO public.bibliographic_records (title, author, publisher_id)
         VALUES ('Legacy title', 'Legacy author', $1) RETURNING id`,
        [Number(publisher.rows[0]!.id)],
      );
      await legacy.query(
        `INSERT INTO public.copies
         (bibliographic_record_id, inventory_code, physical_condition, availability, provenance_type)
         VALUES ($1, 'LEGACY-001', 'unassessed', 'available', 'institutional')`,
        [Number(bib.rows[0]!.id)],
      );
      const before = await legacy.query<{ catalog: number }>(
        "SELECT count(*)::int AS catalog FROM public.available_catalog",
      );
      expect(before.rows[0]?.catalog).toBe(1);

      await legacy.exec(await migrationText("0007_institutional_containment.sql"));

      const state = await legacy.query<{
        availability: string;
        verified_at: string | null;
        catalog: number;
        movements: number;
        audit: number;
      }>(`
        SELECT c.availability, c.verified_at,
          (SELECT count(*)::int FROM public.available_catalog) AS catalog,
          (SELECT count(*)::int FROM public.inventory_movements) AS movements,
          (SELECT count(*)::int FROM public.audit_events
           WHERE event_type = 'inventory.institutional_containment_applied') AS audit
        FROM public.copies c WHERE c.provenance_type = 'institutional'
      `);
      expect(state.rows[0]).toEqual({
        availability: "unavailable",
        verified_at: null,
        catalog: 0,
        movements: 0,
        audit: 1,
      });
    } finally {
      await legacy.close();
    }
  });

  it("aborts containment when an unverified copy has an active reservation", async () => {
    const legacy = await createDatabase(6);
    try {
      const actor = await legacy.query<{ id: string }>(
        `INSERT INTO public.app_users (identity_issuer, identity_subject)
         VALUES ('https://issuer.test', 'legacy-reservation-actor') RETURNING id`,
      );
      const actorId = Number(actor.rows[0]!.id);
      await legacy.query(
        "INSERT INTO public.reservation_policy (policy_id, duration_seconds, updated_by) VALUES (1, 3600, $1)",
        [actorId],
      );
      const publisher = await legacy.query<{ id: string }>(
        `INSERT INTO public.publishers (name, normalized_name) VALUES ('Legacy R', 'legacy-r') RETURNING id`,
      );
      const bib = await legacy.query<{ id: string }>(
        `INSERT INTO public.bibliographic_records (title, author, publisher_id)
         VALUES ('Legacy reserved', 'Legacy author', $1) RETURNING id`,
        [Number(publisher.rows[0]!.id)],
      );
      const copy = await legacy.query<{ id: string }>(
        `INSERT INTO public.copies
         (bibliographic_record_id, inventory_code, physical_condition, availability, provenance_type)
         VALUES ($1, 'LEGACY-RESERVED', 'good', 'available', 'institutional') RETURNING id`,
        [Number(bib.rows[0]!.id)],
      );
      const copyId = Number(copy.rows[0]!.id);
      await legacy.query(
        `INSERT INTO public.privacy_notices (version, content_sha256, approved_at)
         VALUES ('notice-legacy', $1, clock_timestamp())`,
        [digest(81)],
      );
      const participant = await legacy.query<{ id: string }>(
        `INSERT INTO public.participants
          (full_name_ciphertext, full_name_key_version, email_ciphertext, email_key_version,
           identity_ciphertext, identity_key_version)
         VALUES ($1, 1, $2, 1, $3, 1) RETURNING id`,
        [Buffer.from("legacy-name"), Buffer.from("legacy-email"), Buffer.from("legacy-id")],
      );
      const participantId = Number(participant.rows[0]!.id);
      const consent = await legacy.query<{ id: string }>(
        `INSERT INTO public.privacy_consents
          (participant_id, notice_version, purpose, consented_at, evidence_sha256,
           capture_channel, idempotency_key)
         VALUES ($1, 'notice-legacy', 'book_exchange', clock_timestamp(), $2, 'web', gen_random_uuid())
         RETURNING id`,
        [participantId, digest(82)],
      );
      const accessHash = digest(83);
      const request = await legacy.query<{ id: string }>(
        `INSERT INTO public.exchange_requests
          (request_code, participant_id, requested_copy_id, privacy_consent_id,
           request_access_token_sha256, idempotency_key)
         VALUES ('LEGACY-REQUEST', $1, $2, $3, $4, gen_random_uuid()) RETURNING id`,
        [participantId, copyId, Number(consent.rows[0]!.id), accessHash],
      );
      await legacy.query(
        "SELECT * FROM public.reserve_copy($1, $2, $3, $4)",
        [copyId, Number(request.rows[0]!.id), accessHash, "10000000-0000-4000-8000-000000000104"],
      );

      await expect(
        legacy.exec(await migrationText("0007_institutional_containment.sql")),
      ).rejects.toThrow(/active commitments or history/);

      const state = await legacy.query<{ availability: string; reservations: number }>(
        `SELECT c.availability,
          (SELECT count(*)::int FROM public.reservations r WHERE r.copy_id = c.id AND r.status = 'active') AS reservations
         FROM public.copies c WHERE c.id = $1`,
        [copyId],
      );
      expect(state.rows[0]).toEqual({ availability: "reserved", reservations: 1 });
    } finally {
      await legacy.close();
    }
  });
});
