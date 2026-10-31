# Reparación integral de inventario — 2026-10-31

## 1. Alcance

Este procedimiento corrige el defecto que permitió que la importación del evento
`evento-2026-10-30` degradara un ejemplar de un intercambio ya completado, y
establece controles para que no vuelva a ocurrir.

No publica el ejemplar sintético 3. No borra intercambios, movimientos ni
auditoría. No cambia la disponibilidad de los 72 ejemplares institucionales
visibles ni de los 12 ejemplares reservados con solicitudes aprobadas.

Artefactos:

| Artefacto | Función |
|---|---|
| `db/migrations/0020_inventory_integrity_repair.sql` | Columnas de verificación, flag sintético, exenciones legacy, guards, funciones auditadas, importador idempotente y vistas de anomalías |
| `db/repairs/2026-10-31_classify_synthetic_inventory.sql` | Marca únicamente los tres registros de QA conocidos; no cambia disponibilidad |
| `db/repairs/2026-10-31_rollback_0020.sql` | Rollback de emergencia que restaura la vista anterior y retira guards/funciones; conserva columnas y tablas |
| `scripts/import-event-inventory.mjs` | Importador de eventos seguro, dry-run por defecto y escritura solo local salvo autorización expresa |
| `scripts/inventory-anomaly-monitor.mjs` | Monitor de solo lectura que separa anomalías reales de sintéticas |
| `db/migrations/0020_inventory_integrity_repair.test.ts` | Pruebas PGlite de la migración |
| `scripts/inventory-repair-postgres.mjs` | Pruebas reales de concurrencia en PostgreSQL desechable |

## 2. Por qué 0020 es un hotfix autónomo

La producción tiene un ledger no contiguo:

- `0001`–`0005` registradas;
- `0019` aplicada manualmente;
- `0006`–`0018` no aplicadas;
- `0007` no instalada; la vista `available_catalog` es la de `0002`.

Por eso **no se debe ejecutar** `npm run db:migrate:apply` contra producción: el
runner intentaría aplicar versiones históricas y `0007` ocultaría o bloquearía
los 72 ejemplares visibles ni los 12 comprometidos en trueques ya realizados.

`0020` está diseñada para aplicarse sola sobre el esquema real de producción:

- no depende de `0006`–`0019`;
- usa `ADD COLUMN IF NOT EXISTS`;
- conserva la visibilidad y los compromisos existentes mediante una tabla de exención explícita;
- no cambia `copies.availability` de ningún ejemplar;
- no ejecuta `0007` ni su contención masiva.

Si en el futuro se aplica `0007` después de `0020`, su vista estricta reemplazaría
la vista compatible y volvería a ocultar los ejemplares no verificados. **No
aplicar `0007` después de `0020`.** Cualquier reconciliación futura debe ser una
migración nueva y revisada.

## 3. Condiciones previas obligatorias

No iniciar sin:

1. Backup o rama de restauración posterior a `0019` y anterior a `0020`.
2. Verificación real de que el backup se puede consultar/restaurar.
3. Aprobación institucional escrita.
4. Ventana de mantenimiento y responsable.
5. Commit revisado y checksum del archivo `0020`.
6. Confirmación de que el ejemplar 3 sigue siendo sintético y no tiene reservas.
7. Confirmación de que los 72 ejemplares disponibles y los 12 reservados son los esperados.

Registrar fuera del repositorio:

```text
backup_id:
fecha_hora_backup:
responsable_backup:
ventana:
aprobación:
commit:
checksum_0020:
```

## 4. Preflight de solo lectura

Ejecutar con un rol de lectura administrativa, en transacción read-only.

```sql
BEGIN TRANSACTION READ ONLY;

SELECT current_database(), current_setting('transaction_read_only') AS read_only;

SELECT version, checksum, applied_at
FROM public.schema_migrations
ORDER BY version;

SELECT availability, provenance_type, count(*)
FROM public.copies
GROUP BY availability, provenance_type
ORDER BY availability, provenance_type;

SELECT count(*) AS catalog_count FROM public.available_catalog;

SELECT id, inventory_code, availability, provenance_type, is_synthetic
FROM public.copies
WHERE inventory_code IN ('IUB-STG-001','IUB-STG-002','IUB-REC-R-1793222267404')
ORDER BY inventory_code;

SELECT c.id, c.availability, a.status, e.status AS exchange_status,
       (SELECT count(*) FROM public.reservations r
         WHERE r.copy_id = c.id AND r.status = 'active') AS active_holds
FROM public.copies c
LEFT JOIN public.inventory_admissions a ON a.copy_id = c.id
LEFT JOIN public.exchanges e ON e.offered_copy_id = c.id
WHERE c.inventory_code = 'IUB-REC-R-1793222267404';

ROLLBACK;
```

