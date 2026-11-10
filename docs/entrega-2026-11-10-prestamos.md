# Préstamos: historial, vigencia y disponibilidad — 2026-11-10

## 1. Alcance

- Historial auditable de préstamos/trueques con transiciones append-only.
- Vigencia mínima de 48 horas para reservas activas y políticas configurables.
- Disponibilidad controlada al cierre válido, reutilizando las rutinas
  transaccionales existentes.
- API y vista administrativa del historial sin datos personales.
- Sin aplicar migraciones remotas, sin push, deploy ni cambios en producción.

## 2. Migración `0024_loans.sql`

- Tabla `loans`: solicitud, reserva, intercambio, ejemplar prestado, copia
  recibida, estado, inicio, vencimiento, cierre, actor de cierre, motivo y
  referencias a entregas.
- Tabla `loan_events`: transiciones append-only con actor y tipo de actor
  (`participant`, `administrator`, `system`).
- Sincronización automática desde:
  - reservas activas, aprobadas/comprometidas, expiradas o liberadas;
  - intercambios planificados, en curso, con devolución pendiente,
    completados o cancelados;
  - entregas de libro ofrecido, recepción del ejemplar institucional y
    devolución.
- Política de reservas con restricción `duration_seconds >= 172800`.
- `set_reservation_policy` se reemplaza con la misma firma, permisos y una
  validación mínima de 48 horas.
- Las reservas activas con vencimiento menor se ajustan a
  `created_at + 48 horas` durante la migración.
- Los préstamos cerrados no se eliminan ni reescriben.

## 3. Decisiones de modelo y transiciones

- Un préstamo se abre al crear la reserva activa (el modelo actual crea la
  reserva al registrar la solicitud).
- Estados:
  - `reserved`: solicitud registrada y vigente.
  - `committed`: solicitud aprobada y reserva comprometida.
  - `lent`: intercambio iniciado.
  - `return_pending`: cancelación/devolución pendiente de confirmación física.
  - `completed`: trueque completado con entregas confirmadas.
  - `cancelled`: cierre o cancelación válida con compensación.
  - `expired`: reserva vencida sin decisión.
- El cierre del préstamo ocurre dentro de la transacción existente de
  `complete_exchange`, `cancel_exchange`, `set_request_status` o
  `expire_reservations`.
- No se publica el ejemplar si sigue reservado, está retirado, tiene devolución
  pendiente o el flujo físico no está confirmado. Los guards existentes se
  conservan; el trigger valida el estado final del cierre.
- No se duplican reglas críticas en frontend; la UI solo consulta el historial.

## 4. API y UI

- `GET /api/admin/loans`: historial paginado con estado, ejemplar, solicitud,
  inicio, vencimiento, cierre y entregas.
- Requiere `requests.read` o `requests.review`.
- No expone nombres, correos ni documentos del participante.
- Nueva pestaña **Préstamos** en el panel administrativo con filtros por estado
  y paginación.

## 5. Pruebas

```text
db/migrations/0024_loans.test.ts
  5/5 OK
  - rechaza políticas inferiores a 48 horas;
  - crea el préstamo en la reserva y evita expiración anticipada;
  - cierre válido deja el ejemplar available y registra actor;
  - transición inválida no altera inventario ni historial;
  - cierre idempotente no duplica eventos.

netlify/tests/admin-loans.test.ts
  2/2 OK: historial paginado, validación y autorización.

src/components/AdminPanel.test.tsx
  Incluye la vista de préstamos sin datos personales.

npm test
  51 archivos pasan | 2 omitidos
  292 pruebas pasan | 7 omitidas

npm run lint
  OK

npm run build
  OK

npm run build:release
  OK
  release-candidate/assets/index-D5gBhfI3.js
  301.908 bytes
  incluye historial de préstamos
```

## 6. Estado y compatibilidad

- `0024_loans.sql` es aditiva y contigua a `0023`; no edita migraciones previas.
- No se aplicó en producción ni en Neon.
- El conflicto preexistente `0011/0016` para cadenas contiguas nuevas sigue sin
  resolverse y no fue ocultado.
- El correo permanece fuera de alcance.
