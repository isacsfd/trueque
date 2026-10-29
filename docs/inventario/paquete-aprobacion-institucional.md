# Paquete de aprobación institucional — contención de inventario

**Estado:** borrador para aprobación. **No aprobado.**
**Fecha:** 2026-10-29.
**Alcance:** inventario institucional de Trueque – IUB, sede Plaza de la Paz.
**Base de referencia:** migraciones `0001`-`0011`; contención local `0007` y `0008`.
`0009` (evaluación fotográfica), `0010` (lotes de inventario) y `0011` (cuentas y
guard de aprobación) **no forman parte de esta autorización de contención**.
**Documento hermano:** `docs/inventario/plan-despliegue-contencion.md`.

> Este paquete no habilita ejemplares, no cambia disponibilidad y no autoriza
> por sí mismo la aplicación en staging. Los campos de firma están deliberadamente
> vacíos: no se inventan aprobaciones, cargos, fechas ni resoluciones.

---

## 1. Situación actual y riesgo

### 1.1 Situación

- 67 ejemplares institucionales importados en local.
- 65 registros bibliográficos; dos títulos con dos ejemplares legítimos.
- Ubicación `PLAZA DE LA PAZ`.
- `physical_condition = 'unassessed'` en los 67.
- `verified_at`, `verified_by` y `verification_reference` en `NULL` en los 67.
- Antes de la contención: `availability = 'available'` en los 67; `available_catalog` los publicaba y `reserve_copy` podía reservarlos.
- Después de la contención local: `availability = 'unavailable'` en los 67; catálogo institucional 0; sin reservas, solicitudes, intercambios ni movimientos.
- Staging documentado: `0001`-`0005`, datos sintéticos, manifiesto de 283 objetos; `0006`-`0011` no aplicadas. `0009`, `0010` y `0011` requieren autorizaciones separadas.
- Producción: no modificada; no se asume su estado ni sus datos.

### 1.2 Riesgo confirmado

Sin la compuerta:

1. Un ejemplar institucional no verificado podía aparecer como disponible.
2. Un participante podía reservarlo mediante `reserve_copy`.
3. `create_exchange_request` podía crear una solicitud sobre él.
4. Un cambio de disponibilidad podía publicarlo sin una verificación positiva.
5. La condición física `unassessed` no impedía por sí sola la publicación.

La contención local elimina esas rutas mediante una compuerta positiva en base de
datos, no mediante un filtro de React. Staging todavía no tiene esa compuerta.

### 1.3 Qué no es esta aprobación

Aprobar este paquete **no** significa:

- aceptar físicamente los 67 ejemplares;
- habilitarlos en el catálogo;
- aprobar una política de estado físico;
- autorizar una rutina de habilitación;
- autorizar producción;
- sustituir la revisión humana del conteo.

---

## 2. Contención aplicada en local

### 2.1 Migraciones

| Migración | Efecto | Estado |
| --- | --- | --- |
| `0007_institutional_containment.sql` | Añade verificación positiva, guards, compuerta de catálogo/reserva/solicitud y retiene los ejemplares no verificados. | Aplicada solo en PostgreSQL local. |
| `0008_containment_request_compat.sql` | Conserva el comportamiento previo de solicitudes sobre ejemplares no disponibles; mantiene el bloqueo de institucionales no verificados. | Aplicada solo en PostgreSQL local. |

### 2.2 Mecanismos

- `copies.verified_at`, `verified_by`, `verification_reference`.
- `copies_verification_ck`: los tres campos completos o los tres nulos.
- `copies_institutional_eligibility_guard`: no permite `available`/`reserved` sin verificación; no permite verificar con `unassessed`; impide cambiar la procedencia institucional.
- `inventory_copy_is_eligible`: predicado de elegibilidad.
- `available_catalog`: exige disponibilidad **y** verificación positiva para institucionales.
- `reserve_copy`: rechaza ejemplares institucionales no verificados antes de expirar reservas.
- `exchange_requests_institutional_eligibility_guard`: impide solicitudes sobre institucionales no verificados.
- `audit_events`: evento `inventory.institutional_containment_applied` con 67 copias actualizadas.
- Sin `inventory_movements`: la contención no simula una operación física.

### 2.3 Estado local comprobado

