import { useEffect, useState } from "react";
import {
  assignAdminRole,
  createAdminAccount,
  fetchAdminAccounts,
  removeAdminRole,
  setAdminAccountActive,
} from "../lib/api";
import type { AdminAccountListItem, AdminAccountsView } from "../lib/types";

export function AccountsPanel() {
  const [view, setView] = useState<AdminAccountsView | null>(null);
  const [issuer, setIssuer] = useState("local");
  const [subject, setSubject] = useState("");
  const [email, setEmail] = useState("");
  const [roleSelection, setRoleSelection] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh(): Promise<void> {
    setView(await fetchAdminAccounts());
  }

  useEffect(() => {
    queueMicrotask(() => {
      void refresh().catch((reason) =>
        setError(reason instanceof Error ? reason.message : "No se pudieron cargar las cuentas."),
      );
    });
  }, []);

  async function run(action: () => Promise<unknown>, success: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action();
      setMessage(success);
      await refresh();
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo completar la operación.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submitCreate(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const created = await run(
      () => createAdminAccount({ identityIssuer: issuer, identitySubject: subject, email: email || undefined }),
      "Actor administrativo creado. El acceso debe configurarse en ADMIN_USERS o en el proveedor OIDC.",
    );
    if (created) {
      setSubject("");
      setEmail("");
    }
  }

  async function toggle(account: AdminAccountListItem): Promise<void> {
    if (!account.isActive) {
      await run(
        () => setAdminAccountActive(account.userId, true),
        `Cuenta ${account.identitySubject} activada.`,
      );
      return;
    }
    if (!window.confirm(`¿Desactivar la cuenta ${account.identitySubject}? La sesión dejará de tener permisos efectivos.`)) return;
    await run(
      () => setAdminAccountActive(account.userId, false),
      `Cuenta ${account.identitySubject} desactivada.`,
    );
  }

  async function assign(account: AdminAccountListItem): Promise<void> {
    const roleId = roleSelection[account.userId];
    if (!roleId) {
      setError("Selecciona un rol para asignar.");
      return;
    }
    await run(() => assignAdminRole(account.userId, roleId), "Rol asignado y auditado.");
  }

  async function remove(account: AdminAccountListItem, roleId: string, roleKey: string): Promise<void> {
    if (!window.confirm(`¿Retirar el rol ${roleKey} de ${account.identitySubject}?`)) return;
    await run(() => removeAdminRole(account.userId, roleId), "Rol retirado y auditado.");
  }

  if (error && !view) {
    return <div className="notice notice-error" role="alert">{error}</div>;
  }
  if (!view) return <p role="status">Cargando cuentas administrativas…</p>;

  return (
    <section className="admin-module" aria-labelledby="accounts-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Permisos y responsabilidades</p>
          <h3 id="accounts-title">Cuentas administrativas</h3>
        </div>
      </div>

      <div className="notice notice-warning">
        Trueque no almacena contraseñas. Las cuentas se gestionan desde el acceso administrativo y el inicio de sesión
        se configura en la configuración institucional.
      </div>
      {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
      {message ? <div className="notice notice-success" role="status">{message}</div> : null}

      <form className="account-form" onSubmit={(event) => void submitCreate(event)} aria-label="Registrar cuenta administrativa">
        <fieldset disabled={busy}>
          <legend>Registrar cuenta administrativa</legend>
          <label>Origen de identidad
            <input value={issuer} onChange={(event) => setIssuer(event.target.value)} maxLength={250} required />
          </label>
          <label>Identificador de acceso
            <input value={subject} onChange={(event) => setSubject(event.target.value)} minLength={3} maxLength={200} required />
          </label>
          <label>Correo de contacto (opcional)
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={320} />
          </label>
          <p className="field-help">La cuenta se crea sin permisos. Asigna un perfil después. No se crean contraseñas aquí.</p>
          <button className="button button-primary" type="submit">Registrar cuenta</button>
        </fieldset>
      </form>

      <div className="table-scroll">
        <table>
          <caption className="sr-only">Cuentas administrativas, estado y roles</caption>
          <thead>
            <tr>
              <th scope="col">Cuenta</th>
              <th scope="col">Estado</th>
              <th scope="col">Perfil</th>
              <th scope="col">Accesos</th>
              <th scope="col">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {view.accounts.map((account) => {
              const isCurrent = account.userId === view.currentActorUserId;
              const availableRoles = view.roles.filter(
                (role) => !account.roles.some((assigned) => assigned.roleId === role.roleId),
              );
              return (
                <tr key={account.userId}>
                  <td>
                    <strong>{account.identitySubject}</strong>
                    <br />
                    <span className="quiet">{account.identityIssuer ?? "sin emisor"}</span>
                    {account.email ? <><br /><span className="quiet">{account.email}</span></> : null}
                    {isCurrent ? <><br /><span className="status-pill">Sesión actual</span></> : null}
                  </td>
                  <td>{account.isActive ? "Activa" : "Inactiva"}</td>
                  <td>
                    {account.roles.length === 0 ? <span className="quiet">Sin roles</span> : (
                      <ul className="tag-list">
                        {account.roles.map((role) => (
                          <li key={role.roleId}>
                            <span className="status-pill">{role.displayName}</span>
                            {!isCurrent ? (
                              <button
                                className="link-button"
                                type="button"
                                disabled={busy}
                                onClick={() => void remove(account, role.roleId, role.roleKey)}
                              >
                                Retirar
                              </button>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td>
                    {account.permissions.length === 0 ? <span className="quiet">Ninguno</span> : (
                      <span className="quiet">{account.permissions.join(" · ")}</span>
                    )}
                  </td>
                  <td>
                    <div className="button-row">
                      <button
                        className="button button-secondary"
                        type="button"
                        disabled={busy || isCurrent}
                        onClick={() => void toggle(account)}
                      >
                        {account.isActive ? "Desactivar" : "Activar"}
                      </button>
                      {availableRoles.length > 0 && !isCurrent ? (
                        <>
                          <label className="inline-select">
                            <span className="sr-only">Rol para {account.identitySubject}</span>
                            <select
                              value={roleSelection[account.userId] ?? ""}
                              onChange={(event) => setRoleSelection({ ...roleSelection, [account.userId]: event.target.value })}
                              disabled={busy}
                            >
                              <option value="">Seleccionar rol</option>
                              {availableRoles.map((role) => (
                                <option key={role.roleId} value={role.roleId}>{role.displayName}</option>
                              ))}
                            </select>
                          </label>
                          <button className="button button-primary" type="button" disabled={busy} onClick={() => void assign(account)}>
                            Asignar
                          </button>
                        </>
                      ) : null}
                    </div>
                    {isCurrent ? <p className="field-help">Por seguridad, no puedes cambiar tus propios roles ni desactivar tu sesión.</p> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <section aria-labelledby="roles-title">
        <h4 id="roles-title">Roles disponibles</h4>
        {view.roles.length === 0 ? <p className="quiet">No hay roles configurados.</p> : (
          <ul className="role-list">
            {view.roles.map((role) => (
              <li key={role.roleId}>
                <strong>{role.displayName}</strong> <span className="quiet">({role.roleKey})</span>
                <p className="quiet">{role.description ?? "Sin descripción."}</p>
                <p className="quiet">{role.permissions.length > 0 ? role.permissions.join(" · ") : "Sin permisos."}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
