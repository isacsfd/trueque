import { createHash } from "node:crypto";
import { basename } from "node:path";
import { requireAdmin } from "../lib/auth.ts";
import { requireAdminPermission } from "../lib/admin-permissions.ts";
import { queryAdmin } from "../lib/database.ts";
import { inspectSheets, validateBatch, type BatchColumnMapping } from "../lib/inventory-batch.ts";
import { parseXlsx, MAX_XLSX_BYTES } from "../lib/xlsx.ts";
import { ApiError, assertSameOrigin, json, mapError, methodNotAllowed } from "../lib/http.ts";

interface BatchRowResult {
  batch_id: string;
  status: string;
  total_rows: number;
  valid_rows: number;
  warning_rows: number;
  rejected_rows: number;
  duplicate_rows: number;
}

const knownImportedFileHashes = new Map<string, string>([
  ["86d6602a23aa6d95045c5a40eece9c3dd3ce14e7349adf59e19ce37110bd846d", "INVENTARIO TRUEQUE.xlsx"],
  ["433d0246f3266374cae0a5ccaab28fad05246ec121f9b6ca648661671c5c9bb3", "Libros para el Trueque Literario CH.xlsx"],
]);

function parseUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ApiError(400, "invalid_field", "La clave de idempotencia no es válida.");
  }
  return value;
}

