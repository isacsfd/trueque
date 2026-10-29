# Intercambio de libros — IUB

Aplicación institucional para facilitar el intercambio de libros. La base frontend corresponde a la **Fase 1**; el modelo de la **Fase 2**, las correcciones P0 y la integración funcional de la **Fase 4** están implementados y probados. El catálogo, las solicitudes y la administración están desplegados en staging; producción sigue pendiente.

## Requisitos locales

- Node.js 22 o superior.
- npm.

## Desarrollo

Staging desplegado: **https://trueque-staging-2026.netlify.app** (Neon y Netlify separados de producción; datos sintéticos).

```sh
npm install
npm run dev
```

Comprobaciones disponibles:

```sh
npm run lint
npm test
npm run build
```

## Neon y Netlify Functions

El acceso a datos reutilizable usa `@neondatabase/serverless` con el driver HTTP sin estado, apropiado para consultas desde funciones serverless. La función de diagnóstico está en `GET /api/private/database-diagnostics`; requiere `Authorization: Bearer <token>` y devuelve únicamente `{ "ok": true }` o un error genérico. Falla cerrada si no se configura un token de al menos 32 bytes.

Variables de servidor documentadas en [`.env.example`](.env.example):

| Variable | Dónde configurarla | Uso |
| --- | --- | --- |
| `DATABASE_URL` | Netlify: **Site configuration → Environment variables**, alcance de Functions; local en `.env` ignorado por Git | URL pooled con rol `iub_public_runtime`; catálogo y reservas limitadas |
| `DATABASE_ADMIN_URL` | La misma ubicación privada, solo Functions administrativas | URL pooled con rol distinto `iub_admin_runtime` |
| `DATABASE_DIAGNOSTICS_TOKEN` | Netlify, alcance de Functions; local en `.env` ignorado por Git | Token aleatorio de 32 bytes o más para el endpoint privado |
| `DATABASE_MIGRATION_URL` | Entorno local protegido o tarea de migración protegida; **no** en las Functions de Netlify | URL directa separada para el rol migrador |
| `DATABASE_MIGRATION_ROLE` | Entorno protegido que ejecute migraciones | Nombre esperado del rol; el runner lo compara con `current_user` |

Introduce las credenciales en la configuración privada de Netlify indicada o en un `.env` local no versionado. No uses prefijo `VITE_`, no las pongas en `netlify.toml` y no las añadas a `.env.example`. La cadena Neon compartida durante la configuración debe rotarse antes de utilizarla como credencial de aplicación.

La conexión directa a Neon se comprobó en una fase anterior con una consulta de solo lectura y sin consultar filas de la aplicación. En la fase de corrección actual no se hizo ninguna conexión ni se configuraron variables en Netlify.

## Migraciones

`npm run db:schema:inspect` consulta únicamente metadatos y necesita `DATABASE_URL` en el entorno del proceso. `npm run db:migrate:plan` calcula checksums sin abrir una conexión. Las migraciones `db/migrations/0001_initial_schema.sql`, `0002_corrective_schema.sql`, `0003_runtime_privileges.sql`, `0004_p0_integrity.sql` y `0005_participant_api.sql` se han ejecutado �nicamente en staging; producci�n permanece intacta. Tras revisión y aprobación, `npm run db:migrate:apply` exige `DATABASE_URL`, `DATABASE_ADMIN_URL`, `DATABASE_MIGRATION_URL` y `DATABASE_MIGRATION_ROLE`; valida separación de usuarios/endpoint, privilegios efectivos, membresías, ledger y manifiesto, y aplica dentro de una transacción. Nunca se ejecuta desde `npm run build` ni desde el despliegue.

Las pruebas de esquema y flujo usan PGlite (PostgreSQL embebido). `npm run test:postgres` ejecuta las pruebas de concurrencia, bloqueos, permisos y transacciones sobre una base PostgreSQL desechable; no se ejecuta sin `IUB_TEST_DATABASE_URL`. La integración API↔PostgreSQL se ejecuta con `npx vitest run netlify/tests/api-postgres.test.ts` y la misma variable. El procedimiento de despliegue y rollback está en [`docs/deployment-p0.md`](docs/deployment-p0.md); la preparación de staging, en [`docs/staging.md`](docs/staging.md).

