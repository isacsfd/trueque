# Resumen ejecutivo — Trueque IUB

**Fecha:** 2026-10-29  
**Estado:** administración validada localmente y en PostgreSQL real desechable; **no autorizada para producción**.  
**Migración de referencia:** `0011_admin_accounts_and_request_guard.sql`  
**SHA-256:** `47383d1c3412c4a9d9040f3faba685a697d5fd698a826e5d255b8564e81c230c`

---

## 1. Qué está listo

- Flujo público sin registro: catálogo, propuesta de libro, fotografías, solicitud, seguimiento por código y token.
- Rate limiting local en endpoints públicos y login.
- Panel administrativo con solicitudes, revisión fotográfica, lotes, estadísticas, cuentas y “Mi cuenta”.
- Cuentas locales SP/AD provisionadas y verificadas en PostgreSQL desechable.
- Dos fuentes Excel inventariadas sin importar ni modificar.
- Gestión de actores administrativos: listado, alta, activación/desactivación y roles.
- Protección contra autocambio de roles, autodesactivación y escalada de privilegios.
- Auditoría de cambios de cuenta.
- Aprobación y denegación de solicitudes con motivo obligatorio, historial y validación del estado del ejemplar.
- Estadísticas con inventario, solicitudes, ofertas, recepciones, evaluaciones, admisiones, intercambios, lotes y tendencias.
- Lotes Excel con prevalidación, confirmación atómica, cancelación, idempotencia y copias no disponibles.
- Contención `0007`/`0008` intacta.
- Evidencias privadas con autorización por Function y almacenamiento real bloqueado.
- Riesgo de cuenta administrativa desactivada corregido: login y sesiones se revalidan contra PostgreSQL.
- Pruebas en PostgreSQL real y en PGlite: **192/192** con PostgreSQL desechable.
- Documentos de cierre: `CIERRE_SEGURIDAD_AUTENTICACION.md`, `MATRIZ_SEGURIDAD_SESIONES.md`, `SOLICITUD_AUTORIZACION_MIGRACION_0011.md`.

---

## 2. Qué no está listo

1. **OIDC:** no existe proveedor institucional. Crear una cuenta crea un actor de base, no credenciales de acceso.
2. **Rate limiting de login:** existe mitigación local best-effort por instancia; el límite distribuido/duradero sigue pendiente de borde Netlify/WAF o proveedor de identidad.
3. **Evidencias reales:** no hay bucket, credenciales ni lifecycle aprobados. D-13 pendiente.
4. **Antimalware/EXIF:** D-15 pendiente; no se declara implementado.
5. **Habilitación institucional:** no existe rutina transaccional aprobada para ejemplares institucionales conciliados.
6. **Notificaciones al solicitante:** no hay correo configurado.
7. **Producción:** no hay autorización, despliegue ni migraciones remotas.
8. **Carga/DAST/restauración real de Neon:** no ejecutados.

---

## 3. Riesgos que impiden liberar

| Riesgo | Nivel | Mitigación necesaria |
|---|---|---|
| Sin OIDC ni credenciales administradas por proveedor | Alto | Definir proveedor y flujo de alta/rotación |
| Sin rate limiting distribuido/duradero | Alto | Configurar borde/WAF o proveedor |
| Sin almacenamiento privado aprobado | Crítico para fotos | Aprobar D-13 e implementar adaptador |
| Sin antimalware/EXIF | Alto para fotos | Aprobar D-15 e implementar |
| Sin habilitación institucional | Crítico para inventario | D-01–D-12 y rutina transaccional |
| Sin notificaciones | Medio | Configurar correo o canal oficial |
| Sin restauración probada | Alto operativo | Probar snapshot en base desechable |

---

## 4. Decisiones de la fundación pendientes

- D-01 a D-16 siguen abiertas.
- D-13: proveedor, cuenta, bucket, región, cifrado y presupuesto.
- D-14: retención y borrado de evidencias.
- D-15: EXIF/GPS, re-codificación y antimalware.
- D-16: retención y acceso a Excel de lotes.
- Matriz de roles y responsables de cada permiso.
- Autorización de staging y, más adelante, de producción.

