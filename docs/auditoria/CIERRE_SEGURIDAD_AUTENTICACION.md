# Cierre de seguridad de autenticación administrativa

**Fecha:** 2026-10-29  
**Rama:** `main`  
**Migración de referencia:** `0011_admin_accounts_and_request_guard.sql`  
**Hash canónico de `0011`:** `47383d1c3412c4a9d9040f3faba685a697d5fd698a826e5d255b8564e81c230c`  
**Cambios de esquema:** ninguno.  
**Estado:** riesgo corregido en la capa de aplicación y probado contra PostgreSQL real desechable.

---

## 1. Estado inicial

El modelo administrativo existente era:

1. `ADMIN_USERS` contiene usuario, hash scrypt y `actorUserId`.
2. `SESSION_SECRET` firma un token stateless con `sub`, `actor` y `exp`.
3. `readAdminSession` valida firma y expiración, pero no consultaba PostgreSQL.
4. Varios endpoints llamaban después a `assert_actor_permission`, que sí comprueba `app_users.is_active`.
5. Otros endpoints que no exigían permiso RBAC (`GET /api/admin/session`, `GET/POST /api/admin/account`) no comprobaban el estado del actor.
6. `loginAdmin` validaba la contraseña de `ADMIN_USERS` pero no comprobaba el estado del actor en PostgreSQL.

### Riesgo investigado

Un actor desactivado podía:

- iniciar sesión si su contraseña seguía en `ADMIN_USERS`;
- conservar una sesión firmada hasta la expiración;
- acceder a `GET /api/admin/session` y `GET/POST /api/admin/account`;
- recibir un error de autorización tardío en endpoints RBAC, no una denegación de sesión.

La causa raíz era que la cookie se trataba como prueba de vigencia administrativa. La firma demuestra integridad y origen, no que el actor siga activo.

---

## 2. Corrección aplicada

Se añadió `netlify/lib/admin-identity.ts`:

```ts
assertActiveAdminActor(actorUserId)
```

La función consulta `public.app_users` por `id` y exige `is_active = true`. Si no existe, está inactivo o el identificador no es válido, lanza `401 admin_session_invalid`. Si PostgreSQL no está disponible, la excepción se propaga y el backend responde `503`, sin emitir sesión.

### Puntos de aplicación

| Punto | Comportamiento |
|---|---|
| `POST /api/admin/session` | Verifica actor activo antes de devolver `Set-Cookie`; inactivo devuelve error genérico `invalid_credentials` |
| `GET /api/admin/session` | Revalida actor activo; inactivo devuelve `401` |
| `GET /api/admin/account` | Revalida actor activo; inactivo devuelve `401` |
| `POST /api/admin/account` | Revalida antes de responder `409 password_managed_externally` |
| `POST /api/admin/action` | Revalida antes de parsear/ejecutar la acción |
| Endpoints con `requireAdminPermission` | `assert_actor_permission` comprueba estado activo; `28000` se mapea a `401` |
| `admin-batches/confirm` y `cancel` | La rutina PostgreSQL comprueba actor activo; `28000` se mapea a `401` |
| Evidencias administrativas | La consulta de permiso comprueba actor activo; `28000` se mapea a `401` |

### Rate limiting local

`netlify/lib/login-rate-limit.ts` añade una ventana configurable:

- 10 intentos por identidad+IP;
- 60 intentos por IP;
- 15 minutos por defecto;
- claves SHA-256, sin guardar usuario/IP en claro;
- `429 too_many_attempts` con `Retry-After`.

Es una mitigación **best-effort por instancia**. No persiste entre cold starts y no es distribuida. El rate limiting de borde/WAF sigue pendiente.

### Revocación individual

No se implementó una lista de sesiones ni se cambió la cookie. La revocación individual de un token stateless requiere `session_version`/`jti` y una migración futura autorizada. La estrategia está documentada en `MATRIZ_SEGURIDAD_SESIONES.md`.

### Defensa adicional

- `ADMIN_USERS` rechaza usuarios duplicados y `actorUserId` duplicados.
- El login inactivo no revela si la cuenta existe: responde `invalid_credentials`.
- No se añadieron columnas, tablas, migraciones ni credenciales locales.
- No se modificó `0011`, `0007` ni `0008`.

---

## 3. Garantías y límites del modelo stateless

### Garantías reales