Criterios de aborto:

- el ejemplar 3 tiene una reserva activa;
- el ejemplar 3 no está `unavailable`;
- los 72 disponibles o los 12 reservados no coinciden con el inventario esperado;
- hay objetos o columnas inesperadas;
- el backup no está verificado;
- no hay aprobación escrita.

## 5. Aplicación de 0020

La aplicación debe ser manual, transaccional y con el rol migrador. No usar el
runner histórico.

```sh
psql "$DATABASE_MIGRATION_URL" \
  -v ON_ERROR_STOP=1 \
  -f db/migrations/0020_inventory_integrity_repair.sql
```

Antes de ejecutar, revisar el checksum:

```sh
npm run db:migrate:plan
```

El plan incluye todo el historial. Para el hotfix, el responsable debe calcular y
registrar el SHA-256 canónico de `0020` por separado. No confundir el plan
histórico con autorización para aplicar `0006`–`0019`.

Durante la ejecución:

- mantener `statement_timeout` acotado;
- no ejecutar `db:migrate:apply`;
- no aplicar `0007` en la misma ventana;
- si cualquier sentencia falla, la transacción debe quedar abortada y no debe
  hacerse `COMMIT` manual.

## 6. Clasificación de los registros sintéticos

Después de que `0020` esté confirmada:

```sh
psql "$DATABASE_MIGRATION_URL" \
  -v ON_ERROR_STOP=1 \
  -v actor_id=<ID_DE_CUENTA_AUTORIZADA> \
  -f db/repairs/2026-10-31_classify_synthetic_inventory.sql
```

Efecto:

- `IUB-STG-001` → `is_synthetic = true`;
- `IUB-STG-002` → `is_synthetic = true`;
- `IUB-REC-R-1793222267404` → `is_synthetic = true`;
- no cambia `availability`;
- no publica ni retira;
- registra `inventory.synthetic_records_classified`.

El ejemplar 3 debe seguir `unavailable`. Si se decide cuarentenarlo como
`retired`, debe hacerse con una autorización separada y con
`public.withdraw_copy(...)`, que exige motivo, actor e idempotencia. No usar un
`UPDATE` directo.

## 7. Validación posterior

```sql
BEGIN TRANSACTION READ ONLY;

SELECT count(*) AS catalog_count FROM public.available_catalog;

SELECT availability, count(*)
FROM public.copies
GROUP BY availability
ORDER BY availability;

SELECT id, inventory_code, availability, is_synthetic
FROM public.copies
WHERE inventory_code IN ('IUB-STG-001','IUB-STG-002','IUB-REC-R-1793222267404')
ORDER BY inventory_code;

SELECT anomaly_code, severity, is_synthetic, count(*)
FROM public.inventory_anomalies
GROUP BY anomaly_code, severity, is_synthetic
ORDER BY anomaly_code;

SELECT count(*) AS real_anomalies FROM public.real_inventory_anomalies;

SELECT * FROM public.institutional_verification_backlog
ORDER BY review_due_at NULLS LAST, copy_id;

ROLLBACK;
```

Resultados esperados:

- catálogo: 72;
- 72 disponibles, 12 reservadas, 3 no disponibles;
- los tres ejemplares sintéticos siguen fuera del catálogo;
- `real_inventory_anomalies` no contiene el ejemplar 3;
- la anomalía del ejemplar 3, si existe, aparece con `is_synthetic = true`;
- el backlog de verificación muestra los 84 ejemplares legacy (72 visibles + 12 comprometidos), sin ocultarlos ni publicar los reservados.

## 8. Monitor

```sh
DATABASE_ADMIN_URL='<url administrativa>' npm run inventory:monitor -- --json
```

El monitor:

