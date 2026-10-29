# Almacenamiento privado de evidencias y archivos de lotes

**Estado:** diseño local; ningún proveedor contratado, configurado ni activado.
**Alcance:** evidencias fotográficas de libros ofrecidos y archivos Excel originales de lotes.
**Regla central:** sin bucket, credenciales y decisión institucional aprobadas no se
habilita ningún adaptador real; la aplicación falla cerrada.

---

## 1. Auditoría del estado actual

### 1.1 Contrato existente

`netlify/lib/evidence-storage.ts` define:

```ts
interface EvidenceStorage {
  put(key, bytes): Promise<void>;
  get(key): Promise<Buffer>;
  delete(key): Promise<void>;
  head(key): Promise<{ key, size, lastModified }>;
  list(prefix?): Promise<StoredObjectInfo[]>;
}
```

Implementaciones:

- `LocalEvidenceStorage`: escribe bajo `EVIDENCE_STORAGE_DIR` o
  `BATCH_STORAGE_DIR` con escritura temporal + `rename`, permisos `0600` y
  validación de clave. Solo desarrollo y pruebas.
- `SimulatedObjectStorage`: en memoria, con fallos inyectables; solo pruebas.
- Fábrica `getEvidenceStorage()` / `getBatchStorage()`:
  - `PRIVATE_STORAGE_DRIVER=local` fuera de Functions;
  - `PRIVATE_STORAGE_DRIVER=simulated` fuera de Functions;
  - `r2`, `s3`, `gcs`, `blobs`/`netlify-blobs`: **no implementados**, error
    explícito;
  - en Netlify Functions, `local`, `simulated` o la ausencia de driver fallan
    cerrado; nunca se escribe silenciosamente en el filesystem efímero.

### 1.2 Consumidores

- `offered-books-evidence.ts`: valida la imagen antes de `put`, guarda la clave
  en PostgreSQL y borra el objeto si la escritura en base falla.
- `evidence.ts`: sirve una evidencia al token del borrador, sin URL pública.
- `admin-evidence.ts`: exige `offered_books.review` y sesión administrativa.
- `admin-batches.ts`: guarda el Excel original privado y su SHA-256 antes de
  persistir la prevalidación; si la base falla, borra el objeto.
- `admin-batches-*`: historial, detalle, CSV, confirmación y cancelación.

### 1.3 Límites y validaciones existentes

| Elemento | Límite / control |
| --- | --- |
| Evidencia | 4 MB, JPEG/PNG/WebP reales, dimensiones máximas 8000 px y 32 MP, 12 archivos por solicitud |
| Excel | 10 MB comprimido, 50 MB descomprimido, 200 entradas ZIP, 10 000 filas, 250 000 celdas |
| XLSX | rechazo de ZIP inválido/cifrado, rutas traversal, entradas duplicadas, macros, vínculos externos, `DOCTYPE`/`ENTITY` y ratio de compresión anómalo |
| Fórmulas | se detectan y no se evalúan; una fila con fórmula se rechaza en lotes |
| Claves | `[A-Za-z0-9._-]{1,120}`, generadas con UUID; no incluyen nombre, usuario ni correo |
| Acceso | Function autorizada; no hay URL pública ni lectura directa del bucket |

### 1.4 Lo que no está implementado

- Adaptador real de R2, S3, GCS o Netlify Blobs.
- Cifrado de aplicación con clave propia. Se delega en el cifrado del proveedor
  (TLS en tránsito y cifrado en reposo del bucket).
- Eliminación de EXIF/GPS y re-codificación de imágenes.
- Antimalware sobre imágenes o Excel.
- Borrado automático de objetos referenciados.
- Limpieza programada de objetos huérfanos. Existe la función de planificación y
  el modo seco, pero no una tarea desplegada.
- URLs firmadas: no se usan en el flujo actual.

---

## 2. Comparación de proveedores

La comparación se basa en documentación pública consultada en octubre de 2026.
Los precios, regiones, cuotas y condiciones contractuales deben confirmarse con
la institución antes de contratar.

