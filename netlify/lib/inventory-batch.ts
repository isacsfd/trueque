import { normalizeIsbn } from "./crypto.ts";
import { firstNonEmptyRow, rowValues, type XlsxRow, type XlsxSheet } from "./xlsx.ts";

export const MAX_BATCH_ROWS = 5_000;

export interface BatchColumnMapping {
  title: string;
  author: string;
  publisher?: string;
  genre?: string;
  isbn?: string;
  inventory_code?: string;
  location?: string;
  observations?: string;
  source_number?: string;
  copy_number?: string;
}

export interface BatchRow {
  source_row: number;
  raw: Record<string, string>;
  mapped: Record<string, string | null>;
  status: "valid" | "warning" | "rejected" | "duplicate";
  errors: string[];
  warnings: string[];
  inventory_code: string | null;
}

export interface ExistingBibliographicKeys {
  isbn: Set<string>;
  titleAuthorPublisher: Set<string>;
}

export interface BatchValidation {
  rows: BatchRow[];
  validRows: number;
  warningRows: number;
  rejectedRows: number;
  duplicateRows: number;
  errors: string[];
}

export interface SheetInspection {
  name: string;
  headerRow: number;
  headers: string[];
  sampleRows: Array<{ rowNumber: number; values: string[] }>;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function bibKey(title: string, author: string, publisher: string): string {
  return `${normalizeKey(title)}\u0000${normalizeKey(author)}\u0000${normalizeKey(publisher)}`;
}

function headersFor(sheet: XlsxSheet, headerRow: number): string[] {
  const row = sheet.rows.find((candidate) => candidate.rowNumber === headerRow);
  if (!row) throw new Error(`No se encontró la fila de encabezados ${headerRow}.`);
  const values = rowValues(row, Math.max(row.cells.length, 1)).map((value) => value.trim());
  while (values.length > 0 && values[values.length - 1] === "") values.pop();
  if (values.length === 0) throw new Error("La fila de encabezados está vacía.");
  if (values.some((value) => value === "")) {
    throw new Error("La fila de encabezados contiene columnas vacías.");
  }
  if (new Set(values.map((value) => value.toLowerCase())).size !== values.length) {
    throw new Error("La fila de encabezados contiene nombres duplicados.");
  }
  return values;
}

export function inspectSheets(sheet: XlsxSheet, requestedHeaderRow?: number): SheetInspection {
  const headerRow = requestedHeaderRow ?? firstNonEmptyRow(sheet.rows);
  const headers = (() => {
    try {
      return headersFor(sheet, headerRow);
    } catch {
      return [];
    }
  })();
  const sampleRows = sheet.rows
    .filter((row) => row.rowNumber > headerRow)
    .slice(0, 12)
    .map((row) => ({ rowNumber: row.rowNumber, values: rowValues(row, Math.max(headers.length, 1)) }));
  return { name: sheet.name, headerRow, headers, sampleRows };
}

export function validateBatch(input: {
  sheet: XlsxSheet;
  headerRow: number;
  mapping: BatchColumnMapping;
  existing: ExistingBibliographicKeys;
  existingCodes: Set<string>;
}): BatchValidation {
  const headers = headersFor(input.sheet, input.headerRow);
  const indices = new Map<string, number>();
  headers.forEach((header, index) => indices.set(header.toLowerCase(), index));

  const required = ["title", "author"] as const;
  for (const key of required) {
    if (!input.mapping[key]) throw new Error(`Falta el mapeo obligatorio: ${key}.`);
    if (!indices.has(input.mapping[key]!.toLowerCase())) {
      throw new Error(`La columna ${input.mapping[key]} no existe en la hoja.`);
    }
  }
  for (const [key, header] of Object.entries(input.mapping)) {
    if (header && !indices.has(header.toLowerCase())) {
      throw new Error(`La columna ${header} del campo ${key} no existe.`);
    }
  }

  const rows: BatchRow[] = [];
  const dataRows = input.sheet.rows.filter((row) => row.rowNumber > input.headerRow);
  if (dataRows.length === 0) return { rows: [], validRows: 0, warningRows: 0, rejectedRows: 0, duplicateRows: 0, errors: ["La hoja no contiene filas de datos."] };

  const column = (row: XlsxRow, key: keyof BatchColumnMapping): string => {
    const header = input.mapping[key];
    if (!header) return "";
    return rowValues(row, headers.length)[indices.get(header.toLowerCase())!] ?? "";
  };

  const duplicateKeys = new Map<string, number>();
  const codeCounts = new Map<string, number>();
  for (const row of dataRows) {
    const title = column(row, "title");
    const author = column(row, "author");
    const publisher = column(row, "publisher");
    const isbn = normalizeIsbn(column(row, "isbn") || null);
    const key = isbn ? `isbn:${isbn}` : `bib:${bibKey(title, author, publisher)}`;
    if (title || author || publisher || isbn) duplicateKeys.set(key, (duplicateKeys.get(key) ?? 0) + 1);
    const code = column(row, "inventory_code").trim();
    if (code) codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);
  }

