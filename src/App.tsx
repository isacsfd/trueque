import { useState } from "react";
import { AdminPanel } from "./components/AdminPanel";
import { Catalog } from "./components/Catalog";
import { MyRequest } from "./components/MyRequest";
import { RequestForm } from "./components/RequestForm";
import type { CatalogItem } from "./lib/types";

const steps = [
  {
    number: "01",
    title: "Explora",
    description: "Consulta los ejemplares revisados y habilitados para intercambio.",
  },
  {
    number: "02",
    title: "Presenta tu propuesta",
    description: "Registra el libro que deseas ofrecer y envía una solicitud para revisión.",
  },
  {
    number: "03",
    title: "Coordina el intercambio",
    description: "El equipo revisa, recibe y evalúa el libro antes de coordinar la entrega.",
  },
];

type View = "catalog" | "request" | "status" | "admin";

function App() {
  const [view, setView] = useState<View>("catalog");
  const [selected, setSelected] = useState<CatalogItem | null>(null);
  const [requestCode, setRequestCode] = useState("");
  const [requestAccessToken, setRequestAccessToken] = useState("");

  return (
    <div className="site-shell">
      <a className="skip-link" href="#contenido">Saltar al contenido</a>

      <header className="site-header">
        <a className="institution-name" href="#inicio" aria-label="Inicio" onClick={() => setView("catalog")}>
          <span>Institución Universitaria de Barranquilla</span>
          <span className="institution-service">Intercambio de libros</span>
        </a>

        <nav aria-label="Navegación principal">
          <button type="button" aria-current={view === "catalog" ? "page" : undefined} onClick={() => setView("catalog")}>Catálogo</button>
          <button type="button" aria-current={view === "status" ? "page" : undefined} onClick={() => setView("status")}>Mi solicitud</button>
          <button type="button" aria-current={view === "admin" ? "page" : undefined} onClick={() => setView("admin")}>Administración</button>
        </nav>
      </header>

      <main id="contenido">
        <section className="hero" id="inicio" aria-labelledby="hero-title">
          <div className="hero-copy">
            <p className="eyebrow"><span className="status-dot" aria-hidden="true" />Plataforma en preparación</p>
            <h1 id="hero-title">Intercambio de libros</h1>
            <p className="hero-description">
              Una iniciativa para conectar a la comunidad universitaria a través de los libros y promover su circulación responsable.
            </p>
            <div className="hero-actions">
              <button className="button button-primary" type="button" onClick={() => setView("catalog")}>Explorar el catálogo</button>
              <button className="button button-secondary" type="button" onClick={() => setView("status")}>Consultar mi solicitud</button>
            </div>
          </div>

          <aside className="hero-note" aria-label="Estado del servicio">
            <span className="note-label">Servicio institucional</span>
            <p>El catálogo muestra únicamente ejemplares habilitados. Las solicitudes pasan por revisión, recepción y evaluación antes de coordinar el intercambio.</p>
          </aside>
        </section>

        {view === "catalog" ? (
          <Catalog onSelect={(item) => { setSelected(item); setView("request"); }} />
        ) : null}

        {view === "request" ? (
          <RequestForm
            selected={selected}
            onBack={() => setView("catalog")}
            onCreated={({ requestCode: code, accessToken }) => {
              setRequestCode(code);
              setRequestAccessToken(accessToken);
            }}
          />
        ) : null}

        {view === "status" ? <MyRequest initialCode={requestCode} initialToken={requestAccessToken} /> : null}
        {view === "admin" ? <AdminPanel /> : null}

        {view === "catalog" ? (
          <section className="process-section section-block" id="como-funciona" aria-labelledby="process-title">
            <div className="section-heading section-heading-compact">
              <div>
                <p className="eyebrow">Un proceso claro y cuidadoso</p>
                <h2 id="process-title">Así funciona</h2>
              </div>
              <p className="section-intro">Cada libro ofrecido pasa por recepción y evaluación antes de formar parte del catálogo. El ejemplar ofrecido no se habilita hasta cerrar válidamente el intercambio.</p>
            </div>
            <ol className="steps-list">
              {steps.map((step) => (
                <li className="step-card" key={step.number}>
                  <span className="step-number">{step.number}</span>
                  <h3>{step.title}</h3>
                  <p>{step.description}</p>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
      </main>

      <footer className="site-footer">
        <p>Institución Universitaria de Barranquilla</p>
        <p>Intercambio responsable de libros. Los estados y permisos se validan en el servidor.</p>
      </footer>
    </div>
  );
}

export default App;
