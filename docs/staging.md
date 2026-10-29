# Staging — Trueque

> **Actualización P0/fotografías (2026-10-29):** staging sigue en `0001`–`0005`.
> Las migraciones `0006`-`0011` están pendientes y no se aplicaron. `0009` es la
> evaluación fotográfica y no forma parte de la contención; no ejecutar
> `db:migrate:apply` sin autorización y preflight. Ver
> `docs/inventario/plan-despliegue-contencion.md` y
> `docs/inventario/evaluacion-fotografica.md`.

## Estado real

Staging desplegado y probado:

- **Frontend:** https://trueque-staging-2026.netlify.app
- **Netlify project:** `trueque-staging-2026` (`03cb4fd6-5289-4fe4-9379-9a7806ab1ea9`)
- **Neon project:** `trueque-staging-2026` (`withered-dream-91939533`), región São Paulo, PostgreSQL 18.6
- **Base:** `trueque_staging`, rama `production`
- **Restauración:** rama Neon `staging-restore-2026-10-28` creada desde `production` después de la migración.
- **Ledger:** `0001`–`0005` aplicadas; segunda ejecución idempotente.
- **Manifiesto:** 283 objetos.
- **Funciones Netlify:** 8 desplegadas (`catalog`, `requests`, `requests-reserve`, `requests-status`, `admin-session`, `admin-workbench`, `admin-action`, `database-diagnostics`).
- **Producción:** intacta; no se conectó ni modificó.

La visibilidad del proyecto se cambió a pública para permitir smoke tests sin login de equipo. Solo contiene datos sintéticos.

**Nota de seguridad:** una importación inicial de variables mostró valores en la salida del CLI. Se rotaron las contraseñas de los tres roles, `SESSION_SECRET`, las claves de participante, el token de diagnóstico y las contraseñas administrativas; Netlify se actualizó y el login se verificó de nuevo. Los valores anteriores ya no son válidos.

## Roles y datos de staging

- `iub_schema_migrator`, `iub_public_runtime`, `iub_admin_runtime`: `NOINHERIT`, sin superusuario/DDL/RLS bypass.
- Neon concede automáticamente al propietario del proyecto membresía sobre los roles nuevos. El runner permite únicamente esa membresía del `datdba`; cualquier otro rol que reciba un rol runtime sigue siendo rechazado.
- Actores: `staging-manager` y `staging-authorizer`, con permisos separados de catalogación.
- Para la evaluación fotográfica, asignar `offered_books.review` a los revisores y `requests.review` a quien aprueba la solicitud. No se crean roles por defecto.
- El almacenamiento local de evidencias y lotes no es válido en Netlify. La aplicación falla de forma cerrada en Functions si no hay un driver privado aprobado. Antes de habilitar cargas se requiere cuenta, bucket y credenciales aprobadas (D-13) y un adaptador real; ver `docs/inventario/almacenamiento-privado.md`.
- Asignar `inventory.batches.import`, `inventory.batches.confirm`, `inventory.batches.read`, `stats.read` y `account.manage` con separación de funciones; no concederlos al rol público.
- Las credenciales de acceso están en un archivo local fuera del repositorio: `%USERPROFILE%\trueque-staging-admin.txt`.
- Aviso de privacidad sintético: `staging-2026-10`. No usar en producción.
- Política de reservas configurada en 3600 segundos.
- Las contraseñas, claves y tokens están solo en variables privadas de Netlify y archivos temporales fuera del repositorio.

## Puerta local

- `npm test`: 66 pruebas + 2 integraciones API/PostgreSQL omitidas sin `IUB_TEST_DATABASE_URL`.
- `npm run test:postgres`: 13/13.
- Integración API↔PostgreSQL real: 2/2.
- Runner con driver `pg`: `0001`–`0005` y segunda ejecución idempotente.
- `npm run lint`, `npm run build` y `npm audit`: correctos.

## Smoke tests reales ejecutados

Contra `https://trueque-staging-2026.netlify.app`:

1. Catálogo público con dos ejemplares sintéticos.
2. Alta de solicitud y reserva.
3. Consulta de estado con token.
4. Login administrativo.
5. Revisión, aprobación y planificación.
6. Programación y confirmación de entrega.
7. Custodia, evaluación y catalogación.
8. Autorización de catalogación con el segundo actor.
9. Autorización, admisión y habilitación del ejemplar.
10. Handover y cierre.
11. Verificación de ejemplar ofrecido `available` y ejemplar institucional `retired`.
12. Cancelación con devolución física: `cancellation_pending` → devolución confirmada → `cancelled`, sin admisión.
13. Restricciones: acción administrativa sin sesión devuelve 403; catálogo/workbench no exponen nombre/correo.

## Variables privadas de Netlify

Configuradas en el proyecto `trueque-staging-2026`:

- `DATABASE_URL`, `DATABASE_ADMIN_URL`
- `ADMIN_USERS`
- `SESSION_SECRET`
- `PARTICIPANT_DATA_KEY`, `PARTICIPANT_IDENTITY_HMAC_KEY`
- `PARTICIPANT_DATA_KEY_VERSION`, `PARTICIPANT_HMAC_KEY_VERSION`
- `PRIVACY_NOTICE_VERSION`
- `DATABASE_DIAGNOSTICS_TOKEN`
- `ALLOW_LEGACY_REQUEST_INTAKE` (por defecto `false`; no habilitar el alta heredada sin aprobación)
- `PRIVATE_STORAGE_DRIVER` (obligatoria para `staging:check`; `local` y `simulated` se rechazan en staging), `EVIDENCE_STORAGE_DIR`, `BATCH_STORAGE_DIR` (solo desarrollo y pruebas; no son almacenamiento persistente de Netlify)
- `STORAGE_ORPHAN_GRACE_DAYS`, `EVIDENCE_RETENTION_DAYS`, `BATCH_RETENTION_DAYS` (retención; `0` = sin borrado automático mientras D-14/D-16 estén pendientes)
- `LOGIN_RATE_LIMIT_WINDOW_SECONDS`, `LOGIN_RATE_LIMIT_MAX_ATTEMPTS`, `LOGIN_RATE_LIMIT_IP_MAX_ATTEMPTS` (mitigación local best-effort; el límite distribuido requiere borde/WAF o proveedor)

`DATABASE_MIGRATION_URL` no está en Functions; solo se usó desde la sesión de migración.

## Requisitos para un entorno nuevo

1. Crear un proyecto/rama Neon separado y un snapshot de restauración.
2. Crear los tres roles con login separado y `NOINHERIT`.
3. Configurar las URLs privadas y el driver `neon`.
4. Insertar el aviso de privacidad aprobado.
5. Crear los actores administrativos y sus permisos; generar hashes con `npm run admin:hash-password`.
6. Configurar `reservation_policy` con `set_reservation_policy` (la ausencia bloquea `reserve_copy` con `55000`).
7. Ejecutar `npm run staging:check`.
8. Ejecutar `npm run db:migrate:apply` y repetirlo.
9. Configurar variables de Netlify y desplegar.
10. Ejecutar los smoke tests de esta página.

## Bloqueos y pendientes

- OIDC institucional no implementado; la sesión `ADMIN_USERS` es una solución de staging.
- No hay almacenamiento privado de imágenes/evidencias; no se aceptan fotografías.
- El proyecto staging es público y contiene solo datos sintéticos.
- Producción no se ha tocado; cualquier promoción requiere un entorno/snapshot autorizado y repetir la puerta de pruebas.