  for (const row of dataRows) {
    const values = rowValues(row, headers.length);
    if (values.every((value) => value === "")) continue;
    if (rows.length >= MAX_BATCH_ROWS) {
      return { rows, validRows: 0, warningRows: 0, rejectedRows: 0, duplicateRows: 0, errors: [`El lote excede el máximo de ${MAX_BATCH_ROWS} filas.`] };
    }

    const raw: Record<string, string> = {};
    headers.forEach((header, index) => {
      raw[header] = values[index] ?? "";
    });
    const title = column(row, "title").trim();
    const author = column(row, "author").trim();
    const publisher = column(row, "publisher").trim();
    const genre = column(row, "genre").trim();
    const isbnInput = column(row, "isbn").trim();
    const isbnNormalized = normalizeIsbn(isbnInput || null);
    const code = column(row, "inventory_code").trim();
    const location = column(row, "location").trim();
    const observations = column(row, "observations").trim();
    const sourceNumber = column(row, "source_number").trim();
    const copyNumber = column(row, "copy_number").trim();
    const errors: string[] = [];
    const warnings: string[] = [];
    const formula = row.cells.some((cell) => cell.formula);

    // Filler rows that only carry a location/number but no bibliographic data
    // are skipped, matching the historical importer. Incomplete rows with a
    // title or author are kept and rejected explicitly.
    if (!title && !author && !publisher && !genre && !isbnInput) continue;

    if (formula) errors.push("La fila contiene fórmulas; no se evalúan ni se importan.");
    if (!title) errors.push("Falta el título.");
    if (!author) errors.push("Falta el autor.");
    if (isbnInput && !isbnNormalized) errors.push("El ISBN no es válido.");
    if (code && (codeCounts.get(code) ?? 0) > 1) errors.push("Código de inventario duplicado dentro del lote.");
    if (code && input.existingCodes.has(code)) errors.push("El código de inventario ya existe en el inventario.");

    const key = isbnNormalized ? `isbn:${isbnNormalized}` : `bib:${bibKey(title, author, publisher)}`;
    if ((duplicateKeys.get(key) ?? 0) > 1) {
      warnings.push("Posible duplicado bibliográfico en el lote; se conservarán ejemplares separados.");
    }
    if (
      (isbnNormalized && input.existing.isbn.has(isbnNormalized)) ||
      (!isbnNormalized && input.existing.titleAuthorPublisher.has(key.slice(4)))
    ) {
      warnings.push("Posible coincidencia con un registro bibliográfico existente; no se sobrescribirá.");
    }

    const status = errors.length > 0
      ? code && (codeCounts.get(code) ?? 0) > 1 ? "duplicate" : "rejected"
      : warnings.length > 0 ? "warning" : "valid";
    rows.push({
      source_row: row.rowNumber,
      raw,
      mapped: {
        title: title || null,
        author: author || null,
        publisher: publisher || null,
        genre: genre || null,
        isbn: isbnInput || null,
        isbn_normalized: isbnNormalized,
        inventory_code: code || null,
        location: location || null,
        observations: observations || null,
        source_number: sourceNumber || null,
        copy_number: copyNumber || null,
      },
      status,
      errors,
      warnings,
      inventory_code: code || null,
    });
  }

  return {
    rows,
    validRows: rows.filter((row) => row.status === "valid").length,
    warningRows: rows.filter((row) => row.status === "warning").length,
    rejectedRows: rows.filter((row) => row.status === "rejected").length,
    duplicateRows: rows.filter((row) => row.status === "duplicate").length,
    errors: [],
  };
}
