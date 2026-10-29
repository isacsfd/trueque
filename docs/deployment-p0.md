# Despliegue y rollback — Fase 4 + inventario (`0004`-`0006`)

## Estado

- `0004_p0_integrity.sql` y `0005_participant_api.sql` están implementadas y probadas en PostgreSQL 17.11 desechable y en el staging real con PostgreSQL 18.6.
- La API y el frontend integran el catálogo, el alta de solicitudes, la revisión administrativa, la recepción, la evaluación, la admisión, el handover y la cancelación en dos pasos.
- Staging está desplegado en Neon y Netlify: https://trueque-staging-2026.netlify.app.
- Producción permanece intacta; no se conectó ni modificó.
- No se usaron credenciales de producción.
- `0001`, `0002` y `0003` no se modificaron.

> **Actualización P0/fotografías/lotes/cuentas (solo local):** `0006`-`0011` existen y están
> aplicadas únicamente en PostgreSQL local/desechable. Staging sigue documentado
> con `0001`–`0005`. La contención se planifica en
> `docs/inventario/plan-despliegue-contencion.md`; la evaluación fotográfica y
> su almacenamiento en `docs/inventario/evaluacion-fotografica.md`. La gestión de
> lotes está en `docs/inventario/gestion-lotes-inventario.md`. Este documento
> conserva el historial de la fase anterior. `0009`, `0010` y `0011` no son contención:
> no deben aplicarse como parte de la autorización A sin una decisión separada.

## Artefactos y checksums

Comando: `npm run db:migrate:plan` (no abre conexión).

| Migración | SHA-256 canónico |
| --- | --- |
| `0001_initial_schema` | `cf4b22182eb763005f67ff56d03cc3726b95b2800813ccb443cfa363fc0a0a6a` |
| `0002_corrective_schema` | `251ebb6946a06783afb3891006e7b146f04f7af866c5d49460bc796b401a688c` |
| `0003_runtime_privileges` | `7bfbb4ad542bce617b1f186b0995d9768469bf28501bbe32afb9c8be63c65c67` |
| `0004_p0_integrity` | `365c1346d481d9287666b384dd928e58367df870890190fe0d968229bc81fd87` |
| `0005_participant_api` | `156be0a75a0c93d783964dd4131f76cfc190c99c6a37c66210849c384baf8b66` |
| `0006_inventory_import` | `f9339387e9bf0ff6d5dc4be92763cb6e1cba2232a226a76bd2b916ba3e1e230e` |

El checksum es SHA-256 del SQL canónico (UTF-8 sin BOM, LF). `.gitattributes` fija `eol=lf`.

`0006_inventory_import` se aplicó únicamente en PostgreSQL local para la importación del inventario; **no** está aplicado en Neon staging ni en producción.

## Requisitos previos

