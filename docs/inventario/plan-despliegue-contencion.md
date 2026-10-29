# Plan de despliegue de la contención P0 en staging

**Estado:** plan propuesto. **No ejecutado.**
**Fecha:** 2026-10-29.
**Alcance:** aplicar la contención `0006`–`0008` en staging.
**No incluye:** habilitación de ejemplares, aceptación física, publicación del
catálogo institucional ni cambios en producción.
**Documento de aprobación:** `docs/inventario/paquete-aprobacion-institucional.md`.

> Este plan no se ejecutó. No se conectó Neon, no se desplegó Netlify y no se
> aplicaron migraciones remotas. Los valores de staging deben verificarse en el
> momento de la ejecución; no se asumen vacíos ni idénticos a local.

---

## 1. Estado de partida documentado

| Elemento | Estado documentado | Debe verificarse |
| --- | --- | --- |
| Staging Neon | `trueque-staging-2026`, PostgreSQL 18.6 | Proyecto, rama y base correctos. |
| Base | `trueque_staging`, rama `production` | Conexión y rol de migración. |
| Ledger | `0001`–`0005` | Consulta real antes de aplicar. |
| Manifiesto | 283 objetos | Conteo real antes de aplicar. |
| `0006`-`0011` | No aplicadas | Pendientes; `0009`/`0010`/`0011` son funciones separadas, no contención. |
| Datos | Sintéticos, no producción | Conteos reales de copias, reservas, intercambios, solicitudes y movimientos. |
| Restauración | Rama `staging-restore-2026-10-28` | No reutilizarla sin confirmar que cubre el estado actual. |
| Producción | No modificada | No asumir su estado. |

Staging **no está vacío**. Tiene datos sintéticos y un manifiesto existente. El
runner no debe tratarlo como bootstrap.

### 1.1 Auditoría de `0007` y `0008`

| Elemento | Dependencia / comportamiento | Riesgo de despliegue |
| --- | --- | --- |
| `0006_inventory_import` | Crea tablas de auditoría y el índice único de procedencia. No importa datos. | El runner exige una secuencia contigua; staging verá `0006`, `0007` y `0008` como un solo bloque pendiente. No se puede aplicar solo `0007` con el runner. |
| `0007` columnas | `copies.verified_at`, `verified_by` (FK `app_users`), `verification_reference`. | `ALTER TABLE` toma lock; el FK requiere que `app_users` exista. Si hay un `verified_by` inválido, la validación falla. |
| `0007` constraint | `copies_verification_ck`. | Valida la tabla; en staging puede tardar si `copies` es grande. No hay `NOT VALID`; es intencional para no ocultar inconsistencias. |
| `0007` índice | `copies_institutional_unverified_idx`. | Aditivo; solo afecta rendimiento. |
| `0007` bloque de contención | Aborta si un institucional no verificado tiene reserva activa, intercambio activo, solicitud no terminal o cualquier movimiento. | Es el mayor riesgo de aborto. Staging sintético puede tener movimientos de smoke tests; hay que verificar antes. |
| `0007` actualización | Cambia `available`/`reserved` a `unavailable` y registra un `audit_event` si actualiza algo. | No crea `inventory_movements`; no habilita. Si staging no tiene institucionales, no actualiza ni audita. |
| `0007` helper | `inventory_copy_is_eligible` es `SECURITY DEFINER`, `STABLE`, sin `EXECUTE` para runtime. | El runner revisa funciones runtime no autorizadas; ya se probó localmente. La vista no lo invoca; usa la condición inline. |
| `0007` trigger `copies` | `BEFORE INSERT OR UPDATE`; impide `available`/`reserved` sin verificación, verificar con `unassessed`, borrar verificación y cambiar procedencia institucional. | Puede romper scripts que insertaban institucionales directamente como `available`. Deben usar `unavailable` y aprobar después por una rutina futura. |
| `0007` `reserve_copy` | Misma firma; añade gate de verificación y usa el helper tras expirar reservas. | Reemplaza la función de `0004`; conserva grants de `iub_public_runtime`. Cualquier dependencia de la definición anterior debe probarse. |
| `0007` trigger solicitudes | `exchange_requests` antes de insertar o cambiar `requested_copy_id`; bloquea institucionales no verificados. | `0008` lo ajusta para no bloquear solicitudes sobre ejemplares no disponibles no institucionales. Depende de que `0007` cree el trigger. |
| `0007` vista | `available_catalog` exige disponibilidad y verificación institucional. Revoca `SELECT` a `iub_admin_runtime`. | El catálogo público usa `iub_public_runtime`; el admin no usa la vista. Verificar que ninguna Function administrativa dependa de ella. |
| `0008` | Reemplaza `guard_institutional_request_copy`; no cambia datos, permisos ni vista. | No aplicar `0008` sin `0007`: el trigger no existiría. El runner lo aplica después por orden. |
| `0009` | Evaluación fotográfica: tablas, funciones y permiso `offered_books.review`; no toca inventario. | No forma parte de la Autorización A. No desplegar con la contención sin una decisión separada. |
| `0010` | Lotes de inventario: prevalidación/confirmación Excel; crea copias `unavailable`/`unassessed`. | No forma parte de la Autorización A. Requiere permisos y aprobación separados. |
| `0011` | Cuentas administrativas y guard de aprobación de solicitudes; no toca inventario. | No forma parte de la Autorización A. Requiere permisos y aprobación separados. |
| Manifiesto | `0007` crea columnas, constraint, índice, funciones, trigger y reemplaza vista; `0008` reemplaza función. | El runner refresca el manifiesto; si staging tiene objetos manuales no registrados, aborta antes. |
| Ledger | `0001`-`0005` en staging; `0006`-`0011` pendientes. | El runner exige prefijo contiguo. `0009`/`0010`/`0011` son funciones separadas, no contención. No editar `0007`-`0011` después de aplicarlas. |
| Rollback | Forward-only; no hay `DROP`. | Después del `COMMIT`, solo restauración de snapshot o forward-fix. No borrar columnas, tablas ni auditoría. |

