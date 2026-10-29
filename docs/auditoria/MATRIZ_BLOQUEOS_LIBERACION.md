# Matriz de bloqueos de liberación — Trueque IUB

**Fecha:** 2026-10-29.  
**Regla:** un bloqueo solo se cierra con evidencia y aprobación; no se rebaja por conveniencia técnica.  
**Alcance:** `0011` y administración existente. No se autoriza staging ni producción.

Clasificación:

- **Staging:** impide ejecutar la validación controlada en staging.
- **Producción:** impide operar en producción.
- **Módulo:** impide una función concreta, aunque el resto pueda validarse.

---

## 1. Bloqueos institucionales

| ID | Bloqueo | Alcance | Evidencia actual | Acción necesaria | Responsable propuesto |
|---|---|---|---|---|---|
| D-01 | Estado inicial de los 67 ejemplares | Producción / módulo inventario | Contención local; decisión no aprobada | Resolución institucional | Biblioteca / inventario |
| D-02 | Criterios de estado físico | Producción / módulo aceptación | Política pendiente | Aprobar umbral | Biblioteca / conservación |
| D-03 | Materiales no admisibles | Producción | Pendiente | Lista aprobada | Biblioteca / dirección |
| D-04 | Criterios de pertinencia | Producción | Pendiente | Política de colección | Comité de colección |
| D-05 | Anotaciones y subrayados | Producción | Pendiente | Regla aprobada | Biblioteca |
| D-06 | Duplicados | Producción | Pendiente | Regla de conservación/oferta | Biblioteca / catalogación |
| D-07 | Responsables y segregación | Staging (asignación real) / producción | Matriz no aprobada | Aprobar roles y separación | Dirección / talento humano |
| D-08 | Evidencias y conservación | Producción / módulo evidencias | Pendiente | Aprobar expediente y retención | Biblioteca / archivo |
| D-09 | Autoridad de habilitación | Producción | Pendiente | Designar autoridad | Dirección |
| D-10 | Bloqueo y baja | Producción | Pendiente | Aprobar estados y reversibilidad | Biblioteca |
| D-11 | Conservación de datos/auditoría | Producción | Pendiente | Política de retención | Archivo / jurídica |
| D-12 | ISBN ausente y metadatos | Producción | Pendiente | Regla de catalogación | Catalogación |
| D-13 | Almacenamiento privado de evidencias | **Módulo evidencias / producción** | Driver local falla cerrado; no hay proveedor | Aprobar proveedor, bucket, región, cifrado, costos | TI / seguridad |
| D-14 | Retención y borrado de evidencias | **Módulo evidencias / producción** | `0` = no borrar; no hay política | Aprobar plazo y borrado seguro | Archivo / jurídica |
| D-15 | EXIF/GPS y antimalware | **Módulo evidencias / producción** | No implementado | Aprobar y ejecutar sanitización/escaneo | Seguridad / TI |
| D-16 | Retención y acceso a Excel de lotes | **Módulo lotes / producción** | `0` = no borrar; no hay política | Aprobar retención y acceso | Archivo / TI / biblioteca |

**No se cierra ninguno con este expediente.**

---

## 2. Bloqueos técnicos de staging

| ID | Bloqueo | Evidencia | Acción | Responsable |
|---|---|---|---|---|
| S-01 | Autorización de staging | No existe acta | Autorización formal | Fundación / dirección |
| S-02 | Hash de `0011` | `df257...` inicial → `47383...` final | Aprobar el diff y el hash final | Arquitectura / seguridad |
| S-03 | Snapshot de staging | No ejecutado | Crear y verificar snapshot | TI / DBA |
| S-04 | Restauración probada | No ejecutada | Restaurar en base desechable y documentar | DBA |
| S-05 | Variables de entorno | No configuradas | Cargar en entorno privado | TI |
| S-06 | Roles y permisos | Matriz no aprobada | Aprobar y asignar mínimo privilegio | Dirección / TI |
| S-07 | Rate limiting distribuido | Mitigación local best-effort; no distribuida | Configurar borde/WAF o proveedor | Seguridad / TI |
| S-08 | OIDC/credenciales | No hay proveedor | Definir integración o mantener ADMIN_USERS controlado | TI / dirección |
| S-09 | Notificaciones | No hay correo | Configurar canal oficial | Biblioteca / TI |
| S-10 | Validación staging | No ejecutada | Ejecutar matriz de aceptación | QA / biblioteca |

