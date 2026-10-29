import { sha256 } from "../lib/crypto.ts";
import { query } from "../lib/database.ts";
import { enforcePublicRateLimit } from "../lib/public-rate-limit.ts";
import { ApiError, json, mapError, methodNotAllowed } from "../lib/http.ts";

interface SubmissionView {
  submissionId: string;
  status: string;
  workflowStatus: string;
  requestedCopyId: string;
  requestId: string | null;
  requestCode: string | null;
  requestStatus: string | null;
  title: string;
  author: string;
  publisher: string | null;
  genre: string | null;
  isbn: string | null;
  isbnNormalized: string | null;
  declaredCondition: string;
  observations: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  decisionReason: string | null;
  reviewNotes: string | null;
  evidence: Array<{
    id: string;
    slot: string;
    mime: string;
    bytes: number;
    width: number;
    height: number;
    createdAt: string;
  }>;
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();

  try {
    const limited = enforcePublicRateLimit(request, "offered-books-status", 120, 3600);
    if (limited) return limited;
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    const token = request.headers.get("x-submission-token");
    if (!id || !/^[1-9][0-9]{0,15}$/.test(id)) {
      throw new ApiError(400, "invalid_field", "El borrador solicitado no es válido.");
    }
    if (!token || token.length < 32 || token.length > 200) {
      throw new ApiError(401, "unauthorized", "Falta el token del borrador.");
    }

    const rows = await query<{ get_offered_book_submission: SubmissionView | null }>(
      "SELECT public.get_offered_book_submission($1, $2) AS get_offered_book_submission",
      [Number(id), sha256(Buffer.from(token, "utf8"))],
    );
    const submission = rows[0]?.get_offered_book_submission;
    if (!submission) throw new ApiError(404, "not_found", "No se encontró el borrador.");

    return json(200, { submission });
  } catch (error) {
    return mapError(error);
  }
}

export const config = { path: "/api/offered-books/status" };
