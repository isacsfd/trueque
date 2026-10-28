# Migraciones de base de datos

Las migraciones se versionan con nombres secuenciales y descriptivos. Cada migración es aditiva, se revisa antes de aplicarse y registra un checksum en `public.schema_migrations`.

`npm run db:schema:inspect` consulta solo metadatos y puede ejecutarse antes de preparar una migración. `npm run db:migrate:plan` solo calcula y muestra los checksums locales. Aplicar exige el comando explícito `npm run db:migrate:apply` y `DATABASE_MIGRATION_URL`; el runner usa una transacción, bloqueo de migración y rechaza el bootstrap si encuentra objetos de usuario sin historial de migraciones. No se ejecuta desde la aplicación ni desde el build.

La migración `0001_initial_schema.sql` es una propuesta basada en la inspección de solo lectura de Neon. **No ha sido aplicada.** No contiene `DROP`, `TRUNCATE` ni cambios destructivos. Las futuras migraciones deben seguir siendo aditivas y no asumir que una base distinta está vacía.
