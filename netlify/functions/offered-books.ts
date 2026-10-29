import { sha256, normalizeIsbn } from "../lib/crypto.ts";
import { query } from "../lib/database.ts";
import { enforcePublicRateLimit } from "../lib/public-rate-limit.ts";
import {
  ApiError,
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

const conditions = ["excellent", "good", "fair", "poor"] as const;

function requiredValue(value: string | null, message: string): string {
  if (value === null || value.length === 0) throw new ApiError(400, "invalid_field", message);
  return value;
}

function tokenHash(token: string): Buffer {
  if (token.length < 32 || token.length > 200) {
    throw new ApiError(400, "invalid_field", "El token del borrador no es válido.");
  }
  return sha256(Buffer.from(token, "utf8"));
}

function copyIdField(body: Record<string, unknown>): number {
  const value = requiredValue(stringField(body, "copyId", { max: 20 }), "El ejemplar seleccionado no es válido.");
  if (!/^[1-9][0-9]{0,15}$/.test(value)) {
    throw new ApiError(400, "invalid_field", "El ejemplar seleccionado no es válido.");
  }
  return Number(value);
}

function bookFields(body: Record<string, unknown>) {
  const title = requiredValue(stringField(body, "title", { max: 500 }), "El título es obligatorio.");
  const author = requiredValue(stringField(body, "author", { max: 500 }), "El autor es obligatorio.");
  const publisher = optionalStringField(body, "publisher", 250);
  const genre = optionalStringField(body, "genre", 120);
  const isbnInput = optionalStringField(body, "isbn", 30);
  const isbnNormalized = normalizeIsbn(isbnInput);
  if (isbnInput && !isbnNormalized) {
    throw new ApiError(400, "invalid_field", "El ISBN no es válido.");
  }
  const declaredCondition = oneOfField(body, "declaredCondition", conditions);
  const observations = optionalStringField(body, "observations", 3000);
  return {
    title: title.trim(),
    author: author.trim(),
    publisher: publisher?.trim() || null,
    genre: genre?.trim() || null,
    isbn: isbnInput || null,
    isbnNormalized: isbnNormalized || null,
    declaredCondition,
    observations: observations?.trim() || null,
  };
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST" && request.method !== "PATCH") return methodNotAllowed();

  try {
    const limited = enforcePublicRateLimit(request, "offered-books-write", 30, 3600);
    if (limited) return limited;
    const body = await readJson(request);
    const accessToken = requiredValue(stringField(body, "accessToken", { min: 32, max: 200 }), "El token del borrador no es válido.");
    const hash = tokenHash(accessToken);
    const fields = bookFields(body);

    if (request.method === "POST") {
      const requestedCopyId = copyIdField(body);
      const idempotencyKey = uuidField(body, "idempotencyKey");
      const rows = await query<{ submission_id: string; status: string }>(
        `SELECT * FROM public.create_offered_book_submission(
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
        )`,
        [
          requestedCopyId, hash, fields.title, fields.author, fields.publisher,
          fields.genre, fields.isbn, fields.isbnNormalized, fields.declaredCondition,
          fields.observations, idempotencyKey,
        ],
      );
      const row = rows[0];
      if (!row) throw new ApiError(503, "submission_failed", "No se pudo crear el borrador.");
      return json(201, { submissionId: row.submission_id, status: row.status });
    }

    const submissionId = numberField(body, "submissionId");
    const rows = await query<{ submission_id: string; status: string }>(
      `SELECT * FROM public.update_offered_book_submission(
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
      )`,
      [
        submissionId, hash, fields.title, fields.author, fields.publisher,
        fields.genre, fields.isbn, fields.isbnNormalized, fields.declaredCondition,
        fields.observations,
      ],
    );
    const row = rows[0];
    if (!row) throw new ApiError(503, "submission_failed", "No se pudo actualizar el borrador.");
    return json(200, { submissionId: row.submission_id, status: row.status });
  } catch (error) {
    return mapError(error);
  }
}

export const config = { path: "/api/offered-books" };