| Indicador | Valor |
| --- | ---: |
| Ejemplares institucionales | 67 |
| `unavailable` | 67 |
| `unassessed` | 67 |
| `verified_at IS NULL` | 67 |
| Catálogo institucional | 0 |
| Movimientos | 0 |
| Reservas | 0 |
| Solicitudes | 0 |
| Intercambios | 0 |
| Eventos de auditoría de contención | 1 |

No se habilitó ningún ejemplar.

---

## 3. Decisión que se solicita

### 3.1 Autorización A — aplicar la contención

**Se solicita autorización para:**

- aplicar `0006`, `0007` y `0008` en staging;
- **no** aplicar `0009` como parte de esta autorización;
- mantener los ejemplares institucionales no verificados en `unavailable`;
- impedir su aparición en catálogo, su reserva y las solicitudes sobre ellos;
- conservar la auditoría y no crear movimientos ficticios.

**No autoriza:**

- habilitar ejemplares;
- aceptar libros;
- cambiar la política de estados físicos;
- aplicar cambios en producción;
- publicar el catálogo institucional.

Esta autorización es de **seguridad y contención**. Puede aprobarse sin resolver
las decisiones de política física, porque no habilita nada.

### 3.2 Autorización B — habilitación institucional

La habilitación requiere, además:

- decisión sobre el estado inicial y la política de aceptación;
- responsables y segregación;
- autoridad que aprueba;
- rutina transaccional con `inventory.enable`;
- pruebas de concurrencia, idempotencia y reversión.

**No se solicita ni se concede en este paquete.** Si la institución firma solo la
Autorización A, la habilitación sigue bloqueada.

### 3.3 Autorización C — producción

No forma parte de este paquete. Producción requiere un entorno/snapshot
autorizado, revisión de datos reales y una aprobación separada.

---

## 4. Decisiones institucionales pendientes

El detalle está en `docs/inventario/decisiones-pendientes-iub.md`. Resumen:

| ID | Decisión | Bloquea habilitación | Bloquea contención |
| --- | --- | --- | --- |
| D-01 | Estado inicial de los 67 | Sí | No: la contención local ya usó `unavailable` como mitigación. |
| D-02 | Política de estados físicos aceptables | Sí | No. |
| D-03 | Materiales no admisibles | Sí | No. |
| D-04 | Criterios de pertinencia | Sí | No. |
| D-05 | Anotaciones y subrayados | Sí | No. |
| D-06 | Duplicados | Sí | No. |
| D-07 | Responsables y segregación | Sí | No para contener; sí para habilitar. |
| D-08 | Evidencias y conservación | Sí | No. |
| D-09 | Autoridad que aprueba la habilitación | Sí | No. |
| D-10 | Bloqueo y baja | Sí | No. |
| D-11 | Conservación de datos y auditoría | Sí | No. |
| D-12 | ISBN ausente y metadatos | Sí | No. |

**Conclusión:** la contención puede desplegarse sin aprobar D-02, D-03, D-04,
D-05, D-06, D-08, D-09, D-10, D-11 o D-12. La habilitación no puede avanzar sin
esas decisiones.

Las decisiones **D-13** (almacenamiento privado), **D-14** (retención/borrado) y
**D-15** (EXIF/antimalware) del documento de decisiones son específicas de la
evaluación fotográfica. No bloquean la contención de inventario, pero sí bloquean
habilitar cargas de fotografías en staging/producción.

---

## 5. Política de aceptación propuesta

La política completa está en
`docs/inventario/politica-aceptacion-institucional.md`. Puntos que la institución
debe aprobar:

- matriz física de 12 criterios;
- umbral de integridad de páginas, legibilidad, cubierta y anotaciones;
- tratamiento de humedad, hongos, plagas y contaminación;
- criterios de pertinencia;
- duplicados;
- conservación;
- evidencias;
- segregación de funciones.

Los umbrales que no están decididos llevan la etiqueta
`PENDIENTE DE APROBACIÓN INSTITUCIONAL`. La contención no crea umbrales ni acepta
ejemplares.

---

## 6. Responsables y segregación de funciones

### 6.1 Perfiles propuestos

