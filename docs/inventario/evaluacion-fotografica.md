# Evaluación fotográfica manual de libros ofrecidos

**Estado:** implementación local; **no desplegada**.
**Fecha:** 2026-10-29.
**Migración:** `0009_offered_book_photos.sql`.
**Alcance:** libros ofrecidos por estudiantes; no inventario institucional.
**Restricción:** la contención `0007`/`0008` se mantiene intacta.

---

## 1. Auditoría del flujo existente

El flujo anterior de solicitudes:

- `POST /api/requests` cifra datos personales y llama `create_exchange_request`.
- `create_exchange_request` inserta participante, consentimiento, solicitud y libro ofrecido.
- `POST /api/requests/reserve` llama `reserve_copy`.
- La revisión administrativa usa `request.review`, `request.approve` y `request.reject`.
- La recepción física, evaluación, catalogación y habilitación siguen en
  `receptions`, `book_evaluations`, `cataloging_records` e `inventory_admissions`.
- `offered_books` no tenía fotografías ni estados de revisión visual.
- `available_catalog` y `copies` no deben ser modificados por este flujo.

Por eso la evaluación fotográfica se implementó como una **capa previa** al flujo
físico existente, no como una nueva vía de habilitación.

---

## 2. Flujo implementado

### 2.1 Estados fotográficos

`offered_book_submissions.status`:

```text
draft → pending_review → in_review → needs_information → pending_review
                              └────→ preapproved
                              └────→ rejected
pending_review ─────────────────────→ rejected
```

Transiciones permitidas por trigger:

| Desde | Hacia | Actor |
| --- | --- | --- |
| `draft` | `pending_review` | Estudiante (submit) |
| `pending_review` | `in_review` | Revisor |
| `pending_review` | `rejected` | Revisor |
| `in_review` | `needs_information` | Revisor |
| `in_review` | `preapproved` | Revisor |
| `in_review` | `rejected` | Revisor |
| `needs_information` | `pending_review` | Estudiante (resubmit) |

`preapproved` y `rejected` son terminales para la revisión fotográfica. La
preaprobación **no** cambia la solicitud a aprobada ni el inventario.

### 2.2 Estados físicos existentes

La vista `offered_book_submission_workflow` compone los estados existentes:

| Estado compuesto | Fuente |
| --- | --- |
| `pending_physical_delivery` | `preapproved` + solicitud aprobada/programada sin recepción. |
| `received` | recepción `received`, `in_custody` o `evaluated`. |
| `accepted` / `not_accepted` | `book_evaluations.outcome` final. |
| `cataloged` | `cataloging_records.status = 'authorized'`. |
| `enabled` | `inventory_admissions.status = 'enabled'`. |
| Resto | Estado fotográfico. |

La vista no escribe estados. La habilitación sigue siendo una acción física y
administrativa separada; este flujo no la ejecuta.

### 2.3 Bloqueo de aprobación

El trigger `exchange_requests_photo_approval_guard` impide pasar una solicitud a
`approved` si tiene una submission vinculada y esta no está `preapproved`.

Solicitudes antiguas sin submission conservan el comportamiento previo.

---

## 3. Modelo de datos

### 3.1 `offered_book_submissions`

- `id`, `access_token_sha256`, `requested_copy_id`, `status`.
- Datos del libro: título, autor, editorial, género, ISBN, condición declarada,
  observaciones.
- `request_id` único, `idempotency_key` único.
- `submitted_at`, `reviewed_by`, `reviewed_at`, `decision_reason`, `review_notes`.
- Checks de estado, ISBN, longitudes y vínculo con solicitud.

### 3.2 `offered_book_evidence`

- `submission_id`, `slot` (`cover`, `back_cover`, `spine`, `interior`, `damage`).
- `storage_key` opaco y único.
- `detected_mime`, `byte_size`, `sha256`, `width`, `height`.
- `idempotency_key`, `created_at`, `deleted_at`.
- Límites: 4 MB, 12 archivos activos, 8000×8000 y 32 MP.
- Borrado lógico y eliminación del archivo.

### 3.3 `offered_book_submission_reviews`

Historial append-only con actor, acción, estado anterior/nuevo, motivo,
observaciones, clave de idempotencia y fecha. `UPDATE`/`DELETE` bloqueados por
`reject_immutable_change`.

### 3.4 Permiso nuevo

```text
offered_books.review — "Revisar fotografias y preaprobar libros ofrecidos"
```

