# Reactivación segura de préstamos cancelados — 2026-11-10

## 1. Alcance

- Reactivación autorizada de préstamos con estado `cancelled`.
- Transición explícita `cancelled → reserved` o `cancelled → committed`,
  según el flujo real:
  - sin intercambio: la solicitud vuelve a `under_review` y el préstamo a
    `reserved`;
  - con intercambio cancelado sin flujo físico incompatible: el intercambio
    vuelve a `planned`, la solicitud a `scheduled` y el préstamo a
    `committed`.
- Historial preservado: el evento de cancelación no se elimina.
- Evento append-only de reactivación con fecha, actor autorizado y motivo
  obligatorio.
- Sin migraciones remotas, sin push, deploy ni cambios en producción.

## 2. Migración `0025_loan_reactivation.sql`

- Permiso `loans.reactivate`.
- Columnas `reactivation_key`, `reactivated_at`, `reactivated_by` y
  `reactivation_reason`.
- Índice único parcial para idempotencia por clave.
- Función transaccional `reactivate_cancelled_loan`.
- Validaciones dentro de locks y una única transacción:
  - solo préstamos `cancelled`;
  - solicitud elegible para continuar;
  - ejemplar no retirado y disponible/reservado solo para esa solicitud;
  - ninguna otra reserva activa o compromiso sobre el ejemplar;
  - ningún otro préstamo activo;
  - ninguna devolución pendiente o confirmada;
  - ningún intercambio con entregas físicas incompatibles;
  - ninguna copia ofrecida retirada de forma irreversible.
- Si la reserva anterior estaba liberada o expirada, se restablece con
  duración mínima de 48 horas.
- Los estados de solicitud e intercambio se restauran en la misma transacción,
  con historiales `request_status_history`, `state_history` y
  `reception_status_history`.
- Evento `loan.reactivated` y auditoría `loan.reactivated`.

## 3. API y UI

- Acción administrativa `loan.reactivate` en la allowlist
  `POST /api/admin/action`.
- Requiere motivo obligatorio de al menos 3 caracteres y clave de idempotencia.
- La autorización la valida `assert_actor_permission` en PostgreSQL con
  `loans.reactivate`.
- La pestaña **Préstamos** muestra el botón **Reactivar** solo en préstamos
  cancelados, solicita motivo y muestra el resultado sin datos personales.

## 4. Pruebas

```text
db/migrations/0025_loan_reactivation.test.ts
  6/6 OK
  - reactivación válida;
  - conservación del evento de cancelación y creación del evento de reactivación;
  - rechazo con otra reserva/préstamo activo;
  - rechazo con ejemplar retirado o devolución física pendiente;
  - reserva restablecida con al menos 48 horas;
  - reintento idempotente sin duplicar eventos;
  - rechazo sin el permiso administrativo.

netlify/tests/admin-action.test.ts
  incluye delegación allowlist, motivo e idempotencia: 10/10 OK

src/components/LoanHistory.test.tsx
  2/2 OK: control visible, motivo obligatorio y resultado.

npm test
  53 archivos pasan | 2 omitidos
  301 pruebas pasan | 7 omitidas

npm run lint
  OK

npm run build
  OK

npm run build:release
  OK
  release-candidate/assets/index-G2gwOOuF.js
  incluye reactivación de préstamos cancelados
```

## 5. Compatibilidad

- `0025` es aditiva y contigua a `0024`; no edita migraciones previas.
- No se aplicó en producción ni en Neon.
- El conflicto preexistente `0011/0016` para cadenas contiguas nuevas sigue sin
  resolverse y no fue ocultado.
- El correo permanece fuera de alcance.
