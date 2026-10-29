# Conciliación física del inventario

Archivo generado:

`docs/inventario/Conciliacion_Fisica_Trueque_IUB.xlsx`

Contenido:

- 67 ejemplares precargados con códigos `IUB-PAZ-001` a `IUB-PAZ-067`.
- 65 registros bibliográficos; se conservan los títulos repetidos y los ejemplares duplicados legítimos.
- Hoja **Conciliación física** con validaciones, filtros, paneles inmovilizados y formato condicional.
- Hoja **Resumen** con fórmulas; los estados vacíos o “Pendiente” no cuentan como inspección.
- Hoja **Incidencias** para evidencia y resolución.
- Hoja **Instrucciones** con reglas operativas.

Los 67 ejemplares importados están retenidos en `copies` como `unavailable`, no
aparecen en `available_catalog` y no tienen verificación positiva
(`verified_at IS NULL`). No se pueden reservar ni crear solicitudes sobre ellos
hasta una habilitación autorizada. Ver `docs/inventory-import.md` y
`docs/inventario/especificacion-habilitacion-inventario.md`.

Regeneración:

```sh
export DATABASE_MIGRATION_URL='postgresql://iub_schema_migrator@127.0.0.1:55432/iub_local'
npm run inventory:reconciliation
npm run inventory:reconciliation:verify
npm run inventory:reconciliation:verify-source
```

`inventory:reconciliation:verify-source` no necesita PostgreSQL: compara las 67
filas de la plantilla contra `INVENTARIO TRUEQUE.xlsx`, comprueba códigos y
números fuente únicos, los 65 registros bibliográficos, los duplicados legítimos
y el hash SHA-256 registrado en `Resumen!B23`.

La plantilla no modifica la base, no cambia la disponibilidad de los ejemplares y no autoriza habilitaciones. Una propuesta “Habilitar” requiere aprobación institucional.

## Procesamiento del conteo

Una vez completadas las columnas de inspección (presencia, estado, identificación,
disponibilidad, responsable y fecha), generar el informe independiente:

```sh
export DATABASE_MIGRATION_URL='postgresql://iub_schema_migrator@127.0.0.1:55432/iub_local'
npm run inventory:reconciliation:process
```

Salida:

`docs/inventario/Resultado_Conciliacion_Trueque_IUB.xlsx`

El procesador:

- Lee el Excel en modo solo lectura y verifica que su hash no cambie.
- Contrasta cada código contra los ejemplares institucionales de `iub_local`.
- Valida estados, fechas, responsables e incidencias.
- Clasifica cada ejemplar y documenta el motivo.
- Nunca escribe en PostgreSQL, no habilita ejemplares, no cambia disponibilidad,
  no registra movimientos y no resuelve incidencias.
- Rechaza cualquier `DATABASE_MIGRATION_URL` cuyo host no sea local
  (`localhost`, `127.0.0.1`, `::1` o `postgres`).

Mientras el Excel no tenga resultados físicos, el informe es un control de
pendientes: 67 ejemplares procesados, 67 pendientes, 0 confirmados y 0 candidatos.

Registro de hallazgos en la plantilla:

| Hallazgo | Dónde se registra | Efecto |
| --- | --- | --- |
| Faltante / no encontrado | `Presencia física = No` + incidencia `Presencia física` | Clasificación `No encontrado`; no habilitable |
| Daño o deterioro | `Estado físico = Regular/Malo` + incidencia `Estado físico` | No se propone automáticamente; umbral D-02 pendiente |
| Duplicado físico | Incidencia `Datos maestros` u `Otro`, con descripción, evidencia y responsable | No se elimina ni se fusiona automáticamente |
| Ejemplar no identificado | `Identificación bibliográfica = No coincide` + incidencia `Identificación bibliográfica`; si no tiene código, fila sin código y observaciones | Error de validación o bloqueo; no se inventa un código |
| Diferencia de título, autor, editorial, ejemplar o ubicación | Columna `Discrepancia encontrada` + incidencia `Datos maestros` | Clasificación `Con discrepancia`; no habilitable |
| Incidencia abierta o en revisión | Hoja `Incidencias` | Bloquea candidatura |

Un ejemplar sin código no se puede conciliar como candidato: el procesador lo
registra como error de validación y exige el procedimiento institucional de
asignación de códigos.

Pruebas del procesador:

```sh
npm run inventory:reconciliation:test
```

El flujo administrativo de habilitación y su brecha actual están documentados en
`docs/inventario/habilitacion-administrativa.md`.

## Política y especificación

- `docs/inventario/politica-aceptacion-institucional.md` — criterios, matriz
  física, estados, reglas y responsabilidades propuestas.
- `docs/inventario/especificacion-habilitacion-inventario.md` — diseño técnico
  futuro de la habilitación, con controles y matriz de escenarios.
- `docs/inventario/decisiones-pendientes-iub.md` — decisiones que la institución
  debe aprobar antes de programar escrituras.
- `docs/inventario/paquete-aprobacion-institucional.md` — paquete para autorizar
  la contención en staging, con campos de firma vacíos.
- `docs/inventario/plan-despliegue-contencion.md` — preflight, snapshot,
  ejecución, validación, aborto y recuperación de `0006`–`0008` en staging.
- `docs/inventario/evaluacion-fotografica.md` — evaluación manual de libros
  ofrecidos con fotografías privadas, estados y almacenamiento.
- `docs/inventario/gestion-lotes-inventario.md` — carga Excel, prevalidación,
  confirmación atómica, historial, estadísticas y cuenta administrativa.
- `docs/inventario/almacenamiento-privado.md` — comparación R2/S3/GCS/Blobs,
  contrato `EvidenceStorage`, retención, recuperación y D-13–D-16.
- `docs/inventario/fuentes-datos.md` — inventario de los dos Excel fuente,
  hashes, hojas y estado de no importación.

Ninguno de esos documentos está aprobado ni habilita ejemplares por sí mismo.