---

## 3. Bloqueos técnicos de producción

| ID | Bloqueo | Evidencia | Acción | Responsable |
|---|---|---|---|---|
| P-01 | Autorización de producción | No existe | Resolución institucional | Fundación |
| P-02 | Staging validado | No validado | Completar expediente | QA |
| P-03 | OIDC | Pendiente | Implementar y probar | TI / seguridad |
| P-04 | Rate limiting distribuido | Pendiente; mitigación local best-effort | Implementar en borde/proveedor | Seguridad |
| P-05 | Almacenamiento privado D-13 | Pendiente | Contratar/configurar y probar | TI |
| P-06 | EXIF/antimalware D-15 | Pendiente | Implementar y probar | Seguridad |
| P-07 | Retención D-14/D-16 | Pendiente | Aprobar y automatizar con control | Archivo / jurídica |
| P-08 | Habilitación institucional | No existe rutina | Especificar, aprobar y probar | Biblioteca / desarrollo |
| P-09 | Restauración real de Neon | No probada | Probar snapshot/PITR | DBA |
| P-10 | Notificaciones | Pendiente | Configurar y probar | TI |
| P-11 | Matriz de roles | Pendiente | Aprobar y auditar | Dirección |
| P-12 | Carga/DAST | No ejecutadas | Planificar pruebas | Seguridad |

---

## 4. Bloqueos por módulo

| Módulo | Bloqueo | ¿Puede validarse staging sin cerrar? | Condición |
|---|---|---|---|
| Cuentas | OIDC no implementado | **Sí, parcialmente** | Actores creados no tendrán login hasta configurar `ADMIN_USERS`/OIDC |
| Solicitudes | Políticas D-02/D-08 | **Sí, con datos sintéticos** | No habilitar ejemplares ni aceptar libros reales |
| Lotes Excel | D-16 retención | **Sí, con archivos sintéticos** | No conservar datos reales sin política |
| Estadísticas | Ninguno crítico propio | **Sí** | Datos sintéticos y contraste SQL |
| Evidencias | D-13/D-14/D-15 | **No para fotos reales** | Sin proveedor privado, las cargas deben seguir bloqueadas |
| Habilitación | D-01–D-12/D-09 | **No** | No existe rutina aprobada |
| Conciliación física | D-01/D-02 | **Parcial** | Plantilla y procesador sin habilitar inventario |

---

## 5. Bloqueos de seguridad abiertos

| ID | Riesgo | Estado | Mitigación actual | Acción |
|---|---|---|---|---|
| SEC-01 | Fuerza bruta de login | Abierto | Hash scrypt; sin rate limit | Borde/WAF o proveedor |
| SEC-02 | Login CSRF | Mitigado | Origen validado | Mantener prueba |
| SEC-03 | Deactivated login | Abierto parcial | Permisos fallan después del login | Validar `is_active` en login o sesión |
| SEC-04 | Concurrencia de última cuenta | Aceptado con observación | `40P01` → `409 retry`; queda 1 admin | Advisory lock en `0012+` |
| SEC-05 | Evidencias EXIF/GPS | Abierto | Ninguna | D-15 |
| SEC-06 | Malware en archivos | Parcial | Parser XLSX estructural | Antimalware/D-15 |
| SEC-07 | URLs públicas de evidencias | No aplicable | Function + token; driver cerrado | Mantener |

---

## 6. Estado de validación

| Nivel | Estado | Evidencia |
|---|---|---|
| Local (unit/PGlite) | **Validado** | 192/192; build; lint |
| PostgreSQL real desechable | **Validado** | 11 migraciones, P0 15/15, API 2/2, audit sin errores |
| Staging | **No validado** | No se conectó staging |
| Producción | **No validado** | No autorizado |

---

## 7. Conclusión

`0011` está técnicamente lista para **someterse** a aprobación institucional con observaciones. No está lista para staging ni producción.

Los bloqueos de staging son de gobernanza, snapshot/restauración, variables, roles, hash y validación. Los bloqueos de producción incluyen todos los anteriores más OIDC, rate limiting, D-13/D-14/D-15/D-16, habilitación institucional, notificaciones y restauración real de Neon.

No se rebaja ningún bloqueo sin evidencia y aprobación formal.
