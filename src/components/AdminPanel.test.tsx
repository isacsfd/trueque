import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAdminWorkbench, fetchEvidenceBlob, getAdminSession, runAdminAction } from "../lib/api";
import { institutionalDate, proposedDeliveryInstant, todayInInstitutionalTimeZone } from "../lib/institutional-time";
import { AdminPanel } from "./AdminPanel";

vi.mock("../lib/api", () => ({
  fetchAdminWorkbench: vi.fn(),
  getAdminSession: vi.fn(),
  fetchEvidenceBlob: vi.fn(),
  loginAdmin: vi.fn(),
  logoutAdmin: vi.fn(),
  runAdminAction: vi.fn(),
  fetchInventoryBatches: vi.fn(),
  inspectInventoryBatch: vi.fn(),
  prevalidateInventoryBatch: vi.fn(),
  confirmInventoryBatch: vi.fn(),
  cancelInventoryBatch: vi.fn(),
  downloadInventoryBatchReport: vi.fn(),
  fetchAdminStats: vi.fn(),
  fetchAdminAccount: vi.fn(),
  fetchAdminAccounts: vi.fn(),
  createAdminAccount: vi.fn(),
  setAdminAccountActive: vi.fn(),
  assignAdminRole: vi.fn(),
  removeAdminRole: vi.fn(),
}));

const item = {
  requestId: "1",
  requestCode: "IUB-2026-TEST",
  requestStatus: "pending" as const,
  createdAt: "2026-10-28T20:00:00Z",
  requestedTitle: "Libro institucional",
  requestedInventoryCode: "IUB-1",
  offeredTitle: "Libro ofrecido",
  offeredAuthor: "Autora",
  offeredCondition: "good",
  exchangeId: null,
  exchangeStatus: null,
  cancellationKey: null,
  receptionId: null,
  receptionStatus: null,
  evaluationId: null,
  evaluationOutcome: null,
  catalogingId: null,
  catalogingStatus: null,
  admissionId: null,
  admissionStatus: null,
  offeredCopyId: null,
  history: [],
  submissionId: null,
  submissionStatus: null,
  submissionWorkflowStatus: null,
  submissionTitle: null,
  submissionAuthor: null,
  submissionCondition: null,
  submissionObservations: null,
  evidence: [],
  deliveries: [],
};

