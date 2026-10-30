import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { ApiError } from "./http.ts";

const IV_BYTES = 12;
const TAG_BYTES = 16;

function readKey(name: string): Buffer {
  const raw = process.env[name]?.trim();
  if (!raw) {
    throw new ApiError(503, "service_not_configured", "El servicio de solicitudes no está configurado.");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new ApiError(503, "service_not_configured", "El servicio de solicitudes no está configurado.");
  }
  return key;
}

function readVersion(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 32767) {
    throw new ApiError(503, "service_not_configured", "El servicio de solicitudes no está configurado.");
  }
  return value;
}

export function participantCryptoConfig(): {
  dataKey: Buffer;
  hmacKey: Buffer;
  dataKeyVersion: number;
  hmacKeyVersion: number;
  noticeVersion: string;
} {
  const noticeVersion = process.env.PRIVACY_NOTICE_VERSION?.trim();
  if (!noticeVersion) {
    throw new ApiError(503, "privacy_notice_unavailable", "El aviso de privacidad no está configurado.");
  }
  return {
    dataKey: readKey("PARTICIPANT_DATA_KEY"),
    hmacKey: readKey("PARTICIPANT_IDENTITY_HMAC_KEY"),
    dataKeyVersion: readVersion("PARTICIPANT_DATA_KEY_VERSION", 1),
    hmacKeyVersion: readVersion("PARTICIPANT_HMAC_KEY_VERSION", 1),
    noticeVersion,
  };
}

export function encryptPersonalData(value: string, dataKey: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptPersonalData(value: Buffer, dataKey: Buffer): string {
  if (value.length <= IV_BYTES + TAG_BYTES) {
    throw new ApiError(500, "invalid_ciphertext", "No se pudo procesar el dato cifrado.");
  }
  const iv = value.subarray(0, IV_BYTES);
  const tag = value.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = value.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", dataKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function fingerprintIdentity(identity: string, hmacKey: Buffer): Buffer {
  return createHmac("sha256", hmacKey).update(identity, "utf8").digest();
}

export function sha256(value: string | Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

export function generateAccessToken(): string {
  return randomBytes(32).toString("base64url");
}

export function generateRequestCode(): string {
  // The code is also the public lookup credential. Keep the existing
  // IUB-YYYY-<hex> shape, but use eight random bytes (64 bits) for new codes.
  // Existing shorter codes remain valid and queryable.
  return `IUB-${new Date().getUTCFullYear()}-${randomBytes(8).toString("hex").toUpperCase()}`;
}

export function newIdempotencyKey(): string {
  return randomUUID();
}

export function normalizeDocument(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toUpperCase();
}

export function normalizeIsbn(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.replace(/[^0-9Xx]/g, "").toUpperCase();

  if (normalized.length === 10 && /^[0-9]{9}[0-9X]$/.test(normalized)) {
    let sum = 0;
    for (let index = 0; index < 9; index += 1) {
      sum += (10 - index) * Number(normalized[index]);
    }
    const check = normalized[9] === "X" ? 10 : Number(normalized[9]);
    return (sum + check) % 11 === 0 ? normalized : null;
  }

  if (normalized.length === 13 && /^97[89][0-9]{10}$/.test(normalized)) {
    let sum = 0;
    for (let index = 0; index < 12; index += 1) {
      sum += Number(normalized[index]) * (index % 2 === 0 ? 1 : 3);
    }
    const check = (10 - (sum % 10)) % 10;
    return check === Number(normalized[12]) ? normalized : null;
  }

  return null;
}
