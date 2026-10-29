import { describe, expect, it } from "vitest";
import { DatabaseQueryError, DatabaseUnavailableError } from "./database.ts";
import { ApiError, mapError, readJson, stringField } from "./http.ts";

describe("HTTP error mapping", () => {
  it("does not expose database messages", async () => {
    const response = mapError(new DatabaseQueryError("23514"));
    expect(response.status).toBe(409);
    const text = await response.text();
    expect(text).toContain("invalid_state");
    expect(text).not.toContain("SQL");
  });

  it("maps authorization, prerequisite and retry states", () => {
    expect(mapError(new DatabaseQueryError("28000")).status).toBe(401);
    expect(mapError(new DatabaseQueryError("42501")).status).toBe(403);
    expect(mapError(new DatabaseQueryError("55000")).status).toBe(409);
    expect(mapError(new DatabaseQueryError("40001")).status).toBe(409);
    expect(mapError(new DatabaseUnavailableError()).status).toBe(503);
    expect(mapError(new ApiError(400, "invalid", "Dato inválido.")).status).toBe(400);
  });

  it("rejects non-JSON bodies and oversized fields", async () => {
    const request = new Request("https://example.test/api", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "hello",
    });
    await expect(readJson(request)).rejects.toMatchObject({ status: 415 });
    expect(() => stringField({ name: "x".repeat(20) }, "name", { max: 10 })).toThrow(ApiError);
  });
});
