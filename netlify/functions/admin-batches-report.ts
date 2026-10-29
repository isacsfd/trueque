import { requireAdmin } from "../lib/auth.ts";
import { requireAdminPermission } from "../lib/admin-permissions.ts";
import { queryAdmin } from "../lib/database.ts";
import { ApiError, mapError, methodNotAllowed } from "../lib/http.ts";

function csv(value: unknown): string {
  const text = String(value ?? "");
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();

  try {
    const session = requireAdmin(request);
    await requireAdminPermission(session.actorUserId, "inventory.batches.read");
    const url = new URL(request.url);
    const rawId = url.searchParams.get("id");
    if (!rawId || !/^[1-9][0-9]{0,15}$/.test(rawId)) {
      throw new ApiError(400, "invalid_field", "El lote solicitado no es válido.");
    }
    const id = Number(rawId);
    const rows = await queryAdmin<{
      source_row: number;
      status: string;
      mapped_data: Record<string, string | null>;
      errors: string[];
      warnings: string[];
      inventory_code: string | null;
    }>(
      `SELECT source_row, status, mapped_data, errors, warnings, inventory_code
       FROM public.inventory_batch_rows
       WHERE batch_id = $1
       ORDER BY source_row`,
      [id],
    );
    if (rows.length === 0) {
      const exists = await queryAdmin<{ id: string }>("SELECT id FROM public.inventory_batches WHERE id = $1", [id]);
      if (!exists[0]) throw new ApiError(404, "not_found", "No se encontró el lote.");
    }

    const header = ["fila_origen", "estado", "titulo", "autor", "editorial", "isbn", "codigo_inventario", "errores", "advertencias"];
    const lines = [header.map(csv).join(",")];
    for (const row of rows) {
      lines.push([
        row.source_row,
        row.status,
        row.mapped_data.title,
        row.mapped_data.author,
        row.mapped_data.publisher,
        row.mapped_data.isbn,
        row.inventory_code ?? row.mapped_data.inventory_code,
        row.errors.join(" | "),
        row.warnings.join(" | "),
      ].map(csv).join(","));
    }
    return new Response(`\uFEFF${lines.join("\r\n")}\r\n`, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="lote-${id}-validacion.csv"`,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return mapError(error);
  }
}

export const config = { path: "/api/admin/batches/report" };
