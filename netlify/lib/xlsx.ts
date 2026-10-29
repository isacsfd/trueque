import { inflateRawSync } from "node:zlib";

export const MAX_XLSX_BYTES = 10 * 1024 * 1024;
export const MAX_XLSX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
export const MAX_XLSX_ENTRIES = 200;
export const MAX_XLSX_ROWS = 10_000;
export const MAX_XLSX_CELLS = 250_000;

export class XlsxValidationError extends Error {
  readonly code: string;

  constructor(message: string, code = "invalid_xlsx") {
    super(message);
    this.name = "XlsxValidationError";
    this.code = code;
  }
}

export interface XlsxCell {
  value: string;
  formula: boolean;
}

export interface XlsxRow {
  rowNumber: number;
  cells: XlsxCell[];
}

export interface XlsxSheet {
  name: string;
  rows: XlsxRow[];
}

export interface XlsxWorkbook {
  sheets: XlsxSheet[];
}

interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  localOffset: number;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal: string) => String.fromCodePoint(parseInt(decimal, 10)))
    .replace(/&amp;/g, "&");
}

function ensureSafeXml(xml: string): string {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new XlsxValidationError("El archivo contiene una definición XML no permitida.");
  }
  return xml;
}

function readZipEntries(buffer: Buffer): Map<string, ZipEntry> {
  if (buffer.length > MAX_XLSX_BYTES) {
    throw new XlsxValidationError("El Excel supera el tamaño máximo de 10 MB.");
  }
  const minimum = Math.max(0, buffer.length - 65_557);
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new XlsxValidationError("El archivo no es un ZIP/XLSX válido.");

  const entriesCount = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (entriesCount <= 0 || entriesCount > MAX_XLSX_ENTRIES) {
    throw new XlsxValidationError("El Excel contiene una cantidad de archivos no permitida.");
  }
  if (centralOffset >= buffer.length) throw new XlsxValidationError("El Excel está truncado.");

  const entries = new Map<string, ZipEntry>();
  let offset = centralOffset;
  let totalUncompressed = 0;

  for (let index = 0; index < entriesCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new XlsxValidationError("El directorio del Excel está corrupto.");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    if (flags & 0x1) throw new XlsxValidationError("El Excel está cifrado y no se puede procesar.");
    if (method !== 0 && method !== 8) {
      throw new XlsxValidationError("El Excel usa un método de compresión no permitido.");
    }
    if (uncompressedSize > MAX_XLSX_UNCOMPRESSED_BYTES) {
      throw new XlsxValidationError("Una parte del Excel excede el tamaño descomprimido permitido.");
    }
    if (uncompressedSize > 1_000_000 && uncompressedSize / Math.max(compressedSize, 1) > 100) {
      throw new XlsxValidationError("El Excel parece un ZIP bomb.");
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_XLSX_UNCOMPRESSED_BYTES) {
      throw new XlsxValidationError("El Excel descomprimido excede el límite permitido.");
    }
    if (offset + 46 + nameLength + extraLength + commentLength > buffer.length) {
      throw new XlsxValidationError("El directorio del Excel está truncado.");
    }
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength).replace(/\\/g, "/");
    if (!name || name.startsWith("/") || name.split("/").includes("..")) {
      throw new XlsxValidationError("El Excel contiene una ruta no permitida.");
    }
    if (name.toLowerCase().includes("vbaproject") || name.toLowerCase().includes("externallink")) {
      throw new XlsxValidationError("El Excel contiene macros o vínculos externos no permitidos.");
    }
    if (entries.has(name)) throw new XlsxValidationError("El Excel contiene entradas duplicadas.");
    entries.set(name, { name, compressedSize, uncompressedSize, method, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  if (!entries.has("[Content_Types].xml") || !entries.has("xl/workbook.xml")) {
    throw new XlsxValidationError("El archivo no tiene la estructura de un .xlsx.");
  }
  return entries;
}

function readZipEntry(buffer: Buffer, entry: ZipEntry): string {
  const offset = entry.localOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== 0x04034b50) {
    throw new XlsxValidationError("Una entrada del Excel está corrupta.");
  }
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) throw new XlsxValidationError("Una entrada del Excel está truncada.");
  const data = buffer.subarray(dataStart, dataEnd);
  let output: Buffer;
  try {
    output = entry.method === 0 ? data : inflateRawSync(data);
  } catch {
    throw new XlsxValidationError("No se pudo descomprimir una entrada del Excel.");
  }
  if (output.length !== entry.uncompressedSize) {
    throw new XlsxValidationError("El tamaño descomprimido del Excel no coincide.");
  }
  return output.toString("utf8");
}

function sharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  ensureSafeXml(xml);
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) =>
    [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
      .map((text) => decodeXml(text[1]))
      .join(""),
  );
}

function columnIndex(reference: string): number {
  const letters = reference.match(/^[A-Z]+/i)?.[0]?.toUpperCase() ?? "";
  if (!letters) return 0;
  let value = 0;
  for (const letter of letters) value = value * 26 + (letter.charCodeAt(0) - 64);
  return value - 1;
}

