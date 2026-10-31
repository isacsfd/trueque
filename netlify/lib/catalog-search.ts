import { ApiError } from "./http.ts";

export interface CatalogSearch {
  q: string | null;
  genre: string | null;
  code: string | null;
  page: number;
  pageSize: number;
  paginated: boolean;
}

const MAX_QUERY = 120;
const MAX_PAGE_SIZE = 50;

export function normalizeCatalogText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function optionalText(url: URL, key: string, max: number): string | null {
  const raw = url.searchParams.get(key);
  if (raw === null) return null;
  const normalized = normalizeCatalogText(raw);
  if (normalized.length === 0) return null;
  if (raw.length > max || normalized.length > max) {
    throw new ApiError(400, "invalid_query", `El parámetro ${key} es demasiado largo.`);
  }
  return normalized;
}

function positiveInteger(url: URL, key: string, fallback: number, max: number): number {
  const raw = url.searchParams.get(key);
  if (raw === null || raw.trim() === "") return fallback;
  if (!/^[1-9][0-9]{0,5}$/.test(raw)) {
    throw new ApiError(400, "invalid_query", `El parámetro ${key} no es válido.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > max) {
    throw new ApiError(400, "invalid_query", `El parámetro ${key} excede el máximo permitido.`);
  }
  return value;
}

export function parseCatalogSearch(url: URL): CatalogSearch {
  const q = optionalText(url, "q", MAX_QUERY);
  const genre = optionalText(url, "genre", MAX_QUERY);
  const code = optionalText(url, "code", MAX_QUERY);
  const paginated = ["q", "genre", "code", "page", "pageSize"].some((key) => url.searchParams.has(key));
  const page = positiveInteger(url, "page", 1, 10_000);
  const pageSize = paginated
    ? positiveInteger(url, "pageSize", 24, MAX_PAGE_SIZE)
    : positiveInteger(url, "pageSize", 100, MAX_PAGE_SIZE);
  return { q, genre, code, page, pageSize, paginated };
}
