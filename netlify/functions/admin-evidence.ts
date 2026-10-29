import { requireAdmin } from "../lib/auth.ts";
import { queryAdmin } from "../lib/database.ts";
import { getEvidenceStorage } from "../lib/evidence-storage.ts";
import { evidenceFileName, type EvidenceMime } from "../lib/evidence-validation.ts";
import { ApiError, mapError, methodNotAllowed } from "../lib/http.ts";

interface EvidenceRow {
  id: string;
  storage_key: string;
  detected_mime: string;
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();

  try {
    const session = requireAdmin(request);
    const url = new URL(request.url);
    const rawId = url.searchParams.get("id");
    if (!rawId || !/^[1-9][0-9]{0,15}$/.test(rawId)) {
      throw new ApiError(400, "invalid_field", "La evidencia solicitada no es válida.");
    }
    const id = Number(rawId);

    await queryAdmin("SELECT public.assert_actor_permission($1, 'offered_books.review')", [
      session.actorUserId,
    ]);
    const rows = await queryAdmin<EvidenceRow>(
      `SELECT id, storage_key, detected_mime
       FROM public.offered_book_evidence
       WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    const row = rows[0];
    if (!row) throw new ApiError(404, "not_found", "No se encontró la evidencia.");

    let bytes: Buffer;
    try {
      bytes = await getEvidenceStorage().get(row.storage_key);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ApiError(404, "not_found", "La evidencia ya no está disponible.");
      }
      throw new ApiError(503, "evidence_unavailable", "No se pudo recuperar la evidencia.");
    }

    const mime = row.detected_mime as EvidenceMime;
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": mime,
        "Content-Length": String(bytes.length),
        "Content-Disposition": `inline; filename="${evidenceFileName(row.id, mime)}"`,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  } catch (error) {
    return mapError(error);
  }
}

export const config = { path: "/api/admin/evidence" };
