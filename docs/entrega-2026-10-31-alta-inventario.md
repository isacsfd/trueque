# Alta de inventario, importación Excel y cierre de trueque — 2026-10-31

## 1. Resumen ejecutivo

Se completaron los pendientes funcionales solicitados:

1. formulario administrativo de alta manual de ejemplares;
2. importación Excel con publicación automática de las filas elegibles;
3. cierre de trueque sin publicación anticipada, con regresión reforzada;
4. conservación del buscador, la administración, la consulta pública y las
   protecciones de inventario.

No se aplicaron migraciones en producción, no se desplegó y no se hizo push.
El correo sigue fuera de alcance.

## 2. Alta manual de ejemplares

### Flujo

- Nueva pestaña **Alta de ejemplar** en el panel administrativo.
- El formulario captura datos bibliográficos, código de inventario, ubicación,
  estado físico y referencia de verificación.
- El ejemplar se crea siempre como `unavailable`.
- La publicación solo ocurre si:
  - el operador marca “Publicar ahora”;
  - el estado físico está evaluado;
  - existe una referencia de verificación;
  - el actor tiene `inventory.verify` e `inventory.publish`.
- Si no se cumplen esas condiciones, el ejemplar queda pendiente de
  verificación y no aparece en el catálogo.

### Backend

- `POST /api/admin/inventory`: alta idempotente y auditada.
- `GET /api/admin/inventory`: capacidades del actor para mostrar u ocultar la
  publicación.
- `public.register_institutional_copy(...)`:
  - requiere `inventory.register`;
  - valida título, autor, código, ISBN, condición y longitudes;
  - reutiliza o crea registro bibliográfico, editorial y género;
  - bloquea por clave de idempotencia con `pg_advisory_xact_lock`;
  - registra movimiento `received`;
  - si publica, llama a `verify_institutional_copy` y
    `publish_institutional_copy`;
  - registra auditoría `inventory.manual_copy_registered`;
  - devuelve el ejemplar existente en reintentos.

### Permisos

`0022` añade `inventory.register` y lo propaga a roles que ya tienen
`inventory.batches.confirm`, `inventory.admit` o `inventory.enable`.
También propaga `inventory.verify` desde `inventory.admit` y
`inventory.publish` desde `inventory.enable`, sin concederlos a roles públicos.

## 3. Importación Excel y publicación automática

### Flujo

- La pestaña **Lotes de inventario** conserva inspección, mapeo, prevalidación,
  confirmación, cancelación, historial y CSV.
- El mapeo admite ahora:
  - `physical_condition` (estado físico);
  - `verification_reference` (referencia de verificación).
- Una fila es elegible para publicación automática solo si:
  - tiene estado físico `excellent`, `good`, `fair` o `poor` (también se aceptan
    etiquetas equivalentes en español);
  - tiene referencia de verificación;
  - el actor conserva permisos de verificación y publicación.
- Las demás filas se importan como `unavailable` y quedan pendientes.
- Una referencia sin estado físico rechaza la fila; un estado evaluado sin
  referencia genera advertencia y no publica.

### Backend

- `0023_inventory_batch_autopublish.sql` crea
  `confirm_inventory_batch_with_publication`.
- La función:
  - confirma el lote con `confirm_inventory_batch`;
  - actualiza la condición desde la fila;
  - verifica y publica las filas elegibles;
  - deja las demás pendientes;
  - registra `inventory.batch_auto_publish_completed`;
  - devuelve `autoPublished` y `autoSkipped`.
- `POST /api/admin/batches/confirm` usa la nueva rutina cuando existe y vuelve
  al comportamiento anterior si `0023` no está instalada.
- El CSV incluye estado físico y referencia de verificación.
- La confirmación del lote sigue siendo atómica: si falla una publicación
  elegible, se revierte toda la transacción.

## 4. Cierre de trueque

No se cambió la regla de negocio. Se amplió la regresión para aplicar las
migraciones P0 reales `0001`–`0004` en lugar de detenerse en `0003`:

- después de `enable_received_copy`, el ejemplar sigue `unavailable` y fuera de
  `available_catalog`;
- un `complete_exchange` rechazado antes de las entregas no deja movimientos
  `exchange_in` ni publica el libro;
- solo el cierre válido, con admisión, entregas evidenciadas y reserva
  convertida, publica el ejemplar y registra `exchange_in`;
- el catálogo lo incluye únicamente después del cierre.

## 5. Migraciones

| Migración | Dependencia | Estado |
|---|---|---|
| `0022_inventory_registration.sql` | `0020` | Preparada, no aplicada |
| `0023_inventory_batch_autopublish.sql` | `0010` y `0020` | Preparada, no aplicada |

- `0022` puede aplicarse sobre el baseline de producción que ya tiene `0020`.
- `0023` **no** puede aplicarse sobre el baseline de producción sin `0010`;
  el schema de producción reportado no tiene las tablas de lotes.