- Firma HMAC-SHA-256 con `SESSION_SECRET` de al menos 32 bytes.
- Comparación de firma con `timingSafeEqual`.
- Token caduca por `exp`; no hay renovación deslizante.
- Cookie `HttpOnly`, `SameSite=Strict`, `Path=/api/admin`; `Secure` en HTTPS.
- No se establece `Domain`; cookie host-only.
- No se incluyen roles ni permisos en el token: se resuelven en PostgreSQL.
- Desactivar un actor invalida sus peticiones administrativas aunque el token siga firmado.
- Retirar un rol se refleja en la siguiente comprobación RBAC.
- Rotar `SESSION_SECRET` invalida todas las sesiones emitidas.
- Logout borra la cookie, pero **no revoca tokens ya copiados**; al ser stateless no hay lista de revocación.

### Límites

- Una sesión robada sigue siendo válida hasta su expiración si el actor permanece activo.
- No hay revocación individual por `jti` ni almacén de sesiones; no se introdujo por costo y arquitectura.
- Se añadió un rate limit local best-effort por identidad/IP; no es distribuido ni duradero. El límite de borde/WAF sigue pendiente.
- La cookie no se renueva automáticamente; duración fija de 8 horas.
- El identificador de actor en `ADMIN_USERS` es autoritativo; una configuración errónea podría mapear un usuario a otro actor. Se mitiga rechazando duplicados, pero la revisión de configuración sigue siendo operativa.
- `ADMIN_USERS` sigue siendo la fuente de credenciales; no hay OIDC.

---

## 4. Pruebas

### Unitarias y de handler

- `admin-identity.test.ts`: activo, inactivo, inexistente, id inválido, PostgreSQL no disponible.
- `admin-session.test.ts`: login activo, inactivo, origen cruzado, sesión existente activa/inactiva.
- `auth.test.ts`: hash scrypt, firma, expiración, cookie, credenciales inválidas, duplicados de configuración.
- `admin-stats-account.test.ts`: cuenta inactiva no obtiene datos.
- `admin-action.test.ts`: actor activo; motivo obligatorio; CSRF.
- `http.test.ts`: `28000` se mapea a `401`.

### PostgreSQL real desechable

Se usó un clúster local PostgreSQL 18, base `iub_auth_test`, sin Neon ni staging.

`api-postgres.test.ts` verificó:

- login de actor activo;
- login de actor inactivo → `401` sin cookie;
- sesión existente de actor inactivo → `401`;
- sesión existente tras desactivación contra:
  - bandeja,
  - estadísticas,
  - cuentas,
  - evidencias,
  - lotes,
  - acciones administrativas;
- todas las respuestas fueron `401`.

### Resultados reproducidos

| Comando | Resultado |
|---|---|
| `npm test` con `IUB_TEST_DATABASE_URL` | **192/192, 35 archivos** |
| `netlify/tests/api-postgres.test.ts` | **4/4** |
| `netlify/tests/test-admins-postgres.test.ts` | **3/3** (SP/AD, RBAC, aprobación/denegación) |
| `npm run test:postgres` | **15/15** |
| `npm run audit:0011:postgres` | **OK, `errors: []`** |
| `npm run build` | **OK** |
| `npm run lint` | **OK** |
| `npm run staging:check` | Hashes **OK**; falla por variables de staging ausentes |

Las pruebas PGlite aplican migraciones en memoria. Las pruebas `test:postgres`, `api-postgres` y `audit:0011` usan la base desechable.

---

## 5. Riesgos restantes

| Riesgo | Estado |
|---|---|
| Rate limiting de login | **Mitigación local best-effort implementada**; el límite distribuido/durable sigue pendiente de borde/WAF o proveedor |
| OIDC / gestión de identidad | **Pendiente** |
| Revocación individual de sesión stateless | **Limitación**; mitigada por expiración, revalidación y rotación de secreto |
| Sesión robada de actor activo | **Riesgo residual**; HTTPS, HttpOnly, SameSite, expiración |
| Configuración errónea de `ADMIN_USERS` | **Mitigado parcialmente**; revisar configuración y duplicados |
| Evidencias privadas reales | **Bloqueado por D-13** |
| Antimalware/EXIF | **Bloqueado por D-15** |
| Habilitación institucional | **Bloqueada por D-01–D-12/D-09** |

---

## 6. Conclusión

El riesgo de cuenta desactivada fue **reproducido y corregido**. La sesión ya no se considera autoridad suficiente: el servidor revalida el actor contra PostgreSQL antes de emitir o continuar una sesión administrativa.

La corrección es compatible con el modelo actual, no requiere migración, no crea credenciales y no habilita inventario ni evidencias.

No se declara el sistema listo para producción.
