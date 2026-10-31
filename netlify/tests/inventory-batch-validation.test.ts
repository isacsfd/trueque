// @vitest-environment node
import { describe, expect, it } from "vitest";
import { validateBatch } from "../lib/inventory-batch.ts";
import type { XlsxRow, XlsxSheet } from "../lib/xlsx.ts";

function cell(value: string): { value: string; formula: boolean } {
  return { value, formula: false };
}

function row(rowNumber: number, values: string[]): XlsxRow {
  return { rowNumber, cells: values.map(cell) };
}

function sheet(): XlsxSheet {
  return {
    name: "Inventario",
    rows: [
      row(1, ["TITULO", "AUTOR", "ESTADO", "REFERENCIA", "CODIGO"]),
      row(2, ["Publicable", "Autora", "excelente", "Acta 1", "INV-1"]),
      row(3, ["Pendiente", "Autor", "", "", "INV-2"]),
      row(4, ["Sin condición", "Autor", "", "Acta 2", "INV-3"]),
      row(5, ["Estado inválido", "Autor", "regular", "Acta 3", "INV-4"]),
    ],
  };
}

describe("inventory batch condition validation", () => {
  it("maps assessed conditions and verification references for auto-publication", () => {
    const result = validateBatch({
      sheet: sheet(),
      headerRow: 1,
      mapping: {
        title: "TITULO",
        author: "AUTOR",
        physical_condition: "ESTADO",
        verification_reference: "REFERENCIA",
        inventory_code: "CODIGO",
      },
      existing: { isbn: new Set(), titleAuthorPublisher: new Set() },
      existingCodes: new Set(),
    });

    expect(result.rows[0]).toMatchObject({
      status: "valid",
      mapped: {
        title: "Publicable",
        physical_condition: "excellent",
        verification_reference: "Acta 1",
      },
    });
    expect(result.rows[1]).toMatchObject({
      status: "valid",
      mapped: { physical_condition: null, verification_reference: null },
    });
    expect(result.rows[2]).toMatchObject({
      status: "rejected",
      errors: expect.arrayContaining(["La referencia de verificación requiere un estado físico evaluado."]),
    });
    expect(result.rows[3]).toMatchObject({
      status: "rejected",
      errors: expect.arrayContaining(["El estado físico no es válido."]),
    });
  });

  it("warns when an assessed condition has no verification reference", () => {
    const result = validateBatch({
      sheet: {
        name: "Inventario",
        rows: [
          row(1, ["TITULO", "AUTOR", "ESTADO"]),
          row(2, ["Libro", "Autor", "good"]),
        ],
      },
      headerRow: 1,
      mapping: {
        title: "TITULO",
        author: "AUTOR",
        physical_condition: "ESTADO",
      },
      existing: { isbn: new Set(), titleAuthorPublisher: new Set() },
      existingCodes: new Set(),
    });

    expect(result.rows[0]).toMatchObject({
      status: "warning",
      warnings: expect.arrayContaining([
        "Se importará sin publicar: falta la referencia de verificación.",
      ]),
    });
  });
});
