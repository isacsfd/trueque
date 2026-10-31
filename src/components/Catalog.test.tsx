import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCatalogPage } from "../lib/api";
import type { CatalogPage } from "../lib/api";
import { Catalog } from "./Catalog";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, fetchCatalogPage: vi.fn() };
});

function page(overrides: Partial<CatalogPage> = {}): CatalogPage {
  return {
    items: [{
      copyId: "1",
      bibliographicRecordId: "b1",
      title: "Cien años de soledad",
      author: "Gabriel García Márquez",
      isbn: "978",
      edition: null,
      publicationYear: 1967,
      publisher: "Sudamericana",
      genre: "Novela",
      inventoryCode: "INV-001",
      physicalCondition: "good",
      location: "Estante A",
    }],
    pagination: { page: 1, pageSize: 12, total: 1, hasMore: false },
    genres: ["Novela"],
    query: { q: null, genre: null, code: null },
    ...overrides,
  };
}

describe("catálogo con búsqueda", () => {
  beforeEach(() => {
    vi.mocked(fetchCatalogPage).mockResolvedValue(page());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("busca en backend después del debounce y muestra el resultado", async () => {
    render(<Catalog onSelect={vi.fn()} />);
    await waitFor(() => expect(fetchCatalogPage).toHaveBeenCalledWith({
      q: "",
      genre: "",
      page: 1,
      pageSize: 12,
    }));

    fireEvent.change(screen.getByLabelText("Buscar por título, autor, categoría o código"), {
      target: { value: "García" },
    });

    await waitFor(() => expect(fetchCatalogPage).toHaveBeenCalledWith({
      q: "García",
      genre: "",
      page: 1,
      pageSize: 12,
    }), { timeout: 1500 });
    expect(await screen.findByText("Cien años de soledad")).toBeInTheDocument();
    expect(screen.getByText("1 ejemplar encontrado")).toBeInTheDocument();
  });

  it("muestra estado vacío cuando no hay coincidencias", async () => {
    vi.mocked(fetchCatalogPage).mockResolvedValue(page({
      items: [],
      pagination: { page: 1, pageSize: 12, total: 0, hasMore: false },
    }));
    render(<Catalog onSelect={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Buscar por título, autor, categoría o código"), {
      target: { value: "no existe" },
    });

    expect(await screen.findByText("Sin coincidencias")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ver todo el catálogo" })).toBeInTheDocument();
  });

  it("pagina sin perder el filtro y permite limpiar", async () => {
    vi.mocked(fetchCatalogPage)
      .mockResolvedValueOnce(page({ pagination: { page: 1, pageSize: 12, total: 13, hasMore: true } }))
      .mockResolvedValueOnce(page({
        pagination: { page: 1, pageSize: 12, total: 13, hasMore: true },
        query: { q: null, genre: "Novela", code: null },
      }))
      .mockResolvedValueOnce(page({
        items: [{ ...page().items[0], copyId: "2", title: "Segundo libro" }],
        pagination: { page: 2, pageSize: 12, total: 13, hasMore: false },
        query: { q: null, genre: "Novela", code: null },
      }))
      .mockResolvedValueOnce(page());

    render(<Catalog onSelect={vi.fn()} />);
    await screen.findByText("Cien años de soledad");
    fireEvent.change(screen.getByLabelText("Categoría"), { target: { value: "Novela" } });
    await waitFor(() => expect(fetchCatalogPage).toHaveBeenCalledWith({
      q: "",
      genre: "Novela",
      page: 1,
      pageSize: 12,
    }));

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await waitFor(() => expect(fetchCatalogPage).toHaveBeenLastCalledWith({
      q: "",
      genre: "Novela",
      page: 2,
      pageSize: 12,
    }));
    expect(await screen.findByText("Segundo libro")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Limpiar filtros" }));
    await waitFor(() => expect(fetchCatalogPage).toHaveBeenLastCalledWith({
      q: "",
      genre: "",
      page: 1,
      pageSize: 12,
    }));
  });

  it("vuelve a la primera página al cambiar la búsqueda", async () => {
    vi.mocked(fetchCatalogPage).mockImplementation(async (input = {}) => {
      if (input.q === "García") {
        return page({
          pagination: { page: 1, pageSize: 12, total: 1, hasMore: false },
          query: { q: "García", genre: null, code: null },
        });
      }
      if (input.page === 2) {
        return page({
          items: [{ ...page().items[0], copyId: "2", title: "Segundo libro" }],
          pagination: { page: 2, pageSize: 12, total: 13, hasMore: false },
        });
      }
      return page({ pagination: { page: 1, pageSize: 12, total: 13, hasMore: true } });
    });

    render(<Catalog onSelect={vi.fn()} />);
    await screen.findByText("Cien años de soledad");

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await waitFor(() => expect(fetchCatalogPage).toHaveBeenLastCalledWith({
      q: "",
      genre: "",
      page: 2,
      pageSize: 12,
    }));
    expect(await screen.findByText("Segundo libro")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Buscar por título, autor, categoría o código"), {
      target: { value: "García" },
    });

    await waitFor(() => expect(fetchCatalogPage).toHaveBeenLastCalledWith({
      q: "García",
      genre: "",
      page: 1,
      pageSize: 12,
    }), { timeout: 1500 });
    expect(await screen.findByText("Cien años de soledad")).toBeInTheDocument();
  });

  it("limpia el error cuando una búsqueda posterior funciona", async () => {
    vi.mocked(fetchCatalogPage)
      .mockRejectedValueOnce(new Error("fallo temporal"))
      .mockResolvedValueOnce(page({
        query: { q: "García", genre: null, code: null },
      }));

    render(<Catalog onSelect={vi.fn()} />);
    expect(await screen.findByText("fallo temporal")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Buscar por título, autor, categoría o código"), {
      target: { value: "García" },
    });

    expect(await screen.findByText("Cien años de soledad")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("fallo temporal")).not.toBeInTheDocument());
  });
});