function cellValue(
  attributes: string,
  body: string,
  strings: string[],
): XlsxCell {
  const type = attributes.match(/\bt="([^"]+)"/i)?.[1] ?? "";
  const formula = /<f\b/i.test(body);
  const raw = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1];
  if (type === "s") {
    const index = Number(raw ?? "");
    return { value: Number.isInteger(index) ? strings[index] ?? "" : "", formula };
  }
  if (type === "inlineStr") {
    const value = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
      .map((match) => decodeXml(match[1]))
      .join("");
    return { value, formula };
  }
  if (type === "str") return { value: decodeXml(raw ?? ""), formula };
  if (type === "b") return { value: raw === "1" ? "true" : "false", formula };
  return { value: raw === undefined ? "" : decodeXml(raw), formula };
}

function parseSheet(xml: string, strings: string[]): XlsxRow[] {
  ensureSafeXml(xml);
  const rows: XlsxRow[] = [];
  let cellCount = 0;
  for (const rowMatch of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNumber = Number(rowMatch[1].match(/\br="([0-9]+)"/)?.[1] ?? rows.length + 1);
    const body = rowMatch[2] ?? "";
    const cells: XlsxCell[] = [];
    for (const cellMatch of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const reference = cellMatch[1].match(/\br="([A-Z]+[0-9]+)"/i)?.[1] ?? "";
      const index = columnIndex(reference);
      if (index < 0 || index > 500) throw new XlsxValidationError("El Excel contiene demasiadas columnas.");
      while (cells.length <= index) cells.push({ value: "", formula: false });
      cells[index] = cellValue(cellMatch[1], cellMatch[2] ?? "", strings);
      cellCount += 1;
    }
    rows.push({ rowNumber, cells });
    if (rows.length > MAX_XLSX_ROWS || cellCount > MAX_XLSX_CELLS) {
      throw new XlsxValidationError("El Excel contiene demasiadas filas o celdas.");
    }
  }
  return rows;
}

function workbookSheets(workbookXml: string, relsXml: string | undefined): Array<{ name: string; path: string }> {
  ensureSafeXml(workbookXml);
  if (relsXml) ensureSafeXml(relsXml);
  const relationships = new Map<string, string>();
  if (relsXml) {
    for (const match of relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
      const id = match[1].match(/\bId="([^"]+)"/)?.[1];
      const target = match[1].match(/\bTarget="([^"]+)"/)?.[1];
      if (id && target) relationships.set(id, target.replace(/\\/g, "/"));
    }
  }
  const sheets: Array<{ name: string; path: string }> = [];
  const sheetMatches = [...workbookXml.matchAll(/<sheet\b([^>]*)\/?>/g)];
  for (let index = 0; index < sheetMatches.length; index += 1) {
    const attributes = sheetMatches[index][1];
    const name = decodeXml(attributes.match(/\bname="([^"]*)"/)?.[1] ?? `Hoja ${index + 1}`);
    const relation = attributes.match(/\br:id="([^"]+)"/)?.[1];
    const target = relation ? relationships.get(relation) : undefined;
    let path = target && !target.startsWith("/") ? `xl/${target}` : target?.replace(/^\//, "");
    if (!path) path = `xl/worksheets/sheet${index + 1}.xml`;
    path = path.replace(/\/\.\//g, "/");
    sheets.push({ name, path });
  }
  return sheets;
}

export function parseXlsx(buffer: Buffer): XlsxWorkbook {
  const entries = readZipEntries(buffer);
  const workbookXml = readZipEntry(buffer, entries.get("xl/workbook.xml")!);
  const rels = entries.get("xl/_rels/workbook.xml.rels");
  const relsXml = rels ? readZipEntry(buffer, rels) : undefined;
  const stringsEntry = entries.get("xl/sharedStrings.xml");
  const strings = sharedStrings(stringsEntry ? readZipEntry(buffer, stringsEntry) : undefined);
  const sheets = workbookSheets(workbookXml, relsXml);
  if (sheets.length === 0) throw new XlsxValidationError("El Excel no contiene hojas.");

  return {
    sheets: sheets.map((sheet) => {
      const entry = entries.get(sheet.path);
      if (!entry) throw new XlsxValidationError(`No se encontró la hoja ${sheet.name}.`);
      return { name: sheet.name, rows: parseSheet(readZipEntry(buffer, entry), strings) };
    }),
  };
}

export function firstNonEmptyRow(rows: XlsxRow[]): number {
  const withValues = rows.map((row) => ({
    row,
    count: row.cells.filter((cell) => cell.value.trim() !== "").length,
  }));
  const likelyHeader = withValues.find((entry) => entry.count >= 2);
  if (likelyHeader) return likelyHeader.row.rowNumber;
  const first = withValues.find((entry) => entry.count > 0);
  return first?.row.rowNumber ?? 1;
}

export function rowValues(row: XlsxRow, width: number): string[] {
  return Array.from({ length: width }, (_, index) => row.cells[index]?.value.trim() ?? "");
}
