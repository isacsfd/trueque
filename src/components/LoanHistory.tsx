import { useEffect, useState } from "react";
import { fetchLoansPage, runAdminAction } from "../lib/api";
import type { LoanPage, LoanSummary } from "../lib/api";

const statuses = [
  { value: "all", label: "Todos" },
  { value: "reserved", label: "Reservados" },
  { value: "committed", label: "Aprobados" },
  { value: "lent", label: "En préstamo" },
  { value: "return_pending", label: "Devolución pendiente" },
  { value: "completed", label: "Completados" },
  { value: "cancelled", label: "Cancelados" },
  { value: "expired", label: "Expirados" },
] as const;

const PAGE_SIZE = 25;

function loanStatusLabel(status: LoanSummary["status"]): string {
  return statuses.find((item) => item.value === status)?.label ?? status;
}

function dateLabel(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

export function LoanHistory() {
  const [data, setData] = useState<LoanPage | null>(null);
  const [status, setStatus] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyLoanId, setBusyLoanId] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  async function reactivate(item: LoanSummary) {
    const reason = window.prompt("Motivo obligatorio de reactivación:", "");
    if (reason === null) return;
    if (reason.trim().length < 3) {
      setError("Indica un motivo de al menos 3 caracteres.");
      return;
    }

    setBusyLoanId(item.loanId);
    setError(null);
    setResult(null);
    try {
      await runAdminAction({
        action: "loan.reactivate",
        loanId: item.loanId,
        reason: reason.trim(),
        idempotencyKey: crypto.randomUUID(),
      });
      setResult(`Préstamo ${item.requestCode} reactivado.`);
      await load(status, currentPage);
    } catch (reason2) {
      setError(reason2 instanceof Error ? reason2.message : "No se pudo reactivar el préstamo.");
    } finally {
      setBusyLoanId(null);
    }
  }

  async function load(targetStatus = status, targetPage = currentPage) {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchLoansPage({ status: targetStatus, page: targetPage, pageSize: PAGE_SIZE }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo cargar el historial de préstamos.");
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function changeStatus(value: string) {
    setStatus(value);
    setCurrentPage(1);
    void load(value, 1);
  }

  function changePage(value: number) {
    setCurrentPage(value);
    void load(status, value);
  }

  const items = data?.items ?? [];
  const pagination = data?.pagination;
  const totalPages = pagination ? Math.max(1, Math.ceil(pagination.total / PAGE_SIZE)) : 1;

  return (
    <section className="admin-module" aria-labelledby="loans-title">
      <div className="section-heading">
        <div><p className="eyebrow">Historial institucional</p><h3 id="loans-title">Préstamos</h3></div>
      </div>
      <div className="notice">
        Historial auditable de reservas, préstamos en curso y cierres. No muestra datos personales.
      </div>
      {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
      {result ? <div className="notice notice-success" role="status">{result}</div> : null}

      <div className="admin-filter">
        <label>Filtrar préstamos
          <select value={status} onChange={(event) => changeStatus(event.target.value)} disabled={loading}>
            {statuses.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
      </div>

      {loading && !data ? <p role="status">Cargando préstamos…</p> : null}

      {items.length === 0 && !loading ? (
        <div className="notice">No hay préstamos en este filtro.</div>
      ) : null}

      {items.length > 0 ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Solicitud</th>
                <th>Ejemplar</th>
                <th>Estado</th>
                <th>Inicio</th>
                <th>Vence</th>
                <th>Cierre</th>
                <th>Entregas</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.loanId}>
                  <td>{item.requestCode}</td>
                  <td>
                    {item.title}<br />
                    <span className="quiet">{item.author} · {item.inventoryCode}</span>
                  </td>
                  <td>{loanStatusLabel(item.status)}</td>
                  <td>{dateLabel(item.startedAt)}</td>
                  <td>{dateLabel(item.dueAt)}</td>
                  <td>{dateLabel(item.closedAt)}</td>
                  <td>
                    <span className="quiet">
                      {[item.deliveries.dropoffDeliveryId && "Entrega",
                        item.deliveries.handoverDeliveryId && "Recepción",
                        item.deliveries.returnDeliveryId && "Devolución"]
                        .filter(Boolean)
                        .join(" · ") || "—"}
                    </span>
                  </td>
                  <td>
                    {item.status === "cancelled" ? (
                      <button
                        className="button button-secondary"
                        type="button"
                        disabled={busyLoanId === item.loanId || loading}
                        onClick={() => void reactivate(item)}
                      >
                        {busyLoanId === item.loanId ? "Reactivando…" : "Reactivar"}
                      </button>
                    ) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {pagination && totalPages > 1 ? (
        <div className="admin-pagination">
          <button
            className="button button-secondary"
            type="button"
            disabled={pagination.page <= 1 || loading}
            onClick={() => changePage(pagination.page - 1)}
          >
            Anterior
          </button>
          <span>Página {pagination.page} de {totalPages} · {pagination.total} préstamos</span>
          <button
            className="button button-secondary"
            type="button"
            disabled={!pagination.hasMore || loading}
            onClick={() => changePage(pagination.page + 1)}
          >
            Siguiente
          </button>
        </div>
      ) : null}
    </section>
  );
}
