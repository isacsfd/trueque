# Entrega de módulos 1–4 — 2026-10-31

## 1. Resumen ejecutivo

Se implementaron y probaron los cuatro módulos solicitados, sin modificar
producción, sin hacer push y sin desplegar:

1. buscador de catálogo con filtros, paginación y orden estable;
2. validación de las invariantes de disponibilidad del trueque;
3. paginación, filtros y carga diferida del historial administrativo, más un
   índice justificado por medición;
4. consulta pública de estado con un único token y pruebas de contrato;
5. build candidata compatible con el esquema legacy, sin sustituir el
   `release` publicado.

El correo quedó fuera de alcance.

## 2. Problemas encontrados y causas

| Módulo | Causa |
|---|---|
| Buscador | No existía en el API ni en el catálogo React; se cargaba todo el catálogo y se filtraba, si acaso, en cliente. |
| Disponibilidad | `enable_received_copy` difiere la publicación a propósito; la publicación válida ocurre en `complete_exchange`. El defecto histórico fue la importación que degradó un ejemplar completado, ya corregido con 0020. |
| Administración | La consulta ordenaba hasta 10.000 solicitudes antes del `LIMIT` porque no existía un índice por `created_at DESC, id DESC`; además traía 100 filas con historial, entregas y contactos. |
| Estado público | El contrato ya era `{ token }`; faltaba una prueba de API que fijara el comportamiento y verificara que no se acepta una segunda credencial. |
| Frontend | El `release/index.html` usaba un bundle legacy distinto del `src` actual; una build directa del `src` activaría el flujo fotográfico contra un esquema sin 0009. |

Defectos adicionales corregidos durante la validación:

- al buscar desde una página mayor que 1, el catálogo conservaba la página
  anterior y podía mostrar una página vacía; ahora la búsqueda vuelve a la
  página 1;
- un error de red del catálogo no se limpiaba al iniciar una búsqueda posterior;
- la búsqueda administrativa normalizaba acentos en el término pero no en las
  columnas SQL; ahora ambas partes usan la misma normalización;
- el historial administrativo se descargaba para las 25 filas de cada página;
  ahora se carga bajo demanda desde el endpoint de detalle;
- el formulario legacy mostraba el token pero no lo persistía en
  `sessionStorage`; ahora la consulta posterior puede recuperarlo tras recargar.

## 3. Cambios implementados

### 3.1 Buscador

- `netlify/lib/catalog-search.ts`: normalización de texto, validación,
  paginación y límites de entrada.
- `netlify/lib/sql-text.ts`: expresión SQL compartida para búsqueda insensible
  a mayúsculas y acentos.
- `netlify/functions/catalog.ts`: búsqueda en PostgreSQL por título, autor,
  categoría y código; filtros combinados; `count(*)`; orden estable
  (`lower(title), lower(author), copy_id`); `LIMIT/OFFSET`; parámetros SQL.
- `src/components/Catalog.tsx`: campo de búsqueda con debounce de 300 ms,
  filtro por categoría, estados de carga/vacío/error, conteo y paginación.
- La respuesta legacy sin parámetros conserva hasta 100 ejemplares.
- La visibilidad sigue dependiendo de `available_catalog`; no se expone ningún
  ejemplar no autorizado.
- La búsqueda vacía devuelve el catálogo paginado; no se inventan resultados.

### 3.2 Disponibilidad

No se cambió la regla de negocio. Se reforzaron las pruebas:

- el ejemplar ofrecido permanece `unavailable` después de
  `enable_received_copy`;
- `complete_exchange` lo publica y registra `exchange_in`;
- el catálogo lo incluye solo después del cierre;
- las pruebas PGlite cubren reservas, transiciones y publicación;
- PostgreSQL real valida la concurrencia de la reparación 0020.

### 3.3 Administración

- `netlify/functions/admin-workbench.ts`:
  - parámetros `page`, `pageSize`, `status`, `q`, `summary` e `history`;
  - consulta de conteo separada;
  - filtros SQL parametrizados y búsqueda sin acentos;
  - `LIMIT/OFFSET` compatible con clientes legacy;
  - modo `summary` sin historial/entregas/evidencia para usos compactos;
  - modo `history=0` que conserva entregas y evidencia, pero omite el
    historial para cargarlo bajo demanda.
- `netlify/functions/admin-workbench-detail.ts`: detalle autorizado de
  historial, entregas y evidencia por solicitud.
- `src/components/AdminPanel.tsx`: 25 solicitudes por página, búsqueda y filtro
  en servidor, controles de paginación y botón “Ver historial” que consulta el
  detalle solo al abrirse.
