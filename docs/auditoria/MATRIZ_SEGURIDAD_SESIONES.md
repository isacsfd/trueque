# Matriz de seguridad de sesiones administrativas

**Fecha:** 2026-10-29.  
**Alcance:** `ADMIN_USERS`, `SESSION_SECRET`, cookies, sesiones stateless, RBAC y endpoints administrativos.  
**Evidencia:** pruebas unitarias/handler y PostgreSQL 18 local desechable. No staging, no Neon, no producción.

---

## 1. Amenazas y controles

| ID | Amenaza | Control actual | Ubicación | Prueba | Resultado | Riesgo residual |
|---|---|---|---|---|---|---|
| S-01 | Fuerza bruta de contraseña | scrypt + comparación segura + rate limit best-effort por instancia | `auth.ts`, `admin-session.ts`, `login-rate-limit.ts` | `login-rate-limit.test.ts`, `admin-session.test.ts` | Parcial | **Alto**: falta límite distribuido/durable |
| S-02 | Enumeración de usuarios | Error genérico `invalid_credentials` también para inactivo | `admin-session.ts` | handler/API | OK | Bajo: timing de scrypt uniforme |
| S-03 | Login CSRF | Origen cruzado rechazado | `admin-session.ts` | `admin-session.test.ts` | OK | Bajo: Origin ausente se acepta por compatibilidad |
| S-04 | CSRF en acciones admin | `assertSameOrigin` + `X-IUB-Admin: 1` | `http.ts`, handlers POST | `admin-action.test.ts` | OK | Bajo |
| S-05 | Cookie robada | `HttpOnly`, `SameSite=Strict`, `Secure` en HTTPS, 8 h | `auth.ts` | `auth.test.ts` | OK | Medio: replay hasta expiración |
| S-06 | Session fixation | Token nuevo en cada login; no se acepta token de sesión previo | `auth.ts` | `auth.test.ts` | OK | Bajo |
| S-07 | Firma manipulada | HMAC-SHA-256 + `timingSafeEqual` | `auth.ts` | `auth.test.ts` | OK | Bajo |
| S-08 | Token expirado | `exp` validado en cada lectura | `auth.ts` | `auth.test.ts` | OK | Bajo |
| S-09 | Actor desactivado inicia sesión | `assertActiveAdminActor` antes de `Set-Cookie` | `admin-identity.ts`, `admin-session.ts` | unit/API real | OK | Bajo |
| S-10 | Actor desactivado conserva sesión | Revalidación en sesión/cuenta/acción y `assert_actor_permission` en endpoints RBAC | `admin-identity.ts`, endpoints | API real: 6 endpoints → 401 | OK | Bajo |
| S-11 | Rol retirado | Permisos se consultan en PostgreSQL, no en cookie | `assert_actor_permission` | P0/API | OK | Bajo |
| S-12 | Actor inexistente | `401 admin_session_invalid`; login genérico | `admin-identity.ts` | unit/API | OK | Bajo |
| S-13 | PostgreSQL no disponible | Login y revalidación fallan cerrado (`503`), sin cookie | `admin-identity.ts` | unit | OK | Disponibilidad |
| S-14 | Configuración ambigua | `ADMIN_USERS` rechaza usuario o actor duplicado | `auth.ts` | `auth.test.ts` | OK | Configuración operativa |
| S-15 | Logout no revoca tokens | Se documenta limitación stateless; se borra cookie | `auth.ts` | revisión | Limitación | Medio: token copiado sigue válido hasta expirar |
| S-16 | Rotación de secreto | Nuevo `SESSION_SECRET` invalida todas las firmas | `auth.ts` | diseño | OK | Requiere procedimiento operativo |
| S-17 | Fuga de secreto en logs/respuestas | No se registran cookies, tokens ni `SESSION_SECRET`; errores genéricos | handlers/http | revisión + tests | OK | Bajo |
| S-18 | Acceso a otro actor | Token incluye actor; endpoints usan el actor de sesión, no uno del body | handlers | API real | OK | Bajo |
| S-19 | Evidencias privadas sin autorización | Token de dueño o `offered_books.review`; sin URL pública | `evidence.ts`, `admin-evidence.ts` | unit/PGlite | OK | Bajo |
| S-20 | Abuso de creación de sesiones | Rate limit best-effort por identidad/IP; no distribuido | `admin-session.ts`, `login-rate-limit.ts` | unit/handler | Parcial | **Alto**: cold starts e instancias múltiples lo eluden |
| S-21 | Deadlock de última cuenta | `40P01` → `409 retry`; no se pierde el último admin | `0011`, `http.ts` | PostgreSQL real, 10+5 repeticiones | OK con observación | Medio: reintento |
| S-22 | Escalada de privilegios | Roles solo con permisos del actor; sin autoasignación | `0011` | PGlite/PostgreSQL real | OK | Bajo |
| S-23 | Autodesactivación | `42501`; no se permite | `0011` | PostgreSQL real | OK | Bajo |