| Perfil | Responsabilidad | Permiso existente | Brecha |
| --- | --- | --- | --- |
| Verificador físico | Conteo, identificación, evidencia. | Ninguno específico. | No hay permiso de verificación. |
| Evaluador | Estado, daños y recomendación. | `reception.evaluate` solo aplica a recepciones. | No hay rutina institucional. |
| Catalogador | Título, autor, ISBN, duplicados. | `cataloging.validate` / `cataloging.authorize` solo recepciones. | No hay rutina institucional. |
| Autorizador | Aprueba lote y habilitación. | `inventory.enable` existe. | `enable_received_copy` solo cubre `exchange_received`. |
| Auditor | Revisa evidencia y muestras. | Lectura administrativa. | No hay rol creado. |

### 6.2 Segregación propuesta

- Verificador ≠ autorizador.
- Evaluador ≠ única persona que autoriza.
- Catalogador no habilita.
- Auditor no muta estados.
- Una sola persona no debe completar todas las etapas salvo excepción institucional documentada.

No hay roles ni usuarios creados en `iub_local`; no se inventan `role_key` ni
miembros. La asignación es institucional.

---

## 7. Riesgos de no aprobar

### 7.1 Riesgo de no aprobar la contención en staging

- Staging seguirá sin la compuerta que ya protege local.
- Cualquier ejemplar institucional que se cree o importe en staging quedará
  expuesto hasta que se aplique una migración.
- No se podrá validar en staging que catálogo, solicitudes y reservas respetan
  la contención.
- Aumenta el riesgo de promover a producción un esquema sin la protección.

### 7.2 Riesgo de aprobar la contención y creer que habilita

- Los 67 ejemplares seguirán `unavailable`.
- El catálogo institucional seguirá vacío.
- No habrá aceptación, habilitación ni publicación.
- La habilitación requerirá una fase y una autorización distintas.

### 7.3 Riesgo de no aprobar las decisiones de habilitación

- No se podrá implementar la rutina de habilitación.
- No se podrá definir qué estados físicos se aceptan.
- No se podrá autorizar a nadie a habilitar.
- Los ejemplares permanecerán retenidos indefinidamente.

### 7.4 Riesgo de aprobar sin staging verificado

- Staging no está vacío: contiene datos sintéticos y un manifiesto de 283 objetos.
- `0006`–`0008` no están aplicadas.
- `0007` puede abortar si encuentra ejemplares institucionales no verificados con
  reservas, intercambios, solicitudes no terminales o movimientos.
- El plan de despliegue exige preflight y snapshot antes de aplicar.

---

## 8. Autorización requerida

### 8.1 Campos de aprobación — Autorización A (contención)

Completar solo si la institución decide aprobar. **No completar por el equipo técnico.**

```text
Autorización:        [ ] Aprobar contención en staging
                      [ ] Rechazar
                      [ ] Aprobar con condiciones

Aprobado por:        ______________________________________
Cargo:               ______________________________________
Dependencia:         ______________________________________
Fecha:               ____ / ____ / ________
Resolución / acta:   ______________________________________
Alcance:             Aplicar 0006, 0007 y 0008 en staging; mantener
                     ejemplares institucionales no verificados en unavailable.
                     No habilita ejemplares ni autoriza producción.
Condiciones:         ______________________________________
Observaciones:       ______________________________________

Firma:               ______________________________________
```

### 8.2 Campos de aprobación — Autorización B (habilitación)

**No se solicita en este paquete.** Se abre solo después de resolver D-01, D-02,
D-07, D-09 y la especificación técnica.

```text
Autorización:        [ ] Aprobar política de aceptación
                      [ ] Aprobar autoridad de habilitación
                      [ ] Aprobar implementación de rutina
                      [ ] Rechazar
Aprobado por:        ______________________________________
Cargo:               ______________________________________
Fecha:               ____ / ____ / ________
Resolución / acta:   ______________________________________
Observaciones:       ______________________________________
```

### 8.3 Declaración de estado

- No hay aprobación registrada.
- No hay firma registrada.
- No hay fecha de aprobación.
- No se autoriza habilitación por este documento.
- La única autorización solicitada aquí es la contención en staging.

---

## 9. Recomendación técnica

1. Aprobar la **Autorización A** para staging.
2. Ejecutar el plan `plan-despliegue-contencion.md` con snapshot y preflight.
3. No habilitar ejemplares ni publicar catálogo institucional.
4. Abrir después la discusión de D-01, D-02, D-07 y D-09.
5. Implementar la rutina de habilitación solo en una fase posterior.

La contención es una medida de seguridad reversible por restauración o
forward-fix; no es una política de aceptación ni una habilitación.