- `db/migrations/0021_admin_workbench_indexes.sql`: índice
  `exchange_requests_created_at_id_idx`.
- No se descifran contactos adicionales ni se recuperan relaciones que la
  pantalla no necesita.

### 3.4 Consulta pública

- `netlify/tests/requests-status.test.ts`: token único, rechazo de tokens
  inválidos, 404 genérico, rate limit y ausencia de segunda credencial.
- `src/components/MyRequest.tsx` conserva un solo campo y envía `{ token }`.
- `src/components/LegacyRequestForm.tsx` guarda el token en
  `sessionStorage` para la consulta posterior.
- No se modificaron autenticación administrativa ni recuperación controlada de
  tokens.
- El smoke test del candidato confirma: un solo campo, sin contraseña.

### 3.5 Compatibilidad del frontend

- `src/components/LegacyRequestForm.tsx`: formulario compatible con
  `/api/requests` y `/api/requests/reserve`.
- `RequestForm` selecciona el formulario legacy con
  `VITE_REQUEST_MODE=legacy`.
- `.env.release` fija ese modo para el esquema de producción actual.
- `scripts/copy-release-static.mjs` conserva `catalogo.html`, `admin.html` y
  `admin.js` en el candidato.
- `scripts/verify-release.mjs` comprueba buscador, token único, formulario
  legacy, catálogo, panel administrativo, búsqueda administrativa, historial
  diferido y ausencia de “Clave de acceso”.
- `npm run build:release` genera `release-candidate/` sin sobrescribir
  `release/`.
- El bundle publicado actual (`release/`) no se modificó.

## 4. Mediciones administrativas

Metodología:

- PostgreSQL 18.6 local, base desechable `iub_admin_bench`;
- 10.000 solicitudes, 10.000 `state_history`, 10.000 `offered_books`;
- 2 calentamientos + 9 ejecuciones por escenario;
- mediana y p95; payload medido como bytes JSON de la respuesta de datos;
- datos sintéticos; no se usó la base de producción.

### Sin el índice nuevo

| Escenario | Mediana | Payload |
|---|---:|---:|
| Legacy: 100 filas sin filtros | 129.395 ms | 145.263 B |
| Nueva página de 25 + conteo (historial incluido) | 130.975 ms | 36.292 B |
| Nueva página de 25 + conteo (historial diferido, panel) | 135.666 ms | 32.921 B |
| Nueva página de 25 + conteo (resumen) | 141.258 ms | 32.921 B |

La paginación redujo el payload alrededor del 75%, pero sin índice el tiempo no
mejoró: PostgreSQL seguía ordenando las 10.000 solicitudes antes del `LIMIT`.

### Con `0021` aplicado en la base de prueba

| Escenario | Mediana | Payload |
|---|---:|---:|
| Legacy: 100 filas sin filtros | 13.192 ms | 145.263 B |
| Nueva página de 25 + conteo (historial incluido) | 10.574 ms | 36.292 B |
| Nueva página de 25 + conteo (historial diferido, panel) | 10.002 ms | 32.921 B |
| Nueva página de 25 + conteo (resumen) | 9.606 ms | 32.921 B |

Comparación del camino usado por el panel, frente al baseline sin índice:

- tiempo: `129.395 ms → 10.002 ms` (**92,3% menos**);
- payload inicial: `145.263 B → 32.921 B` (**77,3% menos**).

Si se compara la página de 25 con historial incluido, el tiempo baja de
`129.395 ms` a `10.574 ms` (**91,8% menos**) y el payload de `145.263 B` a
`36.292 B` (**75,0% menos**).

La mejora de tiempo se debe principalmente al índice; la carga diferida del
historial reduce además el payload inicial de `36.292 B` a `32.921 B` en este
conjunto (9,3%). En este dataset sintético no hay entregas ni evidencia, por lo
que el ahorro real de esas relaciones puede ser mayor en producción. No se
atribuye al cambio un porcentaje que no haya sido medido.

El índice no está aplicado en producción; queda como migración 0021 pendiente de
autorización.

## 5. Pruebas ejecutadas

