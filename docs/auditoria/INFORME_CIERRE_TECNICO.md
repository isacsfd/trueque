# Informe de cierre técnico — Trueque IUB

**Fecha:** 2026-10-29  
**Rama:** `main`  
**Alcance:** auditoría y validación local de la administración; sin despliegue, sin Neon, sin producción.  
**Migraciones auditadas:** `0001`–`0011`.  
**SHA-256 canónico de `0011`:** `47383d1c3412c4a9d9040f3faba685a697d5fd698a826e5d255b8564e81c230c`.

> Etiquetas usadas: **verificado** = reproducido en esta sesión; **inferido** = deducido del código o configuración; **reportado** = antecedente no reproducido; **pendiente** = no ejecutado o bloqueado.

## 1.1 Cambios desde el informe anterior

El informe previo reportaba `0011` con hash:

`df257339f2243231b498f1a207f2803a4fd3477b5fdda184b87b901be19e036e`

La versión final auditada es:

`47383d1c3412c4a9d9040f3faba685a697d5fd698a826e5d255b8564e81c230c`

Motivo: la validación real encontró grants faltantes y se corrigió `0011`. También se añadió el guard de origen del login y se ajustaron pruebas de integración. `0007` y `0008` no cambiaron. El detalle de archivos y hashes está en la sección 5.

---

## 1. Estado inicial y método

Se auditó el árbol de trabajo sin reconstruir módulos ni sobrescribir cambios locales.

- No se crearon commits ni se hizo push.
- No se conectó Neon ni ningún servicio remoto.
- No se modificaron los Excel originales.
- No se modificaron `0007` ni `0008`.
- No se habilitaron ejemplares ni se alteró disponibilidad.
- No se activó almacenamiento real de evidencias.
- No se aplicaron migraciones fuera de un PostgreSQL local desechable.

La validación real se hizo en:

- PostgreSQL 18 local, clúster temporal `%TEMP%\trueque-pg-audit`, puerto `55436`.
- Base `iub_disposable`, creada exclusivamente para esta auditoría.
- Roles `iub_schema_migrator`, `iub_public_runtime` e `iub_admin_runtime`, todos `LOGIN NOINHERIT`.
- Autenticación local `trust`; sin credenciales institucionales ni datos reales.

---

## 2. Validación PostgreSQL real

### 2.1 Migraciones

| Comprobación | Resultado |
|---|---|
| Aplicación secuencial `0001`–`0011` | **11 migraciones aplicadas** |
| Segunda ejecución | `Database schema is up to date; no migration was applied` |
| Ledger y checksums | **OK** |
| Manifiesto de objetos | **OK** |
| Roles runtime sin DDL/DML directo | **OK** |

`0011` crea funciones de cuentas, guards de solicitudes y grants. No toca inventario, evidencias ni las migraciones históricas.

### 2.2 Grants y privilegios efectivos

Verificado con consultas reales:

| Privilegio | Resultado |
|---|---|
| `iub_admin_runtime` ejecuta `assert_actor_permission` | **Sí** |
| `iub_public_runtime` ejecuta `assert_actor_permission` | **No** |
| `iub_admin_runtime` lee `request_status_history` | **Sí** |
| `iub_admin_runtime` lee `available_catalog` | **Sí** |
| `iub_public_runtime` lee `offered_book_evidence` | **No** |
| `iub_admin_runtime` lee `offered_book_evidence` | **Sí** |
| `iub_public_runtime` ejecuta `get_offered_book_evidence` | **Sí**, solo con prueba opaca |
| `iub_public_runtime` ejecuta funciones de cuentas | **No** |

### 2.3 Triggers verificados en PostgreSQL

- `exchange_requests_copy_approval_guard`
- `exchange_requests_photo_approval_guard`
- `exchange_requests_institutional_eligibility_guard`
- `request_status_history_decision_reason_guard`
- `request_status_history_immutable`
- `copies_institutional_eligibility_guard`
- `copies_exchange_received_availability_guard`

### 2.4 Flujos reales validados

`scripts/audit-0011-postgres.mjs` verificó en PostgreSQL real:

- alta de actor sin columnas de contraseña/hash;
- listado de cuentas;
- asignación y retirada de rol;
- bloqueo de escalada de privilegios;
- bloqueo de cambio de roles propio;
- bloqueo de autodesactivación;
- al menos una cuenta administradora activa tras el intento de autodesactivación;
- auditoría `account.created`, `account.role_assigned`, `account.role_removed`, `account.deactivated`, `account.activated`;
- aprobación bloqueada con ejemplar no disponible;
- aprobación permitida con ejemplar disponible y motivo;
- rechazo con motivo;
- bloqueo de historial de decisión sin motivo;
- aprobación sin admisión, recepción ni movimiento;
- prevalidación, confirmación, repetición idempotente y cancelación de lote;
- copia de lote `unavailable`, `unassessed`, `verified_at = NULL`, `institutional`;
- sin movimientos para la copia del lote.

Resultado del script: `errors: []`.

### 2.5 Concurrencia de la última cuenta administradora

Se probaron dos administradores intentando desactivarse mutuamente en paralelo, con diez repeticiones:

- Una transacción terminó correctamente.
- La otra recibió `40P01` (deadlock detectado por PostgreSQL).
- El número de administradores activos con `account.manage` quedó en **1** en las diez repeticiones.

También se probó la retirada mutua de roles en cinco repeticiones:

- Una transacción terminó correctamente.
- La otra recibió `40P01`.
- Quedó **1** asignación del rol en las cinco repeticiones.

El backend mapea `40P01` a `409 retry`. No se pierde el último administrador, pero la operación concurrente genera reintento en lugar de un conflicto determinista. Se registra como observación, no como bloqueo de seguridad.

---

## 3. Hallazgos

### Críticos

| ID | Hallazgo | Impacto | Estado |
|---|---|---|---|
| C-01 | Faltaba `EXECUTE` de `assert_actor_permission` para `iub_admin_runtime`. La comprobación de permisos de los endpoints administrativos fallaba en PostgreSQL real. | Bandeja, estadísticas, lotes y cuentas podían devolver `403` aunque el actor tuviera permiso. | **Corregido** en `0011`; verificado con API real. |
| C-02 | Faltaba `SELECT` sobre `request_status_history` para `iub_admin_runtime`. El historial añadido a la bandeja provocaba `403`. | La bandeja no podía mostrar el historial de decisiones. | **Corregido** en `0011`; verificado con API real. |

### Altos

| ID | Hallazgo | Impacto | Estado |
|---|---|---|---|
| A-01 | Faltaba `SELECT` sobre `available_catalog` para `iub_admin_runtime`. | El endpoint de estadísticas devolvía `403` en PostgreSQL real. | **Corregido** en `0011`; verificado con API real. |
| A-02 | La prueba P0 aprobaba una solicitud sobre un ejemplar no disponible para luego comprobar que la reserva fallaba. Contradecía la regla de no aprobar solicitudes incompatibles. | La suite podía validar el comportamiento incorrecto. | **Corregido** en `scripts/p0-postgres.mjs`; ahora espera `23514`. |
| A-03 | La prueba API–PostgreSQL no configuraba `reservation_policy`; la reserva devolvía `409`. | Falso fallo de integración y cobertura incompleta del flujo real. | **Corregido** en la preparación de la prueba; reserva real validada. |

### Medios

| ID | Hallazgo | Impacto | Estado |
|---|---|---|---|
| M-01 | El login `POST` no validaba el origen de la petición. | Riesgo de login CSRF de bajo impacto. | **Corregido**: rechazo de origen cruzado y prueba `admin-session.test.ts`. |
| M-02 | No existe rate limiting duradero del login. | Fuerza bruta o abuso distribuido no está mitigado por Trueque. | **Pendiente**. Requiere borde Netlify/WAF o proveedor de identidad; no se simuló con memoria por instancia. |
| M-03 | No hay OIDC ni credenciales propias en la base. Crear una cuenta crea solo el actor de PostgreSQL. | El alta no habilita por sí sola el inicio de sesión; requiere `ADMIN_USERS` u OIDC. | **Limitación conocida y documentada**. |
| M-04 | No hay notificaciones automáticas al solicitante. | El solicitante debe consultar con código y token. | **Pendiente**; no hay proveedor de correo configurado. |
| M-05 | No hay almacenamiento privado real de evidencias. | Cargas bloqueadas en producción; no hay URLs firmadas ni lifecycle. | **Bloqueado por D-13**; el driver local falla cerrado en Netlify. |
| M-06 | Dos administradores que se desactivan o retiran roles mutuamente en paralelo producen un deadlock controlado (`40P01`). | Una operación se reintenta con `409`; no se pierde el último administrador, pero la respuesta no es determinista. | **Aprobado con observación**; recomendable serializar con advisory lock en una migración futura. |

