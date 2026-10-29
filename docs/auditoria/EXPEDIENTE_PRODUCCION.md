# Expediente técnico de producción — Trueque IUB

**Fecha:** 2026-10-29.  
**Estado:** expediente de preparación; **producción no habilitada ni desplegada**.  
**Migración de referencia:** `0011_admin_accounts_and_request_guard.sql`  
**Hash:** `47383d1c3412c4a9d9040f3faba685a697d5fd698a826e5d255b8564e81c230c`.

> Autorización institucional reportada por el usuario: se registra como contexto, no como evidencia técnica ni como permiso de plataforma. No se ejecutó ninguna operación remota.

---

## 1. Destino y entorno

| Entorno | Evidencia | Estado |
|---|---|---|
| Desarrollo local | `npm run dev` (Vite); Functions no se sirven con Vite. | **Parcial**: frontend solamente |
| Staging | `docs/staging.md`: `https://trueque-staging-2026.netlify.app`; Netlify `trueque-staging-2026` (`03cb4fd6-5289-4fe4-9379-9a7806ab1ea9`); Neon `trueque-staging-2026` (`withered-dream-91939533`), PostgreSQL 18.6, base `trueque_staging`, rama `production`. | **Documentado; no verificado en esta sesión** |
| Producción | No hay sitio, dominio, proyecto Neon, variables ni snapshot de producción identificados en el repositorio. | **BLOQUEADO** |

- `.netlify/state.json` contiene el `siteId` del sitio de staging documentado. No hay evidencia de que sea producción.
- No hay `.env` local ni valores privados en el repositorio.
- No se abrió ningún panel remoto ni se ejecutó `netlify` contra un sitio.

---

## 2. Variables requeridas

Lista estática derivada del código y `.env.example`. No se imprimen valores.

### Runtime de Functions

- `DATABASE_URL`
- `DATABASE_ADMIN_URL`
- `ADMIN_USERS`
- `SESSION_SECRET`
- `PARTICIPANT_DATA_KEY`
- `PARTICIPANT_IDENTITY_HMAC_KEY`
- `PARTICIPANT_DATA_KEY_VERSION`
- `PARTICIPANT_HMAC_KEY_VERSION`
- `PRIVACY_NOTICE_VERSION`
- `PRIVATE_STORAGE_DRIVER`
- `STORAGE_ORPHAN_GRACE_DAYS`
- `EVIDENCE_RETENTION_DAYS`
- `BATCH_RETENTION_DAYS`
- `ALLOW_LEGACY_REQUEST_INTAKE=false`

### Opcionales / borde

- `LOGIN_RATE_LIMIT_WINDOW_SECONDS`
- `LOGIN_RATE_LIMIT_MAX_ATTEMPTS`
- `LOGIN_RATE_LIMIT_IP_MAX_ATTEMPTS`
- `DATABASE_DIAGNOSTICS_TOKEN` (solo diagnóstico; no es requisito funcional)

### Solo entorno de migración

- `DATABASE_MIGRATION_URL`
- `DATABASE_MIGRATION_ROLE`
- `DATABASE_MIGRATION_DRIVER`

`DATABASE_MIGRATION_*` no debe estar en Functions de runtime.

### Estado local

`npm run staging:check` reporta variables faltantes porque no hay `.env`; los hashes de migraciones sí coinciden. No se declara configuración de staging/producción.

---

## 3. Neon, migraciones y recuperación

| Control | Evidencia | Estado |
|---|---|---|
| Baseline local `0001`–`0011` | PostgreSQL 18 desechable; 11 aplicadas; segunda ejecución `up to date`. | **Aprobado local** |
| Staging | Documentación histórica indica `0001`–`0005`; `0006`–`0011` no aplicadas. | **Pendiente** |
| Producción | No creada/tocada. | **Bloqueado** |
| `0011` | Hash `47383d...`; no modificada. | **Aprobado técnico condicionado** |
| Snapshot de staging | Documentado; no verificado en esta sesión. | **Pendiente** |
| Restauración de staging | Rama `staging-restore-2026-10-28` documentada; no probada aquí. | **Pendiente** |
| Snapshot de producción | No existe evidencia. | **Bloqueado** |
| Rollback | Forward-only documentado; no se probó restauración real de Neon. | **Pendiente** |
| Smoke tests staging | Documentados de una fase anterior; no reproducidos en esta sesión. | **Reportado, no verificado** |

