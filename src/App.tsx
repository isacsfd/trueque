const steps = [
  {
    number: "01",
    title: "Explora",
    description:
      "Consulta los ejemplares que hayan sido revisados y habilitados para intercambio.",
  },
  {
    number: "02",
    title: "Presenta tu propuesta",
    description:
      "Registra el libro que deseas ofrecer y envía una solicitud para revisión.",
  },
  {
    number: "03",
    title: "Coordina el intercambio",
    description:
      "Cuando el proceso esté habilitado, el equipo coordinará los siguientes pasos.",
  },
];

function App() {
  return (
    <div className="site-shell">
      <a className="skip-link" href="#contenido">
        Saltar al contenido
      </a>

      <header className="site-header">
        <a className="institution-name" href="#inicio" aria-label="Inicio">
          <span>Institución Universitaria de Barranquilla</span>
          <span className="institution-service">Intercambio de libros</span>
        </a>

        <nav aria-label="Navegación principal">
          <a href="#catalogo">Catálogo</a>
          <a href="#como-funciona">Cómo funciona</a>
        </nav>
      </header>

      <main id="contenido">
        <section className="hero" id="inicio" aria-labelledby="hero-title">
          <div className="hero-copy">
            <p className="eyebrow">
              <span className="status-dot" aria-hidden="true" />
              Plataforma en preparación
            </p>
            <h1 id="hero-title">Intercambio de libros</h1>
            <p className="hero-description">
              Una iniciativa para conectar a la comunidad universitaria a
              través de los libros y promover su circulación responsable.
            </p>
            <div className="hero-actions">
              <a className="button button-primary" href="#catalogo">
                Explorar el catálogo
              </a>
              <a className="button button-secondary" href="#como-funciona">
                Conocer el proceso
              </a>
            </div>
          </div>

          <aside className="hero-note" aria-label="Estado del servicio">
            <span className="note-label">Servicio institucional</span>
            <p>
              El catálogo y las solicitudes estarán disponibles cuando se
              complete la configuración y validación del sistema.
            </p>
          </aside>
        </section>

        <section
          className="catalog-section section-block"
          id="catalogo"
          aria-labelledby="catalog-title"
        >
          <div className="section-heading">
            <div>
              <p className="eyebrow">Encuentra tu próxima lectura</p>
              <h2 id="catalog-title">Catálogo de libros</h2>
            </div>
            <span className="catalog-tag">Disponibilidad por confirmar</span>
          </div>

          <div className="empty-state" role="status" aria-live="polite">
            <span className="empty-state-mark" aria-hidden="true">
              —
            </span>
            <h3>Catálogo en preparación</h3>
            <p>
              Aquí se mostrarán únicamente los ejemplares habilitados
              formalmente para intercambio. Aún no hay libros publicados.
            </p>
          </div>
        </section>

        <section
          className="process-section section-block"
          id="como-funciona"
          aria-labelledby="process-title"
        >
          <div className="section-heading section-heading-compact">
            <div>
              <p className="eyebrow">Un proceso claro y cuidadoso</p>
              <h2 id="process-title">Así funcionará</h2>
            </div>
            <p className="section-intro">
              Cada libro ofrecido pasará por recepción y evaluación antes de
              poder formar parte del catálogo.
            </p>
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
      </main>

      <footer className="site-footer">
        <p>Institución Universitaria de Barranquilla</p>
        <p>Propuesta visual inicial para el intercambio responsable de libros.</p>
      </footer>
    </div>
  );
}

export default App;
