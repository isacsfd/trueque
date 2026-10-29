# Gestión administrativa de lotes de inventario

**Estado:** implementación local; no desplegada.
**Migración:** `0010_inventory_batches.sql`.
**Alcance:** prevalidación y confirmación de lotes Excel; historial, reportes y estadísticas.
**Regla central:** ningún lote se publica, habilita ni vuelve disponible automáticamente.

---

## 1. Auditoría previa

### 1.1 Lo existente

- `INVENTARIO TRUEQUE.xlsx` y el importador Python `scripts/import-inventory.py`.
- `0006_inventory_import.sql` conserva lotes/filas de la importación histórica y un
  índice de procedencia.
- `0007`/`0008` mantienen la contención: los ejemplares institucionales no
  verificados deben estar `unavailable`.
- Los roles runtime no tienen DML directo; las mutaciones pasan por funciones
  `SECURITY DEFINER`.
- El panel administrativo solo tenía solicitudes y revisión fotográfica.
- No existía carga Excel desde el panel, prevalidación, historial de lotes ni
  estadísticas agregadas.
- La autenticación usa `ADMIN_USERS`/`SESSION_SECRET`; no hay un proveedor OIDC
  ni almacén de contraseñas propio.

### 1.2 Decisión de diseño

Se añadió un módulo separado del importador histórico:

- no reimporta el inventario anterior;
- no reutiliza `inventory_import_batches` para lotes nuevos;
- conserva el archivo original en almacenamiento privado;
- prevalidación sin escritura de inventario;
- confirmación atómica mediante función PostgreSQL;
- los ejemplares se crean `unavailable`, `unassessed`, sin verificación y sin
  movimientos.

## 2. Flujo

```text
Archivo .xlsx
  → inspect (hojas, encabezados, muestra)
  → mapping + prevalidate (validación y persistencia de filas)
  → prevalidated (sin inventario)
  → confirm / cancel
  → confirmed (copias no disponibles) | cancelled
```

### Estados de lote

- `prevalidated`: filas y reporte guardados; no se creó ningún ejemplar.
- `confirmed`: copias creadas con `unavailable`/`unassessed`; no habilitadas.
- `cancelled`: prevalidación descartada; sin cambios de inventario.
- `failed`: reservado para fallos recuperables; no se usa para simular éxito.

### Trazabilidad

- `inventory_batches`: archivo, SHA-256, tamaño, hoja, fila de encabezados,
  mapeo, conteos, actor, fechas, observaciones y estado.
- `inventory_batch_rows`: fila de origen, fila cruda, datos mapeados, estado,
  errores, advertencias, código y referencias creadas.
- `audit_events`: prevalidación, confirmación y cancelación con actor.
- Archivo original privado; no se sirve por URL pública.

## 3. Importación XLSX segura

### 3.1 Parser propio

`netlify/lib/xlsx.ts` lee ZIP + XML sin evaluar fórmulas:

- exige `[Content_Types].xml` y `xl/workbook.xml`;
- rechaza ZIP inválido, cifrado, métodos desconocidos, rutas traversal,
  entradas duplicadas, macros (`vbaProject.bin`) y vínculos externos;
- limita archivo a **10 MB**, descomprimido a **50 MB**, **200 entradas**,
  **10 000 filas** y **250 000 celdas**;
- limita ratio de compresión para reducir ZIP bombs;
- rechaza `DOCTYPE`/`ENTITY` para evitar entidades externas;
- comparte cadenas XLSX, celdas inline, números y booleanos;
- marca fórmulas y no las ejecuta.

### 3.2 Mapeo

La UI permite seleccionar:

- hoja;
- fila de encabezados;
- columnas para título, autor, editorial, género, ISBN, código de inventario,
  ubicación, número fuente, número de ejemplar y observaciones.

Título y autor son obligatorios. Si un Excel nuevo tiene otras columnas, no se
asume el esquema anterior: el mapeo es explícito.

### 3.3 Validación

- filas de relleno sin datos bibliográficos se omiten;
- título/autor ausentes: rechazada;
- ISBN inválido: rechazada;
- fórmula: rechazada;
- código de inventario duplicado en lote o existente: rechazo/duplicado;
- duplicados bibliográficos dentro del lote o contra la base: advertencia, no
  eliminación de ejemplares legítimos;
- máximos de filas/celdas.

El reporte CSV incluye fila, estado, título, autor, editorial, ISBN, código,
errores y advertencias. Se neutralizan fórmulas de inyección CSV.