| Criterio | Cloudflare R2 | Amazon S3 | Google Cloud Storage | Netlify Blobs |
| --- | --- | --- | --- | --- |
| Acceso privado | Bucket privado por defecto; IAM/tokens | Bucket privado por defecto; IAM | Bucket privado por defecto; IAM | Sin URL pública; la Function es la única compuerta |
| URL temporal | URL prefirmada S3, 1 s–7 días | URL prefirmada SigV4, hasta 7 días | URL firmada V4, hasta 7 días | No ofrece URL firmada ni cliente de carga directa |
| Carga directa | Sí, URL prefirmada PUT | Sí, URL prefirmada PUT/multipart | Sí, URL firmada PUT/resumable | No; requiere proxy por Function |
| Cifrado en tránsito | TLS | TLS | TLS | TLS hacia la API de Netlify |
| Cifrado en reposo | Sí, del proveedor | SSE-S3/SSE-KMS | Cifrado por defecto/CMEK | Gestionado por Netlify |
| Lifecycle / TTL | Reglas de lifecycle | Lifecycle, versioning, Object Lock | Lifecycle, retention, Object Hold | Sin TTL nativo; borrado por código |
| Objeto máximo | Muy alto (multipart) | 5 TB por objeto | 5 TiB por objeto | Límite documentado de 5 GB |
| Consistencia | Fuerte para objetos | Fuerte para objetos nuevos | Fuerte para objetos | Eventual por defecto; opción fuerte |
| Integración con Functions | SDK S3 o API HTTP | SDK AWS | SDK GCP | SDK `@netlify/blobs` |
| Credenciales | Token/API S3, mínimo privilegio | Rol IAM/access key | Cuenta de servicio/IAM | Contexto del sitio Netlify |
| Operación | Panel Cloudflare, lifecycle, métricas | Madurez, herramientas y auditoría | Madurez, IAM y auditoría | Mínima, pero sin lifecycle ni URLs |
| Costos | Almacenamiento, operaciones y egreso según tarifa vigente; confirmar | Almacenamiento, operaciones y egreso; confirmar | Almacenamiento, operaciones y egreso; confirmar | Plan de Netlify; confirmar límites y cargos |
| Riesgo principal | Dependencia de Cloudflare y configuración CORS/firma | Complejidad IAM y costos de egreso | Complejidad IAM y costos de egreso | Sin TTL, sin acceso directo y consistencia eventual |

### 2.1 Netlify Blobs: verificación específica

Netlify Blobs **no** satisface por sí solo los requisitos de acceso temporal ni
de lifecycle:

- no expone URLs públicas ni URLs firmadas;
- no tiene control de acceso integrado: la Function debe autorizar cada lectura;
- no tiene TTL ni lifecycle nativo;
- no tiene flujo de carga directa desde el navegador;
- la consistencia es eventual por defecto (las actualizaciones y borrados
  pueden tardar hasta 60 segundos), con opción de consistencia fuerte;
- el objeto máximo documentado es 5 GB y la clave 600 bytes.

Por tanto, solo sería aceptable si la institución acepta que todo el tráfico de
evidencias pase por Functions y que la retención se implemente con código y
tareas propias.

### 2.2 Recomendación provisional

1. **Cloudflare R2** como candidato principal: API compatible con S3, bucket
   privado, URLs prefirmadas, lifecycle y egreso sin cargos por transferencia
   según su modelo publicado. Confirmar región, retención, cifrado y contrato.
2. **Amazon S3** si la institución ya opera AWS, tiene IAM y presupuesto de
   egreso aprobados.
3. **Google Cloud Storage** si la institución ya opera GCP y prefiere IAM/CMEK.
4. **Netlify Blobs** solo como solución mínima con proxy por Function, sin TTL ni
   URLs firmadas, y con retención implementada por la aplicación.

**No se activa ninguna opción:** falta proveedor aprobado, cuenta, bucket,
región, credenciales, presupuesto y decisión D-13.

---

## 3. Arquitectura propuesta

