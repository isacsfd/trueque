# Especificación técnica: habilitación de inventario institucional

**Estado:** propuesta técnica. **No implementada.**
**Depende de:** `docs/inventario/politica-aceptacion-institucional.md` y
`docs/inventario/decisiones-pendientes-iub.md`.
**Alcance:** ejemplares con `copies.provenance_type = 'institutional'`.
**Restricción de esta fase:** no se crean tablas, funciones, permisos ni endpoints;
no se modifica disponibilidad ni se habilitan ejemplares.

> **Contención P0 ya aplicada en local (0007/0008):** existen `verified_at`,
> `verified_by` y `verification_reference` en `copies`; `available_catalog`,
> `create_exchange_request`, `reserve_copy` y el trigger de `copies` exigen
> verificación positiva para ejemplares institucionales. Los 67 ejemplares están
> en `unavailable`. Esto no es la habilitación administrativa definitiva: no hay
> rutina para aprobar ni habilitar.

---

## 1. Resumen ejecutivo

El sistema ya tiene un patrón administrativo seguro: sesión firmada, allowlist de
acciones, funciones `SECURITY DEFINER`, RBAC en PostgreSQL, bloqueos, idempotencia
y auditoría inmutable. Ese patrón debe reutilizarse.

La brecha es que `public.enable_received_copy` solo habilita ejemplares
`exchange_received` con una admisión de intercambio. No existe una rutina para
ejemplares institucionales preexistentes.

La contención P0 local ya corrigió el estado inicial: los 67 ejemplares están en
`availability = 'unavailable'`, `physical_condition = 'unassessed'` y
`verified_at IS NULL`; no aparecen en `public.available_catalog` y no pueden
reservarse. La habilitación institucional debe pasar de ese estado a `available`
solo con una autorización registrada; la mera disponibilidad no equivale a
verificación.

---

## 2. Arquitectura existente que se reutiliza

### 2.1 Autenticación y autorización

| Pieza | Ubicación | Comportamiento |
| --- | --- | --- |
| Sesión administrativa | `netlify/lib/auth.ts` | Cookie `HttpOnly`, `SameSite=Strict`, `Secure` en HTTPS, firmada con `SESSION_SECRET`; `ADMIN_USERS` enlaza usuario con `actorUserId`. |
| Validación de sesión | `requireAdmin` | Rechaza sin cookie válida; no confía en roles del cliente. |
| Allowlist | `netlify/functions/admin-action.ts` | Solo acciones enumeradas; `actor = session.actorUserId`. |
| Origen | `assertSameOrigin` | Protección CSRF para mutaciones. |
| RBAC | `public.assert_actor_permission` | Exige usuario activo y permiso efectivo en `user_roles`/`role_permissions`/`permissions`. |
| Privilegios | `db/migrations/0003_runtime_privileges.sql` | `iub_admin_runtime` sin DML directo; ejecuta solo funciones concedidas. |
| Auditoría | `public.audit_events` | Append-only; trigger `reject_immutable_change` bloquea `UPDATE` y `DELETE`. |

### 2.2 Permiso `inventory.enable`

El permiso ya existe en `public.permissions`:

```text
inventory.enable — "Habilitar ejemplares catalogados"
```

Hoy solo lo usa `public.enable_received_copy`. La nueva rutina debe reutilizar el
mismo permiso, no crear un permiso paralelo para la misma autoridad.

La asignación del permiso a roles es institucional. En `iub_local` no hay roles ni
usuarios creados; no se deben inventar `role_key` ni miembros.

### 2.3 Función existente y por qué no sirve

`public.enable_received_copy(p_admission_id, p_actor_user_id)`:

- exige `inventory_admissions.status = 'admitted'`;
- exige solicitud e intercambio activos;
- exige `copies.provenance_type = 'exchange_received'`;
- exige `source_admission_id` igual a la admisión;
- exige `availability = 'unavailable'`.