**Conclusión de auditoría:** `0007`/`0008` son aditivas y no habilitan ejemplares,
pero su despliegue en staging es un bloque `0006`–`0008` y puede abortar por datos
sintéticos con historial. El preflight y el ensayo en rama son obligatorios.

**Riesgo residual:** la contención no implementa la verificación administrativa.
El rol de migración/propietario conserva privilegios para establecer
`verified_at`/`verified_by`; los roles runtime no tienen DML directo. La futura
rutina de habilitación deberá validar actor activo, permiso `inventory.enable`,
evidencia y segregación. No se debe usar SQL manual para verificar ejemplares.

---

## 2. Prerrequisitos de staging

### 2.1 Autorización

- Autorización A del paquete institucional: aplicar la contención.
- Confirmación explícita de que **no** se autoriza habilitar ejemplares.
- Responsable de la ventana de cambio y canal de escalamiento.
- Confirmar que los archivos `0007`/`0008`, el runner y los documentos
  corresponden a una revisión revisada y registrada. No aplicar desde un árbol
  de trabajo no revisado. El estado actual del repositorio no debe confundirse
  con una aprobación ni con un commit de despliegue.

### 2.2 Snapshot y credenciales

- Crear una rama/snapshot de restauración **nueva** desde el estado actual de
  staging, no desde una rama antigua.
- Registrar el identificador de la rama fuera del repositorio.
- Confirmar que el snapshot se puede restaurar en una rama de prueba.
- Variables privadas disponibles fuera del repositorio:
  - `DATABASE_URL` → `iub_public_runtime`
  - `DATABASE_ADMIN_URL` → `iub_admin_runtime`
  - `DATABASE_MIGRATION_URL` → `iub_schema_migrator`
  - `DATABASE_MIGRATION_ROLE=iub_schema_migrator`
  - `DATABASE_MIGRATION_DRIVER=neon`
