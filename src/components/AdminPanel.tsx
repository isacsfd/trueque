import { useEffect, useState } from "react";
import {
  fetchAdminWorkbench,
  getAdminSession,
  loginAdmin,
  logoutAdmin,
  runAdminAction,
} from "../lib/api";
import {
  admissionStatusLabel,
  deliveryStatusLabel,
  deliveryTypeLabel,
  exchangeStatusLabel,
  receptionStatusLabel,
  requestStatusLabel,
  submissionStatusLabel,
  submissionWorkflowStatusLabel,
} from "../lib/status";
import { EvidenceGallery } from "./EvidenceGallery";
import { InventoryBatches } from "./InventoryBatches";
import { AdminStatsPanel } from "./AdminStatsPanel";
import { AccountPanel } from "./AccountPanel";
import { AccountsPanel } from "./AccountsPanel";
import type { AdminActionBody, AdminWorkbenchItem } from "../lib/types";

function newKey(): string {
  return crypto.randomUUID();
}

function promptText(message: string, fallback = ""): string | null {
  const value = window.prompt(message, fallback);
  return value === null ? null : value.trim();
}

function normalizeIsbn(value: string): string | null {
  const normalized = value.replace(/[^0-9Xx]/g, "").toUpperCase();
  return normalized.length === 10 || normalized.length === 13 ? normalized : null;
}

function errorStatus(reason: unknown): number {
  if (typeof reason !== "object" || reason === null || !("status" in reason)) return 0;
  const status = (reason as { status?: unknown }).status;
  return typeof status === "number" ? status : 0;
}

function adminErrorMessage(reason: unknown): string {
  const status = errorStatus(reason);
  if (status === 401) return "Tu sesión expiró. Inicia sesión nuevamente.";
  if (status === 403) return "No tienes permiso para realizar esta operación.";
  if (status === 409) return "La operación no se pudo completar en el estado actual.";
  if (status === 429) return "Demasiados intentos. Espera antes de volver a intentarlo.";
  if (status === 503) return "El servicio no está disponible. Inténtalo de nuevo.";
  return "No se pudo completar la operación. Inténtalo de nuevo.";
}

function loginErrorMessage(reason: unknown): string {
  if (errorStatus(reason) === 401) return "Usuario o contraseña incorrectos.";
  return adminErrorMessage(reason);
}