- abre una transacción `READ ONLY`;
- reporta anomalías reales y sintéticas por separado;
- no imprime datos personales;
- devuelve código 1 si hay una anomalía real `critical` o `high`;
- no modifica datos.

Para revisar también las sintéticas:

```sh
DATABASE_ADMIN_URL='<url administrativa>' \
  npm run inventory:monitor -- --include-synthetic --json
```

## 9. Importador de eventos

Dry-run:

```sh
npm run inventory:event:dry-run
```

Aplicación local:

```sh
DATABASE_MIGRATION_URL='postgresql://iub_schema_migrator@127.0.0.1:55432/iub_repair_local' \
npm run inventory:event:import -- --actor-id <ID>
```

Reglas del importador:

- no actualiza ejemplares existentes;
- inserta ejemplares nuevos como `unavailable` y `unassessed`;
- registra movimiento `received` por cada ejemplar nuevo;
- registra auditoría con hash del payload y conteos;
- es idempotente por `idempotency_key`;
- rechaza la misma clave con payload distinto;
- se niega a escribir en hosts no locales salvo autorización explícita.

El archivo histórico `evento/import_evento_2026-10-30.sql` fue desactivado y ya no
contiene el `UPDATE` destructivo. No volver a ejecutarlo.

## 10. Rollback

Si la migración falla antes del `COMMIT`, no hacer `COMMIT`: la transacción debe
revertirse completa.

Si después del `COMMIT` se necesita volver al comportamiento anterior:

```sh
psql "$DATABASE_MIGRATION_URL" \
  -v ON_ERROR_STOP=1 \
  -f db/repairs/2026-10-31_rollback_0020.sql
```

El rollback:

- restaura la vista `available_catalog` anterior;
- retira guards y funciones nuevas;
- **no borra** `is_synthetic`, `verified_at`, exenciones, importaciones ni
  auditoría;
- no cambia disponibilidad;
- no borra movimientos;
- no cancela reservas.

Si el ejemplar 3 ya fue reservado, no revertir su estado automáticamente.
Evaluar la reserva y el flujo antes de cualquier cambio.

## 11. Lo que no debe hacerse

- No ejecutar `UPDATE public.copies SET availability='available'` sobre el
  ejemplar 3.
- No aplicar `0007` después de `0020`.
- No ejecutar `npm run db:migrate:apply` contra producción.
- No borrar el intercambio, la admisión, el ejemplar o los movimientos.
- No marcar los 84 ejemplares legacy como verificados masivamente sin evidencia.
- No ocultar los 72 visibles ni publicar los 12 reservados para "resolver" la verificación.
- No usar el backup con datos reales como ambiente de pruebas.
- No desplegar sin validación y autorización.

## 12. Pendientes operativos

1. Verificar individualmente los 84 ejemplares legacy (72 visibles y 12 comprometidos) y registrar evidencia.
2. Decidir si el ejemplar sintético 3 se deja `unavailable` o se cuarentena como
   `retired` mediante `withdraw_copy`.
3. Asignar los permisos nuevos a los roles administrativos que correspondan:
   `inventory.verify`, `inventory.publish`, `inventory.withdraw`,
   `inventory.events.import`, `inventory.classify_synthetic`.
4. Programar la revisión de las exenciones antes de `review_due_at`.
5. Resolver la deuda del ledger no contiguo en una migración futura revisada.

## 13. Resultados de validación local

Ejecutados el 2026-10-31 en PostgreSQL 18.6 efímero en `127.0.0.1:55432`,
separado de la instancia institucional:

```text
npm test                         39 archivos, 239 pruebas OK, 7 skipped
npm run lint                     OK
npm run build                    OK
PGlite 0020                      7/7 OK
Concurrencia PostgreSQL          4/4 escenarios OK
Dry-run importador               74 bibs, 84 copies, sin escritura
Importación local                84 copies insertadas unavailable
                                 ejemplar legacy conservado available
                                 segunda ejecución idempotente
Rollback 0020                    aplicado en base desechable
npm audit                        12 moderadas en dependencias de desarrollo
```

La importación local de prueba no se ejecutó contra producción. El ejemplar
sintético 3 no se devolvió a `available`. No se desplegó ni se aplicó ninguna
migración en Neon.