function mappingObject(raw: string): BatchColumnMapping {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError(400, "invalid_mapping", "El mapeo de columnas no es válido.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(400, "invalid_mapping", "El mapeo de columnas no es válido.");
  }
  const result: Record<string, string> = {};
  for (const key of ["title", "author", "publisher", "genre", "isbn", "inventory_code", "location", "observations", "source_number", "copy_number"]) {
    const value = (parsed as Record<string, unknown>)[key];
    if (value !== undefined) {
      if (typeof value !== "string") throw new ApiError(400, "invalid_mapping", "El mapeo contiene valores no válidos.");
      if (value.trim()) result[key] = value.trim();
    }
  }
  return result as unknown as BatchColumnMapping;
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();

  try {
    assertSameOrigin(request);
    const session = requireAdmin(request);
    await requireAdminPermission(session.actorUserId, "inventory.batches.import");

    const form = await request.formData();
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_XLSX_BYTES + 2 * 1024 * 1024) {
      throw new ApiError(413, "payload_too_large", "El Excel supera el tamaño máximo de 10 MB.");
    }
    const file = form.get("file");
    if (!file || typeof file === "string" || !("arrayBuffer" in file)) {
      throw new ApiError(400, "invalid_file", "Selecciona un archivo .xlsx.");
    }
    if (file.size > MAX_XLSX_BYTES) {
      throw new ApiError(413, "payload_too_large", "El Excel supera el tamaño máximo de 10 MB.");
    }

    const action = String(form.get("action") ?? "inspect");
    const buffer = Buffer.from(await (file as File).arrayBuffer());
    let workbook;
    try {
      workbook = parseXlsx(buffer);
    } catch (error) {
      throw new ApiError(400, "invalid_xlsx", error instanceof Error ? error.message : "El Excel no es válido.");
    }

    const requestedSheet = String(form.get("sheetName") ?? "").trim();
    const selectedSheet = requestedSheet
      ? workbook.sheets.find((sheet) => sheet.name === requestedSheet)
      : workbook.sheets[0];
    if (!selectedSheet) throw new ApiError(400, "invalid_sheet", "La hoja seleccionada no existe.");

    if (action === "inspect") {
      const rawHeader = String(form.get("headerRow") ?? "").trim();
      const headerRow = rawHeader ? Number(rawHeader) : undefined;
      if (headerRow !== undefined && (!Number.isSafeInteger(headerRow) || headerRow < 1)) {
        throw new ApiError(400, "invalid_field", "La fila de encabezados no es válida.");
      }
      return json(200, {
        mode: "inspect",
        file: {
          name: basename((file as File).name || "lote.xlsx").slice(0, 255),
          size: buffer.length,
          sha256: createHash("sha256").update(buffer).digest("hex"),
        },
        sheets: workbook.sheets.map((sheet) => sheet.name),
        selected: inspectSheets(selectedSheet, headerRow),
      });
    }

    if (action !== "prevalidate") throw new ApiError(400, "invalid_action", "Acción de lote no válida.");

    const rawHeader = String(form.get("headerRow") ?? "").trim();
    const headerRow = Number(rawHeader);
    if (!Number.isSafeInteger(headerRow) || headerRow < 1) {
      throw new ApiError(400, "invalid_field", "La fila de encabezados no es válida.");
    }
    const mapping = mappingObject(String(form.get("mapping") ?? ""));
    const idempotencyKey = parseUuid(String(form.get("idempotencyKey") ?? ""));
    const observations = String(form.get("observations") ?? "").slice(0, 3000);

    const [bibliographicRows, copyRows] = await Promise.all([
      queryAdmin<{ isbn_normalized: string | null; title: string; author: string; publisher: string }>(
        `SELECT b.isbn_normalized, lower(b.title) AS title, lower(b.author) AS author,
                coalesce(p.normalized_name, '') AS publisher
         FROM public.bibliographic_records b
         LEFT JOIN public.publishers p ON p.id = b.publisher_id`,
      ),
      queryAdmin<{ inventory_code: string }>("SELECT inventory_code FROM public.copies"),
    ]);

    const existing = {
      isbn: new Set(bibliographicRows.map((row) => row.isbn_normalized).filter((value): value is string => Boolean(value))),
      titleAuthorPublisher: new Set(
        bibliographicRows.map((row) => `${row.title}\u0000${row.author}\u0000${row.publisher}`),
      ),
    };
    const existingCodes = new Set(copyRows.map((row) => row.inventory_code));
    let validation;
    try {
      validation = validateBatch({ sheet: selectedSheet, headerRow, mapping, existing, existingCodes });
    } catch (error) {
      throw new ApiError(400, "invalid_mapping", error instanceof Error ? error.message : "El lote no es válido.");
    }
    if (validation.errors.length > 0) {
      throw new ApiError(422, "invalid_batch", validation.errors.join(" "));
    }

    const digest = createHash("sha256").update(buffer).digest();
    const knownFile = knownImportedFileHashes.get(digest.toString("hex"));
    if (knownFile) {
      throw new ApiError(
        409,
        "already_imported",
        `El archivo ${knownFile} ya fue importado al inventario del evento. No se volverá a insertar. Para agregar ejemplares nuevos, crea un archivo con solo esos ejemplares.`,
      );
    }
    const existingBatch = await queryAdmin<{
      batch_id: string; status: string; total_rows: number; valid_rows: number;
      warning_rows: number; rejected_rows: number; duplicate_rows: number; file_sha256: string;
    }>(
      `SELECT id AS batch_id, status, total_rows, valid_rows, warning_rows,
              rejected_rows, duplicate_rows, encode(file_sha256, 'hex') AS file_sha256
       FROM public.inventory_batches WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    if (existingBatch[0]) {
      if (existingBatch[0].file_sha256 !== digest.toString("hex")) {
        throw new ApiError(409, "idempotency_conflict", "La clave de idempotencia pertenece a otro archivo.");
      }
      return json(201, {
        mode: "prevalidated",
        batchId: existingBatch[0].batch_id,
        status: existingBatch[0].status,
        totalRows: existingBatch[0].total_rows,
        validRows: existingBatch[0].valid_rows,
        warningRows: existingBatch[0].warning_rows,
        rejectedRows: existingBatch[0].rejected_rows,
        duplicateRows: existingBatch[0].duplicate_rows,
      });
    }

    const fileName = basename((file as File).name || "lote.xlsx").slice(0, 255);
    // The source bytes are intentionally not retained. The SHA-256 digest and
    // the batch metadata provide the audit trail without storing the workbook
    // or its possible personal data in a private bucket.
    const storageKey = `batch-${idempotencyKey}.xlsx`;

    const rows = await queryAdmin<BatchRowResult>(
        `SELECT * FROM public.store_inventory_batch(
          $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11
        )`,
        [
          fileName,
          digest,
          buffer.length,
          selectedSheet.name,
          headerRow,
          JSON.stringify(mapping),
          JSON.stringify(validation.rows),
          session.actorUserId,
          idempotencyKey,
          storageKey,
          observations || null,
        ],
      );
      const row = rows[0];
      if (!row) throw new ApiError(503, "batch_failed", "No se pudo guardar la prevalidación.");
      return json(201, {
        mode: "prevalidated",
        batchId: row.batch_id,
        status: row.status,
        totalRows: row.total_rows,
        validRows: row.valid_rows,
        warningRows: row.warning_rows,
        rejectedRows: row.rejected_rows,
        duplicateRows: row.duplicate_rows,
      });
  } catch (error) {
    return mapError(error);
  }
}

export const config = { path: "/api/admin/batches" };
