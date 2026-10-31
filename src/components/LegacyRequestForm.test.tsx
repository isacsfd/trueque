import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExchangeRequest, reserveCopy } from "../lib/api";
import { LegacyRequestForm } from "./LegacyRequestForm";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, createExchangeRequest: vi.fn(), reserveCopy: vi.fn() };
});

const selected = {
  copyId: "12",
  bibliographicRecordId: "2",
  title: "Cien años de soledad",
  author: "Gabriel García Márquez",
  isbn: "978",
  edition: null,
  publicationYear: 1967,
  publisher: "Sudamericana",
  genre: "Novela",
  inventoryCode: "INV-029",
  physicalCondition: "good",
  location: "Estante",
};

function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText("Nombre completo"), { target: { value: "Ana Pérez" } });
  fireEvent.change(screen.getByLabelText("Correo electrónico"), { target: { value: "ana@example.test" } });
  fireEvent.change(screen.getByLabelText("Documento de identidad"), { target: { value: "12345678" } });
  fireEvent.change(screen.getByLabelText("Título"), { target: { value: "Libro ofrecido" } });
  fireEvent.change(screen.getByLabelText("Autor"), { target: { value: "Autora" } });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Enviar solicitud" }));
}

describe("formulario legacy compatible", () => {
  afterEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it("crea la solicitud con el contrato /api/requests y muestra el token", async () => {
    vi.mocked(createExchangeRequest).mockResolvedValue({
      requestId: "44",
      requestCode: "IUB-2026-ABCD1234",
      accessToken: "token-de-consulta-123456789012345678901234",
    });
    vi.mocked(reserveCopy).mockResolvedValue({
      reservationId: "9",
      expiresAt: "2026-10-31T23:00:00Z",
    });
    const onCreated = vi.fn();
    render(<LegacyRequestForm selected={selected} onBack={vi.fn()} onCreated={onCreated} />);

    expect(screen.queryByLabelText(/contraseña|clave de acceso/i)).not.toBeInTheDocument();
    fillAndSubmit();

    await waitFor(() => expect(createExchangeRequest).toHaveBeenCalledWith(expect.objectContaining({
      copyId: "12",
      participantName: "Ana Pérez",
      participantEmail: "ana@example.test",
      offeredTitle: "Libro ofrecido",
      offeredAuthor: "Autora",
      consent: true,
    })));
    await waitFor(() => expect(reserveCopy).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "44",
      copyId: "12",
      accessToken: "token-de-consulta-123456789012345678901234",
    })));
    expect(onCreated).toHaveBeenCalledWith({
      requestCode: "IUB-2026-ABCD1234",
      accessToken: "token-de-consulta-123456789012345678901234",
    });
    expect(await screen.findByText("token-de-consulta-123456789012345678901234")).toBeInTheDocument();
    expect(JSON.parse(sessionStorage.getItem("iub:participant-request") ?? "{}")).toEqual({
      requestCode: "IUB-2026-ABCD1234",
      accessToken: "token-de-consulta-123456789012345678901234",
    });
  });

  it("mantiene la solicitud creada si falla la reserva temporal", async () => {
    vi.mocked(createExchangeRequest).mockResolvedValue({
      requestId: "45",
      requestCode: "IUB-2026-EFGH5678",
      accessToken: "token-de-consulta-abcdefghijklmnopqrstuvwxyz",
    });
    vi.mocked(reserveCopy).mockRejectedValue(new Error("reserva no disponible"));
    render(<LegacyRequestForm selected={selected} onBack={vi.fn()} onCreated={vi.fn()} />);

    fillAndSubmit();

    expect(await screen.findByText(/no se pudo confirmar/i)).toBeInTheDocument();
    expect(await screen.findByText("IUB-2026-EFGH5678")).toBeInTheDocument();
  });
});
