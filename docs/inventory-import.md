# Importación del inventario institucional

## Fuente

- Archivo: `INVENTARIO TRUEQUE.xlsx`
- SHA-256: `86d6602a23aa6d95045c5a40eece9c3dd3ce14e7349adf59e19ce37110bd846d`
- Hoja: `Hoja1`
- Columnas: `BIBLIOTECA ACTUAL`, `No.`, `AUTOR`, `TITULO`, `EJEMPLAR`, `EDITORIAL`
- Filas de datos: 137 (filas 3–139)
- Registros con título: 67
- Títulos distintos: 65
- Filas de relleno sin datos bibliográficos: 70

El Excel no se modifica; el importador solo lo lee.

## Resultado local

- **Ejemplares importados:** 67
- **Registros bibliográficos:** 65
- **Catálogo local:** 0 ejemplares importados publicados en `available_catalog`; los 67 quedan retenidos por la compuerta de verificación institucional.
- **Filas omitidas:** 70 (`empty_book_row`)
- **Filas rechazadas:** 0
- **Duplicados conservados:**
  - `La Celestina`: 2 ejemplares (No. 16 y 42)
  - `Las Mujeres del Quijote`: 2 ejemplares (No. 30 y 31)
- **ISBN:** todos los registros importados tienen `isbn` y `isbn_normalized` en `NULL`; no se inventó ningún ISBN.
- **Procedencia:** `provenance_type='institutional'`, referencia `inventory-import:<batch>:row:<fila>:no:<No.>:copy:<EJEMPLAR>`.
- **Ubicación:** valor de `BIBLIOTECA ACTUAL` (`PLAZA DE LA PAZ`).
- **Estado físico:** `unassessed`; no se inventó una condición.
- **Disponibilidad:** `unavailable`; la contención P0 impide que un ejemplar institucional no verificado aparezca o sea reservado.
- **Verificación:** `verified_at`, `verified_by` y `verification_reference` quedan en `NULL`; no se registró aceptación ni habilitación.
- **Movimientos históricos:** ninguno; no se inventaron recepciones, transferencias, entregas, evaluaciones ni historiales.
- **Solicitudes persistentes:** ninguna; un intento de solicitud/reserva sobre un ejemplar no verificado se rechaza y no crea datos.

## Modelo

La migración aditiva `0006_inventory_import.sql` crea:

- `inventory_import_batches`: lote, hash del Excel, hoja, contadores y metadata.
- `inventory_import_rows`: fila original, `No.`, `EJEMPLAR`, estado, registro bibliográfico, ejemplar, motivo y fila cruda.
- Índice único de procedencia para que una fila fuente no duplique un ejemplar.

`0006` está aplicada **solo en PostgreSQL local**. No se aplicó en Neon staging ni en producción.

`0007_institutional_containment.sql` es la contención P0: añade `verified_at`,
`verified_by` y `verification_reference`; exige verificación positiva para que un
ejemplar `institutional` pueda estar `available` o `reserved`; protege el catálogo,
la creación de solicitudes y `reserve_copy`; y deja los 67 ejemplares importados en
`unavailable`. **Solo se aplicó en local.** No crea movimientos de inventario; deja
un evento de auditoría de contención.

`0008_containment_request_compat.sql` ajusta el guard de solicitudes para conservar
el comportamiento previo sobre ejemplares no disponibles, sin permitir que un
ejemplar institucional no verificado sea objetivo de una solicitud. También se
aplicó **solo en local**.

## Comandos reproducibles

Requisitos locales: PostgreSQL local desechable, Python 3 con `openpyxl` y `psycopg`.

```sh
export DATABASE_MIGRATION_URL='postgresql://iub_schema_migrator@127.0.0.1:55432/iub_local'
export DATABASE_MIGRATION_DRIVER='pg'

# planificación y migraciones locales
npm run db:migrate:plan
npm run db:migrate:apply

# validación sin escribir
npm run inventory:import

# importación idempotente
npm run inventory:import:apply

# comprobación de cantidades, duplicados, catálogo y procedencia
npm run inventory:verify

# plantilla de conciliación física
npm run inventory:reconciliation
npm run inventory:reconciliation:verify
# sin PostgreSQL: compara códigos, filas y hash contra el Excel de origen
npm run inventory:reconciliation:verify-source

# procesamiento del conteo completado
npm run inventory:reconciliation:process
npm run inventory:reconciliation:test
```

El importador rechaza hosts que no sean `localhost`, `127.0.0.1`, `::1` o `postgres`.

La base local de esta ejecución se dejó en el contenedor persistente `iub-pg-local` (volumen `trueque-local-pgdata`, puerto `55432`, base `iub_local`).

## Reglas aplicadas

- Título, autor, `No.`, `EJEMPLAR` y biblioteca son obligatorios.
- Las filas con todos los campos bibliográficos vacíos se ignoran; no se confunden con títulos ausentes.
- Un título ausente con otros datos se rechaza y se reporta.
- No se deduplican ejemplares: cada `No.`/`EJEMPLAR` produce su propio ejemplar.
- Se reutiliza el registro bibliográfico por título/autor/editorial cuando no hay ISBN.
- Se conservan los valores `N/A`/`N/E` tal como vienen en la fuente; no se inventan autores ni editoriales.
- Los dos registros con autor `N/A` y los que tienen editorial `N/E` quedan con esos valores de origen, no con datos ficticios.
- La segunda ejecución reutiliza los 67 ejemplares y no crea duplicados.
- Un ejemplar `institutional` recién importado se inserta como `unavailable` y `unassessed`; no se publica ni se reserva hasta una verificación positiva autorizada.

## Validación ejecutada

- `npm test`: 66 pruebas aprobadas; 2 integraciones API/PostgreSQL omitidas sin variable de entorno.
- `npm run lint` y `npm run build`: correctos.
- PostgreSQL local: 8 migraciones aplicadas, segunda ejecución idempotente.
- Importación real: 67 ejemplares, 65 registros bibliográficos, 70 filas omitidas, 0 rechazadas.
- Segunda importación: 0 importados, 67 reutilizados, 70 omitidos, 0 rechazados.
- `inventory:verify`: catálogo 0, 67 ejemplares retenidos en `unavailable`, 67 códigos institucionales distintos y sin duplicados, duplicados bibliográficos correctos, ISBN nulo, sin movimientos inventados.
- Solicitud/reserva sobre `IUB-PAZ-001`: rechazada por la compuerta de contención, sin reserva ni movimiento; no se creó ningún intercambio ficticio.

## Bloqueos para publicación

- No se ha publicado ni desplegado nada; el trabajo es local.
- La condición física es `unassessed`; una revisión física puede requerir cambios antes de publicar en Internet.
- La ubicación y disponibilidad se tomaron del inventario institucional, pero no hay una validación física por ejemplar.
- `0006`, `0007` y `0008` no están en staging ni producción; una futura publicación requiere aplicar las migraciones en el entorno autorizado y repetir las pruebas.
- `0009_offered_book_photos` se validó en un clúster PostgreSQL local desechable; no se aplicó en staging ni producción.
- OIDC y almacenamiento de imágenes siguen pendientes para producción.
