import { useEffect, useState } from "react";
import { fetchAdminStats } from "../lib/api";
import {
  admissionStatusLabel,
  exchangeStatusLabel,
  receptionStatusLabel,
  requestStatusLabel,
  submissionStatusLabel,
} from "../lib/status";
import type {
  AdmissionStatus,
  AdminStats,
  ExchangeStatus,
  ReceptionStatus,
  RequestStatus,
  SubmissionStatus,
} from "../lib/types";

function countRows(record: Record<string, number>): Array<[string, number]> {
  return Object.entries(record).sort(([left], [right]) => left.localeCompare(right));
}

function StatCard({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="stat-card">
      <strong>{value}</strong>
      <span>{label}</span>
      {hint ? <small>{hint}</small> : null}
    </div>
  );
}

function Group({
  title,
  record,
  label,
}: {
  title: string;
  record: Record<string, number>;
  label: (key: string) => string;
}) {
  const rows = countRows(record);
  return (
    <section>
      <h4>{title}</h4>
      {rows.length === 0 ? <p className="quiet">Sin registros.</p> : (
        <dl className="compact-list">
          {rows.map(([key, value]) => <div key={key}><dt>{label(key)}</dt><dd>{value}</dd></div>)}
        </dl>
      )}
    </section>
  );
}

function Trend({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ period: string; count: number }>;
}) {
  return (
    <section>
      <h5>{title}</h5>
      {rows.length === 0 ? <p className="quiet">Sin datos en el rango.</p> : (
        <dl className="compact-list">
          {rows.map((item) => <div key={item.period}><dt>{item.period}</dt><dd>{item.count}</dd></div>)}
        </dl>
      )}
    </section>
  );
}

export function AdminStatsPanel() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [months, setMonths] = useState(6);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      setLoading(true);
      void fetchAdminStats(months)
        .then((value) => {
          if (active) {
            setStats(value);
            setError(null);
          }
        })
        .catch((reason) => {
          if (active) setError(reason instanceof Error ? reason.message : "No se pudieron cargar las estadísticas.");
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    });
    return () => {
      active = false;
    };
  }, [months]);

  if (error && !stats) return <div className="notice notice-error" role="alert">{error}</div>;
  if (!stats) return <p role="status">Cargando estadísticas…</p>;

  const completedExchanges = stats.exchanges.completed ?? 0;

  return (
    <section className="admin-module" aria-labelledby="stats-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Datos reales de la base</p>
          <h3 id="stats-title">Estadísticas</h3>
        </div>
        <label className="inline-select">Rango de tendencias
          <select value={months} onChange={(event) => setMonths(Number(event.target.value))} disabled={loading}>
            <option value={3}>3 meses</option>
            <option value={6}>6 meses</option>
            <option value={12}>12 meses</option>
          </select>
        </label>
      </div>
      {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
      <div className="notice">
        Cada indicador tiene una fuente distinta. “Total registrado” incluye todas las procedencias; “institucional”
        es un subconjunto. “Verificado” no significa habilitado, y el catálogo público es la vista elegible, no el
        inventario completo.
      </div>

      <h4>Inventario</h4>
      <div className="stats-grid">
        <StatCard label="Total registrado" value={stats.inventory.totalCopies} hint="Todas las procedencias" />
        <StatCard label="Institucional" value={stats.inventory.institutionalTotal} hint="Subconjunto del total" />
        <StatCard label="Disponibles" value={stats.inventory.available} hint="Institucional disponible" />
        <StatCard label="Reservados" value={stats.inventory.reserved} hint="Reserva activa" />
        <StatCard label="No disponibles" value={stats.inventory.unavailable} hint="Retenidos o bloqueados" />
        <StatCard label="Pendientes de verificación" value={stats.inventory.unverified} hint="Sin verified_at" />
        <StatCard label="Verificados" value={stats.inventory.verified} hint="No implica habilitación" />
        <StatCard label="Catálogo público" value={stats.inventory.publicCatalog} hint="Vista elegible" />
      </div>

      <div className="stats-grid">
        <StatCard label="Ofertas en revisión" value={stats.offersInReview} />
        <StatCard label="Intercambios completados" value={completedExchanges} />
        <StatCard label="Lotes importados" value={stats.batches.total ?? 0} />
        <StatCard label="Filas de lote procesadas" value={stats.batches.processed_rows ?? 0} />
        <StatCard label="Filas rechazadas" value={stats.batches.rejected_rows ?? 0} />
        <StatCard label="Lotes históricos" value={stats.legacyImport.batches ?? 0} hint="Importación 0006" />
        <StatCard label="Filas históricas procesadas" value={stats.legacyImport.processed_rows ?? 0} hint="Importación 0006" />
      </div>

      <div className="stats-columns">
        <Group title="Solicitudes" record={stats.requests} label={(key) => requestStatusLabel(key as RequestStatus)} />
        <Group title="Revisión fotográfica" record={stats.submissions} label={(key) => submissionStatusLabel(key as SubmissionStatus)} />
        <Group title="Recepciones" record={stats.receptions} label={(key) => receptionStatusLabel(key as ReceptionStatus)} />
        <Group title="Evaluaciones" record={stats.evaluations} label={(key) => key === "accepted" ? "Aceptadas" : key === "rejected" ? "Rechazadas" : key} />
        <Group title="Admisiones" record={stats.admissions} label={(key) => admissionStatusLabel(key as AdmissionStatus)} />
        <Group title="Intercambios" record={stats.exchanges} label={(key) => exchangeStatusLabel(key as ExchangeStatus)} />
      </div>

      <h4>Tendencias de los últimos {months} meses</h4>
      <div className="stats-columns">
        <Trend title="Solicitudes creadas por mes" rows={stats.trends.requests ?? []} />
        <Trend title="Intercambios completados por mes" rows={stats.trends.completedExchanges ?? []} />
        <Trend title="Lotes creados por mes" rows={stats.trends.batches ?? []} />
      </div>
    </section>
  );
}
