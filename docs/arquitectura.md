# Arquitectura propuesta

## Alcance y decisiones de esta fase

El repositorio estaba vacío. La Fase 1 creó la base React + TypeScript + Vite y una pantalla informativa sin registros ficticios. La Fase 2 añade acceso privado a Neon y configuración para Netlify Functions. La conexión fue comprobada con consultas de solo lectura; no se aplicaron migraciones ni se publicó el sitio.

Los colores `#FFFFFF`, `#174A91` y `#FFD447` se usan como propuesta visual inicial, no como identidad oficial verificada. No se recrea el logo IUB; se integrará únicamente cuando se entregue el recurso autorizado.

## Vista de componentes

```text
Navegador
  └─ React + TypeScript + Vite
       └─ API HTTPS
            └─ Netlify Functions
                 ├─ Validación de entrada y autorización en servidor
                 ├─ Acceso PostgreSQL mediante conexión privada a Neon
                 └─ Emisión de cargas firmadas para almacenamiento de objetos

Netlify: publicación del frontend y ejecución de Functions
Neon: PostgreSQL
Almacenamiento de objetos: fotografías; proveedor por seleccionar
```

El navegador nunca recibe `DATABASE_URL`, credenciales de almacenamiento ni claves de cifrado. Las funciones deben validar entradas, autenticar y autorizar cada operación, aplicar límites de uso y devolver errores públicos sin detalles internos ni datos personales.

## Módulos

- **Catálogo público:** búsqueda, filtros, paginación y detalle; solo consulta ejemplares habilitados. No muestra datos de participantes ni información interna.
- **Solicitudes:** captura de autorización de privacidad, datos del participante y del libro ofrecido; validación compartida en el cliente y nuevamente en el servidor.
- **Administración:** funciones protegidas por identidad gestionada y roles verificados en servidor. No se confiará en roles enviados por el cliente ni se crearán credenciales por defecto.
- **Recepción:** ciclo independiente para coordinación, entrega física, custodia temporal, evaluación, aceptación/rechazo y devolución documentada. La recepción no crea automáticamente inventario institucional.
- **Catalogación e inventario:** separación entre registro bibliográfico, ejemplar físico, código de inventario, ubicación, disponibilidad, procedencia y movimientos.
- **Intercambios y reservas:** reserva temporal atómica de ejemplares y cierre del intercambio solo tras aceptación física y registro consistente de ambos movimientos.
- **Funciones transversales:** validación de esquemas, autenticación/autorización, manejo centralizado de errores, auditoría y registro técnico sin cuerpos de solicitudes ni identificadores sensibles.

## Datos y consistencia

El modelo relacional se normalizará por dominios y se documentará junto a las migraciones SQL. Como mínimo cubrirá participantes, usuarios/roles/permisos, editoriales, géneros, registros bibliográficos, ejemplares, solicitudes, libros ofrecidos e imágenes, reservas, intercambios, recepciones, evaluaciones, catalogaciones, entregas, movimientos de inventario e historiales/auditoría.

Reglas de diseño que deberán materializarse en esquema y transacciones:

1. Un libro ofrecido vive en recepción/custodia separada; solo una aceptación, catalogación, validación y autorización explícitas permiten habilitar un ejemplar.
2. Una solicitud aprobada no equivale a intercambio completado.
3. La reserva activa se protege con restricción/índice único parcial y operación transaccional con bloqueo del ejemplar. Toda operación también comprueba vencimiento y disponibilidad en backend.
4. El intercambio registra atómicamente la recepción aceptada y los dos movimientos de inventario; no se retira un ejemplar institucional antes de documentar la aceptación y entrega del libro ofrecido.
5. Las transiciones de estado se validan en servidor y se registran en historiales append-only. Las migraciones serán aditivas y revisadas; no se ejecutarán automáticamente al iniciar la aplicación ni se aplicarán de forma destructiva sobre una base existente.

## Protección de datos y archivos

- El documento de identidad no se devolverá al cliente ni se incluirá en logs, errores o telemetría. Propuesta para evitar duplicados: conservar el dato cifrado en el servidor solo si el proceso requiere consultarlo, y mantener una huella HMAC con clave privada separada para comparación. Las claves, normalización, acceso y retención requieren revisión antes de implementar.
- Registrar la versión del aviso de privacidad, fecha y evidencia de autorización. La institución debe aprobar el texto, la finalidad, los plazos de conservación y el procedimiento de consulta/eliminación conforme a sus obligaciones aplicables.
- Fotografías fuera de PostgreSQL. Propuesta: almacenamiento de objetos compatible con cargas prefirmadas de corta duración, emitidas después de validar tipo/tamaño y autorización en backend. El navegador no recibe claves privadas. El proveedor, región, permisos, límites y costos quedan por decidir.
- Aplicar límites de frecuencia y controles de abuso en endpoints públicos; límites de tipo, tamaño, cantidad y contenido real en cargas. Las imágenes deben servirse con permisos y encabezados adecuados.

## Persistencia y despliegue