- No pegar credenciales en documentos, logs ni chat.

### 2.3 Roles y privilegios

Verificar que los tres roles existen, son `NOINHERIT`, sin `SUPERUSER`,
`CREATEDB`, `CREATEROLE`, `REPLICATION` ni `BYPASSRLS`, y que los roles runtime no
tienen membresías indebidas. El runner rechaza la migración si esto no se cumple.

### 2.4 Preflight del runner

`scripts/staging-check.mjs` ya incluye los hashes de `0001`-`0011`. Aun así,
usar `npm run db:migrate:plan` para confirmar que el árbol revisado coincide con
los hashes esperados. `0009_offered_book_photos`, `0010_inventory_batches` y `0011_admin_accounts_and_request_guard` **no son contención**: no deben
aprobarse dentro de la Autorización A. Como el runner aplica todas las migraciones
pendientes en orden, un despliegue de contención debe hacerse desde una revisión
que no incluya `0009` o esperar una autorización separada para la evaluación
fotográfica.

Hashes canónicos locales de referencia:

| Migración | SHA-256 canónico |
| --- | --- |
| `0001_initial_schema` | `cf4b22182eb763005f67ff56d03cc3726b95b2800813ccb443cfa363fc0a0a6a` |
| `0002_corrective_schema` | `251ebb6946a06783afb3891006e7b146f04f7af866c5d49460bc796b401a688c` |
| `0003_runtime_privileges` | `7bfbb4ad542bce617b1f186b0995d9768469bf28501bbe32afb9c8be63c65c67` |
| `0004_p0_integrity` | `365c1346d481d9287666b384dd928e58367df870890190fe0d968229bc81fd87` |
| `0005_participant_api` | `156be0a75a0c93d783964dd4131f76cfc190c99c6a37c66210849c384baf8b66` |
| `0006_inventory_import` | `f9339387e9bf0ff6d5dc4be92763cb6e1cba2232a226a76bd2b916ba3e1e230e` |
| `0007_institutional_containment` | `5dd8a5e2743c9c998e15aacab2e3748d2fb4d42853271fe8d08968b17e6b6cd6` |
| `0008_containment_request_compat` | `49ec4788d6d811d24b85207911d6e7329f0d2094353ffe3a4e322423be79fbf9` |

Confirmar los hashes con `npm run db:migrate:plan`; no confiar en esta tabla si
los archivos cambiaron.

---

## 3. Respaldo y recuperación

### 3.1 Antes de aplicar

1. Crear la rama de restauración desde el estado actual.
2. Registrar fuera del repositorio:
   - proyecto/rama/base;
   - identificador de snapshot;
   - fecha y responsable;
   - ledger y conteo de manifiesto observados;
   - conteos de `copies`, `reservations`, `exchanges`, `exchange_requests`,
     `inventory_movements` y `audit_events`.
3. Probar la restauración en una rama desechable.
4. No usar una restauración que no incluya los datos previos a la ventana.

### 3.2 Recuperación

| Momento | Acción |
| --- | --- |
| Fallo antes del `COMMIT` | El runner hace `ROLLBACK` completo; no hay cambios persistentes. Corregir y repetir. |
| Fallo después del `COMMIT` | Restaurar la rama/snapshot previa o preparar un forward-fix. No borrar tablas, columnas ni historial. |
| Datos incorrectos por contención | Restaurar el snapshot; no poner `available` manualmente ni habilitar ejemplares para “corregir”. |
| Problema solo de aplicación | Mantener el esquema y revertir el despliegue de la aplicación. |
| Migración nueva necesaria | Crear `0012+`; nunca editar `0007`-`0011` ya aplicadas. |

---

## 4. Inventario y operaciones comprometidas

### 4.1 Qué busca la contención

`0007` actualiza a `unavailable` los ejemplares:

- con `provenance_type = 'institutional'`;
- con `verified_at IS NULL`;
- con `availability` en `available` o `reserved`.

Antes de actualizar, aborta si encuentra alguno con:

- reserva `active`;
- intercambio `planned`, `in_process` o `cancellation_pending`;
- solicitud no terminal (`completed`, `cancelled` o `rejected` son terminales);
- cualquier `inventory_movements`.

### 4.2 Preflight obligatorio de compromisos

Ejecutar como `iub_schema_migrator` en staging, en modo lectura:

```sql
-- 1. Ejemplares institucionales y verificación
SELECT
  count(*) AS total_institutional,
  count(*) FILTER (WHERE verified_at IS NULL) AS unverified,
  count(*) FILTER (WHERE verified_at IS NULL AND availability = 'available') AS unverified_available,
  count(*) FILTER (WHERE verified_at IS NULL AND availability = 'reserved') AS unverified_reserved,
  count(*) FILTER (WHERE verified_at IS NOT NULL) AS verified
FROM public.copies
WHERE provenance_type = 'institutional';

-- 2. Compromisos o historial que harían abortar 0007
SELECT count(*) AS blocked
FROM public.copies c
WHERE c.provenance_type = 'institutional'
  AND c.verified_at IS NULL
  AND (
    EXISTS (SELECT 1 FROM public.reservations r
            WHERE r.copy_id = c.id AND r.status = 'active')
    OR EXISTS (SELECT 1 FROM public.exchanges e
               WHERE e.institutional_copy_id = c.id
                 AND e.status IN ('planned','in_process','cancellation_pending'))
    OR EXISTS (SELECT 1 FROM public.exchange_requests r
               WHERE r.requested_copy_id = c.id
                 AND r.status NOT IN ('completed','cancelled','rejected'))
    OR EXISTS (SELECT 1 FROM public.inventory_movements m
               WHERE m.copy_id = c.id)
  );

-- 3. Duplicados que impedirían el índice de 0006
SELECT provenance_reference, count(*)
FROM public.copies
WHERE provenance_type = 'institutional'
  AND provenance_reference LIKE 'inventory-import:%'
GROUP BY provenance_reference
HAVING count(*) > 1;

-- 4. Operaciones globales (no asumir cero)
SELECT
  (SELECT count(*) FROM public.reservations WHERE status = 'active') AS active_reservations,
  (SELECT count(*) FROM public.exchanges WHERE status IN ('planned','in_process','cancellation_pending')) AS active_exchanges,
  (SELECT count(*) FROM public.exchange_requests WHERE status NOT IN ('completed','cancelled','rejected')) AS active_requests,
  (SELECT count(*) FROM public.inventory_movements) AS movements;
```

**Criterio de aborto:** `blocked > 0`, duplicados de procedencia o cualquier
compromiso que el responsable no pueda explicar. No forzar la contención sobre
operaciones reales.

### 4.3 Qué se modifica

- Se añaden columnas de verificación y guards.
- Se actualizan ejemplares institucionales no verificados.
- Se registra un evento de auditoría **solo si `copies_updated > 0`**.
- No se crean movimientos.
- No se habilitan ejemplares.
- `0006` crea tablas de auditoría de importación y un índice; **no importa datos**.
- `0008` solo reemplaza la función del trigger de solicitudes; no cambia datos.

---

## 5. Plan de ejecución

### 5.1 Ensayo en rama de restauración

1. Crear una rama de ensayo desde el snapshot.
2. Configurar URLs de ensayo, nunca producción.
3. Ejecutar `npm run db:migrate:plan`.
4. Ejecutar `npm run db:migrate:apply` con driver `neon`.
5. Repetir `npm run db:migrate:apply`; debe responder “up to date”.
6. Ejecutar las validaciones de la sección 6.
7. Ejecutar smoke tests sintéticos; no habilitar ejemplares reales.
8. Descartar la rama de ensayo.

### 5.2 Ventana de staging

