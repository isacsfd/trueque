import { query } from "../lib/database.ts";
import { parseCatalogSearch } from "../lib/catalog-search.ts";
import { json, mapError, methodNotAllowed } from "../lib/http.ts";
import { normalizedSqlText } from "../lib/sql-text.ts";

interface CatalogRow {
  copy_id: string;
  bibliographic_record_id: string;
  title: string;
  author: string;
  isbn: string | null;
  edition: string | null;
  publication_year: number | null;
  publisher: string | null;
  genre: string | null;
  inventory_code: string;
  physical_condition: string;
  location: string;
}

function whereClause(): string {
  return `WHERE ($1::text IS NULL
       OR strpos(${normalizedSqlText("title")}, $1) > 0
       OR strpos(${normalizedSqlText("author")}, $1) > 0
       OR strpos(${normalizedSqlText("genre")}, $1) > 0
       OR strpos(lower(inventory_code), $1) > 0)
   AND ($2::text IS NULL OR ${normalizedSqlText("genre")} = $2)
   AND ($3::text IS NULL OR strpos(lower(inventory_code), lower($3)) > 0)`;
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();

  try {
    const url = new URL(request.url);
    const search = parseCatalogSearch(url);
    const values = [search.q, search.genre, search.code];
    const offset = (search.page - 1) * search.pageSize;

    // Expired reservations must not keep a verified copy out of the catalogue
    // forever. This routine only releases rows whose expires_at has passed.
    await query("SELECT public.release_expired_reservations()").catch(() => undefined);

    const countRows = await query<{ total: number }>(
      `SELECT count(*)::int AS total FROM public.available_catalog ${whereClause()}`,
      values,
    );
    const total = countRows[0]?.total ?? 0;

    const rows = await query<CatalogRow>(
      `SELECT copy_id, bibliographic_record_id, title, author, isbn, edition,
              publication_year, publisher, genre, inventory_code, physical_condition, location
       FROM public.available_catalog
       ${whereClause()}
       ORDER BY lower(title), lower(author), copy_id
       LIMIT $4 OFFSET $5`,
      [...values, search.pageSize, offset],
    );

    const genreRows = await query<{ genre: string }>(
      `SELECT genre
       FROM public.available_catalog
       WHERE genre IS NOT NULL AND btrim(genre) <> ''
       GROUP BY genre
       ORDER BY lower(genre)
       LIMIT 50`,
    );

    return json(
      200,
      {
        items: rows.map((row) => ({
          copyId: row.copy_id,
          bibliographicRecordId: row.bibliographic_record_id,
          title: row.title,
          author: row.author,
          isbn: row.isbn,
          edition: row.edition,
          publicationYear: row.publication_year,
          publisher: row.publisher,
          genre: row.genre,
          inventoryCode: row.inventory_code,
          physicalCondition: row.physical_condition,
          location: row.location,
        })),
        pagination: {
          page: search.page,
          pageSize: search.pageSize,
          total,
          hasMore: offset + rows.length < total,
        },
        genres: genreRows.map((row) => row.genre),
        query: { q: search.q, genre: search.genre, code: search.code },
      },
      { "Cache-Control": "no-store, max-age=0" },
    );
  } catch (error) {
    return mapError(error);
  }
}

export const config = { path: "/api/catalog" };
