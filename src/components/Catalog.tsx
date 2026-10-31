import { useEffect, useMemo, useRef, useState } from "react";
import { fetchCatalogPage } from "../lib/api";
import type { CatalogPage } from "../lib/api";
import type { CatalogItem as CatalogItemType } from "../lib/types";

interface CatalogProps {
  onSelect: (item: CatalogItemType) => void;
}

const PAGE_SIZE = 12;

export function Catalog({ onSelect }: CatalogProps) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [genre, setGenre] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<CatalogPage | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const debouncedQueryRef = useRef(debouncedQuery);

  useEffect(() => {
    const value = query.trim();
    const timer = window.setTimeout(() => {
      if (debouncedQueryRef.current === value) return;
      debouncedQueryRef.current = value;
      setDebouncedQuery(value);
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let active = true;
    fetchCatalogPage({ q: debouncedQuery, genre, page, pageSize: PAGE_SIZE })
      .then((catalog) => {
        if (active) {
          setResult(catalog);
          setPending(false);
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : "No se pudo cargar el catálogo.");
          setResult(null);
          setPending(false);
        }
      });
    return () => {
      active = false;
    };
  }, [debouncedQuery, genre, page]);

  const loading = pending;
  const items = result?.items ?? [];
  const total = result?.pagination?.total ?? items.length;
  const hasMore = result?.pagination?.hasMore ?? false;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasFilters = Boolean(debouncedQuery || genre);
  const genres = useMemo(() => result?.genres ?? [], [result]);

  function clearFilters() {
    setQuery("");
    setGenre("");
    setPage(1);
    setPending(true);
    setError(null);
  }

  return (
    <section className="catalog-section section-block" id="catalogo" aria-labelledby="catalog-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Encuentra tu próxima lectura</p>
          <h2 id="catalog-title">Catálogo de libros</h2>
        </div>
        <span className="catalog-tag">Ejemplares habilitados</span>
      </div>

      <div className="catalog-controls" role="search">
        <label className="catalog-search">
          <span>Buscar por título, autor, categoría o código</span>
          <input
            type="search"
            value={query}
            onChange={(event) => {
              const value = event.target.value;
              setQuery(value);
              setPending(value.trim() !== debouncedQuery);
              setError(null);
            }}
            placeholder="Ej. Cien años, García Márquez, INV-029"
            maxLength={120}
            autoComplete="off"
          />
        </label>
        <label className="catalog-filter">
          <span>Categoría</span>
          <select
            value={genre}
            onChange={(event) => {
              setGenre(event.target.value);
              setPage(1);
              setPending(true);
              setError(null);
            }}
          >
            <option value="">Todas</option>
            {genres.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        {hasFilters ? (
          <button className="button button-secondary catalog-clear" type="button" onClick={clearFilters}>
            Limpiar filtros
          </button>
        ) : null}
      </div>

      <p className="catalog-count" aria-live="polite">
        {loading ? "Buscando ejemplares…" : `${total} ejemplar${total === 1 ? "" : "es"} encontrado${total === 1 ? "" : "s"}`}
      </p>

      {error ? (
        <div className="notice notice-error" role="alert">{error}</div>
      ) : loading && !result ? (
        <p className="loading-text" role="status">Cargando catálogo…</p>
      ) : items.length === 0 ? (
        <div className="empty-state" role="status" aria-live="polite">
          <span className="empty-state-mark" aria-hidden="true">—</span>
          <h3>{hasFilters ? "Sin coincidencias" : "Catálogo en preparación"}</h3>
          <p>
            {hasFilters
              ? "No encontramos libros con esos criterios. Prueba con otro título, autor, categoría o código."
              : "Aún no hay libros publicados. Aquí se mostrarán únicamente los ejemplares habilitados formalmente para intercambio."}
          </p>
          {hasFilters ? (
            <button className="button button-secondary" type="button" onClick={clearFilters}>Ver todo el catálogo</button>
          ) : null}
        </div>
      ) : (
        <>
          <ul className="catalog-grid">
            {items.map((item) => (
              <li className="catalog-card" key={item.copyId}>
                <div className="catalog-card-heading">
                  <h3>{item.title}</h3>
                  <span className="condition-tag">{conditionLabel(item.physicalCondition)}</span>
                </div>
                <p className="catalog-author">{item.author}</p>
                <dl className="catalog-meta">
                  {item.publisher ? <div><dt>Editorial</dt><dd>{item.publisher}</dd></div> : null}
                  {item.genre ? <div><dt>Género</dt><dd>{item.genre}</dd></div> : null}
                  {item.publicationYear ? <div><dt>Año</dt><dd>{item.publicationYear}</dd></div> : null}
                  <div><dt>Código</dt><dd>{item.inventoryCode}</dd></div>
                  <div><dt>Ubicación</dt><dd>{item.location}</dd></div>
                </dl>
                <button className="button button-primary" type="button" onClick={() => onSelect(item)}>
                  Solicitar este ejemplar
                </button>
              </li>
            ))}
          </ul>

          {totalPages > 1 ? (
            <nav className="catalog-pagination" aria-label="Paginación del catálogo">
              <button
                className="button button-secondary"
                type="button"
                disabled={page <= 1 || loading}
                onClick={() => {
                  setPending(true);
                  setError(null);
                  setPage((current) => Math.max(1, current - 1));
                }}
              >
                Anterior
              </button>
              <span>Página {page} de {totalPages}</span>
              <button
                className="button button-secondary"
                type="button"
                disabled={!hasMore || loading}
                onClick={() => {
                  setPending(true);
                  setError(null);
                  setPage((current) => current + 1);
                }}
              >
                Siguiente
              </button>
            </nav>
          ) : null}
        </>
      )}
    </section>
  );
}

function conditionLabel(value: string): string {
  return {
    excellent: "Excelente",
    good: "Bueno",
    fair: "Aceptable",
    poor: "Deteriorado",
  }[value] ?? value;
}
