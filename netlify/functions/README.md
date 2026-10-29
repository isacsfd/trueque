# Netlify Functions

## Rutas públicas

- `GET /api/catalog`: lee `public.available_catalog` con el rol público. No devuelve datos de participantes.
- `POST /api/requests`: endpoint heredado, **cerrado por defecto** porque no exige fotografías. Solo se habilita con `ALLOW_LEGACY_REQUEST_INTAKE=true` para una ventana de compatibilidad aprobada. El flujo nuevo usa `/api/offered-books`.
- `POST /api/requests/reserve`: valida el token opaco y llama `reserve_copy`.
- `POST /api/requests/status`: consulta `get_request_status`; el token va en el cuerpo para no quedar en URL/logs.
- `POST/PATCH /api/offered-books`: crea/edita un borrador de libro ofrecido con token opaco (solo se guarda su SHA-256).
- `POST/DELETE /api/offered-books/evidence`: subida y borrado lógico de fotografías privadas; valida bytes mágicos, MIME real, tamaño y dimensiones.
- `GET /api/offered-books/status`: estado del borrador y evidencias con el token del dueño.
- `POST /api/offered-books/submit`: envío inicial o reenvío tras `needs_information`; crea la solicitud existente sin duplicarla.
- `GET /api/evidence`: acceso privado a una imagen con token de dueño; no hay URL pública.
- `GET /api/admin/evidence`: acceso administrativo a una imagen con sesión y permiso `offered_books.review`; cookie bajo `/api/admin`.

## Rutas administrativas

- `POST /api/admin/session`: login; cookie `HttpOnly`, `SameSite=Strict` y `Secure` en HTTPS. La configuración sale de `ADMIN_USERS` y `SESSION_SECRET`; el actor debe existir y estar activo en PostgreSQL antes de emitir la cookie. `GET /api/admin/session` revalida el estado activo.
- `DELETE /api/admin/session`: logout. Exige `X-IUB-Admin: 1`.
- `GET /api/admin/workbench`: solicitudes, estados, historial de decisiones y metadatos de evidencias, sin nombres, correos ni documentos. Requiere `requests.review`. Las imágenes se obtienen por `/api/admin/evidence` con permiso `offered_books.review`.
- `POST /api/admin/batches`: inspect y prevalidación multipart de Excel (.xlsx) con mapeo explícito.
- `GET /api/admin/batches/list`, `GET /api/admin/batches/detail`, `GET /api/admin/batches/report`: historial, detalle y CSV.
- `POST /api/admin/batches/confirm`, `POST /api/admin/batches/cancel`: confirmación/cancelación auditada.
- `GET /api/admin/stats?months=1..12`: agregados reales; requiere `stats.read`.
- `GET /api/admin/accounts` y `POST /api/admin/accounts`: listado, alta de actores, activación/desactivación y asignación/retirada de roles; requiere `account.manage`. No acepta contraseñas ni hashes.
- `GET /api/admin/account` y `POST /api/admin/account`: información de cuenta; el cambio de contraseña está delegado al despliegue/OIDC.
- `POST /api/admin/action`: allowlist cerrada de acciones, incluida `submission.review` (`start_review`, `request_information`, `preapprove`, `reject`). `request.approve` y `request.reject` exigen motivo. El actor viene de la sesión; cada rutina PostgreSQL valida permisos con `assert_actor_permission`.

## Reglas

- Los endpoints públicos aplican un rate limit local best-effort por IP; no sustituye el rate limiting de borde/WAF.
- Nunca se aceptan transiciones de estado ni roles enviados por el navegador.
- La API no ejecuta SQL construido con datos del cliente.
- Las respuestas de error no incluyen SQL, parámetros, URLs, hosts ni mensajes PostgreSQL.
- `reserve_copy`, `complete_exchange`, `cancel_exchange` y el resto del ciclo se ejecutan en una sola llamada PL/pgSQL por operación.
- Las claves de cifrado, HMAC, sesión y base de datos se configuran solo en variables privadas de Functions.

`database-diagnostics.ts` sigue exponiendo `GET /api/private/database-diagnostics` con su token privado.

## Evidencias privadas

Los adaptadores locales `EVIDENCE_STORAGE_DIR` y `BATCH_STORAGE_DIR` son solo para desarrollo y pruebas. `PRIVATE_STORAGE_DRIVER` selecciona el adaptador; en Netlify Functions `local`, `simulated` o la ausencia de driver fallan de forma cerrada para no perder datos en el filesystem efímero. Antes de habilitar cargas en staging/producción se debe implementar un adaptador de objeto privado aprobado (S3/R2/GCS/Netlify Blobs) con cifrado, lifecycle, antimalware y eliminación de metadatos. No se sirven imágenes desde `dist` ni desde un bucket público. Ver [`docs/inventario/almacenamiento-privado.md`](../../docs/inventario/almacenamiento-privado.md).