- **Base de datos:** PostgreSQL en Neon.
- **Funciones:** Netlify Functions. `@neondatabase/serverless` usa el driver HTTP sin estado. Reservas y cierre de intercambio invocan una sola rutina PL/pgSQL que realiza locks y mutaciones atómicas; los lotes HTTP no interactivos no se consideran sesiones transaccionales interactivas.
- **Privilegios:** roles separados para ejecución pública, funciones administrativas y migraciones. No se conceden privilegios de escritura a `PUBLIC`; las credenciales se suministran solo desde configuración privada, nunca mediante variables `VITE_*`.
- **Autenticación administrativa:** seleccionar proveedor OIDC/identidad institucional antes de la fase administrativa; verificar tokens y permisos exclusivamente en servidor. Si se usan cookies, configurar `HttpOnly`, `Secure`, `SameSite` y protección CSRF para mutaciones.
- **Imágenes:** seleccionar almacenamiento de objetos y evaluar sus costos y condiciones antes de emitir credenciales.
- **Netlify:** `netlify.toml` configura build de `dist`, Functions, Node 22, headers básicos y fallback SPA. Las variables de entorno se añaden en la configuración privada de Functions, no en Vite ni en `netlify.toml`. El sitio no se ha desplegado.

### Acceso de datos implementado en Fase 2

- `netlify/lib/database.ts` centraliza consultas parametrizadas, URLs separadas para runtime público/administrativo, llamadas atómicas a `reserve_copy`/`complete_exchange` y errores genéricos. Los logs de fallo contienen como máximo un SQLSTATE validado; nunca SQL, parámetros, URL, host ni datos de usuario.
- `GET /api/private/database-diagnostics` verifica solo `SELECT 1`. Exige un Bearer token privado de al menos 32 bytes, comparación de tiempo constante, no permite caché y no expone detalles de conexión. Si no se configura el token, responde 404.
- `.env.example` documenta `DATABASE_URL`, `DATABASE_DIAGNOSTICS_TOKEN` y `DATABASE_MIGRATION_URL` sin valores.
- `scripts/migrate.mjs` es dry-run por defecto. Solo `--apply` abre conexión usando la URL de migración; exige Node 22+, usa checksum y bloqueo transaccional, y rechaza el bootstrap si encuentra objetos de usuario sin ledger.

Una inspección previa encontró únicamente el esquema `public`, sin objetos de usuario. La fase de corrección no reconectó. La credencial compartida previamente tenía permisos de propietario y debe rotarse antes de reutilizarse; el runner actual exige que los roles runtime y migrador estén separados.

## Calidad

El cliente valida para orientar al usuario, pero el backend es la autoridad. Se usará validación de esquemas, respuestas de error seguras y pruebas automatizadas. Las fases funcionales añadirán pruebas unitarias y de integración para transiciones, recepción, imágenes, autorización, reservas concurrentes e intercambios. Las pruebas de base de datos usarán una instancia aislada y datos sintéticos, nunca datos personales reales.

## Modelo de base de datos corregido (staging aplicado; producci�n pendiente)

El esquema base no aplicado está en `db/migrations/0001_initial_schema.sql` y se conserva byte a byte. Las correcciones aditivas están en `db/migrations/0002_corrective_schema.sql`: cifrado/versiones de clave y huellas HMAC versionadas, issuer+subject OIDC, admisión de inventario ligada a recepción/evaluación/propiedad/catalogación, procedimientos de recepción/reserva/cierre, transiciones explícitas e historiales append-only. Los privilegios de runtime están en `db/migrations/0003_runtime_privileges.sql`. La integridad P0 está en `db/migrations/0004_p0_integrity.sql`: cancelación compensada con devolución física confirmada, reversión append-only de propiedad, estados de cancelación pendiente, guards de admisión/disponibilidad y orden de locks por solicitud. La API de intake/estado está en `db/migrations/0005_participant_api.sql`. El checksum del baseline anterior se conserva en `db/migrations/archive/0001_initial_schema.pre-audit.sha256` y su contenido está en la historia Git.

Las pruebas de esquema se ejecutan con PGlite y roles de prueba locales. La concurrencia, los bloqueos y los permisos efectivos se probaron con conexiones independientes en PostgreSQL 17 desechable (`npm run test:postgres`); el despliegue Netlify y la prueba contra staging est�n completados; producci�n sigue pendiente.

Antes de aplicar, debe revisarse la política de campos personales, los estados y sus nombres, el tratamiento de retención/eliminación, permisos por rol, regla de aceptación, comprobantes y el origen de inventario. La migración se deja para aprobación explícita.

## Fases

1. **Arquitectura y estructura** — iniciada en este cambio.
2. **Base de datos y migraciones** - modelo corregido y probado localmente con PGlite y PostgreSQL 17 desechable; staging desplegado en Neon y Netlify; producci�n pendiente de aprobaci�n.
3. **Catálogo público** — consultas, filtros, paginación y ficha.
4. **Solicitudes y fotografías** — privacidad, idempotencia, carga segura y comprobante/código.
5. **Administración** — identidad, permisos, estados, auditoría y gestión de solicitudes.
6. **Recepción y catalogación** — custodia, evaluación, decisión y habilitación formal.
7. **Inventario e intercambios** — reservas, movimientos atómicos y recuperación de vencimientos.
8. **Seguridad, pruebas y despliegue** — revisión integral, configuración privada y aprobación antes de publicar.

## Decisiones pendientes antes de fases posteriores

- Logo autorizado y lineamientos institucionales oficiales.
- Proveedor de identidad/OIDC y responsables de roles administrativos.
- Proveedor de almacenamiento de objetos, región, presupuesto y política de eliminación.
- Texto y revisión institucional del aviso de privacidad, finalidades, retención y procedimiento para titulares.
- Reglas operativas de evaluación, motivos de rechazo, devolución, horarios y comprobantes.
- Duración de reserva, frecuencia de limpieza y política de recuperación de operaciones vencidas.
- Ambientes Neon, URLs y credenciales privadas (roles de migración y runtime separados); no se incluyen valores en el repositorio.
