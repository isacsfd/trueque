import { requireAdmin } from "../lib/auth.ts";
import { assertActiveAdminActor } from "../lib/admin-identity.ts";
import { queryAdmin } from "../lib/database.ts";
import { normalizeIsbn } from "../lib/crypto.ts";
import {
  ApiError,
  assertSameOrigin,
  booleanField,
  json,
  mapError,
  methodNotAllowed,
  oneOfField,
  optionalStringField,
  readJson,
  stringField,
  uuidField,
} from "../lib/http.ts";

const conditions = ["unassessed", "excellent", "good", "fair", "poor"] as const;

interface CapabilitiesRow {
  can_register: boolean;
  can_verify: boolean;
  can_publish: boolean;
}

interface RegistrationRow {
  copy_id: string;
  bibliographic_record_id: string;
  inventory_code: string;
  availability: string;
  verified: boolean;
  created: boolean;
}

async function capabilities(actorUserId: number): Promise<CapabilitiesRow> {
  const rows = await queryAdmin<CapabilitiesRow>(
    `SELECT
       EXISTS (
         SELECT 1
         FROM public.user_roles ur
         JOIN public.role_permissions rp ON rp.role_id = ur.role_id
         JOIN public.permissions p ON p.id = rp.permission_id
         WHERE ur.user_id = $1 AND p.permission_key = 'inventory.register'
       ) AS can_register,
       EXISTS (
         SELECT 1
         FROM public.user_roles ur
         JOIN public.role_permissions rp ON rp.role_id = ur.role_id
         JOIN public.permissions p ON p.id = rp.permission_id
         WHERE ur.user_id = $1 AND p.permission_key = 'inventory.verify'
       ) AS can_verify,
       EXISTS (
         SELECT 1
         FROM public.user_roles ur
         JOIN public.role_permissions rp ON rp.role_id = ur.role_id
         JOIN public.permissions p ON p.id = rp.permission_id
         WHERE ur.user_id = $1 AND p.permission_key = 'inventory.publish'
       ) AS can_publish`,
    [actorUserId],
  );
  return rows[0] ?? { can_register: false, can_verify: false, can_publish: false };
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return methodNotAllowed();
  }

  try {
    if (request.method === "POST") assertSameOrigin(request);
    const session = requireAdmin(request);
    await assertActiveAdminActor(session.actorUserId, session.sessionVersion);

    if (request.method === "GET") {
      const current = await capabilities(session.actorUserId);
      return json(200, {
        capabilities: {
          canRegister: current.can_register,
          canVerify: current.can_verify,
          canPublish: current.can_publish,
        },
      });
    }

    const body = await readJson(request);
    const title = stringField(body, "title", { min: 1, max: 500 });
    const author = stringField(body, "author", { min: 1, max: 500 });
    const publisher = optionalStringField(body, "publisher", 250);
    const genre = optionalStringField(body, "genre", 120);
    const isbnInput = optionalStringField(body, "isbn", 30);
    const isbnNormalized = isbnInput ? normalizeIsbn(isbnInput) : null;
    if (isbnInput && !isbnNormalized) {
      throw new ApiError(400, "invalid_isbn", "El ISBN no es válido.");
    }
    const inventoryCode = stringField(body, "inventoryCode", { min: 1, max: 120 });
    const location = optionalStringField(body, "location", 200);
    const physicalCondition = oneOfField(body, "physicalCondition", conditions);
    const verificationReference = optionalStringField(body, "verificationReference", 500);
    const publish = booleanField(body, "publish");
    const idempotencyKey = uuidField(body, "idempotencyKey");

    if (publish && (physicalCondition === "unassessed" || !verificationReference)) {
      throw new ApiError(
        400,
        "invalid_publication",
        "Para publicar se requiere una condición física evaluada y una referencia de verificación.",
      );
    }

    const rows = await queryAdmin<RegistrationRow>(
      `SELECT * FROM public.register_institutional_copy(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
       )`,
      [
        title,
        author,
        publisher,
        genre,
        isbnInput,
        isbnNormalized,
        inventoryCode,
        location,
        physicalCondition,
        verificationReference,
        publish,
        session.actorUserId,
        idempotencyKey,
      ],
    );
    const row = rows[0];
    if (!row) {
      throw new ApiError(503, "registration_failed", "No se pudo registrar el ejemplar.");
    }
    return json(201, {
      copyId: row.copy_id,
      bibliographicRecordId: row.bibliographic_record_id,
      inventoryCode: row.inventory_code,
      availability: row.availability,
      verified: row.verified,
      published: row.availability === "available",
      created: row.created,
    });
  } catch (error) {
    return mapError(error);
  }
}

export const config = { path: "/api/admin/inventory" };
