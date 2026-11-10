import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLoansPage, runAdminAction } from "../lib/api";
import type { LoanPage } from "../lib/api";
import { LoanHistory } from "./LoanHistory";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    fetchLoansPage: vi.fn(),
    runAdminAction: vi.fn(),
  };
});

function page(overrides: Partial<LoanPage> = {}): LoanPage {
  return {
    items: [{
      loanId: "8",
      requestId: "3",
      requestCode: "IUB-2026-LOAN",
      reservationId: "5",
      exchangeId: null,
      copyId: "12",
      inventoryCode: "INV-001",
      title: "Libro prestado",
      author: "Autora",
      status: "cancelled",
      startedAt: "2026-11-01T10:00:00Z",
      dueAt: "2026-11-03T10:00:00Z",
      closedAt: "2026-11-02T10:00:00Z",
      deliveries: { dropoffDeliveryId: null, handoverDeliveryId: null, returnDeliveryId: null },
    }],
    pagination: { page: 1, pageSize: 25, total: 1, hasMore: false },
    ...overrides,
  };
}

describe("reactivación de préstamos cancelados", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("solicita motivo, envía la acción allowlist y muestra el resultado", async () => {
    vi.mocked(fetchLoansPage)
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(page({
        items: [{ ...page().items[0]!, status: "reserved" }],
      }));
    vi.mocked(runAdminAction).mockResolvedValue({ result: { status: "reserved" } });
    vi.spyOn(window, "prompt").mockReturnValue("Reactivación autorizada");

    render(<LoanHistory />);
    const button = await screen.findByRole("button", { name: "Reactivar" });
    fireEvent.click(button);

    await waitFor(() => expect(runAdminAction).toHaveBeenCalledWith(expect.objectContaining({
      action: "loan.reactivate",
      loanId: "8",
      reason: "Reactivación autorizada",
      idempotencyKey: expect.any(String),
    })));
    expect(await screen.findByText(/Préstamo IUB-2026-LOAN reactivado/)).toBeInTheDocument();
  });

  it("no envía la acción sin un motivo válido", async () => {
    vi.mocked(fetchLoansPage).mockResolvedValue(page());
    vi.spyOn(window, "prompt").mockReturnValue("  ");

    render(<LoanHistory />);
    fireEvent.click(await screen.findByRole("button", { name: "Reactivar" }));

    expect(await screen.findByText(/motivo de al menos 3 caracteres/i)).toBeInTheDocument();
    expect(runAdminAction).not.toHaveBeenCalled();
  });
});
