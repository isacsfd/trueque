# Reservas y disponibilidad del inventario — reporte de pruebas

Fecha: 2026-10-30

## Cambios desplegados

- Migración aplicada: `0016_reservation_lifecycle.sql`.
- Reparación auditada: `db/repairs/2026-10-30_request_4_reservation_repair.sql`.
- Commit de aplicación: `196c06b`.
- Deployment: `6ae40529f183d7ae52be5146`.
- Sitio: https://trueque-iub-2026.netlify.app

## Entornos de prueba

| Entorno | Uso | Aislamiento |
|---|---|---|
| PGlite en memoria | 12 pruebas del ciclo completo de reservas | Base efímera creada desde cero |
| Rama Neon `qa-reservas-20261030` | Concurrencia real con dos conexiones PostgreSQL | Rama hija de `production`, eliminada al terminar |
| PostgreSQL productivo | Solo lecturas de verificación y reparación puntual auditada | No se usó para pruebas de escritura |

La rama temporal se creó desde `production` después de aplicar la migración y se eliminó al finalizar. No quedó ninguna copia, solicitud, reserva o lote de prueba en producción.

## Datos de prueba

- PGlite: ejemplares `QA-RES-1` a `QA-RES-4`, participantes y solicitudes con identificadores `QA-RES-*`.
- Rama Neon: se usaron los ejemplares sintéticos existentes `IUB-STG-001` e `IUB-STG-002`.
- No se usaron como fixtures los ejemplares reales `INV-*` ni `CH-*`.

## Pruebas PGlite

Comando:

```text
npx vitest run db/migrations/0016_reservation_lifecycle.test.ts
```

Resultado: **12 pruebas aprobadas**.

Cubre:

1. Reserva atómica al crear la solicitud.
2. Desaparición inmediata de `available_catalog`.
3. Segundo intento sobre el mismo ejemplar rechazado con `P0005`.
4. Reintento idempotente de la reserva con una nueva clave.
5. Aprobación: reserva `converted`, ejemplar `reserved`, fuera del catálogo.
6. Ejemplar aprobado no puede reservarse de nuevo.
7. Rechazo con motivo: reserva `released`, ejemplar `available`, reaparece en catálogo.
8. Cancelación de solicitud aprobada antes de programar.
9. Expiración: solicitud `cancelled`, reserva `expired`, ejemplar liberado.
10. Intento de aprobar una reserva vencida bloqueado con `P0004`.
11. Una reserva de otra solicitud no se libera al expirar una distinta.
12. Restricción única de PostgreSQL contra dos reservas activas del mismo ejemplar.
13. Dos intentos paralelos: un ganador y un rechazo `P0005`.
14. Auditoría e inexistencia de datos personales en el catálogo público.

## Prueba de concurrencia en rama Neon

Se abrieron dos conexiones `pg` simultáneas contra la rama aislada y se ejecutaron dos `create_exchange_request` para el mismo ejemplar sintético.

Resultado:

```text
Una solicitud: OK
La otra: P0005 — copy is not available
```

Verificación:

- Una sola reserva activa para el ejemplar.
- Un solo ejemplar `reserved`.
- La solicitud perdedora se revirtió completa; no dejó participante, consentimiento ni solicitud parcial.

La rama `qa-reservas-20261030` fue eliminada.

## Verificación del inventario real

Antes de la reparación, la solicitud real `IUB-2026-0E04340C` estaba aprobada pero su reserva había vencido y `INV-063` había vuelto a `available`. Se aplicó la reparación guardada y auditada, sin recrear el ejemplar.

Estado final:

- 87 ejemplares totales.
- 84 ejemplares reales `INV-*` / `CH-*`.
- 83 disponibles.
- 1 reservado: `INV-063`, por `IUB-2026-0E04340C`.
- 3 ejemplares sintéticos `IUB-STG-*` no disponibles.
- Ningún ejemplar real fue eliminado ni recreado.
- La solicitud conserva su ID, código, estudiante y ejemplar.

Auditoría registrada:

```text
reservation.repaired_after_approval
request_code = IUB-2026-0E04340C
inventory_code = INV-063
previous_reservation_status = expired
new_reservation_status = converted
```

## Auditoría de solicitudes QA anteriores

- `IUB-QA-B08B8E0A`: aprobada; ejemplar solicitado `IUB-STG-001`, sintético.
- `IUB-QA-0A1DB2FE`: rechazada; ejemplar solicitado `IUB-STG-002`, sintético.

Ninguna de las dos está vinculada a ejemplares `INV-*` o `CH-*`. No se modificaron durante esta intervención.

## Verificación del sitio publicado

- `/api/catalog`: 83 elementos, sin `INV-063`, sin datos personales.
- `/catalogo`: 83 filas visibles; `INV-063` no aparece.
- `/admin`: 200; solicitud `IUB-2026-0E04340C` muestra reserva **Asignado / comprometido**, ejemplar **Reservado** y no ofrece acciones de aprobación/rechazo.
- Aprobar de nuevo la solicitud aprobada: idempotente, 200, sin cambio de estado.
- Rechazar sin motivo: 400 `reason_required`.
- Build y TypeScript: correctos.
- Suite completa: **200 pruebas aprobadas**, 7 omitidas.

## Limitaciones

- No se realizaron pruebas de escritura sobre solicitudes o ejemplares reales.
- La concurrencia se probó con dos conexiones reales en una rama Neon; no se ejecutó una prueba de carga masiva.
- Las solicitudes QA históricas se conservan porque su historial es inmutable y no afectan el inventario real.
