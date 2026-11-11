# Staging — Trueque

> **Reconstrucción de staging (2026-11-11):** la rama `production` del proyecto
> Neon `trueque-staging-2026` tenía ~90 objetos aplicados manualmente fuera del
> ledger (contenido de `0006`–`0023` sin registro); el runner la rechazó por
> diseño y la transacción se revirtió sin cambios. La ruta elegida fue un
> bootstrap completo en una base nueva `trueque_staging_v2` (mismo proyecto/rama
> Neon), con roles existentes y siembra mínima. Punto de restauración previo:
> rama Neon `staging-restore-2026-11-11` (`br-holy-pond-b60wncnx`, creada desde
> `production` antes de cualquier cambio, auto-delete `Never`).
>
> Estado validado de `trueque_staging_v2`:
>
> - Ledger exacto `0001`–`0026` con checksums canónicos; segunda ejecución del
>   runner idempotente.
> - Manifiesto: 463 objetos.
> - `reservation_policy` configurada con `set_reservation_policy(172800, …)`.
> - Catálogo sembrado con ejemplares sintéticos (`preexisting`).
> - Anomalías reales en cero.
>
> Smoke tests reales contra el deploy borrador de Netlify
> (`https://6af47dbf07188b85af9fa683--trueque-staging-2026.netlify.app`,
> candidata `release-candidate/` con functions y variables de staging):
>
> 1. Catálogo público (`/api/catalog`): 200.
> 2. Alta de solicitud heredada (`ALLOW_LEGACY_REQUEST_INTAKE=true`, habilitada
>    con aprobación explícita): 201.
> 3. Reserva con token: 201, vigencia exacta de 48 h.
> 4. Estado público con token: 200.
> 5. Revisión, aprobación (con motivo obligatorio), planificación, entrega
>    física del ofrecido, custodia, evaluación, catalogación, autorización de
>    catalogación con el segundo actor, admisión, habilitación, inicio,
>    handover y cierre: 200 en cada paso; préstamo registrado y cerrado.
> 6. Cancelación de intercambio (sin entrega confirmada): 200; préstamo
>    `cancelled`.
> 7. Reactivación del préstamo cancelado: 200; préstamo `committed` con
>    vigencia recalculada.
> 8. Login administrativo correcto: 200; contraseña incorrecta: 401; acción
>    administrativa sin sesión: 403; diagnósticos sin token: rechazado.
>
> Nota de siembra: la propagación de `loans.reactivate` en `0025` solo afecta a
> roles existentes al aplicar la migración; los roles sembrados después deben
> recibir el permiso explícitamente.
>
> Pendiente: publicar la candidata en el URL público
> `trueque-staging-2026.netlify.app` (el equipo `soluciones s.a.s` tiene los
> deploys de producción pausados por agotamiento de créditos; el deploy
> borrador ya sirve la candidata con las mismas funciones y variables).


> **Actualización P0/fotografías (2026-10-29):** staging sigue en `0001`–`0005`.
> Las migraciones `0006`-`0011` están pendientes y no se aplicaron. `0009` es la
> evaluación fotográfica y no forma parte de la contención; no ejecutar
> `db:migrate:apply` sin autorización y preflight. Ver
> `docs/inventario/plan-despliegue-contencion.md` y
> `docs/inventario/evaluacion-fotografica.md`.

> **Cadena canónica (2026-11-10):** la secuencia completa válida ahora es
> `0001`–`0026`. `0026_migration_chain_compat.sql` resuelve el conflicto de
> aprobación entre `0011` y `0016`, completa los allowlists del runner y retira
> el DML directo a `admin_credentials`. Staging con ledger `0001`–`0005` puede
> aplicar el bloque `0006`–`0026` tras backup y preflight. Producción no es
> elegible para el runner por su historial manual; ver la sección de migración
> más abajo.

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
- Política de reservas configurada en 3600 segundos. La cadena canónica nueva
  exige 172800 segundos; `0024` ajustará este valor al aplicar.
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
6. Configurar `reservation_policy` con `set_reservation_policy` usando al menos `172800` (la ausencia bloquea `reserve_copy` con `55000`).
7. Ejecutar `npm run staging:check`.
8. Ejecutar `npm run db:migrate:apply` y repetirlo.
9. Configurar variables de Netlify y desplegar.
10. Ejecutar los smoke tests de esta página.

## Cadena canónica, precondiciones y rollback

### Perfiles reconocidos

| Perfil | Ledger efectivo | Ruta permitida |
|---|---|---|
| Base nueva | vacío | bootstrap completo `0001`–`0026` con el runner |
| Staging histórico | `0001`–`0005` y manifiesto consistente | aplicar bloque `0006`–`0026` |
| Producción histórica | `0001`–`0005` en ledger; `0019`/`0020` manuales fuera del ledger | **no usar el runner**; requiere reconciliación autorizada aparte |

El runner rechaza con error claro si detecta el marcador o las tablas de la
reparación manual de inventario con un ledger menor o igual a `0005`. No intenta
aplicar `0006`+ ni tocar datos.

### Precondiciones para staging

1. Snapshot/rama Neon verificable posterior al estado actual.
2. Backup confirmado y responsable/ventana registrados fuera del repositorio.
3. Ledger exacto `0001`–`0005`, sin duplicados ni huecos.
4. Manifiesto consistente y propiedad de objetos en `iub_schema_migrator`.
5. Roles runtime/migrador separados y sin DML directo.
6. `npm test`, `lint`, `build`, `build:release` en verde.
7. Aprobación escrita de migración.

### Orden exacto

1. `npm run db:migrate:plan` y revisar hashes `0006`–`0026`.
2. `npm run db:migrate:apply` (transacción única).
3. Repetir `npm run db:migrate:apply`; debe responder idempotente.
4. Validar ledger, manifiesto, política de reserva y catálogo.
5. Ejecutar smoke tests de solicitudes, préstamos, administración y estado.

### Validación posterior mínima

```sql
BEGIN TRANSACTION READ ONLY;
SELECT version, checksum FROM public.schema_migrations ORDER BY version;
SELECT count(*) AS manifest_rows FROM public.schema_object_manifest;
SELECT duration_seconds FROM public.reservation_policy WHERE policy_id = 1;
SELECT count(*) AS catalog_count FROM public.available_catalog;
SELECT status, count(*) FROM public.loans GROUP BY status ORDER BY status;
SELECT count(*) AS real_anomalies FROM public.real_inventory_anomalies;
ROLLBACK;
```

Criterios: ledger `0001`–`0026`, política `172800` o mayor, catálogo sin
ejemplares reservados, préstamos cerrados preservados y anomalías reales en cero.

### Rollback

- Si el runner falla antes de `COMMIT`, la transacción revierte completa; no hay
  cambios parciales ni filas nuevas en ledger.
- Después de `COMMIT`, el rollback seguro es restaurar el snapshot/rama Neon
  verificado. No borrar filas del ledger ni del manifiesto.
- No ejecutar rollbacks manuales de `0020` sobre staging ya migrada a la cadena
  canónica sin revisión separada.

## Bloqueos y pendientes

- OIDC institucional no implementado; la sesión `ADMIN_USERS` es una solución de staging.
- No hay almacenamiento privado de imágenes/evidencias; no se aceptan fotografías.
- El proyecto staging es público y contiene solo datos sintéticos.
- Producción no se ha tocado; cualquier promoción requiere un entorno/snapshot autorizado y repetir la puerta de pruebas.