### Bajos

| ID | Hallazgo | Impacto | Estado |
|---|---|---|---|
| B-01 | Las tendencias solo muestran meses con datos; no rellenan meses vacíos con cero. | Lectura menos uniforme, sin cifras inventadas. | Aceptado y documentado. |
| B-02 | El alta de actor admite correo administrativo opcional en el campo legado de `app_users`. | Dato personal innecesario si no se usa. | Documentado; no se usa para autenticación ni en la bandeja. |
| B-03 | La prueba API–PostgreSQL emite un `DeprecationWarning` de `pg` por consultas concurrentes sobre un cliente. | Ruido de prueba, no fallo funcional. | Aceptado; no afecta a producción. |

---

## 4. Pruebas ejecutadas

| Ejecución | Resultado real |
|---|---|
| `npm run db:migrate:apply` en base desechable | **11 migraciones aplicadas** |
| Segunda ejecución | **Up to date** |
| `npm run test:postgres` | **15/15 OK** |
| `npx vitest run netlify/tests/api-postgres.test.ts` | **4/4 OK** |
| `npm run audit:0011:postgres` | **OK, `errors: []`** |
| `npm test` con `IUB_TEST_DATABASE_URL` | **192/192 OK, 35 archivos** |
| Pruebas de actor inactivo (login, sesión, 6 endpoints) | **401 en todos los casos** |
| `npm run build` | **OK** |
| `npm run lint` | **OK** |
| `npm run staging:check` | Hashes **OK**; falla por variables de staging ausentes, como se esperaba |
| Concurrencia mutua de cuentas/roles | **10 + 5 repeticiones**, una operación `40P01/409`, nunca 0 administradores |

Las pruebas PGlite aplican migraciones **en memoria**. Las pruebas `test:postgres`, `api-postgres` y `audit:0011:postgres` usan la base desechable.

---

## 5. Archivos modificados en esta auditoría

| Archivo | SHA-256 |
|---|---|
| `db/migrations/0011_admin_accounts_and_request_guard.sql` | `47383d1c3412c4a9d9040f3faba685a697d5fd698a826e5d255b8564e81c230c` |
| `db/migrations/0011_admin_accounts_and_request_guard.test.ts` | `99243c9852db668b4b9ae1a0ead41acb85ccf14adbb7bb631fa1f760ecabaed5` |
| `netlify/functions/admin-accounts.ts` | `5ed7bebe23cddf1bd3be02ded0a885f8df167c4474adfebad23c2cca6e1b63e8` |
| `netlify/functions/admin-action.ts` | `981c93fa2819084f4944414068984cca45dbd1c7131734c9ce2eaef1f65b72e2` |
| `netlify/functions/admin-account.ts` | `632fe1462fad79f7826227fb87c1f301e7e6482eb03e5b0a0b3512a6f3a42a5c` |
| `netlify/functions/admin-stats.ts` | `66ec8e66e7badf2362536000d86fa6d445bf09e52ee17a269b96167b8be63e49` |
| `netlify/functions/admin-workbench.ts` | `b2114b3de1bf8abbcea95c0f6695452a187ec20148ef06a9e233274c6a3b4cc6` |
| `netlify/functions/admin-session.ts` | `4c424434cebf3f2f492c37e8f60e2f35181b23b44816a7bd4436d984a4efe655` |
| `netlify/lib/admin-identity.ts` | `50a1c9f0059d52292f6941e002bbdb14a131bbf792141f52af26a3ceaeb628b7` |
| `netlify/lib/login-rate-limit.ts` | `3508046f5626705dfdeae0388783ab0c157aeb9790fb199a58c89a24f9f79be8` |
| `netlify/lib/auth.ts` | `c9423c5c49b9affc6cea0a8286d0ae643415d975a28d79a2b82104a9c7b2e9e4` |
| `netlify/lib/http.ts` | `a60373bce8d0d8f07f5e2dc94ec49fc97c328a7a00809fed021a1145f8fc7163` |
| `netlify/tests/admin-identity.test.ts` | `5a2242c34f7ddd3b8922fb3c6faefc3364f014252f05b75fd0ca4f592b87a8a0` |
| `netlify/tests/admin-session.test.ts` | `679a08753857f41a715e953baa27e215b60d265d27798fe7516c589487e99dca` |
| `netlify/tests/login-rate-limit.test.ts` | `208711c1026620ec039a5cb304e9eb526d44f67c0b08798a6b11d3cecfbca778` |
| `netlify/tests/admin-stats-account.test.ts` | `792acd438fad33e7e5cfbae196fdbfa41915ec05f9de82f59b357f52dde372ec` |
| `netlify/lib/auth.test.ts` | `593b4061666501a0ca27f8048235bd4a71c2f2d865f2e898d6aa9c2d7d2bba92` |
| `netlify/lib/http.test.ts` | `968996bd81adfe7b985bfa42a237257f3138dc6633c72cf0c1b319d588a86d27` |
| `netlify/tests/api-postgres.test.ts` | `c696c502a4d2abb0cc4296e77fbd3ce74d4f84c4b78aec649609eea977f3f4de` |
| `scripts/p0-postgres.mjs` | `51f4dab3dc25649b8c42b43b514ecdb163ab77364563281d7282383afe68eb91` |
| `scripts/audit-0011-postgres.mjs` | `5bbbd85fb92d30308ff4f8bd25b2eba9aeca705f3b5875ea652710dc45a6caf8` |
| `scripts/migration-safety.mjs` | `83893b51d91985c01b149a6d76d0f03f1a9f9f7e9bc8d7894b52a202e560a7b2` |
| `scripts/staging-check.mjs` | `17cb61a6bb3684605cf81040fccb7db4d5f6a47ab741c4a6a061cbf0d8fb53f8` |