No se asigna a roles por defecto. La institución debe asignarlo a los revisores.

---

## 4. API

### 4.1 Estudiante

| Ruta | Uso |
| --- | --- |
| `POST /api/offered-books` | Crear borrador; token opaco generado por el cliente; el servidor guarda su SHA-256. |
| `PATCH /api/offered-books` | Actualizar datos del libro mientras está en `draft`/`needs_information`. |
| `POST /api/offered-books/evidence` | Subir una imagen multipart con `X-Submission-Token`. |
| `DELETE /api/offered-books/evidence?id=` | Eliminar lógicamente una evidencia. |
| `GET /api/offered-books/status?id=` | Consultar estado, workflow y evidencias con token. |
| `POST /api/offered-books/submit` | Enviar por primera vez o reenviar tras `needs_information`. |
| `GET /api/evidence?id=` | Acceso privado a la imagen con token del dueño. |
| `GET /api/admin/evidence?id=` | Acceso administrativo con sesión y permiso `offered_books.review`. |

### 4.2 Administración

`POST /api/admin/action` incorpora:

```json
{
  "action": "submission.review",
  "submissionId": 4,
  "reviewAction": "preapprove",
  "reason": "Fotografías suficientes",
  "idempotencyKey": "uuid"
}
```

Acciones: `start_review`, `request_information`, `preapprove`, `reject`.
La función PostgreSQL valida `offered_books.review` y el actor de sesión.

`GET /api/admin/workbench` ahora incluye estado fotográfico, datos declarados,
evidencias y motivo de revisión. No incluye datos personales del estudiante.

---

## 5. Almacenamiento privado

### 5.1 Alternativas evaluadas

| Alternativa | Ventajas | Limitaciones | Decisión |
| --- | --- | --- | --- |
| Sistema de archivos local | Simple, privado, sin proveedor, fácil de probar. | No durable en Netlify Functions; no apto para producción serverless. | **Implementado para local/tests.** |
| `bytea` en PostgreSQL | Durable y privado; sin proveedor externo. | Hincha base, backups y conexiones; difícil de servir y limpiar. | No recomendado. |
| Objeto privado (S3/R2/GCS/Netlify Blobs) | Duradero, escalable, cifrado, lifecycle y URLs firmadas. | Requiere credenciales, configuración, coste y pruebas. | **Recomendado para staging/producción; no implementado.** |
| CDN/bucket público | Fácil de servir. | Expone datos personales; inaceptable. | Rechazado. |

### 5.2 Implementación actual

`netlify/lib/evidence-storage.ts` define una interfaz `EvidenceStorage`
(`put`/`get`/`delete`/`head`/`list`) y dos adaptadores:

- `LocalEvidenceStorage`: escribe fuera de `dist`/`public` (por defecto
  `var/evidence` o `var/batches`), nombre UUID, permisos restrictivos, escritura
  atómica y rechazo de claves con traversal.
- `SimulatedObjectStorage`: memoria con fallos inyectables, solo pruebas.

`PRIVATE_STORAGE_DRIVER` selecciona el adaptador. En Netlify Functions `local`,
`simulated` o la ausencia de driver fallan de forma cerrada: no se escribe
silenciosamente en el filesystem efímero. `netlify dev` puede usar `local`.

**Bloqueo de producción:** Netlify Functions no tiene un filesystem persistente.
Antes de habilitar cargas en staging/producción se debe implementar un adaptador
de objeto privado y definir lifecycle/retención. No se debe usar el adaptador local
como almacenamiento de producción. La comparación de proveedores, la retención y
las decisiones D-13–D-16 están en `docs/inventario/almacenamiento-privado.md`.

### 5.3 Validación de archivos

- Se inspeccionan bytes mágicos reales: JPEG, PNG y WebP.
- Se rechazan SVG, PDF, texto, GIF, ejecutables y archivos truncados.
- Se leen dimensiones del encabezado y se limitan a 8000×8000 / 32 MP.
- Se limita a 4 MB por archivo y 12 archivos activos.
- Se calcula SHA-256 y se guarda; no se confía en extensión ni MIME del cliente.
- Se sirve con `X-Content-Type-Options: nosniff`, MIME detectado, `Cache-Control:
  private, no-store`, `Content-Disposition: inline` y sin URL pública.
