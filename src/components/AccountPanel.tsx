import { useEffect, useState } from "react";
import { fetchAdminAccount } from "../lib/api";
import type { AdminAccount } from "../lib/types";

export function AccountPanel() {
  const [account, setAccount] = useState<AdminAccount | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    queueMicrotask(() => {
      void fetchAdminAccount()
        .then(setAccount)
        .catch((reason) => setError(reason instanceof Error ? reason.message : "No se pudo cargar la cuenta."));
    });
  }, []);

  if (!account) {
    return error ? <div className="notice notice-error" role="alert">{error}</div> : <p role="status">Cargando cuenta…</p>;
  }

  return (
    <section className="admin-module" aria-labelledby="account-title">
      <div className="section-heading"><div><p className="eyebrow">Seguridad</p><h3 id="account-title">Mi cuenta</h3></div></div>
      {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
      <dl className="status-grid">
        <div><dt>Usuario</dt><dd>{account.username}</dd></div>
        <div><dt>Identificador de cuenta</dt><dd>{account.actorUserId}</dd></div>
        <div><dt>Sesión expira</dt><dd>{new Date(account.expiresAt).toLocaleString()}</dd></div>
        <div><dt>Acceso</dt><dd>Configuración institucional</dd></div>
      </dl>
      <div className="notice notice-warning">
        La contraseña se gestiona desde la configuración institucional de acceso. Trueque no almacena contraseñas.
      </div>
      <p className="field-help">
        La rotación de contraseña se realiza desde la configuración institucional de acceso.
      </p>
    </section>
  );
}
