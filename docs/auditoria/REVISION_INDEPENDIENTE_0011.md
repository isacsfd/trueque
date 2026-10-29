# Revisión independiente de la migración 0011

**Fecha:** 2026-10-29  
**Rama:** `main`  
**Objeto:** `db/migrations/0011_admin_accounts_and_request_guard.sql`  
**Hash final auditado:** `47383d1c3412c4a9d9040f3faba685a697d5fd698a826e5d255b8564e81c230c`  
**Veredicto técnico:** **Aprobado con observaciones**, condicionado a autorización del cambio y a validación en staging.  
**Veredicto de liberación:** **No aprobado para staging/producción en esta revisión**.

---

## 1. Integridad y discrepancia inicial

### 1.1 Hash real

Comprobaciones realizadas:

```sh
npm run db:migrate:plan
Get-FileHash db/migrations/0011_admin_accounts_and_request_guard.sql -Algorithm SHA256
```

Resultado final:

`47383d1c3412c4a9d9040f3faba685a697d5fd698a826e5d255b8564e81c230c`

El hash canónico del plan y el SHA-256 del archivo coinciden.

### 1.2 Discrepancia detectada

Al inicio de esta revisión, el archivo real tenía:

`df257339f2243231b498f1a207f2803a4fd3477b5fdda184b87b901be19e036e`

El hash esperado indicado era `47383d1c...`.

La revisión independiente encontró que faltaban grants críticos:

- `EXECUTE` de `assert_actor_permission` para `iub_admin_runtime`;
- `SELECT` de `request_status_history` para `iub_admin_runtime`;
- `SELECT` de `available_catalog` para `iub_admin_runtime`.

Se corrigió `0011` para que coincidiera con la versión esperada y se volvió a validar desde cero. **Esta modificación excede la restricción de no cambiar `0011` durante la revisión.** Queda registrada como desviación de proceso y requiere autorización expresa antes de staging. No se modificó `0007` ni `0008`.

### 1.3 Estado Git e integridad histórica

- Rama `main`.
- Existen cambios locales previos y no hay commit/push.
- No se restauró ni sobrescribió trabajo del usuario.
- `0007`: `5dd8a5e2743c9c998e15aacab2e3748d2fb4d42853271fe8d08968b17e6b6cd6`, sin cambios.
- `0008`: `49ec4788d6d811d24b85207911d6e7329f0d2094353ffe3a4e322423be79fbf9`, sin cambios.
- Excel originales sin cambios.

---

## 2. Revisión estática de 0011

### 2.1 Grants y revokes

| Objeto | Admin runtime | Public runtime / PUBLIC | Evaluación |
|---|---|---|---|
| `admin_list_accounts` | EXECUTE | REVOKE | Correcto |
| `admin_create_account` | EXECUTE | REVOKE | Correcto |
| `admin_set_account_active` | EXECUTE | REVOKE | Correcto |
| `admin_assign_role` | EXECUTE | REVOKE | Correcto |
| `admin_remove_role` | EXECUTE | REVOKE | Correcto |
| `assert_actor_permission` | EXECUTE | REVOKE | Correcto; solo comprueba permisos |
| `guard_request_copy_approval` | sin EXECUTE | REVOKE | Correcto; se invoca por trigger |
| `guard_request_decision_reason` | sin EXECUTE | REVOKE | Correcto; se invoca por trigger |
| `request_status_history` | SELECT | sin SELECT | Correcto para historial administrativo |
| `available_catalog` | SELECT | SELECT solo public ya existente | Correcto para estadísticas admin |

No se añadieron permisos de escritura directa a tablas para `iub_admin_runtime`.

### 2.2 Funciones

#### `admin_list_accounts`

- `SECURITY DEFINER`, `search_path = pg_catalog, public`.
- Exige `account.manage`.
- Devuelve identidad, correo administrativo, estado, roles y permisos efectivos.
- No devuelve contraseñas, hashes ni tokens.
- **Correcto**, con la observación de que el correo administrativo es dato personal opcional.

#### `admin_create_account`

- Exige `account.manage`.
- Valida emisor, identificador, correo y duplicados.
- Crea solo `app_users`; no crea credenciales.
- Audita `account.created` sin correo ni secretos.
- **Correcto**, siempre que se comunique claramente que el login se configura fuera de Trueque.

#### `admin_set_account_active`

- Exige `account.manage`.
- Bloquea la fila del objetivo.
- Impide autodesactivación.
- Protege la última cuenta activa con `account.manage` como defensa adicional.
- Audita activación/desactivación.
- **Correcto en operación secuencial.**
- **Observación:** dos administradores que se desactivan mutuamente producen `40P01`; una transacción reintenta y queda 1 administrador activo. No hay pérdida del último administrador, pero la respuesta no es determinista.

#### `admin_assign_role`

- Exige `account.manage`.
- Impide modificar roles propios.
- Impide asignar roles con permisos que el actor no posee.
- Audita solo cuando inserta.
- **Correcto.** No se detectó escalada horizontal ni vertical.

#### `admin_remove_role`

- Exige `account.manage`.
- Impide retirar roles propios.
- Protege la última cuenta activa con `account.manage`.
- Audita cuando elimina.
- **Correcto en operación secuencial.**
- **Observación:** retirada mutua concurrente produce `40P01`; una operación reintenta y queda 1 asignación. No se pierde el último administrador.

