import { query } from "../lib/database.ts";
import { json, mapError, methodNotAllowed } from "../lib/http.ts";

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

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();

  try {
    const rows = await query<CatalogRow>(
      `SELECT copy_id, bibliographic_record_id, title, author, isbn, edition,
              publication_year, publisher, genre, inventory_code, physical_condition, location
       FROM public.available_catalog
       ORDER BY title, author, copy_id
       LIMIT 100`,
    );

    return json(200, {
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
    });
  } catch (error) {
    return mapError(error);
  }
}

export const config = { path: "/api/catalog" };
