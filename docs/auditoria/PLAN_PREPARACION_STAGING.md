# Plan de preparación para staging — Trueque IUB

**Estado:** plan; no ejecutado.  
**Base:** migraciones `0001`–`0011`; `0011` con SHA-256 `47383d1c3412c4a9d9040f3faba685a697d5fd698a826e5d255b8564e81c230c`.  
**Regla:** ninguna acción remota se ejecuta sin autorización institucional expresa y ventana de cambio.

---

## 1. Precondiciones

1. Aprobación formal de la migración `0011` y del alcance administrativo.
2. Autorización de staging por la fundación; producción sigue fuera de alcance.
3. Ventana de cambio con responsable, hora y canal de escalamiento.
4. Snapshot/PITR de staging verificado antes de la ventana.
5. Restauración del snapshot probada en una base desechable.
6. Roles `iub_schema_migrator`, `iub_public_runtime` e `iub_admin_runtime` existentes, `NOINHERIT`, sin privilegios excesivos.
7. Matriz de roles y responsabilidades aprobada por la fundación.
8. Decisiones D-01–D-16 revisadas; en particular D-13 (almacenamiento), D-14/D-16 (retención) y D-15 (EXIF/antimalware).
9. Código congelado para la ventana; sin cambios no revisados.
10. `npm run db:migrate:plan` revisado y hashes esperados confirmados.

---

## 2. Backup y restauración

### Antes de la ventana

- Crear snapshot o punto de restauración de staging.
- Verificar que el snapshot cubre la base completa, no solo el esquema.
- Registrar identificador, fecha, responsable y retención del backup.
- Probar la restauración en una base desechable y documentar el resultado.
- No restaurar datos de producción en staging.
- No reutilizar una base con datos de trabajo.

### Durante la ventana

- No borrar el snapshot hasta cerrar la validación.
- No ejecutar `DROP`, `TRUNCATE` ni restauración destructiva sobre staging.
- Si falla la migración, detener y evaluar rollback por snapshot o forward-fix.

### Después de la ventana

- Conservar el backup según la política institucional.
- Registrar el resultado y los hashes aplicados.
- No borrar el ledger de migraciones.

---

## 3. Autorizaciones necesarias

| Autorización | Para qué |
|---|---|
| Dirección / biblioteca | Alcance de cuentas, solicitudes y lotes |
| Seguridad / TI | Roles, permisos, sesiones y migración |
| Protección de datos | Campos personales y retención |
| D-13 | Proveedor y configuración de almacenamiento privado |
| D-14 / D-16 | Retención y borrado de evidencias y Excel |
| D-15 | EXIF/GPS, re-codificación y antimalware |
| D-01–D-12 | Políticas de inventario, aceptación y habilitación |

Sin estas autorizaciones no se habilita inventario ni se activa almacenamiento real.

---

## 4. Variables necesarias (sin exponer valores)

Configurar en el entorno privado de Functions, nunca en el repositorio ni en `VITE_*`:

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

`DATABASE_MIGRATION_URL` y `DATABASE_MIGRATION_ROLE` solo deben existir en el entorno protegido que ejecuta migraciones, no en las Functions de runtime.

---

## 5. Validaciones previas

Ejecutar sin conectarse a producción:

```sh
npm run db:migrate:plan
npm run staging:check
npm run build
npm run lint
npm test
```

Además:

- Revisar que `PRIVATE_STORAGE_DRIVER` no sea `local` ni `simulated` en staging.
- Verificar que `ALLOW_LEGACY_REQUEST_INTAKE` sea `false`.
- Verificar que los roles runtime no tengan DDL ni DML directo.
- Verificar que `account.manage` no esté concedido al rol público.
- Verificar que `request_status_history` y `available_catalog` sean legibles solo por el rol administrativo.
- Probar concurrencia de desactivación/roles: si PostgreSQL devuelve `40P01`, la UI/API debe reintentar con `409`; verificar que quede al menos una cuenta administradora activa.
- Confirmar que `ADMIN_USERS` referencia actores existentes y activos.
- Confirmar que los actores tienen roles y permisos mínimos.

---

## 6. Secuencia de aplicación

1. Abrir ventana y registrar responsables.
2. Confirmar snapshot y restauración probada.
3. Ejecutar `npm run db:migrate:plan` y comparar hashes.
4. Ejecutar `npm run db:migrate:apply` una sola vez.
5. Ejecutar de nuevo para confirmar `up to date`.
6. Verificar funciones, grants, triggers e índices.
7. Ejecutar pruebas de smoke autenticadas.
8. Validar métricas contra SQL independiente.
9. Validar aprobación/denegación con motivos y estados.
10. Validar lote de prueba sin habilitar inventario.
11. Registrar evidencias de aceptación.
12. Cerrar la ventana o ejecutar rollback.

---

## 7. Rollback

- Preferir **forward-fix** con una migración nueva `0012+`.
- No editar `0007`–`0011` una vez aplicadas.
- No borrar filas del ledger ni del manifiesto.
- No eliminar objetos manualmente.
- Si la base queda inconsistente, restaurar el snapshot verificado.
- Después de restaurar, comprobar ledger, manifiesto y permisos.
- Documentar causa, alcance, decisión y validación posterior.

---

## 8. Criterios de salida

Staging se considera preparado solo si:

- [ ] `0011` aplicada y segunda ejecución `up to date`.
- [ ] Hashes de migraciones coinciden.
- [ ] Roles y grants efectivos verificados.
- [ ] `npm run test:postgres` pasa en base desechable/staging controlado.
- [ ] Integración API–PostgreSQL pasa.
- [ ] Cuentas, solicitudes, lotes y estadísticas pasan smoke tests.
- [ ] Aprobación no crea recepción, admisión, movimiento ni habilitación.
- [ ] Lote confirmado deja copias `unavailable`/`unassessed`.
- [ ] Evidencias siguen bloqueadas si no hay proveedor aprobado.
- [ ] No se activó inventario ni se cambió disponibilidad.
- [ ] D-01–D-16 y autorizaciones están registradas.
- [ ] Backup y restauración están documentados.

---

## 9. Acciones prohibidas

- Conectarse a Neon o a cualquier base remota.
- Aplicar migraciones remotas sin autorización.
- Desplegar Netlify.
- Hacer push o commit sin autorización.
- Modificar Excel originales.
- Editar `0007`/`0008`.
- Conceder `account.manage` al rol público.
- Inventar credenciales, usuarios o aprobaciones.
- Habilitar ejemplares o alterar disponibilidad.
- Activar un proveedor de evidencias sin D-13.
- Borrar evidencias, lotes o auditoría.
- Restaurar datos de producción en staging.
