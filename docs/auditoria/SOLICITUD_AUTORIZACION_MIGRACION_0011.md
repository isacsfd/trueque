# Solicitud de autorización institucional — migración 0011

**Documento:** solicitud de revisión y autorización, no autorización concedida.  
**Fecha:** 2026-10-29.  
**Proyecto:** Trueque IUB.  
**Migración:** `0011_admin_accounts_and_request_guard.sql`.  
**Hash canónico final:** `47383d1c3412c4a9d9040f3faba685a697d5fd698a826e5d255b8564e81c230c`.  
**Hash anterior reportado:** `df257339f2243231b498f1a207f2803a4fd3477b5fdda184b87b901be19e036e`.

> **No se solicita autorización de producción.**  
> **No se declara staging aprobado ni validado.**  
> **No se solicita habilitar inventario, evidencias reales ni OIDC.**

---

## 1. Propósito de 0011

La migración incorpora y protege las funciones administrativas necesarias para:

- listar cuentas administrativas;
- crear actores de PostgreSQL sin crear credenciales;
- activar y desactivar actores;
- asignar y retirar roles con control de escalada;
- proteger la sesión propia y la última cuenta administradora;
- registrar auditoría de cambios de cuenta;
- impedir aprobaciones de solicitudes sobre ejemplares no disponibles, no reservados o institucionales no verificados;
- exigir motivo en aprobaciones y denegaciones;
- conceder al rol administrativo únicamente los accesos necesarios para estas operaciones.

No crea credenciales, no habilita inventario y no activa almacenamiento de evidencias.

---

## 2. Hash y desviación de proceso

### Versión final

`47383d1c3412c4a9d9040f3faba685a697d5fd698a826e5d255b8564e81c230c`

### Versión anterior reportada

`df257339f2243231b498f1a207f2803a4fd3477b5fdda184b87b901be19e036e`

### Desviación

Durante la revisión anterior se modificó `0011` sin autorización previa. La modificación fue necesaria porque la versión `df257...` no concedía al rol administrativo:

- `EXECUTE` de `assert_actor_permission`;
- `SELECT` de `request_status_history`;
- `SELECT` de `available_catalog`.

Sin esos grants, endpoints administrativos devolvían `403` en PostgreSQL real. La desviación está documentada en `REVISION_INDEPENDIENTE_0011.md` y no se oculta.

La autorización solicitada incluye aceptar expresamente el cambio de hash y el diff asociado.

---

## 3. Fallos reales encontrados

| Fallo | Impacto | Corrección |
|---|---|---|
| Sin `EXECUTE` de `assert_actor_permission` para admin runtime | `403` en bandeja, cuentas, estadísticas y lotes | Grant en `0011` |
| Sin `SELECT` de `request_status_history` | `403` al consultar historial | Grant en `0011` |
| Sin `SELECT` de `available_catalog` | `403` en estadísticas | Grant en `0011` |
| Prueba P0 aprobaba ejemplar no disponible | Contradecía la regla de negocio | Prueba corregida |
| Prueba API sin `reservation_policy` | Falso `409` en reservas | Fixture corregido |
| Login sin validación de origen | Login CSRF | Guard de origen |
| Cuenta desactivada podía iniciar sesión | Sesión administrativa indebida | Revalidación contra PostgreSQL |
| Cuenta desactivada conservaba acceso a perfil/sesión | Exposición administrativa | `assertActiveAdminActor` |
| `28000` no mapeado | Error genérico en actor inactivo | Mapeo a `401` |
| `ADMIN_USERS` ambiguo | Identidad duplicada | Rechazo de duplicados |

---

## 4. Evidencia PostgreSQL real

Validación en PostgreSQL 18 local desechable, sin Neon ni staging:

- 11 migraciones aplicadas.
- Segunda ejecución `up to date`.
- `test:postgres`: 15/15.
- `api-postgres`: 4/4.
- `audit:0011:postgres`: `errors: []`.
- Suite completa con PostgreSQL: 192/192.
- Build y lint correctos.
- `staging:check`: hashes correctos; falla por variables de staging ausentes.

