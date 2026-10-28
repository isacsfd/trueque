# Intercambio de libros — IUB

Aplicación institucional para facilitar el intercambio de libros. La base frontend corresponde a la **Fase 1** y se está preparando la conexión y esquema de la **Fase 2**. El catálogo, las solicitudes y la administración todavía no son operativos.

## Requisitos locales

- Node.js 22 o superior.
- npm.

## Desarrollo

```sh
npm install
npm run dev
```

Comprobaciones disponibles:

```sh
npm run lint
npm test
npm run build
```

## Neon y Netlify Functions

El acceso a datos reutilizable usa `@neondatabase/serverless` con el driver HTTP sin estado, apropiado para consultas desde funciones serverless. La función de diagnóstico está en `GET /api/private/database-diagnostics`; requiere `Authorization: Bearer <token>` y devuelve únicamente `{ "ok": true }` o un error genérico. Falla cerrada si no se configura un token de al menos 32 bytes.

Variables de servidor documentadas en [`.env.example`](.env.example):

| Variable | Dónde configurarla | Uso |
| --- | --- | --- |
| `DATABASE_URL` | Netlify: **Site configuration → Environment variables**, alcance de Functions; local en `.env` ignorado por Git | URL Neon para ejecución, con rol de aplicación de privilegios mínimos y endpoint pooled |
| `DATABASE_DIAGNOSTICS_TOKEN` | Netlify, alcance de Functions; local en `.env` ignorado por Git | Token aleatorio de 32 bytes o más para el endpoint privado |
| `DATABASE_MIGRATION_URL` | Entorno local protegido o tarea de migración protegida; **no** en las Functions de Netlify | URL separada con permiso DDL para migraciones revisadas, preferiblemente endpoint directo |

Introduce las credenciales en la configuración privada de Netlify indicada o en un `.env` local no versionado. No uses prefijo `VITE_`, no las pongas en `netlify.toml` y no las añadas a `.env.example`. La cadena Neon compartida durante la configuración debe rotarse antes de utilizarla como credencial de aplicación.

La conexión directa a Neon se comprobó con una consulta de solo lectura y sin consultar filas de la aplicación. Aún no se han configurado estas variables en Netlify.

## Migraciones

`npm run db:schema:inspect` consulta únicamente metadatos y necesita `DATABASE_URL` en el entorno del proceso. `npm run db:migrate:plan` calcula checksums sin abrir una conexión. La migración propuesta `db/migrations/0001_initial_schema.sql` **no se ha ejecutado**. Tras revisar y aprobar el esquema, `npm run db:migrate:apply` permite aplicarla con `DATABASE_MIGRATION_URL`; el runner usa transacción, bloqueo y checksum, y se niega a inicializar si detecta objetos de usuario sin un historial de migraciones. Nunca se ejecuta desde `npm run build` ni desde el despliegue.

## Estructura prevista

```text
src/                    Aplicación React y estilos
netlify/functions/      API backend ejecutada por Netlify Functions
db/migrations/          Migraciones SQL versionadas y revisables
docs/                   Arquitectura y decisiones del proyecto
```

La arquitectura, los límites de seguridad y las decisiones pendientes están descritos en [`docs/arquitectura.md`](docs/arquitectura.md). La conexión y el lugar para introducir las variables están detallados en [`docs/database-access.md`](docs/database-access.md). El esquema propuesto está en [`db/migrations/0001_initial_schema.sql`](db/migrations/0001_initial_schema.sql); requiere revisión antes de aplicarse.

## Seguridad y despliegue

- No hay secretos ni datos institucionales en el repositorio.
- La conexión Neon se verificó mediante `SELECT 1` y lectura de metadatos; las funciones aún requieren variables privadas para usarla.
- No se han aplicado migraciones ni desplegado el sitio.
- El logo oficial no se incluye porque todavía no se ha proporcionado un archivo autorizado. La interfaz usa texto institucional, no un logo sustituto.
- Los colores de la interfaz son la propuesta inicial indicada por el solicitante; no se presentan como códigos oficiales verificados.

La configuración real de Neon, autenticación, almacenamiento de fotografías y Netlify se definirá y probará en sus fases correspondientes antes de cualquier despliegue.