```text
npm test
  44 archivos pasan, 2 omitidos
  265 pruebas pasan, 7 omitidas

npm run lint
  OK

npm run build
  OK

npm run build:release
  OK
  release-candidate/assets/index-DPaEC6uA.js
  292.277 bytes
  verificaciones: token único, buscador, catálogo, selección, formulario
  legacy, endpoint legacy, panel administrativo, búsqueda administrativa,
  historial diferido
  “Clave de acceso”: no presente

npm run test:inventory:postgres
  4/4 escenarios OK en PostgreSQL real
  - retiro concurrente serializado e idempotente
  - publicación concurrente serializada e idempotente
  - importación concurrente serializada e idempotente
  - democión directa bloqueada y retiro autorizado correcto

PGlite 0020
  9/9 pruebas OK

Pruebas nuevas de catálogo
  10/10 OK

Pruebas nuevas de administración
  22/22 OK (workbench, detalle y panel)

Pruebas nuevas de estado público
  4/4 OK

Pruebas del formulario legacy
  2/2 OK
```

Smoke test del candidato en navegador local:

- carga `assets/index-DPaEC6uA.js`;
- muestra el buscador del catálogo;
- el estado público tiene un solo campo (“Código de solicitud o reserva”) y
  ningún campo de contraseña;
- no se sustituyó el `release` publicado.

### Limitación de integración conocida

El test `netlify/tests/api-postgres.test.ts` ejecutado sobre una cadena nueva
0001–0019 + 0021 obtuvo 2/4 pruebas. Las dos que fallan lo hacen en
`request.approve` con HTTP 409: 0016 convierte la reserva a `converted` antes de
actualizar el estado de la solicitud, mientras el trigger de 0011 exige una
reserva `active` en ese instante. Es un conflicto preexistente entre migraciones,
no introducido por estos módulos, y no se modificó el test para ocultarlo.
La producción reportada no tiene aplicada 0016; por eso no se alteró el esquema
productivo.

El arnés histórico `npm run test:postgres` tampoco queda verde con el fixture
actual por la misma familia de incompatibilidades. La concurrencia de la
reparación se validó por separado con
`scripts/inventory-repair-postgres.mjs` en PostgreSQL real.

## 6. Archivos creados y modificados

### Nuevos

```text
netlify/lib/catalog-search.ts
netlify/lib/sql-text.ts
netlify/functions/admin-workbench-detail.ts
netlify/tests/catalog.test.ts
netlify/tests/admin-workbench-detail.test.ts
netlify/tests/requests-status.test.ts
src/components/Catalog.test.tsx
src/components/LegacyRequestForm.tsx
src/components/LegacyRequestForm.test.tsx
db/migrations/0021_admin_workbench_indexes.sql
scripts/copy-release-static.mjs
scripts/verify-release.mjs
scripts/benchmark-admin-workbench.mjs
scripts/explain-admin-workbench.mjs
.env.release
docs/entrega-2026-10-31-modulos.md
```

### Modificados

```text
netlify/functions/catalog.ts
netlify/functions/admin-workbench.ts
netlify/tests/admin-workbench.test.ts
src/lib/api.ts
src/components/Catalog.tsx
src/components/AdminPanel.tsx
src/components/AdminPanel.test.tsx
src/components/RequestForm.tsx
src/styles.css
db/migrations/0001_initial_schema.test.ts
db/migrations/README.md
eslint.config.js
index.html
package.json
.gitignore
```

## 7. Commit y rama

El commit de esta fase contiene este documento y se registra en `main`, sin push
ni deploy. El hash exacto se informa en la entrega final.

## 8. Pendientes y bloqueos

1. Aplicar `0021_admin_workbench_indexes.sql` en producción con backup y
   autorización separada.
2. Desplegar el `release-candidate` solo después de revisar la build y ejecutar
   smoke tests con el backend real.
3. Confirmar que `ALLOW_LEGACY_REQUEST_INTAKE=true` sigue vigente en el entorno
   de producción; el formulario legacy depende de ese contrato.
4. El flujo fotográfico permanece en `src`, pero no se activa en la build legacy.
   Solo debe habilitarse cuando el esquema 0009 esté instalado y validado.
5. Correo: fuera de alcance.
6. Revisar la secuencia de migraciones 0011/0016 antes de usar una cadena
   contigua en un entorno nuevo; el conflicto de aprobación está documentado
   arriba.
7. No volver a aplicar 0020 ni usar `npm run db:migrate:apply` sin resolver el
   ledger.

## 9. Publicación futura

```sh
npm test
npm run lint
npm run build
npm run build:release
npm run test:inventory:postgres
```

Luego:

1. revisar `release-candidate/` y sus hashes;
2. crear backup de producción;
3. aplicar 0021 con autorización;
4. publicar el candidato reemplazando `release/` solo tras aprobación;
5. ejecutar smoke tests de catálogo, búsqueda, reserva, estado y administración;
6. verificar que el catálogo siga mostrando 72 y que los 12 reservados no se
   publiquen.
