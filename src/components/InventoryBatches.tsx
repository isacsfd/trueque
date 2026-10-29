import { useEffect, useState } from "react";
import {
  cancelInventoryBatch,
  confirmInventoryBatch,
  downloadInventoryBatchReport,
  fetchInventoryBatch,
  fetchInventoryBatches,
  inspectInventoryBatch,
  prevalidateInventoryBatch,
} from "../lib/api";
import type { BatchDetail, BatchInspection, BatchSummary } from "../lib/types";

const fields: Array<{ key: string; label: string; required?: boolean }> = [
  { key: "title", label: "Título", required: true },
  { key: "author", label: "Autor", required: true },
  { key: "publisher", label: "Editorial" },
  { key: "genre", label: "Género" },
  { key: "isbn", label: "ISBN (opcional)" },
  { key: "inventory_code", label: "Código de inventario (opcional)" },
  { key: "location", label: "Ubicación" },
  { key: "source_number", label: "Número fuente" },
  { key: "copy_number", label: "Número de ejemplar" },
  { key: "observations", label: "Observaciones" },
];

function newKey(): string {
  return crypto.randomUUID();
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function InventoryBatches() {
  const [file, setFile] = useState<File | null>(null);
  const [inspection, setInspection] = useState<BatchInspection | null>(null);
  const [sheetName, setSheetName] = useState("");
  const [headerRow, setHeaderRow] = useState(1);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [observations, setObservations] = useState("");
  const [summary, setSummary] = useState<{
    batchId: string; status: string; totalRows: number; validRows: number;
    warningRows: number; rejectedRows: number; duplicateRows: number;
  } | null>(null);
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [detail, setDetail] = useState<BatchDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [idempotencyKey] = useState(newKey);

  async function refreshList(): Promise<void> {
    setBatches(await fetchInventoryBatches());
  }

  useEffect(() => {
    queueMicrotask(() => {
      void refreshList().catch((reason) => setError(reason instanceof Error ? reason.message : "No se pudo cargar el historial."));
    });
  }, []);

  async function inspect(selectedFile: File, sheet?: string, row?: number): Promise<void> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await inspectInventoryBatch({ file: selectedFile, sheetName: sheet, headerRow: row });
      setInspection(result);
      setSheetName(result.selected.name);
      setHeaderRow(result.selected.headerRow);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo leer el Excel.");
      setInspection(null);
    } finally {
      setBusy(false);
    }
  }

  async function onFile(selected: File | null): Promise<void> {
    setFile(selected);
    setSummary(null);
    setDetail(null);
    setMapping({});
    if (selected) await inspect(selected);
    else setInspection(null);
  }

  async function changeSheet(name: string): Promise<void> {
    if (!file) return;
    setSheetName(name);
    setMapping({});
    await inspect(file, name, headerRow);
  }

  async function changeHeader(row: number): Promise<void> {
    if (!file) return;
    setHeaderRow(row);
    setMapping({});
    await inspect(file, sheetName, row);
  }

  async function prevalidate(): Promise<void> {
    if (!file || !inspection) return;
    for (const field of fields.filter((item) => item.required)) {
      if (!mapping[field.key]) {
        setError(`Selecciona la columna para ${field.label}.`);
        return;
      }
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await prevalidateInventoryBatch({
        file,
        sheetName: inspection.selected.name,
        headerRow: inspection.selected.headerRow,
        mapping,
        observations,
        idempotencyKey,
      });
      setSummary(result);
      setMessage("Prevalidación guardada. Revisa el resumen antes de confirmar; el inventario no se ha modificado.");
      await refreshList();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo prevalidar el lote.");
    } finally {
      setBusy(false);
    }
  }

  async function confirm(batchId: string): Promise<void> {
    if (!window.confirm("¿Confirmar la importación? Los ejemplares quedarán no disponibles y sin verificación.")) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await confirmInventoryBatch(batchId, newKey());
      setMessage(`Lote confirmado: ${result.insertedRows} insertados, ${result.reusedRows} reutilizados, ${result.skippedRows} omitidos.`);
      setSummary(null);
      await refreshList();
      setDetail(await fetchInventoryBatch(batchId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo confirmar el lote.");
    } finally {
      setBusy(false);
    }
  }

  async function cancel(batchId: string): Promise<void> {
    if (!window.confirm("¿Cancelar la prevalidación? Esta acción no modifica el inventario.")) return;
    setBusy(true);
    setError(null);
    try {
      await cancelInventoryBatch(batchId, newKey());
      setMessage("Prevalidación cancelada.");
      setSummary(null);
      await refreshList();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo cancelar el lote.");
    } finally {
      setBusy(false);
    }
  }

  async function openDetail(batchId: string): Promise<void> {
    setError(null);
    try {
      setDetail(await fetchInventoryBatch(batchId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo cargar el detalle.");
    }
  }

  async function downloadReport(batchId: string): Promise<void> {
    try {
      download(await downloadInventoryBatchReport(batchId), `lote-${batchId}-validacion.csv`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo descargar el reporte.");
    }
  }

  const headers = inspection?.selected.headers ?? [];
  const pending = summary?.status === "prevalidated";

  return (
    <section className="admin-module" aria-labelledby="batches-title">
      <div className="section-heading">
        <div><p className="eyebrow">Inventario institucional</p><h3 id="batches-title">Lotes de inventario</h3></div>
      </div>
      <div className="notice notice-warning">Los lotes no se publican automáticamente. Al confirmar se crean ejemplares institucionales no disponibles, sin verificación positiva y sin movimientos ficticios.</div>
      {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
      {message ? <div className="notice notice-success" role="status">{message}</div> : null}

      <fieldset className="batch-upload">
        <legend>1. Archivo Excel</legend>
        <label>Archivo .xlsx<input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => void onFile(event.target.files?.[0] ?? null)} disabled={busy} /></label>
        {inspection ? (
          <>
            <p className="quiet">Archivo: {inspection.file.name} · {inspection.file.size.toLocaleString()} bytes · SHA-256 {inspection.file.sha256.slice(0, 16)}…</p>
            <label>Hoja
              <select value={sheetName} onChange={(event) => void changeSheet(event.target.value)} disabled={busy}>
                {inspection.sheets.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            <label>Fila de encabezados<input type="number" min={1} value={headerRow} onChange={(event) => void changeHeader(Number(event.target.value))} disabled={busy} /></label>
          </>
        ) : null}
      </fieldset>

      {inspection ? (
        <fieldset className="batch-upload">
          <legend>2. Mapeo de columnas</legend>
          <p className="quiet">Encabezados detectados: {headers.join(" · ") || "sin encabezados"}</p>
          {fields.map((field) => (
            <label key={field.key}>{field.label}{field.required ? " *" : ""}
              <select value={mapping[field.key] ?? ""} onChange={(event) => setMapping({ ...mapping, [field.key]: event.target.value })} disabled={busy}>
                <option value="">— No usar —</option>
                {headers.map((header) => <option key={header} value={header}>{header}</option>)}
              </select>
            </label>
          ))}
          <label>Observaciones del lote<textarea value={observations} onChange={(event) => setObservations(event.target.value)} maxLength={3000} rows={2} /></label>
          <button className="button button-primary" type="button" onClick={() => void prevalidate()} disabled={busy || headers.length === 0}>
            {busy ? "Prevalidando…" : "Prevalidar lote"}
          </button>
        </fieldset>
      ) : null}

      {summary ? (
        <section className="batch-summary" aria-labelledby="batch-summary-title">
          <h4 id="batch-summary-title">3. Resumen de prevalidación</h4>
          <div className="stats-grid">
            <div><strong>{summary.totalRows}</strong><span>Filas</span></div>
            <div><strong>{summary.validRows}</strong><span>Válidas</span></div>
            <div><strong>{summary.warningRows}</strong><span>Advertencias</span></div>
            <div><strong>{summary.rejectedRows}</strong><span>Rechazadas</span></div>
            <div><strong>{summary.duplicateRows}</strong><span>Duplicadas</span></div>
          </div>
          <div className="button-row">
            <button className="button button-primary" type="button" onClick={() => void confirm(summary.batchId)} disabled={busy || !pending || summary.validRows + summary.warningRows === 0}>
              Confirmar importación
            </button>
            <button className="button button-secondary" type="button" onClick={() => void cancel(summary.batchId)} disabled={busy || !pending}>Cancelar prevalidación</button>
            <button className="button button-secondary" type="button" onClick={() => void downloadReport(summary.batchId)} disabled={busy}>Descargar reporte CSV</button>
          </div>
        </section>
      ) : null}

      <section className="batch-history" aria-labelledby="batch-history-title">
        <h4 id="batch-history-title">Historial de lotes</h4>
        {batches.length === 0 ? <p className="quiet">No hay lotes registrados.</p> : (
          <div className="table-scroll">
            <table>
              <thead><tr><th>Archivo</th><th>Estado</th><th>Filas</th><th>Válidas</th><th>Rechazadas</th><th>Responsable</th><th>Fecha</th><th>Acciones</th></tr></thead>
              <tbody>
                {batches.map((batch) => (
                  <tr key={batch.batchId}>
                    <td>{batch.fileName}<br /><span className="quiet">{batch.sha256.slice(0, 12)}…</span></td>
                    <td>{batch.status}</td>
                    <td>{batch.totalRows}</td>
                    <td>{batch.validRows}</td>
                    <td>{batch.rejectedRows + batch.duplicateRows}</td>
                    <td>{batch.createdBy}</td>
                    <td>{new Date(batch.createdAt).toLocaleString()}</td>
                    <td>
                      <button className="button button-secondary" type="button" onClick={() => void openDetail(batch.batchId)}>Detalle</button>
                      <button className="button button-secondary" type="button" onClick={() => void downloadReport(batch.batchId)}>CSV</button>
                      {batch.status === "prevalidated" ? <button className="button button-primary" type="button" onClick={() => void confirm(batch.batchId)}>Confirmar</button> : null}
                      {batch.status === "prevalidated" ? <button className="button button-secondary" type="button" onClick={() => void cancel(batch.batchId)}>Cancelar</button> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {detail ? (
        <section className="batch-detail" aria-labelledby="batch-detail-title">
          <h4 id="batch-detail-title">Detalle del lote {detail.batch.batchId}</h4>
          <p className="quiet">{detail.batch.fileName} · {detail.batch.sheetName} · SHA-256 {detail.batch.sha256}</p>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Fila</th><th>Estado</th><th>Título</th><th>Autor</th><th>Código</th><th>Errores / advertencias</th></tr></thead>
              <tbody>
                {detail.rows.map((row) => (
                  <tr key={row.sourceRow}>
                    <td>{row.sourceRow}</td>
                    <td>{row.status}</td>
                    <td>{row.mapped.title}</td>
                    <td>{row.mapped.author}</td>
                    <td>{row.inventoryCode ?? row.mapped.inventory_code ?? "—"}</td>
                    <td>{[...row.errors, ...row.warnings].join(" · ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </section>
  );
}