describe("panel administrativo", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  function scheduledDay(offset: number): string {
    const base = new Date(proposedDeliveryInstant(todayInInstitutionalTimeZone()));
    base.setUTCDate(base.getUTCDate() + offset);
    return proposedDeliveryInstant(institutionalDate(base));
  }

  function plannedItem(scheduledAt: string | null = scheduledDay(0)) {
    return {
      ...item,
      requestStatus: "scheduled" as const,
      exchangeId: "10",
      exchangeStatus: "planned" as const,
      receptionId: "20",
      receptionStatus: "awaiting_delivery" as const,
      deliveries: scheduledAt
        ? [{
            id: "30",
            type: "offered_book_dropoff" as const,
            status: "scheduled" as const,
            scheduledAt,
            completedAt: null,
            receiptReference: null,
            idempotencyKey: "11111111-1111-4111-8111-111111111111",
          }]
        : [],
    };
  }

  it("programa con la fecha de hoy y sin campo de código de recepción", async () => {
    vi.mocked(getAdminSession).mockResolvedValue({ username: "admin" });
    vi.mocked(fetchAdminWorkbench).mockResolvedValue([{ ...item, requestStatus: "approved" as const }]);

    render(<AdminPanel />);

    await waitFor(() => {
      expect(screen.getByText(/IUB-2026-TEST/)).toBeInTheDocument();
    });
    const dateInput = screen.getByLabelText("Fecha propuesta de entrega") as HTMLInputElement;
    const today = todayInInstitutionalTimeZone();
    expect(dateInput.value).toBe(today);
    expect(screen.queryByText(/Código de recepción/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Programar intercambio" }));

    await waitFor(() => {
      expect(runAdminAction).toHaveBeenCalledWith(expect.objectContaining({
        action: "exchange.plan",
        requestId: "1",
        scheduledAt: `${today}T12:00:00-05:00`,
      }));
    });
    expect(vi.mocked(runAdminAction).mock.calls[0]?.[0]).not.toHaveProperty("receiptCode");
  });

  it("para una entrega de hoy muestra únicamente Entregado y usa confirm_delivery", async () => {
    vi.mocked(getAdminSession).mockResolvedValue({ username: "admin" });
    vi.mocked(fetchAdminWorkbench).mockResolvedValue([plannedItem()]);
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("COMP-001");

    render(<AdminPanel />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Entregado" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Programar entrega" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Programar intercambio" })).not.toBeInTheDocument();
    expect(screen.getByText(/Entrega propuesta para hoy/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Entregado" }));

    await waitFor(() => {
      expect(runAdminAction).toHaveBeenCalledWith(expect.objectContaining({
        action: "delivery.confirm",
        deliveryId: "30",
        receiptReference: "COMP-001",
        idempotencyKey: "11111111-1111-4111-8111-111111111111",
      }));
    });
    expect(prompt).toHaveBeenCalledWith("Comprobante de la entrega:", "");
  });

  it("para una entrega futura no habilita Entregado y muestra la fecha", async () => {
    vi.mocked(getAdminSession).mockResolvedValue({ username: "admin" });
    vi.mocked(fetchAdminWorkbench).mockResolvedValue([plannedItem(scheduledDay(1))]);

    render(<AdminPanel />);

    await waitFor(() => {
      expect(screen.getByText(/Entrega propuesta:/)).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Entregado" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Programar entrega" })).not.toBeInTheDocument();
    expect(screen.getByText(/habilitará ese día/)).toBeInTheDocument();
  });

  it("para una entrega vencida muestra Entrega atrasada y permite confirmar", async () => {
    vi.mocked(getAdminSession).mockResolvedValue({ username: "admin" });
    vi.mocked(fetchAdminWorkbench).mockResolvedValue([plannedItem(scheduledDay(-1))]);

    render(<AdminPanel />);

    await waitFor(() => {
      expect(screen.getByText(/Entrega atrasada/)).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Entregado" })).toBeInTheDocument();
  });

  it("mantiene una salida para intercambios históricos sin entrega programada", async () => {
    vi.mocked(getAdminSession).mockResolvedValue({ username: "admin" });
    vi.mocked(fetchAdminWorkbench).mockResolvedValue([plannedItem(null)]);

    render(<AdminPanel />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Programar entrega" })).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Fecha de entrega")).toHaveValue(todayInInstitutionalTimeZone());

    fireEvent.click(screen.getByRole("button", { name: "Programar entrega" }));

    await waitFor(() => {
      expect(runAdminAction).toHaveBeenCalledWith(expect.objectContaining({
        action: "delivery.schedule",
        exchangeId: "10",
        deliveryType: "offered_book_dropoff",
      }));
    });
  });

  it("muestra la solicitud y la acción permitida sin datos personales", async () => {
    vi.mocked(getAdminSession).mockResolvedValue({ username: "admin" });
    vi.mocked(fetchAdminWorkbench).mockResolvedValue([item]);

    render(<AdminPanel />);

    await waitFor(() => {
      expect(screen.getByText(/IUB-2026-TEST/)).toBeInTheDocument();
    });
    expect(screen.getByText("Pendiente de revisión")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Iniciar revisión" })).toBeInTheDocument();
    expect(screen.queryByText("ana@example.test")).not.toBeInTheDocument();
  });

  it("muestra la revisión fotográfica y sus acciones manuales", async () => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:evidence") });
    vi.mocked(getAdminSession).mockResolvedValue({ username: "admin" });
    vi.mocked(fetchEvidenceBlob).mockResolvedValue(new Blob(["png"], { type: "image/png" }));
    vi.mocked(fetchAdminWorkbench).mockResolvedValue([{
      ...item,
      submissionId: "4",
      submissionStatus: "pending_review" as const,
      submissionWorkflowStatus: "pending_review" as const,
      submissionTitle: "Libro ofrecido",
      submissionAuthor: "Autora",
      submissionCondition: "good",
      submissionObservations: "Con anotaciones",
      evidence: [{ id: "9", slot: "cover" as const, mime: "image/png", bytes: 3, width: 1, height: 1, createdAt: "2026-10-29T00:00:00Z" }],
    }]);

    render(<AdminPanel />);

    await waitFor(() => {
      expect(screen.getByText("Revisión fotográfica")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Iniciar revisión de fotografías" })).toBeInTheDocument();
    expect(screen.getByText(/no equivale a aceptación física/i)).toBeInTheDocument();
  });

  it("abre la sección de lotes sin mezclar el flujo de solicitudes", async () => {
    vi.mocked(getAdminSession).mockResolvedValue({ username: "admin" });
    vi.mocked(fetchAdminWorkbench).mockResolvedValue([]);
    const { fetchInventoryBatches } = await import("../lib/api");
    vi.mocked(fetchInventoryBatches).mockResolvedValue([]);

    render(<AdminPanel />);
    await waitFor(() => expect(screen.getByRole("tab", { name: "Lotes de inventario" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: "Lotes de inventario" }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Lotes de inventario" })).toBeInTheDocument();
    });
    expect(screen.getByText(/no se publican automáticamente/i)).toBeInTheDocument();
  });

  it("abre la gestión de cuentas y protege la sesión propia", async () => {
    vi.mocked(getAdminSession).mockResolvedValue({ username: "admin" });
    vi.mocked(fetchAdminWorkbench).mockResolvedValue([]);
    const { fetchAdminAccounts } = await import("../lib/api");
    vi.mocked(fetchAdminAccounts).mockResolvedValue({
      currentActorUserId: "7",
      accounts: [{
        userId: "7",
        identityIssuer: "local",
        identitySubject: "admin",
        email: "admin@example.test",
        isActive: true,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        roles: [],
        permissions: ["account.manage"],
      }],
      roles: [],
      permissions: [],
    });

    render(<AdminPanel />);
    await waitFor(() => expect(screen.getByRole("tab", { name: "Cuentas" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: "Cuentas" }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Cuentas administrativas" })).toBeInTheDocument();
    });
    expect(screen.getByText("Sesión actual")).toBeInTheDocument();
    expect(screen.getByText(/no puedes cambiar tus propios roles/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Desactivar" })).toBeDisabled();
  });

  it("muestra el formulario de acceso cuando no hay sesión", async () => {
    vi.mocked(getAdminSession).mockRejectedValue(new Error("unauthorized"));

    render(<AdminPanel />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Administración" })).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Usuario")).toBeInTheDocument();
  });
});