La recuperación no debe consistir en revertir migraciones destructivamente. Debe basarse en snapshot/PITR verificado, evaluación de pérdida de datos y forward-fix `0012+` cuando corresponda.

---

## 4. Bloqueos D-01–D-16

| ID | Estado | Responsable propuesto |
|---|---|---|
| D-01 Estado inicial de los 67 ejemplares | PENDIENTE INSTITUCIONAL | Biblioteca / inventario |
| D-02 Criterios de estado físico | PENDIENTE INSTITUCIONAL | Biblioteca / conservación |
| D-03 Materiales no admisibles | PENDIENTE INSTITUCIONAL | Biblioteca / dirección |
| D-04 Pertinencia | PENDIENTE INSTITUCIONAL | Comité de colección |
| D-05 Anotaciones y subrayados | PENDIENTE INSTITUCIONAL | Biblioteca |
| D-06 Duplicados | PENDIENTE INSTITUCIONAL | Biblioteca / catalogación |
| D-07 Responsables y segregación | PENDIENTE INSTITUCIONAL | Dirección / talento humano |
| D-08 Evidencias y conservación | PENDIENTE INSTITUCIONAL | Biblioteca / archivo |
| D-09 Autoridad de habilitación | PENDIENTE INSTITUCIONAL | Dirección |
| D-10 Bloqueo y baja | PENDIENTE INSTITUCIONAL | Biblioteca / patrimonio |
| D-11 Conservación de datos y auditoría | PENDIENTE INSTITUCIONAL | Archivo / jurídica |
| D-12 ISBN y metadatos | PENDIENTE INSTITUCIONAL | Catalogación |
| D-13 Almacenamiento privado | PENDIENTE INFRAESTRUCTURA | TI / seguridad |
| D-14 Retención de evidencias | PENDIENTE INSTITUCIONAL | Archivo / jurídica |
| D-15 EXIF/GPS y antimalware | PENDIENTE INSTITUCIONAL / TI | Seguridad / TI |
| D-16 Retención de Excel | PENDIENTE INSTITUCIONAL / TI | Archivo / TI / biblioteca |

Ninguna está aprobada por este expediente.

---

## 5. Matriz de salida

| Control | Evidencia comprobada | Estado | Responsable | Acción concreta | Criterio verificable de cierre |
|---|---|---|---|---|---|
| Dominio y destino | `.netlify/state.json` apunta al sitio staging documentado; no hay dominio de producción. | **BLOQUEADO** | TI / comunicaciones | Definir sitio, dominio y certificado de producción | URL y `siteId` confirmados; DNS/SSL verificados; ventana aprobada |
| Variables privadas | `.env.example` y código; no hay `.env` local ni valores. | **PENDIENTE** | TI / seguridad | Cargar variables por alcance en el entorno autorizado | `staging:check`/preflight sin faltantes, sin secretos en repo/logs |
| Snapshot | No ejecutado. | **BLOQUEADO** | DBA / TI | Crear snapshot de producción/staging antes de cambios | Snapshot identificado y restaurado en base desechable |
| Restauración | No probada en Neon. | **BLOQUEADO** | DBA | Probar restauración y medir pérdida/ventana | Restore documentado, conteos y ledger verificados |
| Migraciones | Local 11/11; staging 0001–0005 documentado; producción intacta. | **PENDIENTE** | Arquitectura / DBA | Aplicar `0006`–`0011` solo con autorización y preflight | Migraciones aplicadas, segunda ejecución `up to date`, hashes iguales |
| RBAC y cuentas | 0011 y pruebas locales; SP/AD solo locales. | **PENDIENTE** | Dirección / TI | Aprobar matriz de roles y provisionar cuentas por procedimiento | Roles aprobados; actores activos; sin privilegios extra |
| Almacenamiento privado | Driver local falla cerrado; no hay proveedor aprobado. | **BLOQUEADO** | TI / seguridad | Aprobar D-13 e implementar adaptador real | Bucket privado, cifrado, lifecycle y pruebas de acceso |
| EXIF/GPS y antimalware | No implementado. | **BLOQUEADO** | Seguridad / TI | Aprobar D-15 e implementar sanitización/escaneo | Fotos sanitizadas y escaneadas; pruebas negativas |
| Rate limiting de borde | Solo rate limit local por instancia. | **PENDIENTE** | Seguridad / TI | Configurar WAF/borde o proveedor | Límite distribuido probado y monitoreado |
| Protección de datos | Cifrado de participantes, consentimiento y minimización parcial; documento sigue siendo obligatorio. | **PENDIENTE** | Jurídica / privacidad | Aprobar necesidad y retención de documento | Política y aviso aprobados; campos justificados |
| Notificaciones | No hay canal configurado. | **PENDIENTE** | Biblioteca / TI | Definir canal y plantilla sin datos excesivos | Notificación enviada con código/estado, sin PII innecesaria |
| Habilitación de ejemplares | No existe rutina institucional; 67 sin conciliar. | **BLOQUEADO** | Biblioteca / dirección | Aprobar D-01–D-12 y rutina transaccional | Procedimiento probado; ejemplares habilitados solo por autorización |
| Smoke tests y rollback | Smoke tests locales y staging históricos; no reproducidos en producción. | **PENDIENTE** | QA / DBA | Ejecutar matriz en staging y ensayar rollback | Acta firmada, resultados y rollback verificado |

