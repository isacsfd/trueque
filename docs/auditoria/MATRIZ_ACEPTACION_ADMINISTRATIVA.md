# Matriz de aceptación administrativa — Trueque IUB

**Fecha:** 2026-10-29  
**Base:** migraciones `0001`–`0011`; `0011` con SHA-256 `47383d1c3412c4a9d9040f3faba685a697d5fd698a826e5d255b8564e81c230c`.

**Estados:** `Aprobado`, `Fallido`, `Bloqueado`, `No ejecutado`.  
Se indica el nivel de evidencia: **PostgreSQL real**, **PGlite en memoria**, **unitario**, **DOM/UI**, **inferido**.

---

## 1. Cuentas administrativas

| ID | Caso | Precondición | Esperado | Resultado real | Evidencia | Estado |
|---|---|---|---|---|---|---|
| CU-01 | Consultar cuentas | Actor con `account.manage` | Lista con identidad, estado, roles y permisos; sin secretos | Lista obtenida, sin columnas de contraseña/hash | `audit:0011:postgres`, `admin-accounts.test.ts`, API real | **Aprobado** |
| CU-02 | Crear actor administrativo | `account.manage` | Crea actor sin credenciales | Actor creado; `app_users` sin columnas de contraseña/hash; aviso de `ADMIN_USERS`/OIDC | PostgreSQL real + unitario | **Aprobado** |
| CU-03 | Activar/desactivar | `account.manage`; objetivo distinto del actor | Cambia estado y audita | Desactivación/activación auditadas | PostgreSQL real | **Aprobado** |
| CU-04 | Asignar rol | Roles con permisos que el actor ya posee | Asigna y audita | Rol asignado; auditoría `account.role_assigned` | PostgreSQL real | **Aprobado** |
| CU-05 | Retirar rol | `account.manage`; objetivo distinto | Retira y audita | Rol retirado; auditoría `account.role_removed` | PostgreSQL real | **Aprobado** |
| CU-06 | Consultar permisos efectivos | Cuenta con roles | Permisos derivados de roles | Lista devuelve roles y permisos efectivos | PostgreSQL real | **Aprobado** |
| CU-07 | Actor sin privilegios | Usuario sin `account.manage` | `403` | `42501` y rechazo | PostgreSQL real + unitario | **Aprobado** |
| CU-08 | Sesión inválida | Sin cookie o cookie expirada | `401` | Rechazo | `auth.test.ts`, unitario | **Aprobado** |
| CU-09 | Escalada de privilegios | Actor intenta asignar rol con permisos que no tiene | Rechazo | `42501` | PostgreSQL real | **Aprobado** |
| CU-10 | Autocambio de roles | Actor intenta modificar sus roles | Rechazo | `42501` | PostgreSQL real | **Aprobado** |
| CU-11 | Autodesactivación | Actor intenta desactivarse | Rechazo | `42501`; queda al menos una cuenta administradora activa | PostgreSQL real | **Aprobado** |
| CU-12 | Creación de credenciales | Alta de cuenta | No crea contraseña ni token | No hay columnas de credenciales; el login sigue externo | PostgreSQL real + UI | **Aprobado con limitación** |
| CU-13 | Desactivación mutua concurrente | Dos administradores activos | No perder el último administrador | Una operación gana, otra recibe `40P01/409`; queda 1 activo | PostgreSQL real, 10 repeticiones | **Aprobado con observación** |
| CU-14 | Retirada mutua concurrente de roles | Dos administradores activos | No perder el último rol administrador | Una operación gana, otra recibe `40P01/409`; queda 1 rol | PostgreSQL real, 5 repeticiones | **Aprobado con observación** |

---

## 2. Solicitudes y decisiones

