# Acceso privado a Neon y Netlify

## Resultado de inspección

La conexión de solo lectura a Neon funcionó (`SELECT 1`). La consulta de catálogos no leyó filas de la aplicación: encontró el esquema `public`, sin tablas, vistas, secuencias, índices ni restricciones de usuario. La migración inicial que se propone en `db/migrations/0001_initial_schema.sql` no se ha ejecutado.

La conexión compartida para la prueba usa un rol de propietario y ya quedó expuesta en el chat. Rótala en Neon antes de reutilizarla. No se guardó en el repositorio ni en un archivo local.

## Variables y ubicación

| Variable | Ubicación | Requisitos |
| --- | --- | --- |
| `DATABASE_URL` | Netlify Dashboard → **Site configuration → Environment variables**; alcance Functions. Para pruebas locales, archivo `.env` ignorado por Git | URL pooled de Neon y rol exclusivo de runtime sin DDL ni permisos de borrado. Nunca `VITE_DATABASE_URL`. |
| `DATABASE_DIAGNOSTICS_TOKEN` | La misma configuración privada de Functions; local en `.env` | Valor aleatorio de al menos 32 bytes. No debe aparecer en URL, frontend, logs ni repositorio. |
| `DATABASE_MIGRATION_URL` | Solo en la sesión local protegida o tarea de migración aprobada; no en Functions | Rol separado con permisos DDL. Preferir la URL directa de Neon para migraciones. |

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

Crear desde Neon (sin poner contraseñas en SQL ni en código) dos roles separados:

- `iub_app_runtime`: login para Functions; sin `CREATE`, `ALTER`, permisos de rol ni `DELETE`.
- `iub_schema_migrator`: rol protegido usado solo para migraciones aprobadas; propietario del esquema o con DDL acotado.

Después de aprobar y aplicar el esquema, asignar al runtime únicamente `CONNECT`, `USAGE` en `public`, lectura de catálogo/usuarios/roles, `SELECT/INSERT/UPDATE` en los datos operativos que sus funciones requieran, `SELECT/INSERT` en historiales/auditoría y `USAGE/SELECT` en secuencias. No darle permisos sobre `schema_migrations`, DDL ni borrado. Revisar cada tabla nueva y extender privilegios de forma explícita desde la tarea de migración.

No se crearon roles ni se cambiaron permisos en Neon. Para esta inspección solo se usó la conexión disponible y consultas de lectura.
