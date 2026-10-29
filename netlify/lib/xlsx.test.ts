// @vitest-environment node
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { firstNonEmptyRow, parseXlsx, rowValues } from "./xlsx.ts";

describe("XLSX reader", () => {
  it("reads the existing institutional workbook without executing formulas", async () => {
    const buffer = await readFile(new URL("../../INVENTARIO TRUEQUE.xlsx", import.meta.url));
    const workbook = parseXlsx(buffer);
    expect(workbook.sheets.length).toBeGreaterThan(0);
    const sheet = workbook.sheets[0];
    expect(sheet.rows.length).toBeGreaterThan(50);
    const headerRow = firstNonEmptyRow(sheet.rows);
    expect(headerRow).toBeGreaterThan(0);
    const row = sheet.rows.find((candidate) => candidate.rowNumber === headerRow);
    expect(row).toBeTruthy();
    expect(rowValues(row!, 6).length).toBe(6);
  });

  it("rejects non-ZIP content and suspicious XML", () => {
    expect(() => parseXlsx(Buffer.from("not an xlsx"))).toThrow(/ZIP\/XLSX/);
    expect(() => parseXlsx(Buffer.from("PK\x05\x06" + "\0".repeat(18)))).toThrow();
  });
});