1. Congelar cambios de esquema y despliegues.
2. Confirmar snapshot y autorización A.
3. Ejecutar preflight de la sección 4.2.
4. Ejecutar `npm run db:migrate:plan` y revisar los 8 hashes.
5. Ejecutar `npm run db:migrate:apply`.
   - El runner abre una transacción, toma advisory lock, valida roles/manifiesto
     y aplica `0006`, `0007` y `0008` en orden.
   - Si `0007` aborta, se revierte también `0006`; no queda un estado parcial.
6. Ejecutar validaciones post-aplicación.
7. Smoke tests acotados.
8. Declarar éxito o restaurar.

### 5.3 Orden de despliegue

- **Base de datos antes que cualquier cambio de aplicación.**
- No se requiere un cambio de frontend para la contención: el catálogo ya lee
  `available_catalog` y las Functions ya llaman a `reserve_copy`.
- No desplegar una acción administrativa de habilitación: no existe.
- No publicar el catálogo institucional.

---

## 6. Validación post-aplicación

### 6.1 Ledger y manifiesto

```sql
SELECT version, checksum FROM public.schema_migrations ORDER BY version;
-- Esperado: 0001..0008, sin huecos.

SELECT count(*) FROM public.schema_object_manifest;
-- Comparar con el valor previo; el runner debe haberlo actualizado.
```

Repetir `npm run db:migrate:apply`; debe responder “up to date”.

### 6.2 Contención

```sql
SELECT
  count(*) FILTER (WHERE provenance_type = 'institutional') AS institutional,
  count(*) FILTER (WHERE provenance_type = 'institutional' AND verified_at IS NULL) AS unverified,
  count(*) FILTER (WHERE provenance_type = 'institutional' AND verified_at IS NULL AND availability IN ('available','reserved')) AS exposed
FROM public.copies;

SELECT count(*) FROM public.available_catalog
WHERE inventory_code LIKE 'IUB-PAZ-%';
-- Esperado: 0 en staging si existen los 67; 0 si no existen.

SELECT count(*) FROM public.inventory_movements
WHERE copy_id IN (SELECT id FROM public.copies WHERE provenance_type = 'institutional');
-- No debe aumentar por la contención.

SELECT event_type, metadata
FROM public.audit_events
WHERE event_type = 'inventory.institutional_containment_applied'
ORDER BY id DESC;
-- Puede haber 0 eventos si copies_updated = 0.
```

### 6.3 Estructura y privilegios

```sql
SELECT to_regclass('public.inventory_import_batches');
SELECT to_regclass('public.inventory_import_rows');
SELECT to_regclass('public.available_catalog');
SELECT to_regprocedure('public.reserve_copy(bigint,bigint,bytea,uuid)');
SELECT to_regprocedure('public.inventory_copy_is_eligible(bigint)');

SELECT tgname FROM pg_trigger
WHERE tgname IN (
  'copies_institutional_eligibility_guard',
  'exchange_requests_institutional_eligibility_guard'
)
ORDER BY tgname;

SELECT
  has_table_privilege('iub_public_runtime','public.copies','UPDATE') AS public_update,
  has_table_privilege('iub_admin_runtime','public.copies','UPDATE') AS admin_update,
  has_function_privilege('iub_public_runtime','public.inventory_copy_is_eligible(bigint)','EXECUTE') AS public_helper,
  has_function_privilege('iub_public_runtime','public.reserve_copy(bigint,bigint,bytea,uuid)','EXECUTE') AS public_reserve;
-- Esperado: false, false, false, true.
```

### 6.4 Pruebas funcionales acotadas

- Catálogo público: no debe mostrar ejemplares institucionales no verificados.
- `create_exchange_request` con un ejemplar institucional no verificado: debe
  fallar con `23514` y no dejar participante/consentimiento/solicitud.
- `reserve_copy` sobre no verificado: debe fallar con `23514`; sin reserva ni
  movimiento.
- Flujo de intercambio con ejemplares sintéticos no institucionales: debe seguir
  funcionando.
- Un ejemplar institucional verificado de prueba **no** se crea en staging sin
  autorización expresa. La prueba de camino feliz se hizo en local/desechable.
- No usar datos reales ni habilitar ejemplares.