Un ejemplar institucional no tiene recepción, admisión ni intercambio. Reutilizar
esa función sería incorrecto e inseguro.

### 2.4 Disponibilidad y catálogo

Valores reales de `copies.availability`:

```text
available | reserved | unavailable | maintenance | retired
```

`public.available_catalog` publica ejemplares con `availability = 'available'` y,
desde la contención P0, exige además que un ejemplar `institutional` tenga
`verified_at` y una condición distinta de `unassessed`. No existe todavía un campo
único de “publicado”; la verificación positiva es la compuerta actual.

Consecuencia: un ejemplar institucional no verificado no aparece en el catálogo ni
puede reservarse, aunque alguien intente cambiar su disponibilidad. La habilitación
definitiva sigue requiriendo una rutina administrativa futura.

### 2.5 Restricciones útiles ya existentes

- `copies_inventory_code_key` impide códigos duplicados.
- `copies_physical_condition_check` admite `excellent`, `good`, `fair`, `poor`,
  `unassessed`.
- `copies_availability_check` limita los estados de disponibilidad.
- `copies_exchange_source_check` exige admisión solo para `exchange_received`.
- `copies_source_admission_uq` impide dos ejemplares para una misma admisión.
- `reservations_one_active_per_copy_uidx` impide dos reservas activas por ejemplar.
- `inventory_movements` es append-only y `availability_changed` ya existe.
- `cataloging_records` ya exige `validated_by <> authorized_by` en recepciones.

---

## 3. Modelo de datos propuesto (migración futura, no aplicada)

Las tablas siguientes son una propuesta. No existen en la base actual y no deben
crearse en esta fase.

### 3.1 `public.inventory_reconciliation_batches`

Lote de autorización ligado al informe de conciliación.

| Columna | Tipo | Regla |
| --- | --- | --- |
| `id` | `bigint identity` | PK. |
| `report_sha256` | `bytea` | `NOT NULL`, 32 bytes, `UNIQUE`; hash del Excel procesado. |
| `report_filename` | `text` | `NOT NULL`; nombre del archivo. |
| `processor_version` | `text` | `NOT NULL`; versión del procesador. |
| `total_expected` | `integer` | `NOT NULL`, `>= 0`. |
| `processed` | `integer` | `NOT NULL`, `>= 0`. |
| `authorized_by` | `bigint` | FK `app_users(id)`, `NOT NULL`. |
| `authorized_at` | `timestamptz` | `NOT NULL`, `clock_timestamp()`. |
| `idempotency_key` | `uuid` | `NOT NULL`, `UNIQUE`. |
| `metadata` | `jsonb` | `NOT NULL DEFAULT '{}'`, objeto. |

Regla: un mismo `report_sha256` no se autoriza dos veces con contenidos distintos.
Si se repite la misma solicitud, se devuelve el lote existente.

### 3.2 `public.inventory_reconciliation_decisions`

Decisión por ejemplar. Es inmutable; una corrección crea una nueva versión.

| Columna | Tipo | Regla |
| --- | --- | --- |
| `id` | `bigint identity` | PK. |
| `batch_id` | `bigint` | FK lote, `NOT NULL`. |
| `copy_id` | `bigint` | FK `copies(id)`, `NOT NULL`. |
| `inventory_code` | `text` | Copia del código al decidir; `NOT NULL`. |
| `version` | `integer` | `NOT NULL`, `>= 1`. |
| `supersedes_id` | `bigint` | FK a la decisión anterior, nullable. |
| `decision` | `text` | `accepted`, `rejected`, `needs_review`. |
| `assessed_condition` | `text` | `excellent`, `good`, `fair`, `poor`; no `unassessed`. |
| `rationale` | `text` | `NOT NULL`, 1–3000 caracteres. |
| `evidence_reference` | `text` | `NOT NULL`, 1–500 caracteres. |
| `blocking_incidents` | `integer` | `NOT NULL DEFAULT 0`, `>= 0`. |
| `report_row` | `integer` | Fila del Excel, `> 0`. |
| `decided_by` | `bigint` | FK `app_users(id)`, `NOT NULL`. |
| `decided_at` | `timestamptz` | `NOT NULL`. |
| `idempotency_key` | `uuid` | `NOT NULL`, `UNIQUE`. |

