# Administración de cuentas, permisos y decisiones

**Estado:** implementación local; no aplicada en Neon ni desplegada.
**Migración:** `0011_admin_accounts_and_request_guard.sql`.
**Principio:** Trueque no almacena contraseñas propias ni crea un proveedor de identidad paralelo.

---

## 1. Modelo real de autenticación

La autenticación actual combina dos capas:

1. **Credenciales de acceso:** `ADMIN_USERS` contiene usuarios y hashes scrypt en la
   configuración privada del despliegue. `SESSION_SECRET` firma cookies
   `HttpOnly`, `SameSite=Strict`, `Path=/api/admin` y `Secure` en HTTPS.
2. **Actor PostgreSQL:** cada entrada de `ADMIN_USERS` referencia un
   `actorUserId`. Ese actor debe existir en `app_users`, estar activo y tener los
   permisos RBAC necesarios.

No existe una tabla de contraseñas de Trueque. Por eso:

- no se implementó cambio autónomo de contraseña;
- no se almacenan hashes en la base de datos;
- `POST /api/admin/account` responde `409 password_managed_externally`;
- “Mi cuenta” informa el actor, la expiración y el origen de gestión, sin simular
  un formulario que no puede funcionar.

### Alta de cuentas

`admin_create_account` crea un **actor de PostgreSQL** con emisor, identificador y
correo opcional. No crea credenciales. Para que ese actor pueda iniciar sesión, la
institución debe añadir su identificador a `ADMIN_USERS` o provisionarlo en el
proveedor OIDC cuando exista. La UI lo advierte explícitamente.

Esto permite preparar actores y permisos sin inventar contraseñas ni usuarios de
prueba.

---

## 2. Permisos relevantes

| Permiso | Módulo |
| --- | --- |
| `requests.review` | Bandeja de solicitudes, historial y decisiones |
| `offered_books.review` | Revisión fotográfica y preaprobación |
| `inventory.batches.import` | Prevalidar y cancelar lotes Excel |
| `inventory.batches.confirm` | Confirmar un lote prevalidado |
| `inventory.batches.read` | Historial, detalle y reportes de lotes |
| `stats.read` | Estadísticas agregadas |
| `account.manage` | Listado, alta, activación, desactivación y roles |
| `inventory.admit` | Autorizar y admitir ejemplares recibidos |
| `inventory.enable` | Habilitar ejemplares recibidos y verificados |
| `exchange.plan` | Programar un intercambio aprobado |
| `delivery.schedule` / `delivery.confirm` | Entregas y comprobantes |
| `reception.evaluate` | Evaluación física |
| `cataloging.validate` / `cataloging.authorize` | Catalogación |

`account.manage` no concede por sí solo acceso a inventario, evidencias ni
solicitudes. Los permisos se validan en funciones `SECURITY DEFINER`, no solo en
botones del frontend.

---

## 3. Reglas de cuentas

- El listado solo está disponible con `account.manage`.
- Un actor solo puede asignar roles cuyos permisos ya posee: no puede elevar sus
  propios privilegios ni los de otra cuenta por encima de los suyos.
- No se puede desactivar la propia cuenta ni cambiar los roles propios desde la
  misma sesión.
- No se puede desactivar ni retirar el rol de la última cuenta activa con
  `account.manage`.
- La desactivación no borra roles ni historial; al reactivar, los permisos
  existentes vuelven a evaluarse.
- El servidor revalida `app_users.is_active` antes de emitir o continuar una
  sesión administrativa. Un actor desactivado no puede usar la sesión, aunque el
  token firmado no haya expirado. Logout no revoca tokens ya copiados; la
  expiración y la rotación de `SESSION_SECRET` siguen siendo la garantía de
  revocación global.
- Cada alta, activación, desactivación, asignación y retirada de rol escribe
  `audit_events` con actor, recurso y metadatos técnicos. No se guardan correos,
  contraseñas, tokens ni secretos en la auditoría.

La creación de actores no asigna roles automáticamente. La institución debe
configurar los roles y permisos según sus responsabilidades.

---

## 4. Aprobación y denegación de solicitudes

`POST /api/admin/action` mantiene la allowlist cerrada. Para aprobar o denegar:

- se exige `requests.review`;
- se exige un motivo de al menos 3 caracteres;
- `set_request_status` bloquea la solicitud y aplica transiciones válidas;
- repetir la misma transición es idempotente;
- la decisión queda en `request_status_history`, `state_history` y
  `audit_events` con actor y fecha;
- el guard `guard_request_copy_approval` rechaza la aprobación si el ejemplar
  dejó de estar disponible/reservado, si la reserva está vencida o si es
  institucional no verificado;
- la aprobación **no** crea recepción, evaluación, admisión, habilitación,
  movimiento ni entrega.

La aprobación de la solicitud, la aceptación física, la admisión y la habilitación
siguen siendo etapas separadas. La aprobación tampoco crea una reserva: la
reserva se obtiene con el token del solicitante y `plan_exchange` exige que siga
activa y vigente.

---

## 5. Estadísticas

`GET /api/admin/stats?months=1..12` devuelve datos reales:

- inventario total registrado, institucional, disponible, reservado, no
  disponible, verificado, pendiente de verificación y catálogo público;
- solicitudes por estado;
- ofertas en revisión;
- recepciones, evaluaciones y admisiones por estado;
- intercambios por estado, incluido `completed`;
- lotes nuevos e históricos, filas procesadas, insertadas, reutilizadas,
  rechazadas y duplicadas;
- tendencias de solicitudes, lotes e intercambios completados en el rango
  solicitado.

Definiciones para evitar doble conteo:

- `totalCopies` incluye todas las procedencias; `institutionalTotal` es un
  subconjunto.
- `verified` significa `verified_at IS NOT NULL`; no significa habilitado.
- `available` se refiere a ejemplares institucionales disponibles.
- `publicCatalog` es la vista elegible, no el inventario completo.
- `offersInReview` suma `pending_review` e `in_review`; no incluye
  `needs_information`.
- Las tendencias usan `created_at` para solicitudes/lotes y `completed_at` para
  intercambios completados.

No se inventan métricas ni se presentan datos de prueba como reales.

---

## 6. Límites y pendientes

- **OIDC pendiente:** el alta de actores no crea credenciales; el acceso sigue
  dependiendo de `ADMIN_USERS` o del proveedor institucional.
- **Roles iniciales:** la migración no crea ni asigna roles. La institución debe
  definir la matriz de responsabilidades.
- **Contraseña:** no se implementa cambio autónomo mientras no exista un
  proveedor que lo soporte de forma segura.
- **Evidencias:** el almacenamiento privado sigue bloqueado hasta aprobar D-13 y
  configurar un proveedor autorizado.
- **Estadísticas:** los rangos son de 1 a 12 meses; no hay filtros por sede o
  procedencia porque el esquema actual no los expone de forma fiable.
- **Auditoría:** `audit_events` no guarda datos personales; la consulta de
  historial de solicitudes muestra el identificador del actor, no su correo.
- **Límite de intentos de login:** existe una mitigación local best-effort por
  instancia (`LOGIN_RATE_LIMIT_*`). No es un contador distribuido ni duradero;
  se recomienda aplicar rate limiting adicional en el borde de Netlify o en el
  proveedor de identidad. No se presenta la memoria local como protección
  distribuida.
- **Correo de contacto:** el alta de actores puede guardar un correo
  administrativo opcional en el campo legado de `app_users`. No se usa para
  autenticación ni se muestra en la bandeja de solicitudes.

---

## 7. Pruebas locales

- `db/migrations/0011_admin_accounts_and_request_guard.test.ts`: PGlite en
  memoria, aplica `0001`–`0011`; cubre listado, alta, roles, escalada, sesión
  propia y guard de aprobación.
- `netlify/tests/admin-accounts.test.ts`: API, permisos, CSRF y ausencia de
  secretos en la respuesta.
- `netlify/tests/admin-workbench.test.ts`: permiso e historial de decisiones.
- `netlify/tests/admin-action.test.ts`: motivo obligatorio y allowlist.
- `netlify/tests/admin-stats-account.test.ts`: métricas y rango temporal.
- `src/components/AdminPanel.test.tsx`: pestañas, cuentas y protección de la
  sesión propia.

Las pruebas PGlite aplican migraciones en memoria y no usan Neon ni producción.