---

## 5. Clasificación de pendientes

### Resuelto y verificado

- Riesgo de cuenta administrativa desactivada.
- Login y sesiones existentes revalidan el actor activo.
- Grants faltantes de `0011` y endpoints administrativos.
- Deadlock de última cuenta/roles: no se pierde el último administrador; `409 retry`.
- Aprobación/denegación con motivo y guard de ejemplar.
- Lotes idempotentes y copias no disponibles.
- Estadísticas contrastadas contra SQL.
- Evidencias privadas a nivel de autorización y driver cerrado.

### Pendiente técnico

- Rate limiting distribuido/duradero de login (la mitigación local es best-effort).
- Revocación individual de sesiones stateless.
- Notificaciones al solicitante.
- Pruebas de carga/DAST.
- Corrección de la advertencia de `pg` en pruebas concurrentes.

### Pendiente institucional

- D-01 a D-16.
- Matriz de roles y responsables.
- Autorización de staging y producción.
- Política de retención, privacidad y aceptación.

### Pendiente infraestructura

- D-13 almacenamiento privado.
- D-15 antimalware/EXIF.
- Restauración real de Neon.
- Rate limiting en borde/WAF.
- OIDC.

### No verificable localmente

- staging real;
- producción;
- restauración de Neon;
- comportamiento de red y WAF;
- carga real.

## 6. Documentos operativos

- Conciliación física: `docs/inventario/README.md` y `docs/inventario/gestion-lotes-inventario.md`.
- Cuentas y permisos: `docs/administracion-cuentas.md`.
- Preparación de staging: `docs/auditoria/EXPEDIENTE_LIBERACION_STAGING.md`.
- Expediente de producción: `docs/auditoria/EXPEDIENTE_PRODUCCION.md`.
- Plan de staging y rollback: `docs/auditoria/PLAN_PREPARACION_STAGING.md`.
- Despliegue/rollback histórico: `docs/deployment-p0.md`.
- Revisión 0011: `docs/auditoria/REVISION_INDEPENDIENTE_0011.md`.
- Solicitud institucional: `docs/auditoria/SOLICITUD_AUTORIZACION_MIGRACION_0011.md`.

## 7. Próximo paso recomendado

1. Revisar y aprobar `0011` y los roles institucionales.
2. Preparar staging con snapshot, restauración probada y ventana de cambio.
3. Aplicar `0011` solo tras autorización.
4. Configurar `account.manage` para una persona responsable y separar permisos.
5. Ejecutar `npm run test:postgres`, la integración API–PostgreSQL y la matriz de aceptación.
6. Resolver OIDC, rate limiting y almacenamiento privado antes de habilitar usuarios y fotografías reales.
7. No habilitar inventario hasta contar con la rutina y las autorizaciones D-01–D-16.

## 7.1 Estado de producción

- El repositorio tiene un sitio Netlify vinculado en `.netlify/state.json`, pero no hay evidencia de que sea producción ni dominio verificado en el repositorio.
- No hay `.env` local ni variables de producción; solo `.env.example`.
- La documentación histórica indica staging con `0001`–`0005`; `0011` no está aplicada en staging y producción no está tocada.
- No hay snapshot/restauración de Neon probada.
- No hay OIDC, rate limiting de borde, almacenamiento privado ni antimalware.
- No hay acta de autorización de producción dentro del repositorio. La autorización reportada por el usuario no sustituye la verificación técnica ni las credenciales de plataforma.
- **Producción: BLOQUEADA.**

## 8. Decisión técnica

- **Migración `0011`:** LISTA PARA AUTORIZACIÓN INSTITUCIONAL, con observaciones.
- **Autenticación/sesiones:** riesgo de cuenta desactivada RESUELTO Y VERIFICADO.
- **Staging:** BLOQUEADO hasta autorización, snapshot/restauración, roles y validación controlada.
- **Producción:** BLOQUEADA.

**No se declara el sistema listo para producción.** La administración está técnicamente validada; los bloqueos restantes son institucionales y de infraestructura.
