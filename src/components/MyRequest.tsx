import { useEffect, useState } from "react";
import { fetchRequestStatus } from "../lib/api";
import { cancellationExplanation, exchangeStatusLabel, receptionStatusLabel, requestStatusLabel } from "../lib/status";
import type { RequestStatusView } from "../lib/types";
import { PhotoFollowUp } from "./PhotoFollowUp";

interface StoredRequest {
  requestCode: string;
  accessToken: string;
}

function readStored(): StoredRequest | null {
  try {
    const raw = sessionStorage.getItem("iub:participant-request");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredRequest>;
    if (typeof parsed.requestCode === "string" && typeof parsed.accessToken === "string") {
      return { requestCode: parsed.requestCode, accessToken: parsed.accessToken };
    }
  } catch {
    return null;
  }
  return null;
}

export function MyRequest({ initialCode, initialToken }: { initialCode?: string; initialToken?: string }) {
  const stored = readStored();
  const [code, setCode] = useState(stored?.requestCode ?? initialCode ?? "");
  const [token, setToken] = useState(stored?.accessToken ?? initialToken ?? "");
  const [status, setStatus] = useState<RequestStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function lookup(requestCode = code, accessToken = token) {
    setBusy(true);
    setError(null);
    try {
      const result = await fetchRequestStatus({ requestCode, accessToken });
      setStatus(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo consultar la solicitud.");
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (stored) {
      queueMicrotask(() => {
        void lookup(stored.requestCode, stored.accessToken);
      });
    }
    // Only the initial stored request is auto-queried.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const explanation = status
    ? cancellationExplanation(status.status, status.returnRequired, status.returnConfirmed)
    : null;

  return (
    <section className="section-block" aria-labelledby="my-request-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Seguimiento</p>
          <h2 id="my-request-title">Mi solicitud</h2>
        </div>
      </div>

      <form
        className="lookup-form"
        onSubmit={(event) => {
          event.preventDefault();
          void lookup();
        }}
      >
        <label>Código de solicitud<input value={code} onChange={(event) => setCode(event.target.value)} maxLength={80} required /></label>
        <label>Clave de acceso<input value={token} onChange={(event) => setToken(event.target.value)} type="password" maxLength={200} required autoComplete="off" /></label>
        <button className="button button-primary" type="submit" disabled={busy}>{busy ? "Consultando…" : "Consultar"}</button>
      </form>

      {error ? <div className="notice notice-error" role="alert">{error}</div> : null}

      {status ? (
        <article className="status-card">
          <header>
            <div>
              <p className="eyebrow">Solicitud {status.requestCode}</p>
              <h3>{requestStatusLabel(status.status)}</h3>
            </div>
            <span className={`status-pill status-${status.status}`}>{requestStatusLabel(status.status)}</span>
          </header>
          <dl className="status-grid">
            <div><dt>Ejemplar solicitado</dt><dd>{status.copyTitle}</dd></div>
            <div><dt>Intercambio</dt><dd>{exchangeStatusLabel(status.exchangeStatus)}</dd></div>
            <div><dt>Recepción del libro ofrecido</dt><dd>{receptionStatusLabel(status.receptionStatus)}</dd></div>
          </dl>
          {explanation ? <div className="notice notice-warning">{explanation}</div> : null}
          {status.status === "cancelled" ? (
            <div className="notice notice-success">La solicitud está cancelada. Si había un libro en custodia, la devolución quedó registrada.</div>
          ) : null}
        </article>
      ) : null}
      <PhotoFollowUp />
    </section>
  );
}
