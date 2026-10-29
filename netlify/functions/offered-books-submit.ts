import {
  encryptPersonalData,
  fingerprintIdentity,
  generateAccessToken,
  generateRequestCode,
  normalizeDocument,
  participantCryptoConfig,
  sha256,
} from "../lib/crypto.ts";
import { DatabaseQueryError, query } from "../lib/database.ts";
import { enforcePublicRateLimit } from "../lib/public-rate-limit.ts";
import {
  ApiError,
  booleanField,
  json,
  mapError,
  methodNotAllowed,
  readJson,
  stringField,
  uuidField,
} from "../lib/http.ts";

interface SubmissionView {
  submissionId: string;
  status: string;
  workflowStatus: string;
  requestedCopyId: string;
  requestId: string | null;
  requestCode: string | null;
  title: string;
  author: string;
  publisher: string | null;
  genre: string | null;
  isbn: string | null;
  isbnNormalized: string | null;
  declaredCondition: string;
  observations: string | null;
}

async function loadSubmission(submissionId: number, token: string): Promise<SubmissionView> {
  const rows = await query<{ get_offered_book_submission: SubmissionView | null }>(
    "SELECT public.get_offered_book_submission($1, $2) AS get_offered_book_submission",
    [submissionId, sha256(Buffer.from(token, "utf8"))],
  );
  const submission = rows[0]?.get_offered_book_submission;
  if (!submission) throw new ApiError(404, "not_found", "No se encontró el borrador.");
  return submission;
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();

  try {
    const limited = enforcePublicRateLimit(request, "offered-books-submit", 10, 3600);
    if (limited) return limited;
    const body = await readJson(request);
    const rawSubmissionId = stringField(body, "submissionId", { max: 20 });
    if (!rawSubmissionId) throw new ApiError(400, "invalid_field", "El borrador no es válido.");
    const submissionId = Number(rawSubmissionId);
    const submissionToken = stringField(body, "accessToken", { min: 32, max: 200 });
    if (!submissionToken) throw new ApiError(400, "invalid_field", "El token del borrador no es válido.");
    const idempotencyKey = uuidField(body, "idempotencyKey");
    if (!Number.isSafeInteger(submissionId) || submissionId < 1) {
      throw new ApiError(400, "invalid_field", "El borrador no es válido.");
    }

    const submission = await loadSubmission(submissionId, submissionToken);
    if (submission.status === "needs_information") {
      const rows = await query<{ request_id: string; request_code: string }>(
        "SELECT * FROM public.resubmit_offered_book_submission($1, $2, $3)",
        [submissionId, sha256(Buffer.from(submissionToken, "utf8")), idempotencyKey],
      );
      const row = rows[0];
      if (!row) throw new ApiError(503, "submission_failed", "No se pudo reenviar el borrador.");
      return json(200, {
        requestId: row.request_id,
        requestCode: row.request_code,
        resubmitted: true,
      });
    }
    if (submission.status !== "draft") {
      throw new ApiError(
        409,
        "invalid_state",
        "El borrador ya fue enviado o no se puede enviar en su estado actual.",
      );
    }

    const participantName = stringField(body, "participantName", { max: 250 });
    const participantEmail = stringField(body, "participantEmail", { max: 320 });
    const participantDocument = stringField(body, "participantDocument", { min: 4, max: 80 });
    if (!participantName || !participantEmail || !participantDocument) {
      throw new ApiError(400, "invalid_field", "Los datos del participante son obligatorios.");
    }
    const consent = booleanField(body, "consent");
    if (!consent) throw new ApiError(400, "consent_required", "Debes autorizar el tratamiento de datos.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(participantEmail)) {
      throw new ApiError(400, "invalid_field", "El correo electrónico no es válido.");
    }

    const config = participantCryptoConfig();
    const normalizedDocument = normalizeDocument(participantDocument);
    if (normalizedDocument.length < 4) {
      throw new ApiError(400, "invalid_field", "El documento no es válido.");
    }

    const requestCode = generateRequestCode();
    const requestAccessToken = generateAccessToken();
    const requestAccessHash = sha256(Buffer.from(requestAccessToken, "utf8"));
    const fullNameCiphertext = encryptPersonalData(participantName, config.dataKey);
    const emailCiphertext = encryptPersonalData(participantEmail, config.dataKey);
    const identityCiphertext = encryptPersonalData(normalizedDocument, config.dataKey);
    const identityFingerprint = fingerprintIdentity(normalizedDocument, config.hmacKey);
    const consentEvidence = sha256(`${config.noticeVersion}|${requestCode}|web-consent`);

    const payload = {
      participant: {
        fullNameCiphertext: fullNameCiphertext.toString("hex"),
        fullNameKeyVersion: config.dataKeyVersion,
        emailCiphertext: emailCiphertext.toString("hex"),
        emailKeyVersion: config.dataKeyVersion,
        identityCiphertext: identityCiphertext.toString("hex"),
        identityKeyVersion: config.dataKeyVersion,
        identityFingerprint: identityFingerprint.toString("hex"),
        hmacKeyVersion: config.hmacKeyVersion,
      },
      consent: {
        noticeVersion: config.noticeVersion,
        evidenceSha256: consentEvidence.toString("hex"),
      },
      request: {
        requestedCopyId: submission.requestedCopyId,
        accessTokenSha256: requestAccessHash.toString("hex"),
      },
      offeredBook: {
        title: submission.title,
        author: submission.author,
        publisherClaim: submission.publisher,
        genreClaim: submission.genre,
        isbn: submission.isbn,
        isbnNormalized: submission.isbnNormalized,
        declaredCondition: submission.declaredCondition,
        observations: submission.observations,
      },
    };

    const rows = await query<{
      request_id: string;
      request_code: string;
      participant_id: string;
      privacy_consent_id: string;
    }>(
      "SELECT * FROM public.submit_offered_book_submission($1, $2, $3, $4::jsonb, $5)",
      [
        submissionId,
        sha256(Buffer.from(submissionToken, "utf8")),
        requestCode,
        JSON.stringify(payload),
        idempotencyKey,
      ],
    );
    const row = rows[0];
    if (!row) throw new ApiError(503, "submission_failed", "No se pudo enviar el borrador.");

    return json(201, {
      requestId: row.request_id,
      requestCode: row.request_code,
      accessToken: requestAccessToken,
      resubmitted: false,
    });
  } catch (error) {
    if (error instanceof DatabaseQueryError && error.sqlState === "P0002") {
      throw new ApiError(
        503,
        "privacy_notice_unavailable",
        "El aviso de privacidad aún no está publicado. Contacta a la institución.",
      );
    }
    return mapError(error);
  }
}

export const config = { path: "/api/offered-books/submit" };