La API expone catálogo, alta de solicitud, reserva y consulta de estado, además del panel administrativo con allowlist de acciones. Las rutas y reglas están en [`netlify/functions/README.md`](netlify/functions/README.md).

## Administración de cuentas y permisos

El panel administrativo incluye solicitudes, lotes, estadísticas, cuentas y “Mi cuenta”. La autenticación usa `ADMIN_USERS`/`SESSION_SECRET`; Trueque no almacena contraseñas y revalida en PostgreSQL que el actor siga activo antes de emitir o continuar una sesión administrativa. La pantalla de cuentas preaprovisiona actores de PostgreSQL, activa/desactiva cuentas y asigna roles con `account.manage`, protección de la última cuenta administradora y auditoría. El inicio de sesión debe configurarse en `ADMIN_USERS` o en el futuro proveedor OIDC. Los detalles, límites y reglas de aprobación de solicitudes están en [`docs/administracion-cuentas.md`](docs/administracion-cuentas.md).

## Auditoría y aceptación

El cierre técnico, la matriz de aceptación administrativa, el plan de preparación de staging, el flujo público sin registro, las cuentas locales SP/AD y el resumen ejecutivo están en [`docs/auditoria/`](docs/auditoria/). La validación real se ejecutó únicamente en un PostgreSQL local desechable; no se conectó Neon ni se desplegó. Los dos Excel fuente y sus hashes están en [`docs/inventario/fuentes-datos.md`](docs/inventario/fuentes-datos.md).

## Almacenamiento privado

Las evidencias fotográficas y los Excel de lotes usan la interfaz `EvidenceStorage` y claves opacas; nunca se sirven desde un bucket público ni desde `dist`. `PRIVATE_STORAGE_DRIVER=local` y `simulated` son solo para desarrollo y pruebas. En Netlify Functions la aplicación falla de forma cerrada si no hay un adaptador privado aprobado: no escribe en el filesystem efímero. La comparación R2/S3/GCS/Netlify Blobs, la retención, los riesgos pendientes de EXIF/antimalware y las decisiones D-13–D-16 están en [`docs/inventario/almacenamiento-privado.md`](docs/inventario/almacenamiento-privado.md).

El orden de validación en una base desechable y la preparación posterior para producción están en [`docs/migration-test-plan.md`](docs/migration-test-plan.md).

## Estructura prevista

```text
src/                    Aplicación React y estilos
netlify/functions/      API backend ejecutada por Netlify Functions
db/migrations/          Migraciones SQL versionadas y revisables
docs/                   Arquitectura y decisiones del proyecto
```

La arquitectura, los límites de seguridad y las decisiones pendientes están descritos en [`docs/arquitectura.md`](docs/arquitectura.md). La conexión y el lugar para introducir las variables están detallados en [`docs/database-access.md`](docs/database-access.md). El esquema base sin modificar está en [`db/migrations/0001_initial_schema.sql`](db/migrations/0001_initial_schema.sql), las correcciones aditivas en [`db/migrations/0002_corrective_schema.sql`](db/migrations/0002_corrective_schema.sql), los privilegios en [`db/migrations/0003_runtime_privileges.sql`](db/migrations/0003_runtime_privileges.sql), la integridad P0 en [`db/migrations/0004_p0_integrity.sql`](db/migrations/0004_p0_integrity.sql) y la API de intake en [`db/migrations/0005_participant_api.sql`](db/migrations/0005_participant_api.sql) y la importaci�n de inventario en [`db/migrations/0006_inventory_import.sql`](db/migrations/0006_inventory_import.sql); todo requiere revisión antes de aplicarse.

## Seguridad y despliegue

- No hay secretos ni datos institucionales en el repositorio.
- La conexión Neon se verificó mediante `SELECT 1` y lectura de metadatos; las funciones aún requieren variables privadas para usarla.
- No se han aplicado migraciones ni desplegado el sitio.
- El logo oficial no se incluye porque todavía no se ha proporcionado un archivo autorizado. La interfaz usa texto institucional, no un logo sustituto.
- Los colores de la interfaz son la propuesta inicial indicada por el solicitante; no se presentan como códigos oficiales verificados.

La configuración real de Neon, autenticación, almacenamiento de fotografías y Netlify se definirá y probará en sus fases correspondientes antes de cualquier despliegue.