Verificado:

- grants y revokes;
- triggers de aprobación, motivo e inmutabilidad;
- cuentas, roles, escalada y autoasignación;
- último administrador en concurrencia;
- aprobación/denegación con motivo;
- ausencia de recepción, admisión o movimiento al aprobar;
- lotes prevalidados/confirmados/cancelados e idempotencia;
- copias de lote `unavailable`/`unassessed`;
- aislamiento de evidencias;
- login y sesión de actor inactivo.

---

## 5. Riesgos residuales

| Riesgo | Estado |
|---|---|
| Rate limiting de login | Abierto; requiere borde/WAF o proveedor |
| OIDC / identidad institucional | Pendiente |
| Revocación individual de sesión stateless | Limitación; mitigada por expiración/revalidación/rotación |
| D-13 almacenamiento privado | Bloqueado |
| D-14 retención de evidencias | Bloqueado |
| D-15 EXIF/GPS y antimalware | Bloqueado |
| D-16 retención Excel | Bloqueado |
| D-01–D-12 habilitación | Bloqueado |
| Restauración real de Neon | No probada |
| Notificaciones | Pendiente |
| Matriz de roles | Pendiente |
| Deadlock de última cuenta | Aceptado con observación; `409 retry` |

Ninguno de estos riesgos se considera cerrado por esta solicitud.

---

## 6. Alcance exacto de la autorización solicitada

Se solicita autorización para:

1. Aceptar la migración `0011` con hash `47383d1c3412c4a9d9040f3faba685a697d5fd698a826e5d255b8564e81c230c`.
2. Aceptar el diff de grants y guards asociado.
3. Autorizar la **preparación** de staging con snapshot, restauración probada y ventana de cambio.
4. Autorizar la ejecución de la matriz de aceptación en staging, sin producción y sin habilitar inventario.
5. Autorizar la revisión de la matriz de roles y permisos por la fundación.

La autorización **no** incluye:

- producción;
- conexión a Neon desde esta revisión;
- despliegue automático;
- habilitación de ejemplares;
- activación de evidencias reales;
- contratación de servicios;
- OIDC;
- rate limiting;
- modificación de inventario o Excel;
- borrado de evidencias o lotes.

---

## 7. Condiciones previas a staging

- [ ] Aprobar el hash final y el diff.
- [ ] Aprobar matriz de roles.
- [ ] Snapshot y restauración probados.
- [ ] Variables de entorno configuradas sin exponer secretos.
- [ ] Roles runtime verificados.
- [ ] `npm run staging:check` sin variables faltantes.
- [ ] Ventana de cambio y responsables definidos.
- [ ] Criterios de suspensión aceptados.
- [ ] Plan de rollback/forward-fix aceptado.

---

## 8. Exclusiones explícitas

Esta solicitud **no** afirma que:

- staging esté aprobado;
- staging esté validado;
- producción esté autorizada;
- el sistema esté listo para liberación;
- OIDC esté implementado;
- el rate limiting esté resuelto;
- el almacenamiento de evidencias esté aprobado;
- la habilitación institucional exista.

---

## 9. Responsables y firmas

| Rol institucional | Nombre | Decisión | Fecha | Firma |
|---|---|---|---|---|
| Dirección / biblioteca | ____________________ | ____________________ | __________ | __________ |
| Seguridad / TI | ____________________ | ____________________ | __________ | __________ |
| Protección de datos | ____________________ | ____________________ | __________ | __________ |
| Administración / finanzas (si aplica) | ____________________ | ____________________ | __________ | __________ |
| Responsable de inventario | ____________________ | ____________________ | __________ | __________ |

**Estado:** pendiente de firmas.  
**No usar este documento como autorización hasta que las firmas y la decisión estén registradas.**
