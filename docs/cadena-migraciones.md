# Cadena canónica de migraciones — 2026-11-10

## Secuencia válida

```text
0001_initial_schema
0002_corrective_schema
0003_runtime_privileges
0004_p0_integrity
0005_participant_api
0006_inventory_import
0007_institutional_containment
0008_containment_request_compat
0009_offered_book_photos
0010_inventory_batches
0011_admin_accounts_and_request_guard
0012_admin_credentials
0013_admin_password_login
0014_admin_runtime_grants
0015_release_expired_reservations
0016_reservation_lifecycle
0017_public_request_status
0018_plan_exchange_delivery
0019_secure_public_status
0020_inventory_integrity_repair
0021_admin_workbench_indexes
0022_inventory_registration
0023_inventory_batch_autopublish
0024_loans
0025_loan_reactivation
0026_migration_chain_compat
```

## Causa raíz resuelta

`0011` exigía una reserva `active` en la aprobación. `0016` convierte la reserva
a `converted` antes de actualizar la solicitud, por lo que una aprobación válida
fallaba. `0026` acepta el compromiso exacto de la misma solicitud y ejemplar.

También se resolvieron dos incompatibilidades adicionales del runner y del ciclo:

- `0012` otorgaba `INSERT/UPDATE` directos a `admin_credentials`; las rutinas
  son `SECURITY DEFINER`, así que `0026` retira ese DML directo.
- Los allowlists de `iub_public_runtime` e `iub_admin_runtime` no incluían
  funciones revisadas introducidas en `0012`–`0025`; ya están declaradas.
- Al rechazar físicamente un libro ofrecido, `0016` puede cancelar el
  intercambio con la reserva convertida; `0026` libera ese compromiso antes del
  guard de préstamos, dentro de la misma transacción.

## Perfiles de base

| Perfil | Ledger efectivo | Ruta |
|---|---|---|
| Base nueva | vacía | `0001`–`0026` con el runner |
| Staging histórico | `0001`–`0005` y manifiesto consistente | bloque `0006`–`0026` con el runner |
| Producción histórica | `0001`–`0005` más `0019`/`0020` manuales fuera del ledger | runner prohibido; reconciliación manual autorizada aparte |

El runner detecta el perfil productivo con marcadores de `0020` y un ledger
`≤0005`, y falla antes de tocar datos.

## Regla de `0023`

`0023_inventory_batch_autopublish.sql` solo puede aplicarse cuando `0010` existe
en la historia efectiva. En la cadena completa esto se cumple. En una base que
no tenga las tablas de lotes, su precondition debe fallar con:

```text
0023 requires 0010 inventory batches and 0020 verification/publication routines
```

No se fuerza `0023` ni se crea una dependencia falsa en el ledger.

## Validación real ejecutada

- Runner real con driver `pg`, base desechable:
  - primera aplicación: `0001`–`0026`, transacción completa;
  - segunda aplicación: idempotente.
- Ciclo API–PostgreSQL sobre la cadena completa: 4/4.
- `npm run test:postgres` sobre la cadena completa: 15/15 escenarios.
- Pruebas PGlite de `0024`, `0025` y `0026`: en verde.
