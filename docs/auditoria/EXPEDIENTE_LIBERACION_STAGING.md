# Expediente de liberación a staging — Trueque IUB

**Estado:** expediente preparado; **staging no ejecutado ni validado**.  
**Fecha:** 2026-10-29.  
**Migración a someter:** `0011_admin_accounts_and_request_guard.sql`.  
**Hash final:** `47383d1c3412c4a9d9040f3faba685a697d5fd698a826e5d255b8564e81c230c`.  
**Veredicto:** aprobación técnica condicionada; **sin autorización de liberación**.

> Este expediente no autoriza staging ni producción. No se conectó Neon, no se conectó staging, no se aplicaron migraciones remotas y no se desplegó.

---

## 1. Precondiciones técnicas

- [ ] Código congelado y commit/referencia identificados.
- [ ] `0011` revisada y aprobada con el hash final.
- [ ] Diferencia entre el hash inicial `df257...` y el final `47383...` explicada y aceptada.
- [ ] `0007` y `0008` sin cambios.
- [ ] Migraciones `0001`–`0011` aplicadas en una base desechable.
- [ ] Segunda ejecución `up to date` verificada.
- [ ] `npm run test:postgres` aprobado en base desechable.
- [ ] Integración API–PostgreSQL aprobada.
- [ ] Build y lint aprobados.
- [ ] Variables de entorno revisadas sin exponer valores.
- [ ] Roles runtime con mínimo privilegio.
- [ ] Roles institucionales y responsables definidos.

---

## 2. Autorizaciones de la fundación

| Autorización | Estado | Observación |
|---|---|---|
| Autorización de staging | **Pendiente** | No existe evidencia de aprobación |
| Autorización de migración `0011` | **Pendiente** | El hash cambió durante la revisión |
| Matriz de roles y permisos | **Pendiente** | Debe aprobarse por la fundación |
| Protección de datos | **Pendiente** | Correo administrativo y retención |
| D-13 almacenamiento privado | **Pendiente** | Bloquea evidencias |
| D-14 retención de evidencias | **Pendiente** | Bloquea borrado/definición |
| D-15 EXIF/GPS y antimalware | **Pendiente** | Bloquea fotos reales |
| D-16 retención Excel de lotes | **Pendiente** | Bloquea política de conservación |
| D-01–D-12 inventario/habilitación | **Pendiente** | Bloquea habilitación institucional |
| OIDC / identidad | **Pendiente** | No hay credenciales propias |
| Restauración real de Neon | **Pendiente** | No probada |

---

## 3. Inventario de migraciones

| Versión | SHA-256 / estado |
|---|---|
| `0007_institutional_containment` | `5dd8a5e2743c9c998e15aacab2e3748d2fb4d42853271fe8d08968b17e6b6cd6` |
| `0008_containment_request_compat` | `49ec4788d6d811d24b85207911d6e7329f0d2094353ffe3a4e322423be79fbf9` |
| `0011_admin_accounts_and_request_guard` | `47383d1c3412c4a9d9040f3faba685a697d5fd698a826e5d255b8564e81c230c` |
| `0001`–`0010` | Verificar con `npm run db:migrate:plan` antes de la ventana |

No editar `0007`–`0011` después de aplicarlas. Cualquier corrección debe ser `0012+`.

---

## 4. Snapshot previo

Antes de la ventana:

1. Crear snapshot o punto de restauración de staging.
2. Confirmar que cubre la base completa.
3. Registrar identificador, fecha, responsable y retención.
4. No usar datos de producción.
5. No borrar el snapshot hasta cerrar la validación.

Criterio de aborto: si el snapshot no se puede crear o verificar, **no iniciar la migración**.

---

## 5. Restauración probada

La restauración debe probarse en una base desechable **antes** de la ventana:

1. Restaurar el snapshot en una instancia local/desechable.
2. Verificar ledger `schema_migrations`.
3. Verificar manifiesto.
4. Verificar roles y grants.
5. Verificar conteos de inventario, solicitudes y auditoría.
6. Ejecutar smoke tests sin habilitar inventario.
7. Destruir la instancia de prueba.

No se declara probada la restauración de Neon en esta revisión. Es un bloqueo de staging y producción.

---

## 6. Validación de recuperación

| Escenario | Resultado esperado | Evidencia requerida |
|---|---|---|
| Migración falla antes de commit | Base intacta; ledger sin fila nueva | Logs + snapshot |
| Migración falla a mitad | Rollback transaccional | Ledger + objetos |
| Migración aplica pero smoke falla | Forward-fix o restauración evaluada | Acta de decisión |
| Restauración necesaria | Base vuelve al snapshot; se documenta pérdida | Restore log |
| Roles/grants incorrectos | Detener y corregir con `0012+` | Consulta de privilegios |

---

## 7. Variables de entorno requeridas

Sin valores en este documento:

- `DATABASE_URL`
- `DATABASE_ADMIN_URL`
- `DATABASE_MIGRATION_URL`
- `DATABASE_MIGRATION_ROLE`
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
- `LOGIN_RATE_LIMIT_WINDOW_SECONDS`
- `LOGIN_RATE_LIMIT_MAX_ATTEMPTS`
- `LOGIN_RATE_LIMIT_IP_MAX_ATTEMPTS`

`DATABASE_MIGRATION_*` no debe estar en Functions de runtime.

---

## 8. Plan de ejecución y verificación

### Antes

```sh
npm run db:migrate:plan
npm run staging:check
npm run build
npm run lint
npm test
```

En base desechable:

```sh
npm run db:migrate:apply
npm run db:migrate:apply
npm run test:postgres
npx vitest run netlify/tests/api-postgres.test.ts
npm run audit:0011:postgres
```

### Durante staging

1. Confirmar snapshot y restauración probada.
2. Aplicar `0011` una sola vez.
3. Reejecutar para confirmar `up to date`.
4. Verificar grants/revokes y triggers.
5. Verificar login y sesión.
6. Verificar cuentas: listar, crear actor, activar/desactivar, asignar/retirar rol.
7. Verificar actor sin permisos y sesión inválida.
8. Verificar bandeja, historial, aprobación y denegación con motivo.
9. Verificar que aprobar no crea recepción, admisión, movimiento ni habilitación.
10. Verificar lote de prueba: prevalidar, confirmar, cancelar, reintentar.
11. Verificar estadísticas contra SQL independiente.
12. Verificar evidencias: sin URL pública y sin proveedor real.
13. Registrar resultados y hashes.

### Después

- Confirmar que inventario sigue sin habilitaciones no autorizadas.
- Confirmar que no se alteraron Excel originales.
- Confirmar que no se borraron evidencias/lotes.
- Cerrar acta de validación.

---

## 9. Criterios de rollback

### Rollback de código

- Revertir el despliegue de Functions/UI a la versión anterior.
- No requiere revertir la base.
- Verificar compatibilidad de la versión anterior con el esquema nuevo.

### Recuperación de base de datos

- Restaurar snapshot solo si hay daño de datos o inconsistencia grave.
- Evaluar pérdida de datos ocurrida después del snapshot.
- No ejecutar “down migrations” destructivas.
- No borrar filas del ledger.
- No editar `0007`–`0011`.
- Preferir `0012+` para forward-fix.
- Documentar causa, alcance, pérdida y validación.

### Criterios de suspensión

- Hash distinto.
- Migración no idempotente.
- Grants/revokes inesperados.
- Rol público con acceso administrativo.
- Pérdida del último administrador.
- Aprobación sin motivo o de ejemplar no elegible.
- Creación de admisión/movimiento al aprobar.
- Lote confirmado con copias disponibles o verificadas.
- Evidencias con URL pública.
- Fallo de backup/restauración.
- Cualquier operación que habilite inventario.

---

## 10. Pruebas de aceptación mínimas en staging

- [ ] Login y sesión expirada.
- [ ] CSRF y origen cruzado.
- [ ] Cuenta sin `account.manage` recibe `403`.
- [ ] Alta de actor sin credenciales.
- [ ] Activación/desactivación y roles.
- [ ] Último administrador activo protegido.
- [ ] Historial de solicitud visible.
- [ ] Aprobación/denegación con motivo.
- [ ] Aprobación de ejemplar no disponible rechazada.
- [ ] Aprobación sin recepción/admisión/movimiento.
- [ ] Lote prevalidado/confirmado/cancelado.
- [ ] Copias de lote `unavailable`/`unassessed`.
- [ ] Estadísticas contrastadas.
- [ ] Evidencias privadas sin URL pública.
- [ ] Rollback/restauración documentados.

---

## 11. Criterios para autorizar una liberación

La fundación solo debería autorizar staging si:

1. Hash y diff están aprobados.
2. Snapshot y restauración están probados.
3. Roles y permisos están aprobados.
4. La matriz de aceptación está firmada.
5. No hay hallazgos críticos abiertos.
6. Los bloqueos de staging están cerrados o aceptados formalmente.
7. El plan de rollback está aprobado.
8. Producción sigue fuera de alcance.

La liberación a producción requiere además OIDC, rate limiting distribuido, D-13, D-14, D-15, D-16, rutina de habilitación, notificaciones y restauración real de Neon. La mitigación local actual de login es best-effort y no sustituye el límite de borde.

---

## 12. Acciones prohibidas

- Conectarse a Neon o staging desde esta preparación.
- Aplicar migraciones remotas sin autorización.
- Desplegar.
- Hacer commit o push sin autorización.
- Editar `0007`–`0011`.
- Modificar Excel originales.
- Habilitar inventario.
- Borrar evidencias o lotes.
- Restaurar datos de producción en staging.
- Usar un snapshot no verificado.
- Declarar staging validado sin evidencia.
