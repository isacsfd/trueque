import { useMemo, useState } from "react";
import {
  createOfferedBookDraft,
  deleteOfferedBookEvidence,
  reserveCopy,
  submitOfferedBook,
  updateOfferedBookDraft,
  uploadOfferedBookEvidence,
} from "../lib/api";
import type { CatalogItem } from "../lib/types";

interface RequestFormProps {
  selected: CatalogItem | null;
  onBack: () => void;
  onCreated: (input: { requestCode: string; accessToken: string }) => void;
}

type PhotoSlot = "cover" | "back_cover" | "spine" | "interior" | "damage";

interface LocalPhoto {
  key: string;
  slot: PhotoSlot;
  previewUrl: string;
  file?: File;
  evidenceId?: string;
  idempotencyKey: string;
}

const conditions = [
  { value: "excellent", label: "Excelente" },
  { value: "good", label: "Bueno" },
  { value: "fair", label: "Aceptable" },
  { value: "poor", label: "Deteriorado" },
] as const;

const slots: Array<{ value: PhotoSlot; label: string; help: string; required?: boolean }> = [
  { value: "cover", label: "Portada", help: "Foto frontal completa.", required: true },
  { value: "back_cover", label: "Contraportada", help: "Parte posterior del libro." },
  { value: "spine", label: "Lomo", help: "Lomo y encuadernación." },
  { value: "interior", label: "Páginas interiores", help: "Al menos una página interior.", required: true },
  { value: "damage", label: "Daños o anotaciones", help: "Detalles de humedad, roturas, marcas o subrayados." },
];

const MAX_FILES = 12;
const MAX_BYTES = 4 * 1024 * 1024;