Restricciones:

- `UNIQUE (batch_id, copy_id, version)`;
- `assessed_condition <> 'unassessed'`;
- `decision = 'accepted'` exige `blocking_incidents = 0` y evidencia;
- trigger de inmutabilidad para `UPDATE` y `DELETE`.

### 3.3 `public.inventory_copy_enablements`

Estado actual de habilitación por ejemplar.

| Columna | Tipo | Regla |
| --- | --- | --- |
| `id` | `bigint identity` | PK. |
| `copy_id` | `bigint` | FK `copies(id)`, `NOT NULL`. |
| `decision_id` | `bigint` | FK decisión, `NOT NULL`, `UNIQUE`. |
| `batch_id` | `bigint` | FK lote, `NOT NULL`. |
| `previous_availability` | `text` | `unavailable` o `maintenance`. |
| `new_availability` | `text` | `available`. |
| `status` | `text` | `enabled` o `reversed`. |
| `enabled_by` | `bigint` | FK `app_users(id)`, `NOT NULL`. |
| `enabled_at` | `timestamptz` | `NOT NULL`. |
| `idempotency_key` | `uuid` | `NOT NULL`, `UNIQUE`. |
| `reversed_by` | `bigint` | FK `app_users(id)`, nullable. |
| `reversed_at` | `timestamptz` | Nullable. |
| `reversal_reason` | `text` | Nullable, 1–3000. |
| `evidence_reference` | `text` | `NOT NULL`. |

Restricciones:

- índice único parcial `(copy_id) WHERE status = 'enabled'` para impedir doble
  habilitación;
- reversión no borra la fila: cambia `status` y completa campos de reversión;
- `CHECK` de coherencia: `status = 'reversed'` exige `reversed_by`,
  `reversed_at` y `reversal_reason`.

### 3.4 `public.inventory_reconciliation_incidents` (recomendada)

El procesador lee incidencias del Excel, pero la base no las conoce. Para que la
rutina pueda bloquear con datos propios, se propone:

| Columna | Tipo |
| --- | --- |
| `id` | `bigint identity` PK |
| `batch_id` | FK lote |
| `copy_id` | FK `copies(id)` |
| `incident_type` | `text` (`Presencia física`, `Estado físico`, `Identificación bibliográfica`, `Disponibilidad`, `Datos maestros`, `Otro`) |
| `description` | `text` |
| `evidence_reference` | `text` |
| `status` | `text` (`open`, `in_review`, `resolved`, `rejected`) |
| `blocking` | `boolean` |
| `resolution` | `text` nullable |
| `resolved_by` | FK `app_users(id)` nullable |
| `resolved_at` | `timestamptz` nullable |
| `idempotency_key` | `uuid` unique |

Sin esta tabla, la rutina solo puede confiar en `decisions.blocking_incidents`
declarado por el evaluador. Eso es más débil. La decisión de crearla es técnica y
debe revisarse con la institución.

---

## 4. Funciones propuestas

Todas serían `SECURITY DEFINER`, `SET search_path = pg_catalog, public`, con
`assert_actor_permission`, grants explícitos a `iub_admin_runtime` y ningún grant a
`iub_public_runtime`.

### 4.1 `authorize_reconciliation_batch`

```text
public.authorize_reconciliation_batch(
  p_report_sha256 BYTEA,
  p_report_filename TEXT,
  p_processor_version TEXT,
  p_total_expected INTEGER,
  p_processed INTEGER,
  p_actor_user_id BIGINT,
  p_idempotency_key UUID
) RETURNS BIGINT
```

Permiso: `inventory.enable`.

Valida:

- hash de 32 bytes y conteos coherentes;
- actor activo y autorizado;
- no existe un lote con el mismo hash y contenido distinto;
- idempotencia: misma clave/hash devuelve el lote existente.

Inserta el lote y `audit_events` (`inventory.reconciliation_batch_authorized`).

### 4.2 `record_reconciliation_decision`

```text
public.record_reconciliation_decision(
  p_batch_id BIGINT,
  p_copy_id BIGINT,
  p_decision TEXT,
  p_assessed_condition TEXT,
  p_rationale TEXT,
  p_evidence_reference TEXT,
  p_blocking_incidents INTEGER,
  p_report_row INTEGER,
  p_actor_user_id BIGINT,
  p_idempotency_key UUID
) RETURNS BIGINT
```

Permiso propuesto: `inventory.reconcile` (nuevo, futuro) o, si la institución lo
rechaza, `inventory.enable` con segregación por roles. No se crea el permiso en
esta fase.

Valida:

- lote autorizado;
- ejemplar existente y `provenance_type = 'institutional'`;
- `inventory_code` coincide;
- decisión y condición válidas;
- evidencia y motivo no vacíos;
- `blocking_incidents = 0` si la decisión es `accepted`.

No cambia disponibilidad. Inserta decisión y auditoría.

### 4.3 `enable_reconciled_copy`

```text
public.enable_reconciled_copy(
  p_decision_id BIGINT,
  p_actor_user_id BIGINT,
  p_idempotency_key UUID
) RETURNS BIGINT
```

Permiso: `inventory.enable`.

Algoritmo transaccional:

1. `assert_actor_permission(actor, 'inventory.enable')` y
   `set_config('app.actor_user_id', ...)`.
2. Buscar `inventory_copy_enablements` por `idempotency_key`.
   - Si existe para la misma decisión/ejemplar: devolver el id, sin duplicar
     movimientos ni auditoría.
   - Si existe para otra decisión/ejemplar: error de conflicto.
3. Bloquear el ejemplar: `SELECT ... FROM copies WHERE id = ... FOR UPDATE`.
4. Leer y bloquear la decisión (`FOR UPDATE`) y verificar el lote autorizado.
5. Validar:
   - `copies.provenance_type = 'institutional'`;
   - `copies.source_admission_id IS NULL`;
   - `decisions.decision = 'accepted'`;
   - `decisions.copy_id = copies.id`;
   - `decisions.inventory_code = copies.inventory_code`;
   - `decisions.blocking_incidents = 0`;
   - `decisions.evidence_reference` no vacío;
   - `copies.availability IN ('unavailable', 'maintenance')`;
   - `copies.physical_condition IN ('unassessed', decisions.assessed_condition)`.
6. Verificar que no haya compromiso activo:
   - `reservations` con `copy_id` y `status = 'active'`;
   - `exchanges` con `institutional_copy_id` y estado en
     `planned`, `in_process`, `cancellation_pending`;
   - `exchange_requests` con `requested_copy_id` y estado no terminal.
7. Actualizar `copies`:
   - `availability = 'available'`;
   - `physical_condition = decisions.assessed_condition`.
8. Insertar `inventory_copy_enablements`.
9. Insertar `inventory_movements`:
   - `movement_type = 'availability_changed'`;
   - `previous_availability` real;
   - `new_availability = 'available'`;
   - `reason` con lote y decisión;
   - `performed_by`, `idempotency_key`.
10. Insertar `audit_events`
    (`inventory.copy_enabled`) con lote, decisión, hash, códigos, estados y
    evidencia.
11. Devolver el id de habilitación.

Cualquier excepción revierte toda la transacción: no queda ejemplar habilitado sin
movimiento, ni movimiento sin auditoría.

### 4.4 `reverse_reconciled_enablement`

```text
public.reverse_reconciled_enablement(
  p_enablement_id BIGINT,
  p_target_availability TEXT,  -- 'maintenance' o 'retired'
  p_reason TEXT,
  p_evidence_reference TEXT,
  p_actor_user_id BIGINT,
  p_idempotency_key UUID
) RETURNS BIGINT
```