- **Pendiente:** análisis antimalware, eliminación de EXIF/GPS y re-codificación
  defensiva. No se afirman implementados.

---

## 6. Seguridad y privacidad

- Token de borrador opaco; solo se guarda SHA-256.
- Acceso a evidencia por token de dueño o sesión administrativa con
  `offered_books.review`.
- No se devuelve `storage_key` al navegador.
- No se exponen evidencias en `available_catalog` ni en rutas públicas.
- La aprobación de solicitud exige preaprobación fotográfica.
- La preaprobación no crea `copies`, `inventory_movements`, `inventory_admissions`
  ni publica catálogo.
- No se aceptan roles ni transiciones desde el cliente; PostgreSQL valida.
- No se registran nombres, correos, documentos ni tokens en logs de aplicación.
- Datos personales siguen cifrados por el flujo existente al enviar la solicitud.

### Riesgos pendientes

1. Almacenamiento local no durable en Netlify.
2. Sin antimalware ni eliminación de metadatos EXIF.
3. Sin rate limiting por IP/token ni captcha.
4. Sin limpieza automática de borradores/evidencias abandonados.
5. Sin política de retención aprobada.
6. Permiso `offered_books.review` sin roles asignados.
7. No hay OIDC institucional; la sesión administrativa es de staging.
8. Solicitudes antiguas sin fotografías conservan el flujo previo.

---

## 7. Decisiones institucionales pendientes

| Decisión | Opciones | Recomendación | Estado |
| --- | --- | --- | --- |
| Proveedor de almacenamiento | S3/R2/GCS/Netlify Blobs | Objeto privado con cifrado y lifecycle. | `PENDIENTE DE APROBACIÓN INSTITUCIONAL` |
| Retención de evidencias | 30/90/365 días / indefinida | Plazo definido y borrado seguro. | `PENDIENTE DE APROBACIÓN INSTITUCIONAL` |
| Metadatos EXIF/GPS | Conservar / eliminar / re-codificar | Eliminar antes de almacenar. | `PENDIENTE DE APROBACIÓN INSTITUCIONAL` |
| Set mínimo de fotos | Portada + interior / todas las caras | Portada + interior mínimo; admin puede solicitar más. | `PENDIENTE DE APROBACIÓN INSTITUCIONAL` |
| Criterios de estado | Ver política física D-02 | No inventar umbrales. | `PENDIENTE DE APROBACIÓN INSTITUCIONAL` |
| Revisor y autorizador | Mismo rol / roles separados | Separar `offered_books.review` de `requests.review` cuando sea posible. | `PENDIENTE DE APROBACIÓN INSTITUCIONAL` |
| Antimalware | Escaneo externo / no escanear | Escaneo previo a producción. | `PENDIENTE DE APROBACIÓN INSTITUCIONAL` |

---

## 8. Pruebas

- `db/migrations/0009_offered_book_photos.test.ts`: 8 pruebas de migración,
  estados, permisos, preaprobación, bloqueo de aprobación, resubmission,
  evidencias, tokens, límite de archivos, idempotencia y ausencia de cambios de
  inventario.
- `netlify/lib/evidence-validation.test.ts`: formato real, SVG/texto, truncado,
  tamaño y nombre seguro.
- `netlify/tests/offered-books.test.ts`: carga, borrado, acceso por token,
  acceso administrativo con permiso, 403 sin permiso y rechazo de archivos
  inválidos/grandes.
- `netlify/tests/offered-books-draft.test.ts`: creación, hash del token, ISBN,
  estado, submit y ausencia de PII en payload.
- `netlify/tests/admin-action.test.ts`: acción `submission.review` con actor.
- `src/components/RequestForm.test.tsx`: flujo con fotos, borrador, envío y
  reserva.
- `src/components/AdminPanel.test.tsx`: revisión fotográfica y acciones.
- Suites existentes: `npm test`, `npm run lint`, `npm run build`,
  `npm run test:postgres` (15 escenarios) y runner real con 9 migraciones en
  PostgreSQL local desechable.

No se desplegó nada.

---

## 9. Recomendación

1. Aprobar las decisiones de almacenamiento, retención, EXIF y set mínimo.
2. Asignar `offered_books.review` a revisores y `requests.review` a quien aprueba.
3. Implementar adaptador de objeto privado y antimalware antes de staging.
4. Probar el flujo en local con PostgreSQL real; mantener `0007`/`0008`.
5. No habilitar inventario desde este flujo.
