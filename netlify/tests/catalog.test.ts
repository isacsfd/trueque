// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { query } from "../lib/database.ts";
import { parseCatalogSearch } from "../lib/catalog-search.ts";
import handler from "../functions/catalog.ts";

vi.mock("../lib/database.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/database.ts")>();
  return { ...actual, query: vi.fn() };
});

function request(path: string): Request {
  return new Request(`https://example.test${path}`);
}

function catalogRow(label: string) {
  return {
    copy_id: label,
    bibliographic_record_id: `bib-${label}`,
    title: `Titulo ${label}`,
    author: `Autor ${label}`,
    isbn: null,
    edition: null,
    publication_year: 2020,
    publisher: "Editorial",
    genre: "Novela",
    inventory_code: `INV-${label}`,
    physical_condition: "good",
    location: "Estante",
  };
}

describe("catalog search contract", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes accents, whitespace, case and rejects oversized input", () => {
    expect(parseCatalogSearch(new URL("https://example.test/api/catalog?q=%20%20CIEN%20%20A%C3%91OS%20"))).toMatchObject({
      q: "cien anos",
      page: 1,
      pageSize: 24,
      paginated: true,
    });
    expect(parseCatalogSearch(new URL("https://example.test/api/catalog?q=Garc%C3%ADa"))).toMatchObject({
      q: "garcia",
    });
    expect(() => parseCatalogSearch(new URL(`https://example.test/api/catalog?q=${"x".repeat(121)}`))).toThrow(
      /demasiado largo/,
    );
    expect(() => parseCatalogSearch(new URL("https://example.test/api/catalog?page=0"))).toThrow(
      /no es válido/,
    );
  });

  it("returns filtered, paginated and stable results with genres", async () => {
    vi.mocked(query).mockImplementation(async (sql) => {
      if (sql.includes("release_expired_reservations")) return [];
      if (sql.includes("count(*)::int AS total")) return [{ total: 2 }];
      if (sql.includes("GROUP BY genre")) return [{ genre: "Novela" }];
      return [catalogRow("1")];
    });

    const response = await handler(request("/api/catalog?q=Garc%C3%ADa&genre=Novela&page=2&pageSize=1"));
    expect(response.status).toBe(200);
    const body = await response.json() as {
      items: Array<Record<string, unknown>>;
      pagination: Record<string, unknown>;
      genres: string[];
      query: Record<string, unknown>;
    };
    expect(body.items[0]).toMatchObject({ title: "Titulo 1", inventoryCode: "INV-1" });
    expect(body.pagination).toEqual({ page: 2, pageSize: 1, total: 2, hasMore: false });
    expect(body.genres).toEqual(["Novela"]);
    expect(body.query).toEqual({ q: "garcia", genre: "novela", code: null });
    expect(vi.mocked(query)).toHaveBeenCalledWith(
      expect.stringContaining("LIMIT $4 OFFSET $5"),
      ["garcia", "novela", null, 1, 1],
    );
  });

  it("passes malicious input as a parameter and never interpolates it", async () => {
    vi.mocked(query).mockImplementation(async (sql) => {
      if (sql.includes("release_expired_reservations")) return [];
      if (sql.includes("count(*)::int AS total")) return [{ total: 0 }];
      if (sql.includes("GROUP BY genre")) return [];
      return [];
    });

    const payload = "%' OR 1=1 --";
    const response = await handler(request(`/api/catalog?q=${encodeURIComponent(payload)}`));
    expect(response.status).toBe(200);
    const calls = vi.mocked(query).mock.calls;
    const dataCall = calls.find(([sql]) => String(sql).includes("LIMIT $4 OFFSET $5"));
    expect(dataCall).toBeDefined();
    expect(String(dataCall?.[0])).not.toContain(payload);
    expect(dataCall?.[1]).toEqual(["%' or 1=1 --", null, null, 24, 0]);
  });

  it("keeps the legacy all-items response when no pagination parameters are sent", async () => {
    vi.mocked(query).mockImplementation(async (sql) => {
      if (sql.includes("release_expired_reservations")) return [];
      if (sql.includes("count(*)::int AS total")) return [{ total: 1 }];
      if (sql.includes("GROUP BY genre")) return [];
      return [catalogRow("1")];
    });

    const response = await handler(request("/api/catalog"));
    expect(response.status).toBe(200);
    const body = await response.json() as { pagination: Record<string, unknown> };
    expect(body.pagination).toEqual({ page: 1, pageSize: 100, total: 1, hasMore: false });
  });

  it("rejects invalid page sizes without querying the database", async () => {
    const response = await handler(request("/api/catalog?page=1&pageSize=100"));
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { code: string } };
    expect(body.error.code).toBe("invalid_query");
    expect(vi.mocked(query)).not.toHaveBeenCalled();
  });
});