Permiso: `inventory.enable` (o un permiso futuro de bloqueo/baja, a decidir).

- No borra la habilitación ni el movimiento original.
- Cambia `status` a `reversed` y completa actor, fecha y motivo.
- Actualiza `copies.availability` a `maintenance` o `retired`.
- Inserta `inventory_movements` (`availability_changed` o `retired`).
- Inserta `audit_events` (`inventory.copy_enablement_reversed`).
- Si el ejemplar está reservado o en intercambio activo, rechaza hasta resolver el
  compromiso; no se fuerza un estado inconsistente.

---

## 5. Controles obligatorios

### 5.1 Autorización en servidor

- La Function valida la sesión y el `actorUserId`.
- La base valida el permiso con `assert_actor_permission`.
- No se aceptan roles, permisos ni `actorUserId` enviados por el cliente.
- La acción debe añadirse a la allowlist de `admin-action.ts` en la tarea de
  implementación, con validación de campos y misma-origen.

### 5.2 Bloqueos de concurrencia

- `FOR UPDATE` sobre `copies` antes de decidir.
- `FOR UPDATE` sobre la decisión.
- Lectura bloqueada de reservas e intercambios activos.
- Orden de bloqueo consistente: ejemplar → decisión → lote (lectura) →
  reservas/intercambios por id.
- Índice único parcial de habilitación activa como última barrera.
- No usar `LOCK TABLE`; no serializar todo el inventario.

### 5.3 Idempotencia

- `idempotency_key` único en lote, decisión y habilitación.
- Repetición exacta: devolver el mismo resultado.
- Repetición con distinto contenido: error `23505`/conflicto, sin cambios.
- El `idempotency_key` de movimiento puede derivarse del de habilitación, como ya
  hace `complete_exchange` con `md5(...)`.

### 5.4 Auditoría

Cada operación registra en `audit_events`:

```json
{
  "batch_id": 1,
  "decision_id": 10,
  "copy_id": 42,
  "inventory_code": "IUB-PAZ-001",
  "previous_availability": "unavailable",
  "new_availability": "available",
  "previous_condition": "unassessed",
  "new_condition": "good",
  "report_sha256": "hex...",
  "processor_version": "1.0.0",
  "evidence_reference": "acta-2026-001"
}
```

Reglas:

- no incluir nombre, correo, documento ni datos de participantes;
- `audit_events` es inmutable;
- no se permite `UPDATE`/`DELETE` sobre movimientos ni auditoría;
- la evidencia se referencia, no se incrusta si contiene datos personales;
- el motivo de la aprobación vive en `inventory_reconciliation_decisions.rationale`;
- la habilitación guarda el actor, la fecha y la referencia a la decisión y su
  evidencia; no se acepta una habilitación sin decisión previa.

### 5.5 Validación del estado actual

Antes de habilitar:

- `provenance_type = 'institutional'`;
- `source_admission_id IS NULL`;
- disponibilidad de origen `unavailable` o `maintenance`;
- condición evaluada, no `unassessed`;
- sin reserva activa;
- sin intercambio ni solicitud en curso;
- sin incidencia bloqueante;
- decisión aceptada y lote autorizado;
- hash del informe coincidente.

Esta especificación asume la opción 1 de D-01 (`unavailable` hasta habilitar).
Si la institución elige la opción 3 (mantener `available` y añadir una compuerta
de publicación), la comprobación de disponibilidad debe sustituirse por esa
compuerta y `available_catalog` debe modificarse en la misma migración.

### 5.6 Doble habilitación

Tres barreras:

1. bloqueo `FOR UPDATE` del ejemplar;
2. verificación de que no existe habilitación `enabled`;
3. índice único parcial `(copy_id) WHERE status = 'enabled'`.

Si dos solicitudes llegan a la vez, una gana y la otra recibe conflicto o el
resultado idempotente, sin segundo movimiento.

