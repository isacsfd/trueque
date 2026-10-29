# Habilitación administrativa de ejemplares conciliados

Documento de análisis del flujo existente. **No implementa escrituras nuevas.**
La conciliación física produce una propuesta; no autoriza ni habilita ejemplares.

> **Documento preliminar.** La especificación vigente y ampliada es
> `docs/inventario/especificacion-habilitacion-inventario.md`. La política
> institucional está en `docs/inventario/politica-aceptacion-institucional.md`.
> Este archivo se conserva como contexto del flujo administrativo existente.

## 1. Flujo administrativo existente

El sistema ya cuenta con un mecanismo administrativo autenticado y auditado:

1. `POST /api/admin/session` inicia sesión con `ADMIN_USERS` y emite una cookie
   `HttpOnly`, `SameSite=Strict` y `Secure` en HTTPS.
2. `requireAdmin` valida la cookie firmada con `SESSION_SECRET` y obtiene el
   `actorUserId` de PostgreSQL.
3. `POST /api/admin/action` acepta únicamente una allowlist cerrada de acciones.
4. Cada acción llama a una función `SECURITY DEFINER` con `search_path` fijo.
5. La función ejecuta `public.assert_actor_permission(actorUserId, permissionKey)`,
   que exige un usuario activo y un permiso RBAC efectivo.
6. Las mutaciones registran `audit_events` y, cuando corresponde,
   `inventory_movements` e historiales append-only.
7. El rol `iub_admin_runtime` no tiene `INSERT/UPDATE/DELETE` directo sobre las
   tablas; solo ejecuta rutinas autorizadas.

Permisos relevantes ya existentes:

| Permiso | Uso actual |
| --- | --- |
| `inventory.admit` | Autorizar y admitir ejemplares recibidos de un intercambio. |
| `inventory.enable` | Habilitar el ejemplar admitido de un intercambio. |

## 2. Cobertura actual

`public.enable_received_copy(admissionId, actorUserId)` es la única rutina de
habilitación. Sus validaciones exigen:

- una admisión `admitted` con `copy_id`;
- una solicitud e intercambio activos;
- `provenance_type = 'exchange_received'`;
- `source_admission_id` igual a la admisión;
- disponibilidad `unavailable` antes de habilitar.

Por tanto, **no cubre** los ejemplares importados por el inventario institucional:
su procedencia es `institutional`, no tienen `source_admission_id` ni un
intercambio asociado, y desde la contención P0 local están en `unavailable` y sin
verificación positiva.

Conclusión: no existe hoy un mecanismo seguro para aprobar y habilitar
ejemplares institucionales conciliados. No debe reutilizarse
`enable_received_copy` ni ejecutarse SQL manual sobre `copies`.

## 3. Qué puede hacer hoy un usuario autorizado

1. Recibir y revisar el informe
   `docs/inventario/Resultado_Conciliacion_Trueque_IUB.xlsx`.
2. Verificar que el hash del Excel de entrada coincide con el registrado en la
   hoja **Metadatos**.
3. Revisar las filas clasificadas como `Candidato a habilitación`, sus motivos,
   responsables, fechas e incidencias.
4. Confirmar que no hay incidencias bloqueantes abiertas o en revisión.
5. Documentar la decisión institucional fuera del sistema (acta o resolución)
   hasta que exista la rutina transaccional correspondiente.
6. No modificar `copies.availability` manualmente.

El informe es de solo lectura. Ejecutar el procesador no cambia la base ni el
Excel de conciliación.

## 4. Especificación vigente

La propuesta detallada de tablas, funciones, bloqueos, idempotencia, auditoría,
reversión, interacción con reservas/intercambios y matriz de escenarios está en:

`docs/inventario/especificacion-habilitacion-inventario.md`

Resumen de la corrección respecto a este documento preliminar:

- la habilitación institucional no parte de `availability = 'available'`;
- el estado de origen propuesto es `unavailable` o `maintenance`;
- la transición autorizada es hacia `available`;
- los ejemplares pendientes de verificación no deben seguir publicados por
  `available_catalog`;
- la corrección del estado inicial de los 67 ejemplares ya se aplicó como
  contención P0 local; la política y la habilitación definitivas siguen pendientes;

Hasta entonces, la clasificación `Candidato a habilitación` es solo una
propuesta sujeta a aprobación institucional.

## 5. Pruebas existentes del procesador

`scripts/tests/test_process_inventory_reconciliation.py` cubre, entre otros:

- 67 códigos originales y títulos repetidos;
- códigos duplicados, desconocidos y ausentes;
- filas vacías y filas sin código;
- no encontrados, identificación no coincidente y estado pendiente;
- incidencias abiertas y resueltas;
- estados y fechas inválidos;
- datos bibliográficos alterados;
- Excel incompleto, hoja o encabezados incorrectos;
- ejecución repetida determinista;
- rechazo de hosts remotos;
- ausencia de cambios en la base local.

La cobertura del flujo de habilitación administrativa queda pendiente hasta que
exista la rutina propuesta.
