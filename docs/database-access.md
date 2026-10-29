# Acceso privado a Neon y Netlify

## Resultado de inspección

El informe de una fase anterior registró una conexión de solo lectura a Neon y un esquema `public` sin objetos de usuario. Esta fase de corrección no se conectó a Neon. Las migraciones 0001-0005 se ejecutaron �nicamente en staging; producci�n permanece intacta.

La conexión compartida para la prueba usa un rol de propietario y ya quedó expuesta en el chat. Rótala en Neon antes de reutilizarla. No se guardó en el repositorio ni en un archivo local.

## Variables y ubicación

| Variable | Ubicación | Requisitos |
| --- | --- | --- |
| `DATABASE_URL` | Netlify Dashboard → **Site configuration → Environment variables**; alcance Functions. Para pruebas locales, archivo `.env` ignorado por Git | URL pooled y rol `iub_public_runtime`; solo vista pública y funciones aprobadas. Nunca `VITE_DATABASE_URL`. |
| `DATABASE_ADMIN_URL` | La misma configuración privada, solo funciones administrativas | URL pooled con rol separado `iub_admin_runtime`; sin DDL ni acceso de escritura directo a tablas. |
| `DATABASE_DIAGNOSTICS_TOKEN` | La misma configuración privada de Functions; local en `.env` | Valor aleatorio de al menos 32 bytes. No debe aparecer en URL, frontend, logs ni repositorio. |
| `DATABASE_MIGRATION_URL` | Solo en la sesión local protegida o tarea de migración aprobada; no en Functions | URL directa y rol `iub_schema_migrator`; separado de ambas URLs runtime. |
| `DATABASE_MIGRATION_ROLE` | Entorno protegido que ejecute migraciones | Nombre esperado del rol. El runner lo compara con `current_user`; no es un secreto. |
| `DATABASE_MIGRATION_DRIVER` | Entorno protegido de migraciones | `neon` por defecto; `pg` solo para PostgreSQL local/desechable. |
| `ADMIN_USERS` | Configuración privada de Functions | JSON con `username`, `passwordHash` (scrypt) y `actorUserId` de PostgreSQL. Nunca en el frontend. |
| `SESSION_SECRET` | Configuración privada de Functions | Secreto de firma de sesión administrativa de al menos 32 bytes. |
| `PARTICIPANT_DATA_KEY` | Configuración privada de Functions | Clave AES-256-GCM en base64 (32 bytes). No versionar. |
| `PARTICIPANT_IDENTITY_HMAC_KEY` | Configuración privada de Functions | Clave HMAC-SHA-256 en base64 (32 bytes) para huellas de documento. |
| `PARTICIPANT_DATA_KEY_VERSION`, `PARTICIPANT_HMAC_KEY_VERSION` | Configuración privada de Functions | Versiones positivas de clave; por defecto `1`. |
| `PRIVACY_NOTICE_VERSION` | Configuración privada de Functions | Versión del aviso ya insertado en `privacy_notices`; la API falla si no existe. |

`.env.example` contiene los nombres vacíos. Tras rotar la credencial, crea `.env` local solo si vas a usar `netlify dev`; no lo añadas a Git. Para Netlify, introduce cada valor en su dashboard privado. La migración no se ejecuta automáticamente en build o deploy.

Genera el token de diagnóstico localmente, sin compartirlo ni guardarlo en el repo:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

La llamada privada es:

```sh
curl -H "Authorization: Bearer $DATABASE_DIAGNOSTICS_TOKEN" https://<sitio>/api/private/database-diagnostics
```

El endpoint solo comprueba conectividad. Devuelve `{"ok":true}` o un error genérico; no devuelve host, rol, nombre de base, SQL, filas ni mensajes de Neon. No se ha publicado el endpoint, pues el sitio no está desplegado.

## Separación de privilegios

Los grants versionados están en `db/migrations/0003_runtime_privileges.sql`; no crean roles. Antes de aplicarlos, un operador debe crear roles separados desde Neon (sin contraseñas en SQL ni en código):

- `iub_public_runtime`: login para funciones públicas; sin permisos DML directos, DDL o acceso a participantes. Lee la vista de catálogo y ejecuta la rutina de reserva con prueba opaca por solicitud. Debe ser `NOINHERIT`, sin membresías en otros roles y sin `BYPASSRLS`.
- `iub_admin_runtime`: login distinto para funciones administrativas; lectura operativa selectiva y procedimientos autorizados, sin `INSERT/UPDATE/DELETE` directo. El contacto cifrado se obtiene mediante `get_participant_contact`, que requiere permiso RBAC y registra el acceso; no hay `SELECT` directo sobre `participants`. También debe ser `NOINHERIT`, sin membresías y sin `BYPASSRLS`.
- `iub_schema_migrator`: login de la tarea de migración, propietario/creador acotado del esquema. No debe ser superusuario ni tener `CREATEDB`/`CREATEROLE`, debe ser `NOINHERIT` y no puede pertenecer a roles privilegiados (`pg_write_all_data`, `pg_read_all_data`, `pg_database_owner`, `neon_superuser` ni roles con atributos de superusuario/DDL).

`0003_runtime_privileges.sql` revoca permisos de `PUBLIC`, tablas, secuencias y funciones antes de los grants selectivos. `0004_p0_integrity.sql` no concede escritura directa: añade solo una lectura administrativa de la tabla append-only `ownership_transfer_reversals`. Los historiales, auditoría, custodia y movimientos son append-only; runtime no recibe `INSERT/UPDATE/DELETE` directo. Las rutinas `SECURITY DEFINER` usan `search_path` fijo y validan permisos RBAC. La autenticación OIDC sigue siendo responsabilidad obligatoria de la Function que invoca una rutina.

La creación de roles y la ejecución del template son pasos de despliegue manuales pendientes de aprobación. El migrator valida que la sesión sea el rol esperado, sea distinto de los roles runtime, no tenga privilegios de clúster excesivos, sea `NOINHERIT`, no tenga membresías prohibidas, tenga `CREATE` solo donde corresponda, que los objetos de `public` le pertenezcan y que `PUBLIC`/los roles runtime no tengan escritura directa, privilegios efectivos no revisados ni default ACL. También compara el manifiesto de objetos PostgreSQL con el ledger antes de migrar.

La API cifra nombre, correo y documento con AES-256-GCM antes de invocar `create_exchange_request`; el token de participante se devuelve una sola vez y se guarda solo como SHA-256. El panel administrativo usa una sesión de staging con cookie `HttpOnly`/`SameSite=Strict`, `ADMIN_USERS` y `SESSION_SECRET`; cada acción se autoriza en PostgreSQL con el `actorUserId` de la sesión. El proveedor OIDC institucional sigue pendiente para producción.

`reserve_copy` y `complete_exchange` son una única llamada SQL cada una; sus rutinas PL/pgSQL hacen locks y cambios en la transacción implícita de esa sentencia. `@neondatabase/serverless` HTTP no se trata como sesión interactiva: `transaction([...])` queda para lotes estáticos, no para decidir consultas posteriores con resultados previos. `reserveCopy()` usa el rol público y una prueba opaca por solicitud; `completeExchange()` usa el rol administrativo. La Function de alta atómica de solicitudes aún no existe, por lo que no se concede `INSERT` directo al rol público.

No se crearon roles ni se cambiaron permisos en Neon. Las pruebas actuales son locales sobre PGlite, con roles efímeros; no demuestran cómo están configurados los roles de Neon.
