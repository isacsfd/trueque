import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRequestStatus } from "../lib/api";
import type { RequestStatusView } from "../lib/types";
import { MyRequest } from "./MyRequest";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, fetchRequestStatus: vi.fn() };
});

const status: RequestStatusView = {
  requestCode: "IUB-2026-ABCD1234",
  status: "under_review",
  createdAt: "2026-10-30T12:00:00.000Z",
  copyTitle: "Libro solicitado",
  requestedTitle: "Libro solicitado",
  requestedAuthor: "Autora",
  requestedInventoryCode: "INV-001",
  offeredTitle: "Libro ofrecido",
  offeredAuthor: "Autor",
  reservationStatus: "active",
  reservationLabel: "Reservado temporalmente",
  reservationExpiresAt: "2026-10-30T13:00:00.000Z",
  exchangeStatus: null,
  receptionStatus: null,
  nextStep: "La solicitud está en revisión. El ejemplar está reservado temporalmente.",
};

describe("consulta pública de estado", () => {
  afterEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  it("consulta únicamente con el token y no pide contraseña", async () => {
    vi.mocked(fetchRequestStatus).mockResolvedValue(status);

    const token = "token-with-more-than-thirty-two-characters-123";
    render(<MyRequest initialToken={token} />);

    expect(screen.getByLabelText("Código de solicitud o reserva")).toBeInTheDocument();
    expect(screen.queryByLabelText(/contraseña|clave de acceso/i)).not.toBeInTheDocument();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Consultar" }));

    await waitFor(() => {
      expect(fetchRequestStatus).toHaveBeenCalledWith({ token });
    });
    expect(await screen.findByText("Reservado temporalmente")).toBeInTheDocument();
    expect(screen.getAllByText(/Libro ofrecido/).length).toBeGreaterThan(0);
  });
});
