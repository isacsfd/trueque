import { useEffect, useState } from "react";
import { fetchCatalog } from "../lib/api";
import type { CatalogItem } from "../lib/types";

interface CatalogProps {
  onSelect: (item: CatalogItem) => void;
}

export function Catalog({ onSelect }: CatalogProps) {
  const [items, setItems] = useState<CatalogItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchCatalog()
      .then((catalog) => {
        if (active) setItems(catalog);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "No se pudo cargar el catálogo.");
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <section className="catalog-section section-block" id="catalogo" aria-labelledby="catalog-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Encuentra tu próxima lectura</p>
          <h2 id="catalog-title">Catálogo de libros</h2>
        </div>
        <span className="catalog-tag">Ejemplares habilitados</span>
      </div>

      {error ? (
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      ) : items === null ? (
        <p className="loading-text" role="status">Cargando catálogo…</p>
      ) : items.length === 0 ? (
        <div className="empty-state" role="status" aria-live="polite">
          <span className="empty-state-mark" aria-hidden="true">—</span>
          <h3>Catálogo en preparación</h3>
          <p>Aún no hay libros publicados. Aquí se mostrarán únicamente los ejemplares habilitados formalmente para intercambio.</p>
        </div>
      ) : (
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
                <div><dt>Ubicación</dt><dd>{item.location}</dd></div>
              </dl>
              <button className="button button-primary" type="button" onClick={() => onSelect(item)}>
                Solicitar este ejemplar
              </button>
            </li>
          ))}
        </ul>
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
    unassessed: "Sin evaluar",
  }[value] ?? value;
}
