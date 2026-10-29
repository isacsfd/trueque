import { useEffect, useState } from "react";
import {
  deleteOfferedBookEvidence,
  fetchOfferedBookStatus,
  submitOfferedBook,
  updateOfferedBookDraft,
  uploadOfferedBookEvidence,
} from "../lib/api";
import { submissionStatusLabel, submissionWorkflowStatusLabel } from "../lib/status";
import type { SubmissionView } from "../lib/types";
import { EvidenceGallery } from "./EvidenceGallery";

interface StoredDraft {
  submissionId: string;
  accessToken: string;
}

function readDraft(): StoredDraft | null {
  try {
    const raw = sessionStorage.getItem("iub:offered-book-draft");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredDraft>;
    if (typeof parsed.submissionId === "string" && typeof parsed.accessToken === "string") {
      return { submissionId: parsed.submissionId, accessToken: parsed.accessToken };
    }
  } catch {
    return null;
  }
  return null;
}

function newKey(): string {
  return crypto.randomUUID();
}

export function PhotoFollowUp() {
  const [draft] = useState<StoredDraft | null>(readDraft);
  const [submission, setSubmission] = useState<SubmissionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    title: "",
    author: "",
    condition: "good" as "excellent" | "good" | "fair" | "poor",
    observations: "",
  });

  async function refresh(): Promise<void> {
    if (!draft) return;
    const result = await fetchOfferedBookStatus(draft);
    setSubmission(result);
    setForm({
      title: result.title,
      author: result.author,
      condition: result.declaredCondition,
      observations: result.observations ?? "",
    });
  }

  useEffect(() => {
    if (!draft) return;
    queueMicrotask(() => {
      void refresh().catch((reason) => {
        setError(reason instanceof Error ? reason.message : "No se pudo consultar la revisión fotográfica.");
      });
    });
    // The stored draft is read once for this session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!draft) return null;

  async function saveData(): Promise<void> {
    if (!draft || !submission) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await updateOfferedBookDraft({
        submissionId: draft.submissionId,
        accessToken: draft.accessToken,
        copyId: submission.requestedCopyId,
        title: form.title,
        author: form.author,
        publisher: submission.publisher ?? undefined,
        genre: submission.genre ?? undefined,
        isbn: submission.isbn ?? undefined,
        declaredCondition: form.condition,
        observations: form.observations,
      });
      await refresh();
      setMessage("Datos actualizados.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudieron guardar los datos.");
    } finally {
      setBusy(false);
    }
  }

  async function addPhoto(slot: "cover" | "back_cover" | "spine" | "interior" | "damage", file: File): Promise<void> {
    if (!draft) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await uploadOfferedBookEvidence({
        submissionId: draft.submissionId,
        accessToken: draft.accessToken,
        slot,
        file,
        idempotencyKey: newKey(),
      });
      await refresh();
      setMessage("Fotografía añadida.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo subir la fotografía.");
    } finally {
      setBusy(false);
    }
  }

  async function removePhoto(evidenceId: string): Promise<void> {
    if (!draft) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await deleteOfferedBookEvidence({ evidenceId, accessToken: draft.accessToken });
      await refresh();
      setMessage("Fotografía eliminada.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo eliminar la fotografía.");
    } finally {
      setBusy(false);
    }
  }

  async function resubmit(): Promise<void> {
    if (!draft) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await submitOfferedBook({
        submissionId: draft.submissionId,
        accessToken: draft.accessToken,
        idempotencyKey: newKey(),
      });
      await refresh();
      setMessage("Fotografías reenviadas. La revisión administrativa continúa.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo reenviar el borrador.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="submission-followup" aria-labelledby="photo-followup-title">
      <header>
        <p className="eyebrow">Revisión fotográfica</p>
        <h3 id="photo-followup-title">{submissionWorkflowStatusLabel(submission?.workflowStatus ?? null)}</h3>
      </header>
      {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
      {message ? <div className="notice notice-success" role="status">{message}</div> : null}
      {submission ? (
        <>
          <p className="quiet">Estado de la revisión: {submissionStatusLabel(submission.status)}. La preaprobación no equivale a aceptación ni habilitación.</p>
          {submission.decisionReason ? <div className="notice notice-warning">Revisión administrativa: {submission.decisionReason}</div> : null}
          <EvidenceGallery items={submission.evidence} accessToken={draft.accessToken} />

          {submission.status === "needs_information" ? (
            <div className="submission-followup-form">
              <h4>Completar información</h4>
              <label>Título<input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} maxLength={500} /></label>
              <label>Autor<input value={form.author} onChange={(event) => setForm({ ...form, author: event.target.value })} maxLength={500} /></label>
              <label>Estado declarado
                <select value={form.condition} onChange={(event) => setForm({ ...form, condition: event.target.value as typeof form.condition })}>
                  <option value="excellent">Excelente</option>
                  <option value="good">Bueno</option>
                  <option value="fair">Aceptable</option>
                  <option value="poor">Deteriorado</option>
                </select>
              </label>
              <label>Observaciones<textarea value={form.observations} onChange={(event) => setForm({ ...form, observations: event.target.value })} maxLength={3000} rows={2} /></label>
              <button className="button button-secondary" type="button" onClick={() => void saveData()} disabled={busy}>Guardar datos</button>

              <p className="field-help">Añade o reemplaza fotografías. La portada y una página interior son obligatorias.</p>
              {(["cover", "back_cover", "spine", "interior", "damage"] as const).map((slot) => (
                <label key={slot} className="followup-file">
                  {slot === "cover" ? "Portada" : slot === "back_cover" ? "Contraportada" : slot === "spine" ? "Lomo" : slot === "interior" ? "Páginas interiores" : "Daños o anotaciones"}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    disabled={busy}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void addPhoto(slot, file);
                      event.target.value = "";
                    }}
                  />
                </label>
              ))}
              {submission.evidence.length > 0 ? (
                <div className="button-row">
                  {submission.evidence.map((item) => (
                    <button key={item.id} className="button button-secondary" type="button" onClick={() => void removePhoto(item.id)} disabled={busy}>
                      Eliminar {item.slot}
                    </button>
                  ))}
                </div>
              ) : null}
              <button className="button button-primary" type="button" onClick={() => void resubmit()} disabled={busy}>
                {busy ? "Procesando…" : "Reenviar fotografías"}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