| ID | Caso | Precondición | Esperado | Resultado real | Evidencia | Estado |
|---|---|---|---|---|---|---|
| SO-01 | Listar solicitudes | `requests.review` | Bandeja con contexto | Lista real con estados y datos no personales | API real | **Aprobado** |
| SO-02 | Filtrar por estado | Bandeja cargada | Filtro local por estado | Probado en DOM | UI test | **Aprobado** |
| SO-03 | Ver historial | Solicitud con decisiones | Historial con estado, fecha, actor y motivo | Historial real devuelto por la bandeja | API real | **Aprobado** |
| SO-04 | Aprobar con motivo | Solicitud `under_review`; ejemplar elegible | Cambia a `approved` y audita | Aprobación real con motivo | API real + PostgreSQL real | **Aprobado** |
| SO-05 | Rechazar con motivo | Solicitud `under_review` | Cambia a `rejected` y audita | Rechazo real con motivo | PostgreSQL real | **Aprobado** |
| SO-06 | Aprobar sin motivo | Solicitud `under_review` | Rechazo | `400` en API y `23514` en historial sin motivo | Unitario + PostgreSQL real | **Aprobado** |
| SO-07 | Aprobar ejemplar no disponible | Ejemplar `maintenance` | Rechazo | `23514` | PostgreSQL real | **Aprobado** |
| SO-08 | Aprobar ejemplar no verificado | Ejemplar institucional sin verificación | Rechazo | La contención `0007`/`0008` impide que sea objetivo/reservable; el guard de aprobación añade defensa en profundidad | PostgreSQL real P0 + revisión de SQL | **Aprobado con limitación** |
| SO-09 | Aprobar no crea recepción | Aprobación válida | Sin recepción, admisión, movimiento ni entrega | `0` recepciones, `0` admisiones, `0` movimientos | PostgreSQL real | **Aprobado** |
| SO-10 | Doble aprobación | Repetir la misma transición | Idempotente, sin duplicar historial | Una sola fila `approved` | PGlite/PostgreSQL real | **Aprobado** |
| SO-11 | Concurrencia de reservas | Dos clientes | Una sola reserva activa | Serialización correcta | PostgreSQL real P0 | **Aprobado** |
| SO-12 | Solicitud sobre ejemplar institucional no verificado | Contención 0007/0008 | Rechazo | Guard de contención | PostgreSQL real P0 | **Aprobado** |

---

## 3. Lotes de inventario

| ID | Caso | Precondición | Esperado | Resultado real | Evidencia | Estado |
|---|---|---|---|---|---|---|
| LO-01 | Inspeccionar Excel | Archivo `.xlsx` real | Hojas, encabezados y muestra | Parser y handler probados | Unitario + handler | **Aprobado** |
| LO-02 | Mapear columnas | Encabezados detectados | Mapeo explícito | Validado | Unitario + UI | **Aprobado** |
| LO-03 | Prevalidar | Mapeo válido | Persiste lote sin tocar inventario | `prevalidated` | PostgreSQL real | **Aprobado** |
| LO-04 | Cancelar | Lote prevalidado | Cancela sin copias | `cancelled`; 0 copias | PostgreSQL real | **Aprobado** |
| LO-05 | Confirmar | Lote prevalidado | Crea copias `unavailable`/`unassessed` | Copia real con `verified_at = NULL` | PostgreSQL real | **Aprobado** |
| LO-06 | Reintentar confirmación | Lote confirmado | Mismos conteos, sin duplicados | Replay idéntico | PostgreSQL real | **Aprobado** |
| LO-07 | Error por fila | Fila inválida | Rechazo/advertencia visible y reporte | Probado en validador y PGlite | PGlite/unitario | **Aprobado** |
| LO-08 | Rollback | Fila inválida en confirmación | No deja copias parciales | Transacción atómica | PGlite | **Aprobado** |
| LO-09 | Integridad del inventario | Confirmación | Sin movimientos ni habilitación | 0 movimientos | PostgreSQL real | **Aprobado** |
| LO-10 | Reporte CSV | Lote con errores | Descarga neutralizada | Fórmulas neutralizadas | Handler test | **Aprobado** |

---

## 4. Estadísticas

| ID | Caso | Precondición | Esperado | Resultado real | Evidencia | Estado |
|---|---|---|---|---|---|---|
| ES-01 | Inventario total/institucional | `stats.read` | Totales reales | Contraste con `SELECT count(*)` real | API real + SQL | **Aprobado** |
| ES-02 | Disponibilidad y reservas | `stats.read` | Conteos por estado | Datos reales | API real | **Aprobado** |
| ES-03 | Pendientes de verificación | `stats.read` | `verified_at IS NULL` | Métrica `unverified` | API real | **Aprobado** |
| ES-04 | Solicitudes por estado | `stats.read` | Suma coincide con tabla | Contraste con SQL independiente | API real | **Aprobado** |
| ES-05 | Ofertas en revisión | `stats.read` | `pending_review` + `in_review` | Métrica `offersInReview` | API real + UI | **Aprobado** |
| ES-06 | Recepciones/evaluaciones/admisiones | `stats.read` | Agrupadas por estado | Datos reales | API real | **Aprobado** |
| ES-07 | Intercambios completados | `stats.read` | Conteo y tendencia | `exchanges.completed` | API real | **Aprobado** |
| ES-08 | Lotes y resultados | `stats.read` | Nuevos e históricos separados | Métricas reales | API real | **Aprobado** |
| ES-09 | Rango mensual | `months=1..12` | Acepta rango; rechaza fuera | `400` fuera de rango | Unitario + API | **Aprobado** |
| ES-10 | Permiso insuficiente | Sin `stats.read` | `403` | Rechazo | Unitario | **Aprobado** |