1. Los tres roles existen con login separado: `iub_schema_migrator`, `iub_public_runtime`, `iub_admin_runtime`.
2. Los tres son `NOINHERIT`, sin `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `REPLICATION` ni `BYPASSRLS`.
3. Ningún rol runtime tiene membresías; el migrator no pertenece a roles privilegiados.
4. El esquema `public` está vacío y no existe `public.schema_migrations` (bootstrap).
5. El migrator tiene `USAGE, CREATE` en `public` y es propietario de los objetos que creará.
6. Existe un snapshot o rama Neon de restauración, con identificador registrado fuera del repositorio.
7. Variables privadas de migración/functions:
   - `DATABASE_URL` → `iub_public_runtime`
   - `DATABASE_ADMIN_URL` → `iub_admin_runtime`
   - `DATABASE_MIGRATION_URL` → `iub_schema_migrator`
   - `DATABASE_MIGRATION_ROLE=iub_schema_migrator`
   - `DATABASE_MIGRATION_DRIVER=neon` (usar `pg` solo en PostgreSQL local/desechable)
8. Variables privadas de la API (nunca `VITE_*`):
   - `ADMIN_USERS` (JSON con username, passwordHash scrypt y actorUserId)
   - `SESSION_SECRET` (≥32 bytes)
   - `PARTICIPANT_DATA_KEY` y `PARTICIPANT_IDENTITY_HMAC_KEY` (base64 de 32 bytes)
   - `PARTICIPANT_DATA_KEY_VERSION`, `PARTICIPANT_HMAC_KEY_VERSION`
   - `PRIVACY_NOTICE_VERSION`
9. La fila de `privacy_notices` con esa versión debe existir antes de aceptar solicitudes. La API falla cerrada si no existe.

## Puerta de pruebas antes de aplicar

```sh
npm ci
npm test
npm run lint
npm run build
npm audit --audit-level=low
npm run db:migrate:plan
```

Resultados reales de esta fase:

- `npm test`: **66 pruebas** en 15 archivos; las 2 pruebas de integración API/PostgreSQL quedan *skip* sin `IUB_TEST_DATABASE_URL`.
- `npx vitest run netlify/tests/api-postgres.test.ts` con PostgreSQL real: **2/2** flujos completos (ciclo exitoso y cancelación con devolución).
- `npm run lint`: sin errores.
- `npm run build`: correcto.
- `npm audit --audit-level=low`: 0 vulnerabilidades.
- `db:migrate:plan`: seis hashes, sin abrir conexión.
- `npm run test:postgres`: **13 escenarios**, todos en verde en PostgreSQL 17.11.
- Runner real con `DATABASE_MIGRATION_DRIVER=pg`: aplicó `0001`–`0005` en una transacción y la segunda ejecución respondió `Database schema is up to date`.
- Rollback real de `0005`: `create_exchange_request` y `get_request_status` quedaron `NULL`.
- Rollback real de `0004`: tabla/columnas/función revertidas.

### PostgreSQL real

`npm run test:postgres` requiere `IUB_TEST_DATABASE_URL` apuntando a una base desechable ya migrada con `0001`–`0005`. No usar Neon de producción.

Salida comprobada:

```text
ok - cancellation before physical receipt
ok - cancellation after custody requires confirmed return and creates no admission
ok - accepted cancellation requires return, reverses transfer and retires offered copy
ok - concurrent reservations serialize to one active hold
ok - expiry and reservation keep one active hold
ok - cancel/reserve race leaves no active hold
ok - confirmed institutional handover blocks cancellation
ok - completion releases offered copy only at the valid close
ok - concurrent cancellations serialize without deadlock
ok - rejected reception returns physically without admission
ok - independent session blocks on the copy lock
ok - participant intake is atomic and idempotent
ok - runtime permissions remain least-privilege
all PostgreSQL P0 tests passed
```

## API integrada

Rutas Netlify:

- `GET /api/catalog` — catálogo público desde `available_catalog`.
- `POST /api/requests` — alta atómica mediante `create_exchange_request`; devuelve código y token opaco una sola vez.
- `POST /api/requests/reserve` — reserva mediante `reserve_copy`; exige el token opaco.
- `POST /api/requests/status` — estado mediante `get_request_status`; el token va en el cuerpo, nunca en la URL.
- `POST /api/admin/session` — login con cookie `HttpOnly`, `SameSite=Strict`, `Secure` en HTTPS.
- `DELETE /api/admin/session` — logout; exige cabecera `X-IUB-Admin`.
- `GET /api/admin/workbench` — solicitudes y estados sin datos personales.
- `POST /api/admin/action` — allowlist cerrada de acciones; el actor y los permisos se validan en PostgreSQL.

El frontend público incluye catálogo, formulario de solicitud con consentimiento, reserva y consulta de estado. El panel administrativo muestra estados, permisos y acciones contextuales; no permite escribir transiciones directamente ni recibe datos personales.

## Procedimiento de aplicación

1. **Congelar cambios de esquema** y confirmar el snapshot/rama de restauración.
2. **Revisar el plan** con `npm run db:migrate:plan`; comparar los cinco hashes.
3. **Confirmar roles**:
   ```sql
   SELECT current_user, rolinherit, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
   FROM pg_roles WHERE rolname = current_user;
   ```
4. **Aplicar**:
   ```sh
   npm run db:migrate:apply
   ```
   El runner abre una transacción, toma un advisory lock, aplica `0001`–`0005`, valida roles/privilegios/manifiesto y hace `ROLLBACK` completo ante cualquier error.
5. **Verificar ledger**:
   ```sql
   SELECT version, checksum FROM public.schema_migrations ORDER BY version;
   ```
   Deben aparecer exactamente `0001`–`0005`.
6. **Verificar manifiesto**:
   ```sql
   SELECT count(*) FROM public.schema_object_manifest;
   ```
   Una segunda ejecución debe responder `Database schema is up to date`.
7. **Verificar constraints, triggers y tablas**:
   ```sql
   SELECT conname FROM pg_constraint
   WHERE conname IN ('exchange_requests_status_check','exchanges_status_check',
     'receptions_status_check','inventory_admissions_status_check','inventory_admissions_reversed_ck')
   ORDER BY conname;

   SELECT tgname FROM pg_trigger
   WHERE tgname IN ('inventory_admissions_request_guard','ownership_transfers_request_guard',
     'copies_exchange_received_availability_guard','ownership_transfer_reversals_immutable')
   ORDER BY tgname;

   SELECT to_regclass('public.ownership_transfer_reversals');
   SELECT to_regprocedure('public.create_exchange_request(text,jsonb,uuid)');
   SELECT to_regprocedure('public.get_request_status(text,bytea)');
   ```
8. **Verificar permisos efectivos**:
   ```sql
   SELECT
     has_table_privilege('iub_admin_runtime','public.copies','UPDATE') AS admin_update,
     has_table_privilege('iub_public_runtime','public.copies','SELECT') AS public_reads_copies,
     has_function_privilege('iub_admin_runtime','public.iub_lock_request(bigint)','EXECUTE') AS admin_locks,
     has_function_privilege('iub_public_runtime','public.create_exchange_request(text,jsonb,uuid)','EXECUTE') AS public_intake,
     has_table_privilege('iub_admin_runtime','public.ownership_transfer_reversals','SELECT') AS admin_reads_reversals;
   ```
   Esperado: `false, false, false, true, true`.
9. **Smoke test en staging**:
   - catálogo con un ejemplar habilitado;
   - alta de solicitud y reserva con token;
   - revisión, aprobación y planificación;
   - entrega/recepción/custodia;
   - evaluación, catalogación, admisión y habilitación;
   - handover y cierre;
   - cancelación antes de recepción;
   - cancelación con devolución pendiente, confirmación de devolución y cierre;
   - intento de cancelar tras handover: debe fallar.

## Gestión de usuarios administrativos

El panel usa `ADMIN_USERS` (JSON privado). Cada entrada enlaza un usuario de sesión con un `actorUserId` de PostgreSQL, cuyos permisos se validan con `assert_actor_permission`.

```sh
printf '%s\n' 'una-contraseña-larga' | npm run admin:hash-password
```

El resultado es `scrypt$<salt>$<hash>`. Se coloca solo en la variable privada de Netlify, nunca en el repositorio, el frontend ni los logs.

Para separar catalogación y autorización se necesitan dos actores con permisos distintos (`cataloging.validate` y `cataloging.authorize`), tal como exige la rutina.

## Cambios operativos que la aplicación asume

- `exchange_requests.status` y `exchanges.status` pueden ser `cancellation_pending`.
- `receptions.status` puede ser `cancelled`.
- `inventory_admissions.status` puede ser `reversed`.
- `enable_received_copy` **no** pone el ejemplar en `available`; solo `complete_exchange` lo hace.
- La cancelación con libro físicamente recibido es en dos pasos:
  1. `cancel_exchange` deja `cancellation_pending` y crea/usa una entrega `offered_book_return`.
  2. Tras `confirm_delivery`, se repite `cancel_exchange` con la misma clave para cerrar y, si hubo aceptación, registrar la reversión.
- Una segunda llamada antes de confirmar la devolución devuelve `55000`.
- No se cancela un intercambio con handover confirmado ni completado.
- El token de participante se devuelve una sola vez y no se guarda en claro en PostgreSQL.

## Rollback operativo

### Fallo antes del commit

El runner hace `ROLLBACK` completo. Verificar que no existan filas nuevas en `schema_migrations` ni objetos de `0004`/`0005`; corregir y repetir.

### Fallo después del commit

`0004` y `0005` son aditivas y forward-only. **No ejecutar `DROP TABLE`, `DROP COLUMN` ni borrados de historial en producción.**

Opciones:

1. Restaurar el snapshot/rama Neon previo y revertir el despliegue de la aplicación.
2. Forward-fix con una migración nueva revisada (`0012+`). El ledger conserva las filas aplicadas; no reintentar ni borrar sus filas.
3. Si el problema es solo de aplicación, mantener el esquema y desplegar la corrección de la API.

### Rollback en base desechable

Recrear la base o ejecutar `BEGIN … ROLLBACK` con la migración correspondiente. El contenedor se elimina con:

```sh
docker rm -f iub-pg-test
```

## Bloqueos pendientes

- **Staging desplegado:** Neon `trueque-staging-2026` y Netlify `trueque-staging-2026` están operativos. No hay bloqueo de despliegue de staging.
- **Producción:** no se ha creado ni aplicado nada; requiere un entorno/snapshot autorizado y repetir la puerta de pruebas.
- La autenticación administrativa es una sesión de staging con `ADMIN_USERS`; el proveedor OIDC institucional sigue pendiente para producción.
- El almacenamiento de fotografías/evidencias no está implementado; no se aceptan imágenes en esta fase.
- El smoke test de staging se ejecutó contra el draft y la URL principal; cubre flujo completo y cancelación con devolución.