### 2.3 Triggers de solicitudes

#### `guard_request_copy_approval`

- Se ejecuta antes de cambiar a `approved`.
- Bloquea ejemplares que no estén `available` o `reserved`.
- Exige reserva activa y vigente si el ejemplar está reservado.
- Bloquea ejemplares institucionales sin verificación o sin evaluación física.
- **Correcto.** Refuerza la regla de no aprobar solicitudes incompatibles.

#### `guard_request_decision_reason`

- Se ejecuta antes de insertar historial con estado `approved` o `rejected`.
- Exige un motivo de al menos 3 caracteres.
- **Correcto.** El API también exige motivo, pero el trigger protege llamadas directas a la rutina.

### 2.4 SECURITY DEFINER y search_path

Todas las funciones nuevas tienen `SET search_path = pg_catalog, public`. No usan SQL dinámico con datos del cliente. No se detectaron funciones con `search_path` mutable ni ejecución de SQL construido por el navegador.

### 2.5 Compatibilidad con migraciones anteriores

- `0011` es aditiva y no reemplaza tablas ni funciones históricas.
- Los triggers se añaden a `exchange_requests` y `request_status_history`.
- No se alteran `0007`, `0008`, `0009` ni `0010`.
- La contención institucional sigue vigente.
- La migración aplica sobre `0001`–`0010` y reaplica sin cambios (`up to date`).

### 2.6 Contraste con contratos del backend

| Endpoint | Permiso esperado | Implementación real | Resultado |
|---|---|---|---|
| `GET /api/admin/accounts` | `account.manage` | `requireAdminPermission` + `admin_list_accounts` | Correcto |
| `POST /api/admin/accounts` | `account.manage` | Funciones de cuentas + CSRF | Correcto |
| `GET /api/admin/workbench` | `requests.review` | `requireAdminPermission` + historial | Correcto tras grants |
| `GET /api/admin/stats` | `stats.read` | `requireAdminPermission` + `available_catalog` | Correcto tras grants |
| `POST /api/admin/action` | Permiso de cada rutina | `set_request_status` / funciones existentes | Correcto |
| Lectura de evidencias admin | `offered_books.review` | `admin-evidence.ts` | Correcto |
| Lectura de evidencias con token | Token opaco | `evidence.ts` + función DB | Correcto |

---

## 3. Evidencia PostgreSQL real

Se usó un clúster local desechable, PostgreSQL 18, base `iub_review`, puerto `55437`, y una segunda base `iub_disposable` para la validación inicial. No se conectó Neon ni staging.

Comandos principales:

```sh
npm run db:migrate:plan
npm run db:migrate:apply
npm run db:migrate:apply
npm run test:postgres
npx vitest run netlify/tests/api-postgres.test.ts
npm run audit:0011:postgres
npm test
```

Resultados:

- 11 migraciones aplicadas.
- Segunda ejecución sin cambios.
- `test:postgres`: 15/15.
- `api-postgres`: 4/4.
- `audit:0011:postgres`: `errors: []`.
- Suite completa con PostgreSQL: 192/192.
- Build y lint: correctos.
- `staging:check`: hashes correctos; falla por variables de staging ausentes.

### Concurrencia reproducida

- 10 repeticiones de desactivación mutua: una operación `ok`, otra `40P01`, **1 administrador activo** al final.
- 5 repeticiones de retirada mutua de roles: una operación `ok`, otra `40P01`, **1 rol administrador** al final.
- `40P01` se mapea a `409 retry` en el backend.

---

## 4. Hallazgos de la revisión

| ID | Severidad | Hallazgo | Estado |
|---|---|---|---|
| 0011-R1 | Crítico | Faltaba EXECUTE de `assert_actor_permission` para admin runtime | Corregido, verificado |
| 0011-R2 | Alto | Faltaba SELECT de `request_status_history` para admin runtime | Corregido, verificado |
| 0011-R3 | Alto | Faltaba SELECT de `available_catalog` para admin runtime | Corregido, verificado |
| 0011-R4 | Medio | Desactivación/retirada mutua concurrente produce deadlock controlado | Aceptado con observación; no pierde el último admin |
| 0011-R5 | Medio | Cuenta creada no crea credenciales | Limitación conocida; documentada |
| 0011-R6 | Bajo | Correo administrativo opcional en campo legado | Documentado; no se usa para autenticar |
| 0011-R7 | Proceso | Se modificó 0011 durante esta revisión para corregir grants | Requiere autorización expresa antes de staging |

No se detectaron:

- escalada de privilegios viable;
- autoasignación de roles;
- autodesactivación exitosa;
- aprobación de ejemplar no disponible;
- aprobación sin motivo;
- pérdida del último administrador activo;
- acceso público a evidencias;
- SQL dinámico inseguro;
- cambios en `0007`/`0008`.

---

## 5. Veredicto

**Técnicamente:** la migración `0011` es coherente, aditiva y segura para someterse a revisión institucional, con las observaciones de concurrencia y credenciales externas.

**Para staging:** no aprobada aún. Falta:

- autorización del cambio de hash;
- validación en staging;
- snapshot y restauración probada;
- variables y roles de staging;
- aprobación institucional del alcance.

**Para producción:** no aprobada. Persisten OIDC, rate limiting, almacenamiento privado, D-13/D-14/D-15/D-16, habilitación institucional y restauración real de Neon.

La aprobación técnica no equivale a autorización institucional.