---

## 7. Criterios de éxito

1. `schema_migrations` contiene `0001`–`0008` sin huecos.
2. El manifiesto se actualiza y una segunda ejecución dice “up to date”.
3. No hay ejemplares institucionales no verificados en `available_catalog`.
4. No hay ejemplares institucionales no verificados en `available` o `reserved`.
5. `copies_updated` puede ser 0 o igual al número de ejemplares retenidos; el
   evento de auditoría debe coincidir con ese conteo.
6. No se crean movimientos por la contención.
7. Los triggers, funciones y privilegios existen como se especifica.
8. Los flujos de intercambio sintéticos siguen pasando.
9. No se habilitó ningún ejemplar.
10. No se modificó producción.

## 8. Criterios de aborto

Abortar antes del `COMMIT` si:

- el ledger no es contiguo o el manifiesto no coincide;
- los roles o privilegios no cumplen;
- hay duplicados que impiden el índice de `0006`;
- `blocked > 0` en el preflight de `0007`;
- el runner falla por cualquier motivo;
- se detecta una operación real o un dato no sintético no revisado;
- no hay snapshot verificable;
- no existe autorización A.

Abortar después del `COMMIT` y restaurar si:

- el catálogo expone un ejemplar no verificado;
- una solicitud o reserva no verificada tiene éxito;
- se creó un movimiento por la contención;
- los flujos de intercambio dejan de funcionar;
- el ledger/manifiesto queda inconsistente;
- se modificó un ejemplar comprometido.

No “arreglar” el estado poniendo `available` a mano. No borrar filas de auditoría,
movimientos ni ledger.

---

## 9. Monitoreo posterior

Durante la ventana definida por la institución:

- `available_catalog` por procedencia y verificación;
- `copies.availability` y `verified_at`;
- errores `23514`/`42501` en solicitudes y reservas;
- nuevas reservas e intercambios;
- `inventory_movements` inesperados;
- eventos `inventory.institutional_containment_applied`;
- acceso al catálogo y tasa de respuestas vacías;
- errores de Functions por permisos de vista o funciones.

No se inventa un SLA. La institución define la duración y el responsable.

---

## 10. Diferencias staging / producción

| Aspecto | Staging | Producción |
| --- | --- | --- |
| Ledger | `0001`–`0005` documentado | No asumido |
| Datos | Sintéticos | Reales; revisión obligatoria |
| `0006`-`0009` | Pendientes; `0009` no es contención | No aplicar sin aprobación separada |
| Snapshot | Crear uno nuevo | Requiere entorno/snapshot autorizado |
| Habilitación | No autorizada | No autorizada |
| Objetivo | Validar contención | No tocar en esta fase |
| Riesgo de datos | Bajo, pero verificar | Alto; no asumir |

Aplicar la contención en producción no es una consecuencia automática de este
plan. Requiere autorización C, snapshot, preflight de datos reales y evaluación de
compromisos.

---

## 11. Plan para no exponer ejemplares no conciliados

1. Aplicar `0007`/`0008` antes de importar o crear ejemplares institucionales.
2. Insertar nuevos institucionales como `unavailable` (el importador local ya lo
   hace).
3. No marcar `verified_at` sin decisión institucional y evidencia.
4. No usar `physical_condition` como sustituto de verificación.
5. No habilitar mediante SQL manual.
6. Mantener el catálogo vacío de institucionales no verificados.
7. Verificar después de cada importación que `available_catalog` no los expone.
8. Si se detecta una exposición, detener la ventana y restaurar/forward-fix; no
   “ocultar” en React.

---

## 12. Autorización y siguiente paso

- **Gate A (este plan):** autorización para aplicar la contención en staging.
- **Gate B (fase posterior):** autorización de política y habilitación
  institucional; no cubierta por este plan.
- **Gate C:** producción; no cubierta.

Si Gate A se aprueba, ejecutar el ensayo en rama, luego staging, y detenerse. No
avanzar a habilitación ni a producción sin Gate B/C.
