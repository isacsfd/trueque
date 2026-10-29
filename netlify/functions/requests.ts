import {
  DatabaseQueryError,
  query,
} from "../lib/database.ts";
import {
  encryptPersonalData,
  fingerprintIdentity,
  generateAccessToken,
  generateRequestCode,
  normalizeDocument,
  normalizeIsbn,
  participantCryptoConfig,
  sha256,
} from "../lib/crypto.ts";
import {
  ApiError,
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

const conditions = ["excellent", "good", "fair", "poor"] as const;

function normalizeOptional(value: string | null): string | null {
  return value && value.length > 0 ? value : null;
}

async function createRequest(request: Request): Promise<Response> {
  if (process.env.ALLOW_LEGACY_REQUEST_INTAKE !== "true") {
    throw new ApiError(
      410,
      "photo_review_required",
      "El alta de solicitudes requiere el flujo con fotografías. Usa el formulario de libro ofrecido.",
    );
  }
  const body = await readJson(request);
  const copyId = stringField(body, "copyId", { max: 20 });
  const participantName = stringField(body, "participantName", { max: 250 });
  const participantEmail = stringField(body, "participantEmail", { max: 320 });
  const participantDocument = stringField(body, "participantDocument", { min: 4, max: 80 });
  const offeredTitle = stringField(body, "offeredTitle", { max: 500 });
  const offeredAuthor = stringField(body, "offeredAuthor", { max: 500 });
  const offeredPublisher = optionalStringField(body, "offeredPublisher", 250);
  const offeredGenre = optionalStringField(body, "offeredGenre", 120);
  const offeredIsbn = optionalStringField(body, "offeredIsbn", 30);
  const offeredCondition = oneOfField(body, "offeredCondition", conditions);
  const offeredObservations = optionalStringField(body, "offeredObservations", 3000);
  const consent = booleanField(body, "consent");
  const idempotencyKey = uuidField(body, "idempotencyKey");

  if (!/^[1-9][0-9]{0,15}$/.test(copyId ?? "")) {
    throw new ApiError(400, "invalid_field", "El ejemplar seleccionado no es válido.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(participantEmail ?? "")) {
    throw new ApiError(400, "invalid_field", "El correo electrónico no es válido.");
  }
  if (!consent) {
    throw new ApiError(400, "consent_required", "Debes autorizar el tratamiento de datos para continuar.");
  }

  const isbnNormalized = normalizeIsbn(offeredIsbn);
  if (offeredIsbn && !isbnNormalized) {
    throw new ApiError(400, "invalid_field", "El ISBN no es válido.");
  }

  const config = participantCryptoConfig();
  const normalizedDocument = normalizeDocument(participantDocument ?? "");
  if (normalizedDocument.length < 4) {
    throw new ApiError(400, "invalid_field", "El documento no es válido.");
  }

  const requestCode = generateRequestCode();
  const accessToken = generateAccessToken();
  const accessHash = sha256(Buffer.from(accessToken, "utf8"));
  const fullNameCiphertext = encryptPersonalData(participantName ?? "", config.dataKey);
  const emailCiphertext = encryptPersonalData(participantEmail ?? "", config.dataKey);
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
      requestedCopyId: copyId,
      accessTokenSha256: accessHash.toString("hex"),
    },
    offeredBook: {
      title: offeredTitle,
      author: offeredAuthor,
      publisherClaim: normalizeOptional(offeredPublisher),
      genreClaim: normalizeOptional(offeredGenre),
      isbn: normalizeOptional(offeredIsbn),
      isbnNormalized,
      declaredCondition: offeredCondition,
      observations: normalizeOptional(offeredObservations),
    },
  };

  try {
    const rows = await query<{
      request_id: string;
      request_code: string;
      participant_id: string;
      privacy_consent_id: string;
    }>(
      "SELECT * FROM public.create_exchange_request($1, $2::jsonb, $3)",
      [requestCode, JSON.stringify(payload), idempotencyKey],
    );
    const row = rows[0];
    if (!row) throw new ApiError(500, "internal_error", "No se pudo crear la solicitud.");

    return json(201, {
      requestId: row.request_id,
      requestCode: row.request_code,
      accessToken,
    });
  } catch (error) {
    if (error instanceof DatabaseQueryError && error.sqlState === "P0002") {
      throw new ApiError(
        503,
        "privacy_notice_unavailable",
        "El aviso de privacidad aún no está publicado. Contacta a la institución.",
      );
    }
    throw error;
  }
}

export default async function handler(request: Request): Promise<Response> {
  try {
    if (request.method === "POST") return await createRequest(request);
    return methodNotAllowed();
  } catch (error) {
    return mapError(error);
  }
}

export const config = { path: "/api/requests" };
