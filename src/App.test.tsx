import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("inicio del sistema de intercambio", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("presenta el catálogo vacío sin inventar libros disponibles", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ items: [] })));
    render(<App />);

    expect(screen.getByRole("heading", { level: 1, name: "Intercambio de libros" })).toBeInTheDocument();
    expect(screen.getByText("Plataforma en preparación")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("Aún no hay libros publicados");
    });
  });

  it("muestra el acceso administrativo separado del flujo público", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/catalog") return Promise.resolve(jsonResponse({ items: [] }));
      if (url === "/api/admin/session") {
        return Promise.resolve(jsonResponse({ error: { code: "unauthorized", message: "Inicia sesión." } }, 401));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    screen.getByRole("button", { name: "Administración" }).click();

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 2, name: "Administración" })).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Usuario")).toBeInTheDocument();
    expect(screen.getByLabelText("Contraseña")).toBeInTheDocument();
  });
});
