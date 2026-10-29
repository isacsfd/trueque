import { requireAdmin } from "../lib/auth.ts";
import { assertActiveAdminActor } from "../lib/admin-identity.ts";
import { queryAdmin } from "../lib/database.ts";
import { normalizeIsbn } from "../lib/crypto.ts";
import {
  ApiError,
  assertSameOrigin,
  json,
  mapError,
  methodNotAllowed,
  numberField,
  oneOfField,
  optionalStringField,
  readJson,
  stringField,
  uuidField,
} from "../lib/http.ts";

const actions = [
  "request.review",
  "request.approve",
  "request.reject",
  "submission.review",
  "exchange.plan",
  "delivery.schedule",
  "delivery.confirm",
  "reception.custody",
  "reception.evaluate",
  "reception.return",
  "cataloging.prepare",
  "cataloging.authorize",
  "admission.authorize",
  "admission.admit",
  "admission.enable",
  "exchange.start",
  "exchange.complete",
  "exchange.cancel",
] as const;

const deliveryTypes = [
  "offered_book_dropoff",
  "offered_book_return",
  "institutional_copy_handover",
] as const;

const conditions = ["excellent", "good", "fair", "poor"] as const;
const outcomes = ["accepted", "rejected"] as const;

function optionalDate(body: Record<string, unknown>, key: string): string | null {
  const value = optionalStringField(body, key, 40);
  if (!value) return null;
  if (Number.isNaN(Date.parse(value))) {
    throw new ApiError(400, "invalid_field", `El campo ${key} no es válido.`);
  }
  return value;
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();

  try {
    assertSameOrigin(request);
    const session = requireAdmin(request);
    await assertActiveAdminActor(session.actorUserId, session.sessionVersion);
    const body = await readJson(request);
    const action = oneOfField(body, "action", actions);
    const actor = session.actorUserId;
    let rows: Array<Record<string, unknown>>;

    switch (action) {
      case "request.review": {
        const requestId = numberField(body, "requestId");
        const reason = optionalStringField(body, "reason", 3000);
        rows = await queryAdmin("SELECT public.set_request_status($1, 'under_review', $2, $3)", [
          requestId, actor, reason,
        ]);
        break;
      }
      case "request.approve": {
        const requestId = numberField(body, "requestId");
        const reason = stringField(body, "reason", { min: 3, max: 3000 });
        rows = await queryAdmin("SELECT public.set_request_status($1, 'approved', $2, $3)", [
          requestId, actor, reason,
        ]);
        break;
      }
      case "request.reject": {
        const requestId = numberField(body, "requestId");
        const reason = stringField(body, "reason", { min: 3, max: 3000 });
        rows = await queryAdmin("SELECT public.set_request_status($1, 'rejected', $2, $3)", [
          requestId, actor, reason,
        ]);
        break;
      }
      case "submission.review": {
        const submissionId = numberField(body, "submissionId");
        const reviewAction = oneOfField(body, "reviewAction", [
          "start_review", "request_information", "preapprove", "reject",
        ] as const);
        const reason = optionalStringField(body, "reason", 3000);
        const notes = optionalStringField(body, "notes", 3000);
        const idempotencyKey = uuidField(body, "idempotencyKey");
        rows = await queryAdmin(
          "SELECT * FROM public.review_offered_book_submission($1, $2, $3, $4, $5, $6)",
          [submissionId, actor, reviewAction, reason, notes, idempotencyKey],
        );
        break;
      }
      case "exchange.plan": {
        const requestId = numberField(body, "requestId");
        const receiptCode = stringField(body, "receiptCode", { max: 120 });
        const planningKey = uuidField(body, "planningKey");
        rows = await queryAdmin(
          "SELECT * FROM public.plan_exchange($1, $2, $3, $4)",
          [requestId, receiptCode, planningKey, actor],
        );
        break;
      }
      case "delivery.schedule": {
        const exchangeId = numberField(body, "exchangeId");
        const deliveryType = oneOfField(body, "deliveryType", deliveryTypes);
        const scheduledAt = optionalDate(body, "scheduledAt");
        const idempotencyKey = uuidField(body, "idempotencyKey");
        rows = await queryAdmin(
          "SELECT public.schedule_delivery($1, $2, coalesce($3::timestamptz, clock_timestamp()), $4, $5)",
          [exchangeId, deliveryType, scheduledAt, idempotencyKey, actor],
        );
        break;
      }
      case "delivery.confirm": {
        const deliveryId = numberField(body, "deliveryId");
        const receiptReference = stringField(body, "receiptReference", { max: 500 });
        const notes = optionalStringField(body, "notes", 2000);
        const idempotencyKey = uuidField(body, "idempotencyKey");
        rows = await queryAdmin("SELECT public.confirm_delivery($1, $2, $3, $4, $5)", [
          deliveryId, actor, receiptReference, notes, idempotencyKey,
        ]);
        break;
      }
      case "reception.custody": {
        const receptionId = numberField(body, "receptionId");
        const location = stringField(body, "location", { max: 200 });
        const custodian = stringField(body, "custodian", { max: 200 });
        const evidenceReference = stringField(body, "evidenceReference", { max: 500 });
        const idempotencyKey = uuidField(body, "idempotencyKey");
        rows = await queryAdmin(
          "SELECT public.place_reception_in_custody($1, $2, $3, $4, $5, $6)",
          [receptionId, actor, location, custodian, evidenceReference, idempotencyKey],
        );
        break;
      }
      case "reception.evaluate": {
        const receptionId = numberField(body, "receptionId");
        const outcome = oneOfField(body, "outcome", outcomes);
        const assessedCondition = oneOfField(body, "assessedCondition", conditions);
        const rationale = stringField(body, "rationale", { max: 3000 });
        const evidenceReference = stringField(body, "evidenceReference", { max: 500 });
        const idempotencyKey = uuidField(body, "idempotencyKey");
        rows = await queryAdmin(
          "SELECT public.evaluate_reception($1, $2, $3, $4, $5, $6, $7)",
          [receptionId, actor, outcome, assessedCondition, rationale, idempotencyKey, evidenceReference],
        );
        break;
      }
      case "reception.return": {
        const receptionId = numberField(body, "receptionId");
        const reason = stringField(body, "reason", { max: 3000 });
        rows = await queryAdmin("SELECT public.request_reception_return($1, $2, $3)", [
          receptionId, actor, reason,
        ]);
        break;
      }
      case "cataloging.prepare": {
        const receptionId = numberField(body, "receptionId");
        const title = stringField(body, "title", { max: 500 });
        const author = stringField(body, "author", { max: 500 });
        const isbn = optionalStringField(body, "isbn", 30);
        const isbnNormalizedInput = optionalStringField(body, "isbnNormalized", 20);
        const isbnNormalized = isbn ? normalizeIsbn(isbn) : null;
        if (isbn && !isbnNormalized) {
          throw new ApiError(400, "invalid_field", "El ISBN no es válido.");
        }
        if (isbnNormalizedInput && isbnNormalizedInput !== isbnNormalized) {
          throw new ApiError(400, "invalid_field", "El ISBN normalizado no coincide.");
        }
        const validationKey = uuidField(body, "validationKey");
        rows = await queryAdmin(
          "SELECT public.prepare_cataloging($1, $2, $3, $4, $5, $6, $7)",
          [receptionId, title, author, isbn, isbnNormalized, actor, validationKey],
        );
        break;
      }
      case "cataloging.authorize": {
        const catalogingId = numberField(body, "catalogingId");
        const authorizationKey = uuidField(body, "authorizationKey");
        rows = await queryAdmin("SELECT public.authorize_cataloging($1, $2, $3)", [
          catalogingId, actor, authorizationKey,
        ]);
        break;
      }
      case "admission.authorize": {
        const receptionId = numberField(body, "receptionId");
        const idempotencyKey = uuidField(body, "idempotencyKey");
        rows = await queryAdmin("SELECT public.authorize_inventory_admission($1, $2, $3)", [
          receptionId, actor, idempotencyKey,
        ]);
        break;
      }
      case "admission.admit": {
        const admissionId = numberField(body, "admissionId");
        const inventoryCode = stringField(body, "inventoryCode", { max: 120 });
        const location = stringField(body, "location", { max: 200 });
        rows = await queryAdmin("SELECT public.admit_received_book($1, $2, $3, $4)", [
          admissionId, inventoryCode, location, actor,
        ]);
        break;
      }
      case "admission.enable": {
        const admissionId = numberField(body, "admissionId");
        rows = await queryAdmin("SELECT public.enable_received_copy($1, $2)", [admissionId, actor]);
        break;
      }
      case "exchange.start": {
        const exchangeId = numberField(body, "exchangeId");
        rows = await queryAdmin("SELECT public.start_exchange($1, $2)", [exchangeId, actor]);
        break;
      }
      case "exchange.complete": {
        const exchangeId = numberField(body, "exchangeId");
        const completionKey = uuidField(body, "completionKey");
        rows = await queryAdmin("SELECT public.complete_exchange($1, $2, $3)", [
          exchangeId, completionKey, actor,
        ]);
        break;
      }
      case "exchange.cancel": {
        const exchangeId = numberField(body, "exchangeId");
        const cancellationKey = uuidField(body, "cancellationKey");
        const reason = optionalStringField(body, "reason", 3000);
        rows = await queryAdmin("SELECT public.cancel_exchange($1, $2, $3, $4)", [
          exchangeId, cancellationKey, actor, reason,
        ]);
        break;
      }
      default:
        throw new ApiError(400, "unknown_action", "Acción no reconocida.");
    }

    return json(200, { result: rows[0] ?? null });
  } catch (error) {
    return mapError(error);
  }
}

export const config = { path: "/api/admin/action" };