---

## 6. Cierre funcional

### 6.1 Devolver el motivo de rechazo

Hoy `request_status` devuelve estado, ejemplar y recepción, pero **no el motivo**. El motivo está en `request_status_history` y se muestra a administradores.

No se implementó un cambio porque requiere modificar la función/consulta de estado y, probablemente, una migración autorizada. Propuesta segura:

- nueva función de estado que reciba código + token y devuelva `decision_reason` únicamente para la solicitud autenticada;
- sanear el texto y no devolver datos del actor;
- exponerlo solo al solicitante con token válido;
- prueba de IDOR y de no exposición en catálogo/bandeja;
- autorización específica para la migración/función.

**Estado:** PENDIENTE TÉCNICO; no bloquea el flujo actual, que muestra el estado.

### 6.2 Notificar decisiones

No hay proveedor de correo/canal. No se inventó uno. Propuesta:

- canal institucional aprobado (correo institucional o notificación interna);
- mensaje mínimo: código de solicitud, estado y enlace/instrucción de consulta;
- no incluir nombre, documento, fotografías ni token en el asunto/log;
- el token se obtiene por el canal seguro ya existente o se solicita al usuario;
- auditoría del envío sin cuerpo sensible.

**Estado:** PENDIENTE INFRAESTRUCTURA / INSTITUCIONAL.

### 6.3 Documento de identidad

Actualmente el documento es obligatorio, se cifra y se usa para identidad/detección de duplicados. No se elimina en esta fase porque cambiaría el contrato y la política de privacidad.

Opciones para decisión:

- conservarlo con finalidad, retención y acceso definidos;
- sustituirlo por correo + nombre, aceptando menor capacidad de deduplicación;
- solicitarlo solo en recepción física, no en el formulario público;
- eliminar el dato tras el cierre con auditoría.

**Estado:** PENDIENTE INSTITUCIONAL / PRIVACIDAD. Requiere decisión y, si cambia el contrato, migración/función autorizada.

---

## 7. Secuencia reversible recomendada

1. Aprobar D-01–D-16 y matriz de roles.
2. Definir sitio/dominio/proyecto Neon de producción.
3. Crear snapshot y probar restauración en base desechable.
4. Configurar variables privadas sin exponerlas.
5. Aplicar migraciones de forma controlada y forward-only.
6. Ejecutar smoke tests con datos sintéticos y SP/AD de staging.
7. Verificar que los 67 ejemplares siguen no habilitados.
8. Aprobar liberación; desplegar código solo entonces.
9. Si falla: restaurar snapshot evaluando pérdida, o forward-fix `0012+`; no borrar ledger ni hacer drops destructivos.

---

## 8. Decisión

- **Staging:** documentado, pero no validado en esta sesión.
- **Producción:** **BLOQUEADA**.
- **`0011`:** técnicamente lista para autorización, no aplicada en remoto.
- **Inventario:** 67 ejemplares siguen sin habilitación; no se alteró nada.
- **D-01–D-16:** pendientes.

No se declara producción lista.
