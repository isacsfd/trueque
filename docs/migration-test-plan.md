# Plan de pruebas de migración y preparación

Este plan no se ejecutó contra Neon. La prueba integrada actual usa PGlite y roles efímeros; no modifica bases remotas.

## 1. Comprobaciones locales sin conexión

```sh
npm install
npm test
npm run lint
npm run build
npm audit
npm run db:migrate:plan
```

`db:migrate:plan` no abre conexiones y muestra el SHA-256 canónico de cada migración activa: UTF-8 sin BOM y saltos LF, fijados por `.gitattributes` (`eol=lf`). `0001_initial_schema.sql` coincide byte a byte con el checksum registrado en `db/migrations/archive/0001_initial_schema.pre-audit.sha256` (`cf4b22…`); no se ha reescrito. La prueba unitaria verifica además que ningún SQL versionado contenga `\r`.

## 2. Base PostgreSQL desechable

Preparar una instancia nueva, aislada y con nombre de base que identifique claramente una base de prueba (por ejemplo, sufijo `_test`). No usar la base institucional ni una rama que contenga datos personales reales.

1. Crear allí, manualmente y sin contraseñas en SQL, `iub_schema_migrator`, `iub_public_runtime` e `iub_admin_runtime` con login separado. Ninguno debe ser superusuario, crear bases/roles ni heredar al propietario.
2. Dar al migrator `USAGE, CREATE` en `public`; no crear tablas todavía.
3. En el `.env` local ignorado por Git, configurar las dos URLs runtime, `DATABASE_MIGRATION_URL` y `DATABASE_MIGRATION_ROLE=iub_schema_migrator`, todas al mismo endpoint/base. No usar las credenciales de propietario como runtime.
4. Ejecutar `npm run db:migrate:plan` y revisar el SQL activo y su checksum.
5. Solo con aprobación expresa, ejecutar `npm run db:migrate:apply` contra esa base desechable.
6. `npm run db:migrate:apply` aplica `0001_initial_schema.sql`, `0002_corrective_schema.sql`, `0003_runtime_privileges.sql`, `0004_p0_integrity.sql` y `0005_participant_api.sql` en una sola transacción; `0001` se conserva byte a byte y `0003` exige que los tres roles ya existan (no los crea).
7. Ejecutar otra vez `npm run db:migrate:apply`: debe informar que no hay migraciones pendientes. Modificar el checksum de una copia de prueba debe provocar rechazo.
8. Verificar tablas, relaciones, manifiesto, permisos, funciones, secuencias y que `PUBLIC` no reciba permisos sobre objetos.

## 3. Flujos integrados

`db/migrations/0001_initial_schema.test.ts` aplica las migraciones base sobre PGlite y cubre los flujos históricos. `db/migrations/0004_p0_integrity.test.ts` aplica las cuatro primeras migraciones, verifica estados/constraints/guards/permisos y el rollback transaccional de `0004`. `db/migrations/0005_participant_api.test.ts` verifica el alta idempotente y la consulta de estado con prueba opaca. `netlify/tests/api-postgres.test.ts` ejecuta los handlers reales contra PostgreSQL desechable para el ciclo completo y la cancelación con devolución. La importación `0006` se prueba con `scripts/import-inventory.py` y `scripts/verify-inventory-import.py` en PostgreSQL local. La prueba real `npm run test:postgres` cubre:

- cancelación antes de la recepción física, sin admisión ni transferencia;
- cancelación tras custodia: exige devolución física confirmada, no admite evaluación/admisión posterior;
- cancelación tras aceptación: revierte la transferencia en tabla append-only, retira el ejemplar ofrecido y exige devolución;
- doble reserva concurrente y vencimiento concurrente sin dos reservas activas;
- carrera cancelación/reserva y cancelación/cancelación sin deadlock;
- handover institucional confirmado bloquea la cancelación;
- el ejemplar ofrecido permanece `unavailable` hasta `complete_exchange` y solo entonces pasa a `available`;
- recepción rechazada, devolución y ausencia de admisión;
- permisos efectivos: runtime sin DML, helpers internos no ejecutables y tabla de reversiones solo lectura para admin.

La prueba paralela de PGlite usa una sola instancia y no prueba interbloqueos entre sesiones. La prueba real usa `pg` con conexiones independientes y una base desechable.

## 3.1 PostgreSQL real desechable

`IUB_TEST_DATABASE_URL` debe apuntar a una base desechable ya migrada con `0001`-`0005`. No usar Neon de producción ni credenciales de propietario. Ejemplo local con Docker:

```sh
docker run --name iub-pg-test -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55432:5432 -d postgres:17-alpine
docker exec -i iub-pg-test psql -U postgres -c "CREATE ROLE iub_schema_migrator LOGIN NOINHERIT; CREATE ROLE iub_public_runtime LOGIN NOINHERIT; CREATE ROLE iub_admin_runtime LOGIN NOINHERIT;"
docker exec -i iub-pg-test createdb -U postgres -O iub_schema_migrator iub_test
docker exec -i iub-pg-test psql -U postgres -d iub_test -c "GRANT USAGE, CREATE ON SCHEMA public TO iub_schema_migrator;"
# aplicar 0001-0005 con psql como iub_schema_migrator
IUB_TEST_DATABASE_URL=postgresql://iub_schema_migrator@127.0.0.1:55432/iub_test npm run test:postgres
```

La prueba de rollback real se ejecuta en otra base desechable: aplicar `0001`-`0003`, abrir `BEGIN`, aplicar `0004`, forzar un error y `ROLLBACK`; después `to_regclass('public.ownership_transfer_reversals')` y `to_regprocedure('public.iub_lock_request(bigint)')` deben ser `NULL`. Repetir con `0005`; `to_regprocedure('public.create_exchange_request(text,jsonb,uuid)')` y `get_request_status(text,bytea)` deben quedar `NULL`. El resultado de esta fase está registrado en `docs/deployment-p0.md`.

## 4. Preparación para producción, sin aplicar

1. Revisar y aprobar el baseline, permisos y decisiones de retención/privacidad.
2. Crear los roles reales en el panel de Neon según `db/migrations/0003_runtime_privileges.sql`; no reutilizar la cuenta propietaria.
3. Configurar variables privadas por ámbito en Netlify; probar `DATABASE_URL` y `DATABASE_ADMIN_URL` separadas con las Functions correspondientes.
4. Hacer una última inspección de solo lectura del esquema/roles y comprobar que el ledger no contiene el checksum anterior.
5. Solo tras aprobación explícita, programar la aplicación controlada del baseline. Este paso no se ejecutó ni se ejecutará sin autorización.

## Límites del runner

El runner comprueba URL/rol esperado, separación de nombres y destino normalizado, atributos de roles (`NOINHERIT`, sin superusuario/DDL/RLS bypass), membresías en `pg_auth_members`, privilegios efectivos por tabla/columna/secuencia/función, propiedad de objetos, `PUBLIC` y default ACL, DDL runtime, checksum/continuidad del ledger, esquema vacío inicial y manifiesto de nombres/tipos de objetos. El manifiesto no compara definiciones completas de columnas, funciones ni filas de negocio; los tests PostgreSQL y la revisión SQL son necesarios para eso. Tampoco crea roles ni determina si la política institucional de permisos/retención es correcta.
