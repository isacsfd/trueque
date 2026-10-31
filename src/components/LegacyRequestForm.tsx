import { useState } from "react";
import { createExchangeRequest, reserveCopy } from "../lib/api";
import type { CatalogItem } from "../lib/types";

interface LegacyRequestFormProps {
  selected: CatalogItem | null;
  onBack: () => void;
  onCreated: (input: { requestCode: string; accessToken: string }) => void;
}

const conditions = [
  { value: "excellent", label: "Excelente" },
  { value: "good", label: "Bueno" },
  { value: "fair", label: "Aceptable" },
  { value: "poor", label: "Deteriorado" },
] as const;

export function LegacyRequestForm({ selected, onBack, onCreated }: LegacyRequestFormProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [created, setCreated] = useState<{ requestCode: string; accessToken: string } | null>(null);
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  if (!selected) {
    return (
      <section className="section-block" aria-labelledby="request-title">
        <div className="section-heading"><h2 id="request-title">Nueva solicitud</h2></div>
        <div className="notice">Selecciona primero un ejemplar del catálogo.</div>
        <button className="button button-secondary" type="button" onClick={onBack}>Volver al catálogo</button>
      </section>
    );
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setWarning(null);
    const form = new FormData(event.currentTarget);
    try {
      const result = await createExchangeRequest({
        copyId: selected!.copyId,
        participantName: String(form.get("participantName") ?? ""),
        participantEmail: String(form.get("participantEmail") ?? ""),
        participantDocument: String(form.get("participantDocument") ?? ""),
        offeredTitle: String(form.get("offeredTitle") ?? ""),
        offeredAuthor: String(form.get("offeredAuthor") ?? ""),
        offeredPublisher: String(form.get("offeredPublisher") ?? "") || undefined,
        offeredGenre: String(form.get("offeredGenre") ?? "") || undefined,
        offeredIsbn: String(form.get("offeredIsbn") ?? "") || undefined,
        offeredCondition: String(form.get("offeredCondition")) as "excellent" | "good" | "fair" | "poor",
        offeredObservations: String(form.get("offeredObservations") ?? "") || undefined,
        consent: form.get("consent") === "on",
        idempotencyKey,
      });
      setCreated({ requestCode: result.requestCode, accessToken: result.accessToken });
      try {
        sessionStorage.setItem("iub:participant-request", JSON.stringify({
          requestCode: result.requestCode,
          accessToken: result.accessToken,
        }));
      } catch {
        // Storage may be unavailable; the token is still shown on screen.
      }
      onCreated({ requestCode: result.requestCode, accessToken: result.accessToken });
      try {
        await reserveCopy({
          requestId: result.requestId,
          copyId: selected!.copyId,
          accessToken: result.accessToken,
          idempotencyKey: crypto.randomUUID(),
        });
      } catch {
        setWarning("La solicitud quedó registrada, pero la reserva temporal no se pudo confirmar. El equipo la revisará.");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo registrar la solicitud.");
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <section className="section-block" aria-labelledby="request-created-title">
        <div className="section-heading"><div><p className="eyebrow">Solicitud registrada</p><h2 id="request-created-title">Guarda tu código de consulta</h2></div></div>
        <div className="notice notice-success">
          <p><strong>Código de solicitud:</strong> {created.requestCode}</p>
          <p><strong>Token de consulta:</strong> <code>{created.accessToken}</code></p>
          <p>Conserva este token. Es la credencial para consultar el estado de tu solicitud.</p>
        </div>
        {warning ? <div className="notice notice-warning" role="status">{warning}</div> : null}
        <div className="button-row">
          <button className="button button-primary" type="button" onClick={() => onCreated(created)}>Ir a consultar estado</button>
          <button className="button button-secondary" type="button" onClick={onBack}>Volver al catálogo</button>
        </div>
      </section>
    );
  }

  return (
    <section className="section-block" aria-labelledby="request-title">
      <div className="section-heading">
        <div><p className="eyebrow">Nueva solicitud</p><h2 id="request-title">Presenta tu propuesta</h2></div>
        <button className="button button-secondary" type="button" onClick={onBack} disabled={busy}>Volver al catálogo</button>
      </div>

      <div className="notice">
        <strong>Ejemplar solicitado:</strong> {selected.title} · {selected.author} · {selected.inventoryCode}
      </div>

      <form className="request-form" onSubmit={submit}>
        <fieldset>
          <legend>Datos del participante</legend>
          <label>Nombre completo<input name="participantName" required maxLength={250} autoComplete="name" /></label>
          <label>Correo electrónico<input name="participantEmail" type="email" required maxLength={320} autoComplete="email" /></label>
          <label>Documento de identidad<input name="participantDocument" required minLength={4} maxLength={80} autoComplete="off" /></label>
        </fieldset>

        <fieldset>
          <legend>Libro que ofreces</legend>
          <label>Título<input name="offeredTitle" required maxLength={500} /></label>
          <label>Autor<input name="offeredAuthor" required maxLength={500} /></label>
          <label>Editorial<input name="offeredPublisher" maxLength={250} /></label>
          <label>Categoría<input name="offeredGenre" maxLength={120} /></label>
          <label>ISBN (opcional)<input name="offeredIsbn" maxLength={30} inputMode="numeric" /></label>
          <label>Estado
            <select name="offeredCondition" defaultValue="good">
              {conditions.map((condition) => <option key={condition.value} value={condition.value}>{condition.label}</option>)}
            </select>
          </label>
          <label>Observaciones<textarea name="offeredObservations" maxLength={3000} rows={3} /></label>
        </fieldset>

        <label className="checkbox-row">
          <input type="checkbox" name="consent" required />
          <span>Autorizo el tratamiento de mis datos para gestionar esta solicitud.</span>
        </label>

        {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
        <button className="button button-primary" type="submit" disabled={busy}>
          {busy ? "Registrando…" : "Enviar solicitud"}
        </button>
      </form>
    </section>
  );
}