export function AdminPanel() {
  const [session, setSession] = useState<{ username: string } | null>(null);
  const [checking, setChecking] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [items, setItems] = useState<AdminWorkbenchItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyRequestId, setBusyRequestId] = useState<string | null>(null);
  const [tab, setTab] = useState<"requests" | "batches" | "stats" | "accounts" | "account">("requests");
  const [requestFilter, setRequestFilter] = useState("all");

  async function refresh() {
    const workbench = await fetchAdminWorkbench();
    setItems(workbench);
  }

  useEffect(() => {
    let active = true;
    getAdminSession()
      .then(async (current) => {
        if (!active) return;
        setSession(current);
        try {
          const workbench = await fetchAdminWorkbench();
          if (active) setItems(workbench);
        } catch (reason) {
          if (active) {
            if (errorStatus(reason) === 401) setSession(null);
            setError(adminErrorMessage(reason));
          }
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function submitLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      const current = await loginAdmin({ username, password });
      setSession(current);
      setPassword("");
      await refresh();
    } catch (reason) {
      setError(loginErrorMessage(reason));
    }
  }

  async function logout() {
    await logoutAdmin().catch(() => undefined);
    setSession(null);
    setItems([]);
  }

  async function act(item: AdminWorkbenchItem, body: Omit<AdminActionBody, "idempotencyKey"> & { idempotencyKey?: string }) {
    setBusyRequestId(item.requestId);
    setError(null);
    try {
      await runAdminAction({ ...body, idempotencyKey: body.idempotencyKey ?? newKey() } as AdminActionBody);
      await refresh();
    } catch (reason) {
      if (errorStatus(reason) === 401) setSession(null);
      setError(adminErrorMessage(reason));
    } finally {
      setBusyRequestId(null);
    }
  }

  const visibleItems = requestFilter === "all"
    ? items
    : items.filter((item) => item.requestStatus === requestFilter);

  if (checking) {
    return <section className="section-block"><p role="status">Comprobando sesión administrativa…</p></section>;
  }

  if (!session) {
    return (
      <section className="section-block" aria-labelledby="admin-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Acceso restringido</p>
            <h2 id="admin-title">Administración</h2>
          </div>
        </div>
        <p className="section-intro">Gestiona las solicitudes y los intercambios del Trueque Literario IUB.</p>
        <p className="field-help">Acceso para personal autorizado. Inicia sesión con tu cuenta administrativa para continuar.</p>
        {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
        <form className="login-form" onSubmit={submitLogin}>
          <label>Usuario<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required maxLength={120} /></label>
          <label>Contraseña<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required minLength={8} maxLength={500} /></label>
          <button className="button button-primary" type="submit">Entrar</button>
        </form>
      </section>
    );
  }

  return (
    <section className="section-block" aria-labelledby="admin-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Sesión de {session.username}</p>
          <h2 id="admin-title">Panel administrativo</h2>
        </div>
        <div className="button-row">
          <button className="button button-secondary" type="button" onClick={() => void refresh().catch((reason) => setError(adminErrorMessage(reason)))}>Actualizar</button>
          <button className="button button-secondary" type="button" onClick={() => void logout()}>Salir</button>
        </div>
      </div>

      <div className="admin-tabs" role="tablist" aria-label="Secciones administrativas">
        <button type="button" role="tab" aria-selected={tab === "requests"} className={tab === "requests" ? "button button-primary" : "button button-secondary"} onClick={() => setTab("requests")}>Solicitudes</button>
        <button type="button" role="tab" aria-selected={tab === "batches"} className={tab === "batches" ? "button button-primary" : "button button-secondary"} onClick={() => setTab("batches")}>Lotes de inventario</button>
        <button type="button" role="tab" aria-selected={tab === "stats"} className={tab === "stats" ? "button button-primary" : "button button-secondary"} onClick={() => setTab("stats")}>Estadísticas</button>
        <button type="button" role="tab" aria-selected={tab === "accounts"} className={tab === "accounts" ? "button button-primary" : "button button-secondary"} onClick={() => setTab("accounts")}>Cuentas</button>
        <button type="button" role="tab" aria-selected={tab === "account"} className={tab === "account" ? "button button-primary" : "button button-secondary"} onClick={() => setTab("account")}>Mi cuenta</button>
      </div>

      {tab === "requests" ? (
        <>
          {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
          <div className="admin-filter">
            <label>Filtrar solicitudes
              <select value={requestFilter} onChange={(event) => setRequestFilter(event.target.value)}>
                <option value="all">Todas ({items.length})</option>
                <option value="pending">Pendientes</option>
                <option value="under_review">En revisión</option>
                <option value="approved">Aprobadas</option>
                <option value="rejected">Denegadas</option>
                <option value="scheduled">Programadas</option>
                <option value="in_process">En curso</option>
                <option value="completed">Completadas</option>
                <option value="cancellation_pending">Cancelación pendiente</option>
                <option value="cancelled">Canceladas</option>
              </select>
            </label>
          </div>
          {visibleItems.length === 0 ? <div className="notice">No hay solicitudes en este filtro.</div> : null}
          <div className="admin-list">
            {visibleItems.map((item) => (
              <AdminRequestCard
                key={item.requestId}
                item={item}
                busy={busyRequestId === item.requestId}
                onAction={(body) => act(item, body)}
              />
            ))}
          </div>
        </>
      ) : null}
      {tab === "batches" ? <InventoryBatches /> : null}
      {tab === "stats" ? <AdminStatsPanel /> : null}
      {tab === "accounts" ? <AccountsPanel /> : null}
      {tab === "account" ? <AccountPanel /> : null}
    </section>
  );
}

function AdminRequestCard({
  item,
  busy,
  onAction,
}: {
  item: AdminWorkbenchItem;
  busy: boolean;
  onAction: (body: Omit<AdminActionBody, "idempotencyKey"> & { idempotencyKey?: string }) => Promise<void>;
}) {
  const dropoff = item.deliveries.find((delivery) => delivery.type === "offered_book_dropoff");
  const handover = item.deliveries.find((delivery) => delivery.type === "institutional_copy_handover");
  const returnDelivery = item.deliveries.find((delivery) => delivery.type === "offered_book_return");
  const canComplete = Boolean(
    item.exchangeStatus === "in_process" &&
    dropoff?.status === "completed" &&
    handover?.status === "completed",
  );

  return (
    <article className="admin-card">
      <header className="admin-card-header">
        <div>
          <p className="eyebrow">Solicitud {item.requestCode}</p>
          <h3>{item.requestedTitle}</h3>
          <p className="quiet">Ofrecido: {item.offeredTitle} · {item.offeredAuthor}</p>
        </div>
        <div className="status-stack">
          <span className={`status-pill status-${item.requestStatus}`}>{requestStatusLabel(item.requestStatus)}</span>
          {item.exchangeStatus ? <span className="status-pill">{exchangeStatusLabel(item.exchangeStatus)}</span> : null}
          {item.receptionStatus ? <span className="status-pill">{receptionStatusLabel(item.receptionStatus)}</span> : null}
          {item.admissionStatus ? <span className="status-pill">{admissionStatusLabel(item.admissionStatus)}</span> : null}
        </div>
      </header>

      <dl className="admin-grid">
        <div><dt>Ejemplar institucional</dt><dd>{item.requestedInventoryCode}</dd></div>
        <div><dt>Evaluación</dt><dd>{item.evaluationOutcome ?? "Sin evaluación"}</dd></div>
        <div><dt>Catalogación</dt><dd>{item.catalogingStatus ?? "Sin catalogación"}</dd></div>
        <div><dt>Admisión</dt><dd>{item.admissionStatus ? admissionStatusLabel(item.admissionStatus) : "Sin admisión"}</dd></div>
      </dl>

      {item.history && item.history.length > 0 ? (
        <section className="request-history" aria-labelledby={`history-${item.requestId}`}>
          <h4 id={`history-${item.requestId}`}>Historial de la solicitud</h4>
          <ol>
            {item.history.map((entry, index) => (
              <li key={`${entry.changedAt}-${index}`}>
                <span>{requestStatusLabel(entry.newStatus)}</span>
                <span className="quiet">
                  {new Date(entry.changedAt).toLocaleString()}
                  {entry.changedBy ? ` · ${entry.changedBy}` : ""}
                </span>
                {entry.reason ? <span className="quiet">Motivo: {entry.reason}</span> : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {item.submissionId ? (
        <section className="submission-review" aria-labelledby={`submission-${item.submissionId}`}>
          <div className="submission-review-header">
            <div>
              <p className="eyebrow">Revisión fotográfica</p>
              <h4 id={`submission-${item.submissionId}`}>{item.submissionTitle ?? item.offeredTitle}</h4>
              <p className="quiet">{item.submissionAuthor ?? item.offeredAuthor} · Estado declarado: {item.submissionCondition ?? item.offeredCondition}</p>
            </div>
            <div className="status-stack">
              <span className="status-pill">{submissionStatusLabel(item.submissionStatus)}</span>
              <span className="status-pill">{submissionWorkflowStatusLabel(item.submissionWorkflowStatus)}</span>
            </div>
          </div>
          {item.submissionObservations ? <p className="quiet">Observaciones: {item.submissionObservations}</p> : null}
          <EvidenceGallery items={item.evidence} />
          <p className="action-note">La preaprobación fotográfica no equivale a aceptación física ni a habilitación.</p>
          <div className="action-grid">
            {item.submissionStatus === "pending_review" ? (
              <ActionButton
                label="Iniciar revisión de fotografías"
                busy={busy}
                onClick={() => onAction({ action: "submission.review", submissionId: item.submissionId!, reviewAction: "start_review" })}
              />
            ) : null}
            {item.submissionStatus === "in_review" ? (
              <>
                <ActionButton
                  label="Preaprobar fotografías"
                  busy={busy}
                  onClick={() => {
                    const reason = promptText("Motivo de la preaprobación:");
                    if (reason) void onAction({ action: "submission.review", submissionId: item.submissionId!, reviewAction: "preapprove", reason });
                  }}
                />
                <ActionButton
                  label="Solicitar información"
                  variant="secondary"
                  busy={busy}
                  onClick={() => {
                    const reason = promptText("Información o fotografías adicionales requeridas:");
                    if (reason) void onAction({ action: "submission.review", submissionId: item.submissionId!, reviewAction: "request_information", reason });
                  }}
                />
                <ActionButton
                  label="Rechazar fotografías"
                  variant="secondary"
                  busy={busy}
                  onClick={() => {
                    const reason = promptText("Motivo del rechazo fotográfico:");
                    if (reason) void onAction({ action: "submission.review", submissionId: item.submissionId!, reviewAction: "reject", reason });
                  }}
                />
              </>
            ) : null}
            {item.submissionStatus === "needs_information" ? (
              <p className="action-note">El estudiante debe completar o reemplazar fotografías y reenviar el borrador.</p>
            ) : null}
            {item.submissionStatus === "preapproved" ? (
              <p className="action-note">Fotografías preaprobadas. La aceptación definitiva requiere recepción y evaluación física.</p>
            ) : null}
          </div>
        </section>
      ) : null}

      {item.deliveries.length > 0 ? (
        <ul className="delivery-list">
          {item.deliveries.map((delivery) => (
            <li key={delivery.id}>
              <span>{deliveryTypeLabel(delivery.type)}</span>
              <span className={`status-pill status-${delivery.status}`}>{deliveryStatusLabel(delivery.status)}</span>
              {delivery.receiptReference ? <span className="quiet">Comprobante: {delivery.receiptReference}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="action-grid">
        {item.requestStatus === "pending" ? (
          <ActionButton label="Iniciar revisión" onClick={() => onAction({ action: "request.review", requestId: item.requestId })} busy={busy} />
        ) : null}
        {item.requestStatus === "under_review" ? (
          <>
            {item.submissionId && item.submissionStatus !== "preapproved" ? (
              <p className="action-note">La solicitud no puede aprobarse hasta que las fotografías estén preaprobadas.</p>
            ) : (
              <ActionButton
                label="Aprobar solicitud"
                busy={busy}
                onClick={() => {
                  const reason = promptText("Motivo de la aprobación:");
                  if (!reason) return;
                  if (!window.confirm(`¿Aprobar la solicitud ${item.requestCode}? La aprobación no recibe el libro ni habilita el ejemplar.`)) return;
                  void onAction({ action: "request.approve", requestId: item.requestId, reason });
                }}
              />
            )}
            <ActionButton
              label="Denegar solicitud"
              variant="secondary"
              onClick={() => {
                const reason = promptText("Motivo de la denegación:");
                if (!reason) return;
                if (!window.confirm(`¿Denegar la solicitud ${item.requestCode}? El motivo quedará en el historial.`)) return;
                void onAction({ action: "request.reject", requestId: item.requestId, reason });
              }}
              busy={busy}
            />
          </>
        ) : null}
        {item.requestStatus === "approved" ? (
          <ActionButton
            label="Programar intercambio"
            onClick={() => {
              const receiptCode = promptText("Código de recepción:");
              if (receiptCode) void onAction({ action: "exchange.plan", requestId: item.requestId, receiptCode, planningKey: newKey() });
            }}
            busy={busy}
          />
        ) : null}
        {item.exchangeStatus === "planned" && item.receptionStatus === "awaiting_delivery" && !dropoff ? (
          <ActionButton
            label="Programar entrega del libro"
            onClick={() => onAction({ action: "delivery.schedule", exchangeId: item.exchangeId!, deliveryType: "offered_book_dropoff" })}
            busy={busy}
          />
        ) : null}
        {dropoff && (dropoff.status === "scheduled" || dropoff.status === "in_progress") ? (
          <ConfirmDeliveryButton
            busy={busy}
            onAction={(receiptReference) => onAction({
              action: "delivery.confirm",
              deliveryId: dropoff.id,
              receiptReference,
              idempotencyKey: dropoff.idempotencyKey,
            })}
          />
        ) : null}
        {item.receptionStatus === "received" ? (
          <ActionButton
            label="Registrar custodia"
            onClick={() => {
              const location = promptText("Ubicación:");
              const custodian = promptText("Responsable de custodia:");
              const evidenceReference = promptText("Referencia de evidencia:");
              if (location && custodian && evidenceReference) {
                void onAction({ action: "reception.custody", receptionId: item.receptionId!, location, custodian, evidenceReference });
              }
            }}
            busy={busy}
          />
        ) : null}
        {item.receptionStatus === "in_custody" ? (
          <ActionButton
            label="Evaluar libro"
            onClick={() => {
              const outcome = promptText("Resultado (accepted/rejected):", "accepted");
              if (outcome !== "accepted" && outcome !== "rejected") return;
              const assessedCondition = promptText("Estado (excellent/good/fair/poor):", "good");
              if (!assessedCondition || !["excellent", "good", "fair", "poor"].includes(assessedCondition)) return;
              const rationale = promptText("Justificación:");
              const evidenceReference = promptText("Evidencia de la evaluación:");
              if (rationale && evidenceReference) {
                void onAction({
                  action: "reception.evaluate", receptionId: item.receptionId!, outcome,
                  assessedCondition: assessedCondition as "excellent" | "good" | "fair" | "poor",
                  rationale, evidenceReference,
                });
              }
            }}
            busy={busy}
          />
        ) : null}
        {item.receptionStatus === "evaluated" && !item.catalogingId ? (
          <ActionButton
            label="Preparar catalogación"
            onClick={() => {
              const title = promptText("Título catalogado:", item.offeredTitle);
              const author = promptText("Autor catalogado:", item.offeredAuthor);
              const isbnRaw = promptText("ISBN (opcional):");
              if (!title || !author) return;
              const isbn = isbnRaw || null;
              const isbnNormalized = isbn ? normalizeIsbn(isbn) : null;
              if (isbn && !isbnNormalized) {
                window.alert("El ISBN no es válido.");
                return;
              }
              void onAction({ action: "cataloging.prepare", receptionId: item.receptionId!, title, author, isbn: isbn ?? undefined, isbnNormalized: isbnNormalized ?? undefined, validationKey: newKey() });
            }}
            busy={busy}
          />
        ) : null}
        {item.catalogingStatus === "validated" ? (
          <ActionButton
            label="Autorizar catalogación"
            onClick={() => onAction({ action: "cataloging.authorize", catalogingId: item.catalogingId!, authorizationKey: newKey() })}
            busy={busy}
          />
        ) : null}
        {item.evaluationOutcome === "accepted" && item.catalogingStatus === "authorized" && !item.admissionId ? (
          <ActionButton
            label="Autorizar admisión"
            onClick={() => onAction({ action: "admission.authorize", receptionId: item.receptionId! })}
            busy={busy}
          />
        ) : null}
        {item.admissionStatus === "authorized" ? (
          <ActionButton
            label="Admitir ejemplar"
            onClick={() => {
              const inventoryCode = promptText("Código de inventario:");
              const location = promptText("Ubicación física:");
              if (inventoryCode && location) void onAction({ action: "admission.admit", admissionId: item.admissionId!, inventoryCode, location });
            }}
            busy={busy}
          />
        ) : null}
        {item.admissionStatus === "admitted" ? (
          <ActionButton label="Habilitar ejemplar" onClick={() => onAction({ action: "admission.enable", admissionId: item.admissionId! })} busy={busy} />
        ) : null}
        {item.admissionStatus === "enabled" && item.exchangeStatus === "planned" ? (
          <ActionButton label="Iniciar intercambio" onClick={() => onAction({ action: "exchange.start", exchangeId: item.exchangeId! })} busy={busy} />
        ) : null}
        {item.exchangeStatus === "in_process" && item.receptionStatus === "evaluated" && !handover ? (
          <ActionButton
            label="Programar entrega institucional"
            onClick={() => onAction({ action: "delivery.schedule", exchangeId: item.exchangeId!, deliveryType: "institutional_copy_handover" })}
            busy={busy}
          />
        ) : null}
        {handover && (handover.status === "scheduled" || handover.status === "in_progress") ? (
          <ConfirmDeliveryButton
            busy={busy}
            onAction={(receiptReference) => onAction({
              action: "delivery.confirm",
              deliveryId: handover.id,
              receiptReference,
              idempotencyKey: handover.idempotencyKey,
            })}
          />
        ) : null}
        {canComplete ? (
          <ActionButton
            label="Completar intercambio"
            onClick={() => onAction({ action: "exchange.complete", exchangeId: item.exchangeId!, completionKey: newKey() })}
            busy={busy}
          />
        ) : null}
        {item.receptionStatus === "rejected" ? (
          <ActionButton
            label="Registrar devolución"
            variant="secondary"
            onClick={() => {
              const reason = promptText("Motivo de la devolución:");
              if (reason) void onAction({ action: "reception.return", receptionId: item.receptionId!, reason });
            }}
            busy={busy}
          />
        ) : null}
        {item.receptionStatus === "return_pending" && !returnDelivery ? (
          <ActionButton
            label="Programar devolución"
            onClick={() => onAction({ action: "delivery.schedule", exchangeId: item.exchangeId!, deliveryType: "offered_book_return" })}
            busy={busy}
          />
        ) : null}
        {returnDelivery && (returnDelivery.status === "scheduled" || returnDelivery.status === "in_progress") ? (
          <ConfirmDeliveryButton
            label="Confirmar devolución física"
            busy={busy}
            onAction={(receiptReference) => onAction({
              action: "delivery.confirm",
              deliveryId: returnDelivery.id,
              receiptReference,
              idempotencyKey: returnDelivery.idempotencyKey,
            })}
          />
        ) : null}
        {item.exchangeStatus === "planned" || item.exchangeStatus === "in_process" ? (
          <ActionButton
            label="Cancelar intercambio"
            variant="secondary"
            onClick={() => {
              const reason = promptText("Motivo de la cancelación:");
              if (reason) void onAction({ action: "exchange.cancel", exchangeId: item.exchangeId!, cancellationKey: newKey(), reason });
            }}
            busy={busy}
          />
        ) : null}
        {item.exchangeStatus === "cancellation_pending" ? (
          <>
            {returnDelivery?.status === "completed" && item.cancellationKey ? (
              <ActionButton
                label="Cerrar cancelación"
                onClick={() => onAction({ action: "exchange.cancel", exchangeId: item.exchangeId!, cancellationKey: item.cancellationKey!, reason: "devolución confirmada" })}
                busy={busy}
              />
            ) : null}
            <p className="action-note">La cancelación queda pendiente hasta confirmar la devolución física. No se habilitan nuevas operaciones mientras tanto.</p>
          </>
        ) : null}
      </div>
    </article>
  );
}

function ActionButton({
  label,
  onClick,
  busy,
  variant = "primary",
}: {
  label: string;
  onClick: () => void;
  busy: boolean;
  variant?: "primary" | "secondary";
}) {
  return (
    <button className={`button button-${variant}`} type="button" onClick={onClick} disabled={busy}>
      {busy ? "Procesando…" : label}
    </button>
  );
}

function ConfirmDeliveryButton({
  busy,
  onAction,
  label = "Confirmar entrega",
}: {
  busy: boolean;
  onAction: (receiptReference: string) => void;
  label?: string;
}) {
  return (
    <ActionButton
      label={label}
      busy={busy}
      onClick={() => {
        const receiptReference = promptText("Comprobante de la entrega:");
        if (receiptReference) onAction(receiptReference);
      }}
    />
  );
}