function newKey(): string {
  return crypto.randomUUID();
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function RequestForm({ selected, onBack, onCreated }: RequestFormProps) {
  const [step, setStep] = useState<"details" | "participant">("details");
  const [draft, setDraft] = useState<{ submissionId: string; accessToken: string } | null>(null);
  const [draftKey] = useState(newKey);
  const [draftToken] = useState(newToken);
  const [photos, setPhotos] = useState<LocalPhoto[]>([]);
  const [book, setBook] = useState({
    title: "",
    author: "",
    publisher: "",
    genre: "",
    isbn: "",
    declaredCondition: "good" as "excellent" | "good" | "fair" | "poor",
    observations: "",
  });
  const [busy, setBusy] = useState(false);
  const [busyMessage, setBusyMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [created, setCreated] = useState<{ requestId: string; requestCode: string; accessToken: string } | null>(null);
  const [storageSaved, setStorageSaved] = useState(true);

  const requiredPhotos = useMemo(() => ({
    cover: photos.filter((photo) => photo.slot === "cover").length > 0,
    interior: photos.filter((photo) => photo.slot === "interior").length > 0,
  }), [photos]);

  if (!selected) {
    return (
      <section className="section-block" aria-labelledby="request-title">
        <div className="section-heading"><h2 id="request-title">Nueva solicitud</h2></div>
        <div className="notice">Selecciona primero un ejemplar del catálogo.</div>
        <button className="button button-secondary" type="button" onClick={onBack}>Volver al catálogo</button>
      </section>
    );
  }

  function addFiles(slot: PhotoSlot, files: FileList | null): void {
    if (!files) return;
    setError(null);
    const incoming = Array.from(files);
    const next: LocalPhoto[] = [];
    for (const file of incoming) {
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
        setError("Solo puedes subir fotografías JPEG, PNG o WebP.");
        continue;
      }
      if (file.size > MAX_BYTES) {
        setError("Cada fotografía debe pesar como máximo 4 MB.");
        continue;
      }
      if (photos.length + next.length >= MAX_FILES) {
        setError("Puedes adjuntar como máximo 12 fotografías.");
        break;
      }
      next.push({
        key: newKey(),
        slot,
        previewUrl: URL.createObjectURL(file),
        file,
        idempotencyKey: newKey(),
      });
    }
    if (next.length > 0) setPhotos((current) => [...current, ...next]);
  }

  async function removePhoto(photo: LocalPhoto): Promise<void> {
    setError(null);
    if (draft && photo.evidenceId) {
      try {
        await deleteOfferedBookEvidence({ evidenceId: photo.evidenceId, accessToken: draft.accessToken });
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "No se pudo eliminar la fotografía.");
        return;
      }
    }
    URL.revokeObjectURL(photo.previewUrl);
    setPhotos((current) => current.filter((item) => item.key !== photo.key));
  }

  async function saveDetails(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setWarning(null);
    if (!requiredPhotos.cover || !requiredPhotos.interior) {
      setError("Adjunta al menos una fotografía de portada y una de páginas interiores.");
      return;
    }

    setBusy(true);
    try {
      let currentDraft = draft;
      if (!currentDraft) {
        setBusyMessage("Creando borrador…");
        const accessToken = draftToken;
        const createdDraft = await createOfferedBookDraft({
          copyId: selected!.copyId,
          accessToken,
          title: book.title,
          author: book.author,
          publisher: book.publisher,
          genre: book.genre,
          isbn: book.isbn,
          declaredCondition: book.declaredCondition,
          observations: book.observations,
          idempotencyKey: draftKey,
        });
        currentDraft = { submissionId: createdDraft.submissionId, accessToken };
        setDraft(currentDraft);
        try {
          sessionStorage.setItem(
            "iub:offered-book-draft",
            JSON.stringify({ submissionId: currentDraft.submissionId, accessToken: currentDraft.accessToken }),
          );
        } catch {
          // The draft is already on the server; storage is only a convenience.
        }
      } else {
        setBusyMessage("Actualizando borrador…");
        await updateOfferedBookDraft({
          submissionId: currentDraft.submissionId,
          accessToken: currentDraft.accessToken,
          copyId: selected!.copyId,
          title: book.title,
          author: book.author,
          publisher: book.publisher,
          genre: book.genre,
          isbn: book.isbn,
          declaredCondition: book.declaredCondition,
          observations: book.observations,
        });
      }

      let uploaded = photos;
      const pending = photos.filter((photo) => photo.file && !photo.evidenceId);
      for (let index = 0; index < pending.length; index += 1) {
        const photo = pending[index];
        setBusyMessage(`Subiendo fotografía ${index + 1} de ${pending.length}…`);
        const result = await uploadOfferedBookEvidence({
          submissionId: currentDraft.submissionId,
          accessToken: currentDraft.accessToken,
          slot: photo.slot,
          idempotencyKey: photo.idempotencyKey,
          file: photo.file!,
        });
        uploaded = uploaded.map((item) =>
          item.key === photo.key ? { ...item, file: undefined, evidenceId: result.evidenceId } : item,
        );
        setPhotos(uploaded);
      }
      setStep("participant");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo guardar el borrador.");
    } finally {
      setBusy(false);
      setBusyMessage("");
    }
  }

  async function submitParticipant(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!draft) {
      setError("Primero guarda los datos y las fotografías del libro.");
      return;
    }
    const form = new FormData(event.currentTarget);
    if (form.get("consent") !== "on") {
      setError("Debes autorizar el tratamiento de datos para continuar.");
      return;
    }

    setBusy(true);
    setBusyMessage("Enviando solicitud…");
    setError(null);
    setWarning(null);
    try {
      const response = await submitOfferedBook({
        submissionId: draft.submissionId,
        accessToken: draft.accessToken,
        idempotencyKey: newKey(),
        participantName: String(form.get("participantName") ?? ""),
        participantEmail: String(form.get("participantEmail") ?? ""),
        participantDocument: String(form.get("participantDocument") ?? ""),
        consent: true,
      });
      if (!response.accessToken) {
        throw new Error("La solicitud se reenvió, pero falta el token de consulta.");
      }
      setCreated({ requestId: response.requestId, requestCode: response.requestCode, accessToken: response.accessToken });
      try {
        sessionStorage.setItem(
          "iub:participant-request",
          JSON.stringify({ requestCode: response.requestCode, accessToken: response.accessToken }),
        );
        setStorageSaved(true);
      } catch {
        // The request is already created; keep the token in React state for
        // this tab and show it once if browser storage is unavailable.
        setStorageSaved(false);
      }
      onCreated({ requestCode: response.requestCode, accessToken: response.accessToken });

      try {
        await reserveCopy({
          requestId: response.requestId,
          copyId: selected!.copyId,
          accessToken: response.accessToken,
          idempotencyKey: newKey(),
        });
      } catch (reservationError) {
        setWarning(
          reservationError instanceof Error
            ? `${reservationError.message} La solicitud quedó registrada y el equipo puede revisarla.`
            : "La solicitud quedó registrada, pero no se pudo reservar el ejemplar.",
        );
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo enviar la solicitud.");
    } finally {
      setBusy(false);
      setBusyMessage("");
    }
  }

  async function retryReservation(): Promise<void> {
    if (!created) return;
    setBusy(true);
    setWarning(null);
    try {
      await reserveCopy({
        requestId: created.requestId,
        copyId: selected!.copyId,
        accessToken: created.accessToken,
        idempotencyKey: newKey(),
      });
    } catch (reservationError) {
      setWarning(reservationError instanceof Error ? reservationError.message : "No se pudo reservar el ejemplar.");
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <section className="section-block" aria-labelledby="request-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Solicitud registrada</p>
            <h2 id="request-title">Guarda tu código</h2>
          </div>
        </div>
        <div className="notice notice-success" role="status">
          <p>Tu solicitud <strong>{created.requestCode}</strong> fue registrada.</p>
          <p>Conserva este código. El acceso a tu solicitud quedó guardado en este navegador; si lo pierdes, contacta al equipo institucional.</p>
          <p>La revisión de fotografías es manual. La preaprobación no significa que el libro ya haya sido aceptado ni habilitado.</p>
        </div>
        {!storageSaved ? (
          <div className="notice notice-warning" role="alert">
            <p>El navegador no permitió guardar el acceso. Conserva esta clave de consulta para esta solicitud:</p>
            <p><strong>{created.accessToken}</strong></p>
            <p>No la compartas; permite consultar tu solicitud y su estado.</p>
          </div>
        ) : null}
        {warning ? <div className="notice notice-warning" role="alert">{warning}</div> : null}
        {warning ? (
          <button className="button button-secondary" type="button" onClick={() => void retryReservation()} disabled={busy}>
            {busy ? "Reintentando…" : "Reintentar reserva"}
          </button>
        ) : null}
        <button className="button button-primary" type="button" onClick={onBack}>Volver al catálogo</button>
      </section>
    );
  }

  return (
    <section className="section-block" aria-labelledby="request-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">{step === "details" ? "Paso 2 de 4" : "Paso 3 de 4"}</p>
          <h2 id="request-title">{step === "details" ? "Presenta tu libro" : "Confirma tus datos"}</h2>
        </div>
        <button className="button button-secondary" type="button" onClick={onBack} disabled={busy}>Volver al catálogo</button>
      </div>

      <div className="selected-copy">
        <strong>{selected.title}</strong>
        <span>{selected.author}</span>
        <span>Ejemplar {selected.inventoryCode}</span>
      </div>

      {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
      {busy && busyMessage ? <div className="notice" role="status">{busyMessage}</div> : null}

      {step === "details" ? (
        <form className="request-form" onSubmit={(event) => void saveDetails(event)}>
          <fieldset>
            <legend>El libro que ofreces</legend>
            <label>Título<input value={book.title} onChange={(event) => setBook({ ...book, title: event.target.value })} required maxLength={500} /></label>
            <label>Autor<input value={book.author} onChange={(event) => setBook({ ...book, author: event.target.value })} required maxLength={500} /></label>
            <label>Editorial<input value={book.publisher} onChange={(event) => setBook({ ...book, publisher: event.target.value })} maxLength={250} /></label>
            <label>Género<input value={book.genre} onChange={(event) => setBook({ ...book, genre: event.target.value })} maxLength={120} /></label>
            <label>ISBN (opcional)<input value={book.isbn} onChange={(event) => setBook({ ...book, isbn: event.target.value })} maxLength={30} inputMode="text" placeholder="Déjalo vacío si el libro no tiene ISBN" /></label>
            <label>Estado declarado
              <select value={book.declaredCondition} onChange={(event) => setBook({ ...book, declaredCondition: event.target.value as typeof book.declaredCondition })}>
                {conditions.map((condition) => <option key={condition.value} value={condition.value}>{condition.label}</option>)}
              </select>
            </label>
            <label>Observaciones<textarea value={book.observations} onChange={(event) => setBook({ ...book, observations: event.target.value })} maxLength={3000} rows={3} /></label>
          </fieldset>

          <fieldset>
            <legend>Fotografías del libro</legend>
            <p className="field-help">Adjunta hasta 12 fotografías JPEG, PNG o WebP de máximo 4 MB cada una. La portada y una página interior son obligatorias. Las imágenes se revisan de forma privada.</p>
            {slots.map((slot) => (
              <div className="photo-slot" key={slot.value}>
                <div>
                  <strong>{slot.label}{slot.required ? " *" : ""}</strong>
                  <p className="field-help">{slot.help}</p>
                </div>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  multiple
                  onChange={(event) => {
                    addFiles(slot.value, event.target.files);
                    event.target.value = "";
                  }}
                  disabled={busy}
                  aria-label={`Añadir fotografías de ${slot.label}`}
                />
                <div className="local-evidence-list">
                  {photos.filter((photo) => photo.slot === slot.value).map((photo) => (
                    <div className="local-evidence" key={photo.key}>
                      <img src={photo.previewUrl} alt={`Vista previa de ${slot.label}`} />
                      <span>{photo.evidenceId ? "Subida" : "Pendiente"}</span>
                      <button className="button button-secondary" type="button" onClick={() => void removePhoto(photo)} disabled={busy}>
                        Eliminar
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </fieldset>

          <button className="button button-primary" type="submit" disabled={busy}>
            {busy ? "Guardando…" : "Guardar borrador y continuar"}
          </button>
        </form>
      ) : (
        <form className="request-form" onSubmit={(event) => void submitParticipant(event)}>
          <fieldset>
            <legend>Tus datos y consentimiento</legend>
            <label>Nombre completo<input name="participantName" required maxLength={250} autoComplete="name" /></label>
            <label>Correo electrónico<input name="participantEmail" type="email" required maxLength={320} autoComplete="email" /></label>
            <label>Documento de identidad<input name="participantDocument" required minLength={4} maxLength={80} autoComplete="off" /></label>
            <p className="field-help">El documento se cifra antes de almacenarse y no se devuelve a la interfaz.</p>
          </fieldset>
          <label className="checkbox-row">
            <input name="consent" type="checkbox" required />
            <span>Autorizo el tratamiento de mis datos personales para gestionar esta solicitud de intercambio, conforme al aviso de privacidad institucional.</span>
          </label>
          <p className="field-help">La solicitud quedará pendiente de revisión manual de las fotografías. La preaprobación no es aceptación ni habilitación.</p>
          <div className="button-row">
            <button className="button button-secondary" type="button" onClick={() => setStep("details")} disabled={busy}>Volver a fotografías</button>
            <button className="button button-primary" type="submit" disabled={busy}>{busy ? "Enviando…" : "Enviar solicitud"}</button>
          </div>
        </form>
      )}
    </section>
  );
}
