import { useEffect, useState } from "react";
import {
  fetchInventoryRegistrationCapabilities,
  registerInstitutionalCopy,
} from "../lib/api";
import type {
  InventoryRegistrationCapabilities,
  InventoryRegistrationResult,
} from "../lib/api";

const conditions = [
  { value: "unassessed", label: "Sin evaluar" },
  { value: "excellent", label: "Excelente" },
  { value: "good", label: "Bueno" },
  { value: "fair", label: "Aceptable" },
  { value: "poor", label: "Deteriorado" },
] as const;

function newKey(): string {
  return crypto.randomUUID();
}

export function InventoryRegistration() {
  const [capabilities, setCapabilities] = useState<InventoryRegistrationCapabilities | null>(null);
  const [condition, setCondition] = useState<(typeof conditions)[number]["value"]>("unassessed");
  const [publish, setPublish] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InventoryRegistrationResult | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(newKey);

  useEffect(() => {
    let active = true;
    fetchInventoryRegistrationCapabilities()
      .then((value) => {
        if (active) setCapabilities(value);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "No se pudieron comprobar los permisos.");
      });
    return () => {
      active = false;
    };
  }, []);

  const canPublishNow = Boolean(capabilities?.canVerify && capabilities?.canPublish);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const created = await registerInstitutionalCopy({
        title: String(form.get("title") ?? ""),
        author: String(form.get("author") ?? ""),
        publisher: String(form.get("publisher") ?? "") || undefined,
        genre: String(form.get("genre") ?? "") || undefined,
        isbn: String(form.get("isbn") ?? "") || undefined,
        inventoryCode: String(form.get("inventoryCode") ?? ""),
        location: String(form.get("location") ?? "") || undefined,
        physicalCondition: condition,
        verificationReference: String(form.get("verificationReference") ?? "") || undefined,
        publish,
        idempotencyKey,
      });
      setResult(created);
      formElement.reset();
      setCondition("unassessed");
      setPublish(false);
      setIdempotencyKey(newKey());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo registrar el ejemplar.");
    } finally {
      setBusy(false);
    }
  }

  if (!capabilities && !error) {
    return <p role="status">Comprobando permisos de inventario…</p>;
  }

  if (capabilities && !capabilities.canRegister) {
    return (
      <section className="admin-module" aria-labelledby="inventory-register-title">
        <div className="section-heading">
          <div><p className="eyebrow">Inventario institucional</p><h3 id="inventory-register-title">Alta manual de ejemplar</h3></div>
        </div>
        <div className="notice notice-warning">
          Tu cuenta no tiene el permiso <code>inventory.register</code>. Solicita acceso a un administrador.
        </div>
      </section>
    );
  }

  return (
    <section className="admin-module" aria-labelledby="inventory-register-title">
      <div className="section-heading">
        <div><p className="eyebrow">Inventario institucional</p><h3 id="inventory-register-title">Alta manual de ejemplar</h3></div>
      </div>
      <div className="notice">
        El ejemplar se crea siempre como <strong>no disponible</strong>. Solo se publica si marcas
        “Publicar ahora”, registras una condición física evaluada y una referencia de verificación,
        y tu cuenta tiene permisos de verificación y publicación. La operación queda auditada y es
        idempotente.
      </div>
      {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
      {result ? (
        <div className="notice notice-success" role="status">
          <p><strong>Ejemplar registrado.</strong> Código de inventario: {result.inventoryCode}.</p>
          <p>
            {result.published
              ? "Publicado en el catálogo tras verificación."
              : "Guardado como no disponible; queda pendiente de verificación o publicación."}
          </p>
          {result.created ? null : <p>La clave de idempotencia ya existía; se devolvió el ejemplar existente.</p>}
        </div>
      ) : null}

      <form className="request-form" onSubmit={submit}>
        <fieldset>
          <legend>Datos bibliográficos</legend>
          <label>Título<input name="title" required maxLength={500} /></label>
          <label>Autor<input name="author" required maxLength={500} /></label>
          <label>Editorial<input name="publisher" maxLength={250} /></label>
          <label>Categoría<input name="genre" maxLength={120} /></label>
          <label>ISBN (opcional)<input name="isbn" maxLength={30} inputMode="numeric" /></label>
        </fieldset>

        <fieldset>
          <legend>Ejemplar físico</legend>
          <label>Código de inventario<input name="inventoryCode" required maxLength={120} /></label>
          <label>Ubicación<input name="location" maxLength={200} /></label>
          <label>Estado físico
            <select value={condition} onChange={(event) => setCondition(event.target.value as typeof condition)}>
              {conditions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <label>Referencia de verificación
            <input name="verificationReference" maxLength={500} placeholder="Acta, revisión física o comprobante" />
          </label>
          <p className="field-help">
            Obligatoria para publicar. No se muestra en el catálogo público.
          </p>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={publish}
              onChange={(event) => setPublish(event.target.checked)}
              disabled={!canPublishNow}
            />
            <span>Publicar ahora si cumple elegibilidad</span>
          </label>
          {!canPublishNow ? (
            <p className="field-help">
              Tu cuenta puede registrar, pero no verificar/publicar. El ejemplar quedará no disponible.
            </p>
          ) : null}
        </fieldset>

        <button className="button button-primary" type="submit" disabled={busy}>
          {busy ? "Registrando…" : "Registrar ejemplar"}
        </button>
      </form>
    </section>
  );
}