---

## 5. Cuenta personal y contraseña

| ID | Caso | Precondición | Esperado | Resultado real | Evidencia | Estado |
|---|---|---|---|---|---|---|
| CP-01 | Ver cuenta | Sesión válida | Usuario, actor y expiración | Endpoint existente | Unitario | **Aprobado** |
| CP-02 | Intento de cambio de contraseña | Sesión válida | Mensaje de gestión externa; sin almacenamiento | `409 password_managed_externally` | Unitario | **Aprobado** |
| CP-03 | Falsa función de cambio | UI | No mostrar formulario funcional | Formulario eliminado; aviso explícito | UI test/build | **Aprobado** |
| CP-04 | Almacenamiento local de contraseñas | Cualquier flujo | No debe existir | No hay tabla/columna de contraseñas | PostgreSQL real | **Aprobado** |

---

## 6. Evidencias

| ID | Caso | Precondición | Esperado | Resultado real | Evidencia | Estado |
|---|---|---|---|---|---|---|
| EV-01 | Acceso con token de dueño | Token válido | Imagen privada, sin URL pública | Handler y pruebas | Unitario | **Aprobado** |
| EV-02 | Acceso administrativo | `offered_books.review` | Imagen autorizada | Handler y pruebas | Unitario | **Aprobado** |
| EV-03 | Aislamiento | Token de otro borrador | No acceso | Función DB + token | Unitario/PGlite | **Aprobado** |
| EV-04 | Lectura pública de metadata | Rol público | Denegada | `public_evidence_read = false` | PostgreSQL real | **Aprobado** |
| EV-05 | Driver en producción | Netlify Functions sin proveedor | Falla cerrado | `local`/`simulated` rechazados | `private-storage.test.ts` | **Aprobado** |
| EV-06 | Proveedor real | Bucket/credenciales aprobados | Carga privada real | No existe proveedor | — | **Bloqueado** |
| EV-07 | EXIF/GPS y antimalware | Fotos reales | Sanitizar/escanear | No implementado | — | **Bloqueado** |

---

## 7. Seguridad y validación

| ID | Caso | Esperado | Resultado real | Evidencia | Estado |
|---|---|---|---|---|---|
| SE-01 | CSRF en acciones admin | Marcador + mismo origen | Rechazo sin marcador | Unitario | **Aprobado** |
| SE-02 | CSRF de login | Origen cruzado rechazado | `403` | `admin-session.test.ts` | **Aprobado** |
| SE-03 | Cookie endurecida | `HttpOnly`, `SameSite=Strict`, `Secure` en HTTPS | Correcto | Unitario | **Aprobado** |
| SE-04 | Expiración de sesión | Token vencido rechazado | Correcto | `auth.test.ts` | **Aprobado** |
| SE-05 | Inyección SQL | Consultas parametrizadas | Sin concatenación de datos | Revisión + pruebas | **Aprobado** |
| SE-06 | Escalada de privilegios | Roles con permisos superiores | Rechazo | PostgreSQL real | **Aprobado** |
| SE-07 | IDOR/BOLA | Acceso por ID sin permiso | Rechazo | Handlers + RBAC | **Aprobado** |
| SE-08 | Secretos en respuestas | No exponer hashes/tokens | Respuestas de cuentas sin secretos | Unitario + API real | **Aprobado** |
| SE-09 | Auditoría sin datos sensibles | Metadatos técnicos | Sin correo/contraseña | PostgreSQL real | **Aprobado** |
| SE-10 | Archivos maliciosos | ZIP bomb/macros/fórmulas | Rechazo/sin ejecución | Parser XLSX | **Aprobado** |
| SE-11 | Fórmulas CSV | Neutralizadas | Prefijo seguro | Handler test | **Aprobado** |
| SE-12 | Rate limiting de login | Límite duradero | No implementado | — | **Bloqueado** |
| SE-13 | Pruebas de carga/DAST | Sin hallazgos críticos | No ejecutadas | — | **No ejecutado** |

---

## 8. Resumen

- **Aprobado:** cuentas, solicitudes, lotes, estadísticas, cuenta personal, privacidad de evidencias a nivel de autorización y controles principales.
- **Aprobado con limitación:** alta de cuentas sin credenciales propias.
- **Bloqueado:** proveedor de evidencias, antimalware/EXIF, rate limiting distribuido, OIDC, habilitación institucional.
- **No ejecutado:** carga, penetración y restauración real de Neon.

Ningún caso marcado como aprobado sustituye las decisiones institucionales D-01–D-16 ni la autorización de producción.
