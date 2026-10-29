export const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
export const MAX_EVIDENCE_FILES = 12;
export const MAX_IMAGE_DIMENSION = 8000;
export const MAX_IMAGE_PIXELS = 32_000_000;
export const ALLOWED_EVIDENCE_MIME = ["image/jpeg", "image/png", "image/webp"] as const;

export type EvidenceMime = (typeof ALLOWED_EVIDENCE_MIME)[number];

export interface InspectedImage {
  mime: EvidenceMime;
  extension: "jpg" | "png" | "webp";
  width: number;
  height: number;
  bytes: number;
}

export class EvidenceValidationError extends Error {
  readonly code: string;

  constructor(message: string, code = "invalid_evidence") {
    super(message);
    this.name = "EvidenceValidationError";
    this.code = code;
  }
}

function ensureDimensions(width: number, height: number): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_IMAGE_DIMENSION ||
    height > MAX_IMAGE_DIMENSION ||
    width * height > MAX_IMAGE_PIXELS
  ) {
    throw new EvidenceValidationError("La imagen tiene dimensiones no permitidas.");
  }
}

function inspectJpeg(buffer: Buffer): InspectedImage {
  if (buffer.length < 12 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
    throw new EvidenceValidationError("El archivo no es un JPEG válido.");
  }

  let offset = 2;
  let width = 0;
  let height = 0;

  while (offset + 1 < buffer.length) {
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;
    const marker = buffer[offset];
    offset += 1;

    if (marker === 0xd9) break;
    if (marker === 0xda) break;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (marker === 0x01) continue;
    if (offset + 2 > buffer.length) break;

    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) {
      throw new EvidenceValidationError("El JPEG está truncado.");
    }

    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame) {
      if (segmentLength < 7) throw new EvidenceValidationError("El JPEG no declara dimensiones válidas.");
      height = buffer.readUInt16BE(offset + 3);
      width = buffer.readUInt16BE(offset + 5);
    }

    offset += segmentLength;
  }

  if (width === 0 || height === 0) {
    throw new EvidenceValidationError("El JPEG no declara dimensiones válidas.");
  }
  if (buffer[buffer.length - 2] !== 0xff || buffer[buffer.length - 1] !== 0xd9) {
    throw new EvidenceValidationError("El JPEG está truncado.");
  }
  ensureDimensions(width, height);
  return { mime: "image/jpeg", extension: "jpg", width, height, bytes: buffer.length };
}

function inspectPng(buffer: Buffer): InspectedImage {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(signature)) {
    throw new EvidenceValidationError("El archivo no es un PNG válido.");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let first = true;
  let sawEnd = false;

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (length > buffer.length || dataEnd + 4 > buffer.length) {
      throw new EvidenceValidationError("El PNG está truncado.");
    }
    if (first) {
      if (type !== "IHDR" || length !== 13) {
        throw new EvidenceValidationError("El PNG no tiene un IHDR válido.");
      }
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      first = false;
    }
    if (type === "IEND") {
      sawEnd = true;
      break;
    }
    offset = dataEnd + 4;
  }

  if (first || !sawEnd || width === 0 || height === 0) {
    throw new EvidenceValidationError("El PNG está incompleto.");
  }
  ensureDimensions(width, height);
  return { mime: "image/png", extension: "png", width, height, bytes: buffer.length };
}

function inspectWebp(buffer: Buffer): InspectedImage {
  if (
    buffer.length < 30 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  ) {
    throw new EvidenceValidationError("El archivo no es un WebP válido.");
  }

  let offset = 12;
  let width = 0;
  let height = 0;

  while (offset + 8 <= buffer.length) {
    const type = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > buffer.length) throw new EvidenceValidationError("El WebP está truncado.");

    if (type === "VP8X" && size >= 10) {
      width = 1 + buffer.readUIntLE(dataStart + 4, 3);
      height = 1 + buffer.readUIntLE(dataStart + 7, 3);
    } else if (type === "VP8 " && size >= 10) {
      if (buffer[dataStart + 3] !== 0x9d || buffer[dataStart + 4] !== 0x01 || buffer[dataStart + 5] !== 0x2a) {
        throw new EvidenceValidationError("El WebP no tiene un frame válido.");
      }
      width = buffer.readUInt16LE(dataStart + 6) & 0x3fff;
      height = buffer.readUInt16LE(dataStart + 8) & 0x3fff;
    } else if (type === "VP8L" && size >= 5) {
      if (buffer[dataStart] !== 0x2f) throw new EvidenceValidationError("El WebP no tiene un VP8L válido.");
      const bits = buffer.readUInt32LE(dataStart + 1);
      width = (bits & 0x3fff) + 1;
      height = ((bits >> 14) & 0x3fff) + 1;
    }

    if (width > 0 && height > 0) break;
    offset = dataEnd + (size % 2);
  }

  if (width === 0 || height === 0) {
    throw new EvidenceValidationError("El WebP no declara dimensiones válidas.");
  }
  ensureDimensions(width, height);
  return { mime: "image/webp", extension: "webp", width, height, bytes: buffer.length };
}

export function inspectEvidenceImage(buffer: Buffer): InspectedImage {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new EvidenceValidationError("El archivo está vacío.");
  }
  if (buffer.length > MAX_EVIDENCE_BYTES) {
    throw new EvidenceValidationError("La imagen supera el tamaño máximo de 4 MB.");
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8) return inspectJpeg(buffer);
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return inspectPng(buffer);
  }
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return inspectWebp(buffer);
  }
  throw new EvidenceValidationError("Solo se aceptan imágenes JPEG, PNG o WebP reales.");
}

export function evidenceExtension(mime: EvidenceMime): "jpg" | "png" | "webp" {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  return "webp";
}

export function evidenceFileName(id: string, mime: EvidenceMime): string {
  return `evidence-${id.replace(/[^0-9]/g, "") || "unknown"}.${evidenceExtension(mime)}`;
}