### Archivos adicionales del cierre de autenticación y flujo público

| Archivo | SHA-256 |
|---|---|
| `netlify/lib/public-rate-limit.ts` | `9683895219518f904a48143eaacdc6605839a61f33583aa08b4082e970b6647a` |
| `netlify/tests/public-rate-limit.test.ts` | `8ffef1217ea4d24448a3bb4d248f1b2a24521726cd3971138eb9418037d9c173` |
| `netlify/tests/test-admins-postgres.test.ts` | `ec88e2c2d0ca60ecd1180458782c401d42262fe1d69e5ec18436fd65c9bad931` |
| `scripts/provision-test-admins.mjs` | `3e621d5bd58d87e34bd65e22d255bb200fd64b1b9a61abe6ac53cd5ce3fb24fd` |
| `src/App.tsx` | `25a62e3bed2f5345c59f0bc4fcca6f97525ac16b87ead7ff223f991fe3613366` |
| `src/components/MyRequest.tsx` | `2a40a73822f910354f2ff89e4a466bbf4f9034b4348e4b3400aa61aae864a6b9` |
| `src/components/RequestForm.tsx` | `f58aba18c8b6f1936e8b8567d898c13e6437b2fa36bf1ef3a9b8c265de76bf41` |

Los hashes de `0007`/`0008` y de los Excel originales permanecen sin cambios:

- `0007`: `5dd8a5e2743c9c998e15aacab2e3748d2fb4d42853271fe8d08968b17e6b6cd6`
- `0008`: `49ec4788d6d811d24b85207911d6e7329f0d2094353ffe3a4e322423be79fbf9`
- `INVENTARIO TRUEQUE.xlsx`: `86d6602a23aa6d95045c5a40eece9c3dd3ce14e7349adf59e19ce37110bd846d`

---

## 6. Limitaciones y riesgos abiertos

- No se conectó Neon, no se desplegó y no se aplicó `0011` en staging ni producción.
- No hay autorización institucional de producción.
- No hay OIDC ni rate limiting duradero.
- No hay proveedor real de evidencias ni lifecycle aprobado.
- No existe rutina de habilitación institucional; D-01–D-16 siguen pendientes.
- No se ejecutaron pruebas de carga, penetración ni DAST.
- No se validó una restauración real de Neon; el plan de staging exige probarla.
- Las pruebas reales usaron datos sintéticos y una base desechable.

**Conclusión:** la administración queda técnicamente validada en local y en PostgreSQL real desechable. No está lista para producción hasta resolver los bloqueos institucionales y de infraestructura indicados.