### 5.7 Disponibilidad y catálogo

- La rutina es la única vía administrativa para pasar a `available`.
- `iub_admin_runtime` no recibe `UPDATE` directo sobre `copies`.
- `available_catalog` sigue siendo la vista pública; no se modifica en esta fase.
- Una reversión a `maintenance` o `retired` retira el ejemplar del catálogo.

### 5.8 Errores y rollback

Convenciones existentes:

| Situación | SQLSTATE propuesto | HTTP |
| --- | --- | --- |
| Sin sesión | `28000` / `42501` | 401/403 |
| Sin permiso | `42501` | 403 |
| Ejemplar/decisión/lote no existe | `P0002` | 404 |
| Estado incompatible | `23514` | 409/422 |
| Idempotencia o unicidad | `23505` | 409 |
| Configuración incompleta | `55000` | 503 |

`mapError` debe devolver mensajes genéricos y no exponer SQL, parámetros, host ni
datos de usuario. Todo error revierte la transacción.

### 5.9 Incidencias bloqueantes

- `record_reconciliation_decision` rechaza `accepted` si
  `blocking_incidents > 0`.
- Si existe la tabla de incidencias, `enable_reconciled_copy` verifica
  directamente que no haya incidencias `open`/`in_review` ni `resolved` sin
  resolución.
- Una incidencia `rejected` no bloquea, pero debe revisarse si afecta identidad o
  estado.
- La resolución nunca se hace automáticamente desde el procesador.

---

## 6. Interacción con inventario comprometido

| Elemento | Regla propuesta |
| --- | --- |
| Reservas | Si existe `reservations.status = 'active'` para el ejemplar, no habilitar. Si está `reserved`, la disponibilidad ya no es la de origen. |
| Intercambios | Si existe `exchanges` en `planned`, `in_process` o `cancellation_pending` con `institutional_copy_id`, no habilitar. |
| Solicitudes | Si existe `exchange_requests` no terminal con `requested_copy_id`, no habilitar. |
| Movimientos | Solo se insertan; nunca se actualizan ni borran. La habilitación y la reversión dejan rastro. |
| Recepciones | Un ejemplar institucional no debe tener recepción; si `source_admission_id` no es `NULL`, rechazar. |
| Entregas | No aplican a institucional; no se crean entregas ficticias. |
| Devoluciones | No aplican; no se altera el flujo de devolución de intercambios. |
| Inventario ya comprometido | `reserved` o `retired` nunca se sobreescriben; `maintenance` requiere decisión explícita. |
| Catálogo | `available_catalog` muestra el ejemplar solo después de la habilitación; la reversión lo retira. |

La rutina **no** debe tocar `reservations`, `exchanges`, `deliveries`, `receptions`
ni `offered_books`. Solo lee su estado para bloquear.

---

## 7. Estrategia de reversión y baja

- La habilitación no se elimina: se revierte.
- Reversión temporal: `available` → `maintenance`; el ejemplar sale del catálogo,
  pero conserva historial.
- Baja: `available`/`maintenance` → `retired`; no se borra la fila.
- No se permite `DELETE` sobre `copies`, `inventory_movements`,
  `inventory_copy_enablements` ni `audit_events`.
- Una nueva habilitación después de una reversión crea una nueva decisión y un
  nuevo registro de habilitación; no reutiliza el anterior.
- Si hay una reserva o intercambio activo, la reversión espera o se rechaza; no se
  fuerza un estado inconsistente.

---

## 8. Matriz de escenarios de prueba

Estos escenarios deben implementarse cuando se autorice la tarea de escritura.
Hoy son especificación.