```text
Navegador
  │  multipart (imagen/Excel)
  ▼
Netlify Function autorizada
  │  1. sesión/token y permiso
  │  2. límite de tamaño
  │  3. validación real del contenido
  │  4. clave opaca nueva
  ▼
EvidenceStorage (interfaz)
  ├── LocalEvidenceStorage     (solo desarrollo)
  ├── SimulatedObjectStorage   (solo pruebas)
  └── adaptador aprobado       (pendiente)
        │
        ▼
  Bucket privado + lifecycle
        │
        ▼
PostgreSQL: storage_key, MIME detectado, SHA-256, actor, estado
```

### 3.1 Reglas de diseño

- El objeto se escribe **después** de validar el contenido y **antes** de
  confirmar la fila; si la base falla, se intenta borrar el objeto.
- La clave se genera con UUID y no deriva de datos personales.
- El navegador nunca recibe `storage_key`.
- Las lecturas pasan por `evidence.ts` (token del borrador) o
  `admin-evidence.ts` (`offered_books.review`).
- No se sirven evidencias desde `dist`, CDN público ni bucket público.
- Las URLs firmadas solo se usarán si una decisión posterior las justifica; hoy
  no son necesarias porque el volumen es bajo y la Function puede transmitir el
  objeto. Si se usan, se generarán bajo demanda, con expiración corta, y no se
  registrarán en logs ni auditoría.
- La auditoría guarda clave, hash, actor, tamaño, MIME, resultado y estado; no
  guarda secretos, tokens, contraseñas ni URLs firmadas.

### 3.2 Cargas recuperables

- `put` debe ser idempotente por clave; una clave nueva por intento evita
  sobrescribir.
- Si la escritura del objeto funciona y la transacción falla, el objeto queda
  huérfano y se detecta por diferencia entre `list()` y las claves referenciadas.
- La limpieza de huérfanos tiene periodo de gracia y modo seco por defecto.
- En proveedores S3/R2/GCS se debe configurar `AbortIncompleteMultipartUpload`
  para cargas multipart abandonadas.
- La confirmación de lotes ya es atómica en PostgreSQL; un reintento devuelve
  los conteos existentes y no duplica copias.

### 3.3 Retención

`netlify/lib/storage-retention.ts` ofrece:

- `retentionPolicy()`: lee `STORAGE_ORPHAN_GRACE_DAYS`,
  `EVIDENCE_RETENTION_DAYS` y `BATCH_RETENTION_DAYS`; `0` significa “no borrar
  automáticamente”.
- `collectRetentionCandidates()`: compara objetos con claves referenciadas.
- `planRetention()`: separa huérfanos, referenciados vencidos y retenidos.
- `removeOrphans()`: por defecto `dryRun: true`; solo borra huérfanos y nunca
  objetos referenciados.

Los objetos referenciados vencidos se **señalan** pero no se borran: D-14 y D-16
siguen pendientes. Cualquier borrado de evidencia o lote requiere aprobación,
auditoría y, cuando corresponda, conservación por obligación legal.

---

## 4. Variables de entorno

| Variable | Uso | Valor seguro |
| --- | --- | --- |
| `PRIVATE_STORAGE_DRIVER` | `local`, `simulated`, o proveedor aprobado | `local` solo desarrollo; en Netlify es obligatorio un driver aprobado |
| `EVIDENCE_STORAGE_DIR` | Raíz del adaptador local de evidencias | Solo desarrollo/pruebas |
| `BATCH_STORAGE_DIR` | Raíz del adaptador local de lotes | Solo desarrollo/pruebas |
| `STORAGE_ORPHAN_GRACE_DAYS` | Días antes de considerar huérfano | `1` por defecto |
| `EVIDENCE_RETENTION_DAYS` | Retención de evidencias | `0` = no automático; D-14 pendiente |
| `BATCH_RETENTION_DAYS` | Retención de Excel | `0` = no automático; D-16 pendiente |

Variables propuestas para el adaptador real, **no activas** hasta aprobar D-13:

- `PRIVATE_STORAGE_BUCKET`
- `PRIVATE_STORAGE_REGION`
- `PRIVATE_STORAGE_ENDPOINT` (R2/S3 compatible)
- credenciales mediante el gestor de secretos del proveedor; nunca en el
  repositorio, `netlify.toml` ni variables `VITE_`.

