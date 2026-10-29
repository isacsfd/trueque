import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAdminWorkbench, fetchEvidenceBlob, getAdminSession } from "../lib/api";
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
    vi.clearAllMocks();
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