## 4. Confirmación atómica

`confirm_inventory_batch`:

- exige `inventory.batches.confirm`;
- bloquea el lote `FOR UPDATE`;
- revalida filas y códigos dentro de la transacción;
- reutiliza un registro bibliográfico solo con ISBN exacto o
  título/autor/editorial exactos sin ISBN; nunca lo sobrescribe;
- inserta copias con `availability='unavailable'`, `physical_condition='unassessed'`,
  `provenance_type='institutional'` y `verified_at NULL`;
- no inserta `inventory_movements`, recepciones, aceptaciones ni habilitaciones;
- si cualquier fila falla, revierte todo y deja el lote `prevalidated`;
- repetir la confirmación devuelve los conteos existentes.

Código de inventario: se usa el mapeado o se genera
`IUB-LOTE-<batch>-<source_row>`. Nunca se reutiliza un código existente.

## 5. Permisos

| Permiso | Uso |
| --- | --- |
| `inventory.batches.import` | Prevalidar y cancelar. |
| `inventory.batches.confirm` | Confirmar un lote. |
| `inventory.batches.read` | Historial, detalle y reporte. |
| `stats.read` | Estadísticas agregadas. |
| `account.manage` | Reservado para gestión de cuenta; no habilita cambio de contraseña. |

No se asignan roles por defecto. La institución debe asignarlos con mínimo
privilegio y separar importación de confirmación.

## 6. Estadísticas

`GET /api/admin/stats` devuelve, solo con `stats.read`:

- inventario institucional total, disponible, no disponible, reservado,
  mantenimiento, retirado, verificado y sin evaluar;
- catálogo público;
- solicitudes, revisiones fotográficas, recepciones, evaluaciones y admisiones
  agrupadas por estado;
- lotes nuevos y lotes históricos con filas procesadas, insertadas, reutilizadas,
  rechazadas y duplicadas;
- tendencias mensuales solo si existen datos en los últimos seis meses.

No se calcula ni se inventa una métrica sin fuente. “Verificado” es un subconjunto
del inventario institucional; “catálogo público” es la vista elegible.

## 7. Mi cuenta y contraseña

El sistema actual autentica contra `ADMIN_USERS` (hash scrypt) y
`SESSION_SECRET`, no contra un proveedor OIDC ni una tabla de contraseñas.

Por eso:

- “Mi cuenta” muestra usuario, actor, expiración y gestión de contraseña;
- el formulario de cambio está deshabilitado;
- el endpoint `POST /api/admin/account` responde `409 password_managed_externally`
  y no almacena ni modifica contraseñas;
- la rotación se realiza en la configuración privada del despliegue o mediante
  el futuro OIDC institucional.

No se creó un almacén paralelo de contraseñas porque debilitaría la autenticación
y sería incompatible con OIDC.

## 8. Pruebas

- PGlite: migración `0010`, prevalidación, confirmación, reutilización,
  cancelación, duplicados, rollback y permisos.
- Parser XLSX: archivo real, ZIP inválido, XML no permitido.
- Validador: hoja real, filas de relleno, títulos repetidos, fórmulas,
  incompletos, códigos duplicados/existentes.
- Handlers: inspección, archivo inválido, prevalidación con archivo privado,
  confirmación/cancelación y CSRF.
- Estadísticas/cuenta: agregados y bloqueo de cambio de contraseña.
- UI: pestañas, lotes, revisión fotográfica, formulario de solicitud.

## 9. Limitaciones y decisiones pendientes

1. El almacenamiento de archivos de lote es local (`BATCH_STORAGE_DIR`) solo en
   desarrollo; en Netlify Functions el driver local falla de forma cerrada. Antes
   de staging se requiere un objeto privado aprobado con lifecycle; ver
   `docs/inventario/almacenamiento-privado.md`.
2. No hay antimalware ni análisis de macros más allá del rechazo estructural;
   no se ejecutan fórmulas ni macros.
3. No hay OCR ni lectura de imágenes.
4. Retención del Excel original y filas: **PENDIENTE DE APROBACIÓN INSTITUCIONAL**.
5. Política de aceptación física y set mínimo de fotografías: D-02/D-08.
6. Roles y autoridad de confirmación: D-07/D-09.
7. OIDC y cambio de contraseña autónomo: pendiente de proveedor institucional.
8. La reutilización bibliográfica exacta debe ser validada por catalogación; no
   modifica registros existentes.
