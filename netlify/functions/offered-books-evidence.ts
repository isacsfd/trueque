import { sha256 } from "../lib/crypto.ts";
import { getEvidenceStorage, newEvidenceStorageKey } from "../lib/evidence-storage.ts";
import {
  EvidenceValidationError,
  MAX_EVIDENCE_BYTES,
  inspectEvidenceImage,
  type EvidenceMime,
} from "../lib/evidence-validation.ts";
import { query } from "../lib/database.ts";
import { enforcePublicRateLimit } from "../lib/public-rate-limit.ts";
import {
  ApiError,
  json,
  mapError,
  methodNotAllowed,
} from "../lib/http.ts";

const slots = new Set(["cover", "back_cover", "spine", "interior", "damage"]);

function tokenFrom(request: Request): string {
  const token = request.headers.get("x-submission-token");
  if (!token || token.length < 32 || token.length > 200) {
    throw new ApiError(401, "unauthorized", "Falta el token del borrador.");
  }
  return token;
}

function positiveId(value: string | null, label: string): number {
  if (!value || !/^[1-9][0-9]{0,15}$/.test(value)) {
    throw new ApiError(400, "invalid_field", `${label} no es válido.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new ApiError(400, "invalid_field", `${label} no es válido.`);
  }
  return number;
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST" && request.method !== "DELETE") return methodNotAllowed();

  try {
    const limited = enforcePublicRateLimit(request, "offered-books-evidence", 60, 3600);
    if (limited) return limited;
    const token = tokenFrom(request);
    const hash = sha256(Buffer.from(token, "utf8"));

    if (request.method === "DELETE") {
      const url = new URL(request.url);
      const evidenceId = positiveId(url.searchParams.get("id"), "La evidencia");
      const rows = await query<{ storage_key: string }>(
        "SELECT * FROM public.delete_offered_book_evidence($1, $2)",
        [evidenceId, hash],
      );
      const row = rows[0];
      if (!row) throw new ApiError(404, "not_found", "No se encontró la evidencia.");
      await getEvidenceStorage().delete(row.storage_key);
      return new Response(null, { status: 204 });
    }

    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_EVIDENCE_BYTES + 1024 * 1024) {
      throw new ApiError(413, "payload_too_large", "La imagen supera el tamaño máximo de 4 MB.");
    }

    const form = await request.formData();
    const submissionId = positiveId(String(form.get("submissionId") ?? ""), "El borrador");
    const slot = String(form.get("slot") ?? "");
    const idempotencyKey = String(form.get("idempotencyKey") ?? "");
    const file = form.get("file");

    if (!slots.has(slot)) throw new ApiError(400, "invalid_field", "El tipo de fotografía no es válido.");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
      throw new ApiError(400, "invalid_field", "La clave de idempotencia no es válida.");
    }
    if (!file || typeof file === "string" || !("arrayBuffer" in file)) {
      throw new ApiError(400, "invalid_file", "Selecciona una imagen.");
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    let image: ReturnType<typeof inspectEvidenceImage>;
    try {
      image = inspectEvidenceImage(bytes);
    } catch (error) {
      if (error instanceof EvidenceValidationError) {
        throw new ApiError(400, "invalid_file", error.message);
      }
      throw error;
    }
    const storageKey = newEvidenceStorageKey(image.mime as EvidenceMime);
    const storage = getEvidenceStorage();
    await storage.put(storageKey, bytes);

    try {
      const rows = await query<{ evidence_id: string; storage_key: string }>(
        `SELECT * FROM public.register_offered_book_evidence(
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
        )`,
        [
          submissionId, hash, slot, storageKey, image.mime, image.bytes,
          sha256(bytes), image.width, image.height, idempotencyKey,
        ],
      );
      const row = rows[0];
      if (!row) throw new ApiError(503, "upload_failed", "No se pudo registrar la imagen.");
      if (row.storage_key !== storageKey) {
        await storage.delete(storageKey);
      }
      return json(201, {
        evidenceId: row.evidence_id,
        slot,
        mime: image.mime,
        bytes: image.bytes,
        width: image.width,
        height: image.height,
      });
    } catch (error) {
      await storage.delete(storageKey).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    return mapError(error);
  }
}

export const config = { path: "/api/offered-books/evidence" };
