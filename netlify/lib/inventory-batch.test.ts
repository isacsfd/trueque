// @vitest-environment node
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { inspectSheets, validateBatch } from "./inventory-batch.ts";
import { parseXlsx, type XlsxSheet } from "./xlsx.ts";

const emptyExisting = {
  isbn: new Set<string>(),
  titleAuthorPublisher: new Set<string>(),
};

function sheetWith(rows: XlsxSheet["rows"]): XlsxSheet {
  return { name: "Hoja1", rows };
}

describe("inventory batch validation", () => {
  it("inspects and validates the existing workbook without importing", async () => {
    const workbook = parseXlsx(await readFile(new URL("../../INVENTARIO TRUEQUE.xlsx", import.meta.url)));
    const sheet = workbook.sheets[0];
    const inspection = inspectSheets(sheet);
    expect(inspection.headerRow).toBe(2);
    expect(inspection.headers).toContain("TITULO");

    const result = validateBatch({
      sheet,
      headerRow: inspection.headerRow,
      mapping: {
        title: "TITULO",
        author: "AUTOR",
        publisher: "EDITORIAL",
        location: "BIBLIOTECA ACTUAL",
        source_number: "No.",
        copy_number: "EJEMPLAR",
      },
      existing: emptyExisting,
      existingCodes: new Set(),
    });
    expect(result.rows).toHaveLength(67);
    expect(result.validRows).toBe(63);
    expect(result.warningRows).toBe(4);
    expect(result.rejectedRows).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("keeps legitimate repeated titles as separate rows and flags them", () => {
    const rows = [
      { rowNumber: 1, cells: [{ value: "TITULO", formula: false }, { value: "AUTOR", formula: false }, { value: "EDITORIAL", formula: false }] },
      { rowNumber: 2, cells: [{ value: "La Celestina", formula: false }, { value: "Autor", formula: false }, { value: "Editor", formula: false }] },
      { rowNumber: 3, cells: [{ value: "La Celestina", formula: false }, { value: "Autor", formula: false }, { value: "Editor", formula: false }] },
    ];
    const result = validateBatch({
      sheet: sheetWith(rows),
      headerRow: 1,
      mapping: { title: "TITULO", author: "AUTOR", publisher: "EDITORIAL" },
      existing: emptyExisting,
      existingCodes: new Set(),
    });
    expect(result.rows).toHaveLength(2);
    expect(result.warningRows).toBe(2);
    expect(result.rows.every((row) => row.warnings.some((warning) => warning.includes("duplicado bibliográfico")))).toBe(true);
  });

  it("rejects formulas, incomplete rows and duplicate codes", () => {
    const rows = [
      { rowNumber: 1, cells: [{ value: "TITULO", formula: false }, { value: "AUTOR", formula: false }, { value: "CODIGO", formula: false }] },
      { rowNumber: 2, cells: [{ value: "=HYPERLINK(\"x\")", formula: true }, { value: "Autor", formula: false }, { value: "IUB-1", formula: false }] },
      { rowNumber: 3, cells: [{ value: "Sin autor", formula: false }, { value: "", formula: false }, { value: "IUB-2", formula: false }] },
      { rowNumber: 4, cells: [{ value: "Código repetido", formula: false }, { value: "Autor", formula: false }, { value: "IUB-2", formula: false }] },
    ];
    const result = validateBatch({
      sheet: sheetWith(rows),
      headerRow: 1,
      mapping: { title: "TITULO", author: "AUTOR", inventory_code: "CODIGO" },
      existing: emptyExisting,
      existingCodes: new Set(["IUB-2"]),
    });
    expect(result.rows[0]?.status).toBe("rejected");
    expect(result.rows[1]?.status).toBe("duplicate");
    expect(result.rows[2]?.status).toBe("duplicate");
    expect(result.duplicateRows).toBe(2);
  });
});