| # | Escenario | Entrada / estado | Resultado esperado | Efecto en base |
| --- | --- | --- | --- | --- |
| 1 | Ejemplar encontrado y coincidente | Presencia `Sí`, identificación `Coincide`, estado `good`, sin incidencias. | Decisión `accepted`; habilitación permitida tras autorización. | `availability` de `unavailable` a `available`; movimiento y auditoría. |
| 2 | Ejemplar no encontrado | Presencia `No` o informe `No encontrado`. | Rechazo/bloqueo; habilitación denegada. | Sin cambio; incidencia. |
| 3 | Identificación incorrecta | Título/autor o código no coincide. | Bloqueo; no habilitar; corregir o rechazar. | Sin cambio; incidencia. |
| 4 | Daños físicos | Humedad, hongos, páginas graves o estado `poor`. | Evaluación especializada; no habilitar sin política y aprobación. | Sin cambio o `maintenance`. |
| 5 | ISBN ausente | `bibliographic_records.isbn IS NULL`. | No es rechazo por sí solo; identificar por otros datos. | Sin cambio de disponibilidad. |
| 6 | Duplicados | Dos ejemplares del mismo título. | Conservar ambos; decidir cuántos se habilitan. | Sin borrar; decisiones separadas. |
| 7 | Incidencia abierta | `open` o `in_review`, o `resolved` sin resolución. | Habilitación denegada. | Sin cambio. |
| 8 | Incidencia resuelta | `resolved` con resolución y evidencia. | Puede continuar si el resto cumple. | Sin cambio hasta habilitar. |
| 9 | Usuario no autorizado | Sesión sin `inventory.enable`. | 403; no se ejecuta la rutina. | Sin cambio. |
| 10 | Doble solicitud de habilitación | Misma clave de idempotencia, misma decisión. | Devuelve el mismo resultado; sin duplicar. | Un solo movimiento y una sola auditoría. |
| 11 | Conflicto de concurrencia | Dos sesiones habilitan el mismo ejemplar. | Una gana; la otra recibe conflicto o resultado idempotente. | Un solo `enabled`, un solo movimiento. |
| 12 | Ejemplar reservado o comprometido | `availability = 'reserved'` o intercambio activo. | Habilitación denegada (409/422). | Sin cambio. |
| 13 | Reversión de habilitación | Habilitación existente, motivo y evidencia. | Reversión registrada; ejemplar sale del catálogo. | `maintenance`/`retired`; movimiento y auditoría; no borra. |
| 14 | Auditoría incompleta | Falta actor, evidencia, hash o movimiento. | La transacción falla y revierte. | Ningún cambio parcial. |
| 15 | Reserva concurrente con habilitación | `reserve_copy` y `enable` a la vez. | Solo una transición válida; sin estado inconsistente. | Un ganador; el otro recibe conflicto. |
| 16 | Ejecución repetida del procesador | Mismo Excel y misma base. | Misma huella y clasificaciones. | Sin escritura. |

Comprobaciones adicionales:

- `available_catalog` muestra el ejemplar solo después de habilitar.
- El rol `iub_admin_runtime` no puede hacer `UPDATE` directo sobre `copies`.
- El rol público no puede ejecutar la función de habilitación.
- `audit_events` rechaza `UPDATE` y `DELETE`.
- No se crean movimientos, reservas, entregas ni participantes ficticios.
- No se modifica el Excel ni el inventario fuente.

---

## 9. Plan de implementación recomendado (fase posterior)

1. Aprobar las decisiones institucionales de
   `docs/inventario/decisiones-pendientes-iub.md`.
2. La contención local ya corrigió el estado inicial a `unavailable`; la
   decisión institucional definitiva sigue pendiente.
3. Crear tablas y funciones propuestas en una migración nueva, sin reescribir
   `0001`–`0009`.
4. Añadir permisos/roles según la decisión institucional; no crear roles por
   defecto.
5. Añadir la acción a la allowlist y la interfaz administrativa.
6. Implementar las pruebas de la matriz, incluyendo concurrencia real con dos
   sesiones y verificación de rollback.
7. Ejecutar en local, luego staging, con revisión de seguridad y sin exponer
   inventario no conciliado.
8. Documentar la operación y el procedimiento de reversión.

Hasta completar esos pasos, la habilitación institucional permanece **no
implementada**.