---

## 2. Endpoints administrativos y revalidación

| Endpoint | Autorización | Revalida actor activo | Evidencia |
|---|---|---|---|
| `POST /api/admin/session` | Credenciales + actor activo | Sí, antes de cookie | API real |
| `GET /api/admin/session` | Cookie firmada + actor activo | Sí | API real/unit |
| `DELETE /api/admin/session` | Cookie/CSRF | No requiere actor activo; solo logout | Unit/revisión |
| `GET/POST /api/admin/account` | Cookie + actor activo | Sí | Unit |
| `POST /api/admin/action` | Cookie + actor activo + RBAC de rutina | Sí | Unit/API real |
| `GET /api/admin/workbench` | `requests.review` | Sí vía `assert_actor_permission` | API real |
| `GET /api/admin/stats` | `stats.read` | Sí vía permiso | API real |
| `GET/POST /api/admin/accounts` | `account.manage` | Sí vía permiso | PostgreSQL real/unit |
| `/api/admin/batches*` | permisos de lotes | Sí vía permiso/rutina | Unit/PGlite |
| `/api/admin/evidence` | `offered_books.review` | Sí vía permiso | Unit |

---

## 3. Garantías del token

- Algoritmo: HMAC-SHA-256.
- Payload: `sub`, `actor`, `exp`.
- No incluye roles ni permisos.
- `SESSION_SECRET` mínimo: 32 bytes.
- Expiración: 8 horas.
- Sin renovación deslizante.
- Sin `jti` ni lista de revocación.
- La cookie es `HttpOnly`, `SameSite=Strict`, `Path=/api/admin`, `Secure` en HTTPS.
- No se define `Domain`.

### Limitación de revocación

El logout elimina la cookie del navegador, pero un token copiado antes del logout sigue siendo válido hasta `exp` si el actor permanece activo. La desactivación del actor y la retirada de permisos sí bloquean el uso administrativo porque se revalida PostgreSQL. No se introdujo un almacén de sesiones por costo y arquitectura.

---

## 4. Rate limiting y abuso

Se implementó `netlify/lib/login-rate-limit.ts`:

- ventana de 15 minutos configurable;
- máximo por identidad+IP: 10 intentos;
- máximo por IP: 60 intentos;
- claves hasheadas con SHA-256;
- `429 too_many_attempts` con `Retry-After`;
- limpieza de ventanas y límite de buckets en memoria;
- no registra usuario, IP ni contraseña.

**Limitación:** el contador vive en memoria de cada instancia de Netlify Functions. No es distribuido, no persiste entre cold starts y no sustituye un límite en borde/WAF o un proveedor de identidad. El riesgo de fuerza bruta distribuida sigue **alto** para producción.

No se implementó un almacén compartido porque no existe uno aprobado y gratuito en la arquitectura actual.

## 4.1 Estrategia de revocación individual de sesiones

La sesión actual es stateless: no hay `jti`, tabla de sesiones ni versión de sesión. Sin cambiar cookie/esquema no es posible revocar un token individual de un actor activo.

Estrategia actual:

- desactivar el actor invalida login y todas sus peticiones administrativas;
- retirar roles invalida las operaciones RBAC;
- rotar `SESSION_SECRET` invalida todas las sesiones;
- logout borra la cookie, pero no un token copiado;
- expiración máxima de 8 horas.

Estrategia futura propuesta, **no implementada** y sujeta a autorización:

1. migración `0012+` con `app_users.session_version`;
2. incluir `iat`/`sid`/`sv` en el token;
3. comparar `sv` con la base en cada revalidación;
4. incrementar `session_version` para cerrar todas las sesiones de un actor;
5. opcionalmente, tabla de revocación por `jti`.

No se implementó una lista en memoria porque no sería durable ni distribuida y daría falsa seguridad.

---

## 5. Conclusión

Los controles de firma, cookies, expiración, desactivación, RBAC y aislamiento de endpoints están implementados y probados. El riesgo de cuenta inactiva quedó cerrado.

Quedan abiertos el rate limiting, OIDC y la revocación individual de sesiones stateless.

No se declara seguridad de producción completa.