`npm run staging:check` exige `PRIVATE_STORAGE_DRIVER` y rechaza `local` o
`simulated`, de modo que staging no se declara listo sin un adaptador aprobado.

No se ha creado ninguna cuenta, bucket, token ni política IAM.

---

## 5. Permisos mínimos

| Permiso | Uso |
| --- | --- |
| `offered_books.review` | Ver evidencias y revisar solicitudes |
| `inventory.batches.import` | Prevalidar y cancelar lotes |
| `inventory.batches.confirm` | Confirmar un lote |
| `inventory.batches.read` | Historial, detalle y CSV |
| `stats.read` | Estadísticas agregadas |

Las claves de almacenamiento no otorgan acceso por sí mismas: toda lectura exige
sesión/token y permiso. Los roles runtime no reciben DML directo sobre las tablas
de evidencias o lotes.

---

## 6. Recuperación y operación

1. **Verificar referencias:** consultar las claves de `offered_book_evidence` y
   `inventory_batches` y compararlas con `list()`.
2. **Objetos huérfanos:** planificar con `collectRetentionCandidates()` y
   `planRetention()`; revisar el modo seco antes de borrar.
3. **Objeto faltante:** si la fila existe pero el objeto no, marcar la evidencia
   como no disponible; no inventar una imagen de reemplazo.
4. **Fallo de escritura:** reintentar con una clave nueva; nunca reutilizar una
   clave parcial.
5. **Fallo de base tras `put`:** borrar el objeto recién creado; si el borrado
   falla, queda huérfano y entra en la limpieza con gracia.
6. **Restauración:** dependerá del proveedor (versioning, Object Lock o copia).
   Debe probarse antes de producción y documentarse en el runbook de staging.
7. **Auditoría:** conservar actor, clave, hash, tamaño, MIME, fechas y resultado;
   nunca secretos ni URLs firmadas.

---

## 7. Riesgos y controles no implementados

| Riesgo | Estado | Control requerido |
| --- | --- | --- |
| EXIF/GPS en fotos | **No mitigado** | D-15: eliminar metadatos o re-codificar antes de guardar |
| Malware en imágenes/Excel | **No mitigado** | D-15: antimalware y cuarentena antes de publicar |
| Fórmulas maliciosas en Excel | Mitigación parcial | El parser no evalúa fórmulas y rechaza macros/XML peligroso; no sustituye antimalware |
| Bucket público por error | **No aplicable aún** | Política de bucket privado, IAM mínimo y prueba de acceso anónimo |
| URL firmada filtrada | **No aplicable aún** | Expiración corta, no registrar en logs, no enviar por correo |
| Borrado accidental | **No automatizado** | D-14/D-16, modo seco, gracia y auditoría |
| Costos de egreso | **Por confirmar** | Estimación institucional y alertas de presupuesto |
| Consistencia eventual | Solo Blobs | Consistencia fuerte o lectura desde la Function con reintento |

---

## 8. Decisiones institucionales pendientes

- **D-13:** proveedor, cuenta, bucket, región, cifrado y presupuesto.
- **D-14:** plazo y borrado seguro de evidencias.
- **D-15:** EXIF/GPS, re-codificación y antimalware.
- **D-16:** retención y acceso a los Excel de lotes.

Sin estas decisiones no se debe activar un proveedor, ni habilitar cargas en
staging/producción, ni borrar evidencias o lotes existentes.

---

## 9. Pruebas locales

`netlify/tests/private-storage.test.ts` cubre:

- escritura/lectura/`head`/`list`/borrado;
- claves que escapan de la raíz;
- fallos simulados de escritura y borrado con reintento;
- claves impredecibles;
- selección de driver y fallo cerrado en Netlify;
- `netlify dev` con almacenamiento local;
- huérfanos, gracia, retención vencida y modo seco;
- borrado parcial con fallos registrados;
- lectura defensiva de variables.

Las pruebas de autorización, aislamiento por token y acceso administrativo están
en `netlify/tests/offered-books.test.ts`; las de lotes, en
`netlify/tests/admin-batches.test.ts`.

No se ejecutó ninguna prueba contra un proveedor real porque no existe cuenta ni
credencial aprobada.
