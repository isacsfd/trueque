import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchInventoryRegistrationCapabilities,
  registerInstitutionalCopy,
} from "../lib/api";
import { InventoryRegistration } from "./InventoryRegistration";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    fetchInventoryRegistrationCapabilities: vi.fn(),
    registerInstitutionalCopy: vi.fn(),
  };
});

describe("alta manual de ejemplares", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("registra y publica un ejemplar elegible", async () => {
    vi.mocked(fetchInventoryRegistrationCapabilities).mockResolvedValue({
      canRegister: true,
      canVerify: true,
      canPublish: true,
    });
    vi.mocked(registerInstitutionalCopy).mockResolvedValue({
      copyId: "91",
      bibliographicRecordId: "44",
      inventoryCode: "INV-MAN-001",
      availability: "available",
      verified: true,
      published: true,
      created: true,
    });

    render(<InventoryRegistration />);
    expect(await screen.findByLabelText("Título")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Título"), { target: { value: "Cien años de soledad" } });
    fireEvent.change(screen.getByLabelText("Autor"), { target: { value: "Gabriel García Márquez" } });
    fireEvent.change(screen.getByLabelText("Código de inventario"), { target: { value: "INV-MAN-001" } });
    fireEvent.change(screen.getByLabelText("Estado físico"), { target: { value: "good" } });
    fireEvent.change(screen.getByLabelText("Referencia de verificación"), {
      target: { value: "Acta física 2026-10-31" },
    });
    fireEvent.click(screen.getByLabelText("Publicar ahora si cumple elegibilidad"));
    fireEvent.click(screen.getByRole("button", { name: "Registrar ejemplar" }));

    await waitFor(() => expect(registerInstitutionalCopy).toHaveBeenCalledWith(expect.objectContaining({
      title: "Cien años de soledad",
      author: "Gabriel García Márquez",
      inventoryCode: "INV-MAN-001",
      physicalCondition: "good",
      verificationReference: "Acta física 2026-10-31",
      publish: true,
      idempotencyKey: expect.any(String),
    })));
    expect(await screen.findByText(/Publicado en el catálogo/)).toBeInTheDocument();
  });

  it("oculta el formulario cuando falta inventory.register", async () => {
    vi.mocked(fetchInventoryRegistrationCapabilities).mockResolvedValue({
      canRegister: false,
      canVerify: false,
      canPublish: false,
    });

    render(<InventoryRegistration />);
    expect(await screen.findByText(/inventory\.register/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Registrar ejemplar" })).not.toBeInTheDocument();
  });

  it("permite registrar sin publicar cuando no hay permisos de publicación", async () => {
    vi.mocked(fetchInventoryRegistrationCapabilities).mockResolvedValue({
      canRegister: true,
      canVerify: false,
      canPublish: false,
    });
    vi.mocked(registerInstitutionalCopy).mockResolvedValue({
      copyId: "92",
      bibliographicRecordId: "45",
      inventoryCode: "INV-MAN-002",
      availability: "unavailable",
      verified: false,
      published: false,
      created: true,
    });

    render(<InventoryRegistration />);
    expect(await screen.findByLabelText("Título")).toBeInTheDocument();
    expect(screen.getByLabelText("Publicar ahora si cumple elegibilidad")).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Título"), { target: { value: "Libro sin verificar" } });
    fireEvent.change(screen.getByLabelText("Autor"), { target: { value: "Autora" } });
    fireEvent.change(screen.getByLabelText("Código de inventario"), { target: { value: "INV-MAN-002" } });
    fireEvent.click(screen.getByRole("button", { name: "Registrar ejemplar" }));

    await waitFor(() => expect(registerInstitutionalCopy).toHaveBeenCalledWith(expect.objectContaining({
      publish: false,
      physicalCondition: "unassessed",
    })));
    expect(await screen.findByText(/Guardado como no disponible/)).toBeInTheDocument();
  });
});
