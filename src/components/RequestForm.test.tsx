import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOfferedBookDraft,
  reserveCopy,
  submitOfferedBook,
  uploadOfferedBookEvidence,
} from "../lib/api";
import { RequestForm } from "./RequestForm";

vi.mock("../lib/api", () => ({
  createOfferedBookDraft: vi.fn(),
  updateOfferedBookDraft: vi.fn(),
  uploadOfferedBookEvidence: vi.fn(),
  deleteOfferedBookEvidence: vi.fn(),
  submitOfferedBook: vi.fn(),
  reserveCopy: vi.fn(),
}));

const selected = {
  copyId: "10",
  bibliographicRecordId: "3",
  title: "Libro institucional",
  author: "Autora",
  isbn: null,
  edition: null,
  publicationYear: 2020,
  publisher: "Editorial",
  genre: "Ensayo",
  inventoryCode: "IUB-10",
  physicalCondition: "good",
  location: "Estante A",
};

function imageFile(name: string): File {
  return new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], name, { type: "image/jpeg" });
}

describe("formulario de libro ofrecido con fotografías", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it("crea borrador, sube portada e interior, envía y reserva", async () => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:preview"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });

    vi.mocked(createOfferedBookDraft).mockResolvedValue({ submissionId: "41", status: "draft" });
    vi.mocked(uploadOfferedBookEvidence)
      .mockResolvedValueOnce({ evidenceId: "1", slot: "cover", mime: "image/jpeg", bytes: 4, width: 1, height: 1 })
      .mockResolvedValueOnce({ evidenceId: "2", slot: "interior", mime: "image/jpeg", bytes: 4, width: 1, height: 1 });
    vi.mocked(submitOfferedBook).mockResolvedValue({
      requestId: "55",
      requestCode: "IUB-2026-ABCD1234",
      accessToken: "token-with-more-than-thirty-two-characters-123",
    });
    vi.mocked(reserveCopy).mockResolvedValue({ reservationId: "77", expiresAt: "2026-10-28T21:00:00Z" });

    render(<RequestForm selected={selected} onBack={() => undefined} onCreated={() => undefined} />);

    fireEvent.change(screen.getByLabelText("Título"), { target: { value: "Libro ofrecido" } });
    fireEvent.change(screen.getByLabelText("Autor"), { target: { value: "Autor ofrecido" } });
    fireEvent.change(screen.getByLabelText("Añadir fotografías de Portada"), {
      target: { files: [imageFile("cover.jpg")] },
    });
    fireEvent.change(screen.getByLabelText("Añadir fotografías de Páginas interiores"), {
      target: { files: [imageFile("interior.jpg")] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Guardar borrador y continuar" }));

    await waitFor(() => {
      expect(screen.getByLabelText("Nombre completo")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText("Nombre completo"), { target: { value: "Ana Pérez" } });
    fireEvent.change(screen.getByLabelText("Correo electrónico"), { target: { value: "ana@example.test" } });
    fireEvent.change(screen.getByLabelText("Documento de identidad"), { target: { value: "12345678" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Enviar solicitud" }));

    await waitFor(() => {
      expect(screen.getByText("IUB-2026-ABCD1234")).toBeInTheDocument();
    });
    expect(createOfferedBookDraft).toHaveBeenCalledWith(expect.objectContaining({
      copyId: "10",
      title: "Libro ofrecido",
      author: "Autor ofrecido",
      declaredCondition: "good",
    }));
    expect(uploadOfferedBookEvidence).toHaveBeenCalledWith(expect.objectContaining({ slot: "cover", submissionId: "41" }));
    expect(uploadOfferedBookEvidence).toHaveBeenCalledWith(expect.objectContaining({ slot: "interior", submissionId: "41" }));
    expect(submitOfferedBook).toHaveBeenCalledWith(expect.objectContaining({
      submissionId: "41",
      participantName: "Ana Pérez",
      consent: true,
    }));
    expect(reserveCopy).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "55",
      copyId: "10",
      accessToken: "token-with-more-than-thirty-two-characters-123",
    }));
    expect(sessionStorage.getItem("iub:participant-request")).toContain("IUB-2026-ABCD1234");
  });

  it("no crea el borrador si faltan portada o páginas interiores", async () => {
    render(<RequestForm selected={selected} onBack={() => undefined} onCreated={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Título"), { target: { value: "Libro ofrecido" } });
    fireEvent.change(screen.getByLabelText("Autor"), { target: { value: "Autor ofrecido" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar borrador y continuar" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("portada y una de páginas interiores");
    expect(createOfferedBookDraft).not.toHaveBeenCalled();
  });
});