- No se aplicó `0020` de nuevo.
- No se modificó el ledger ni se ejecutó `db:migrate:apply`.

## 6. Pruebas ejecutadas

```text
npm test
  49 archivos pasan | 2 omitidos
  284 pruebas pasan | 7 omitidas

npm run lint
  OK

npm run build
  OK

npm run build:release
  OK
  release-candidate/assets/index-DSVbSESY.js
  298.106 bytes
  11 verificaciones, incluida el alta manual y el control de publicación

npm run test:inventory:registration
  4/4 OK en PostgreSQL real:
  - alta concurrente serializada por clave de idempotencia;
  - publicación verificada exactamente una vez;
  - movimientos recibido/publicación sin duplicados;
  - reintento idempotente sin duplicar el ejemplar.

npm run test:inventory:postgres
  4/4 OK en PostgreSQL real.

PGlite 0022
  5/5 OK: permisos, alta no disponible, publicación elegible,
  idempotencia, rechazo de publicación incompleta.

PGlite 0023
  2/2 OK: publicación automática de filas elegibles y ausencia de
  publicación cuando faltan permisos.

Validación de lotes
  2/2 OK: mapeo de condición/referencia, alias en español,
  rechazo de referencia sin condición y advertencia sin referencia.

API de alta manual
  4/4 OK: capacidades, registro, validaciones y permiso denegado.

UI de alta manual
  3/3 OK: formulario, ocultamiento sin permiso y registro sin publicación.

API de lotes
  9/9 OK: incluye selección de la rutina nueva y fallback a la anterior.
```

La suite completa se ejecuta con `maxWorkers: 4` y timeouts de 60 s porque las
pruebas PGlite/WASM son intensivas en CPU y memoria. No se cambió ninguna
aserción para ocultar fallos; con 51 workers en paralelo los hooks de PGlite
agotaban su tiempo. El documento de la fase anterior
(`docs/entrega-2026-10-31-modulos.md`) conserva las mediciones del buscador y la
administración. El conflicto preexistente
0011/0016 documentado allí sigue aplicando a una cadena contigua nueva; no se
ocultó ni se modificó.

## 7. Archivos principales

### Nuevos

```text
netlify/functions/admin-inventory.ts
src/components/InventoryRegistration.tsx
src/components/InventoryRegistration.test.tsx
netlify/tests/admin-inventory.test.ts
netlify/tests/inventory-batch-validation.test.ts
db/migrations/0022_inventory_registration.sql
db/migrations/0022_inventory_registration.test.ts
db/migrations/0023_inventory_batch_autopublish.sql
db/migrations/0023_inventory_batch_autopublish.test.ts
scripts/inventory-registration-postgres.mjs
docs/entrega-2026-10-31-alta-inventario.md
```

### Modificados

```text
src/components/AdminPanel.tsx
src/components/AdminPanel.test.tsx
src/components/InventoryBatches.tsx
src/lib/api.ts
netlify/lib/inventory-batch.ts
netlify/functions/admin-batches.ts
netlify/functions/admin-batches-confirm.ts
netlify/functions/admin-batches-report.ts
netlify/tests/admin-batches.test.ts
db/migrations/0001_initial_schema.test.ts
db/migrations/README.md
scripts/provision-test-admins.mjs
scripts/verify-release.mjs
package.json
vite.config.ts
netlify/functions/README.md
docs/administracion-cuentas.md
```

## 8. Pendientes y bloqueos

1. Aplicar `0022` en producción con backup y autorización separada para habilitar
   el alta manual.
2. Aplicar `0021` y `0022`; `0023` queda bloqueada hasta que el entorno tenga
   `0010` (lotes Excel) y `0020`.
3. Confirmar `ALLOW_LEGACY_REQUEST_INTAKE=true` para el formulario legacy.
4. Desplegar el candidato solo después de revisar la build y ejecutar smoke tests
   con el backend real.
5. Revisar el conflicto preexistente 0011/0016 antes de usar una cadena contigua
   nueva.
6. Correo: fuera de alcance.

## 9. Publicación futura

```sh
npm test
npm run lint
npm run build
npm run build:release
npm run test:inventory:registration
npm run test:inventory:postgres
```

Después:

1. revisar `release-candidate/` y sus hashes;
2. crear backup de producción;
3. aplicar `0022` (y `0021` si se autoriza el índice);
4. si el entorno tiene `0010`, aplicar `0023` y validar la importación Excel;
5. publicar el candidato reemplazando `release/` solo tras aprobación;
6. ejecutar smoke tests de alta manual, búsqueda, estado público, reserva,
   administración y cierre de trueque;
7. verificar que el catálogo conserve 72 ejemplares y que los 12 reservados no se
   publiquen.

## 10. Commit y rama

El commit de esta fase se registra en `main`, sin push ni deploy. El hash exacto
se informa en la entrega final.
