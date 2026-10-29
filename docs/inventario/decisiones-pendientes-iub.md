# Decisiones pendientes — Inventario institucional IUB

**Estado general:** ninguna decisión de este documento está aprobada.
**Uso:** la institución debe resolver cada fila antes de programar la habilitación
de ejemplares institucionales.
**Base:** 67 ejemplares, 65 registros bibliográficos, sede Plaza de la Paz.
**Fecha:** 2026-10-28.

> Las recomendaciones son técnicas. No sustituyen una resolución institucional.
> Las etiquetas `PENDIENTE DE APROBACIÓN INSTITUCIONAL` indican que no existe
> autorización registrada.

---

## 1. Decisiones institucionales

| ID | Decisión | Opciones propuestas | Recomendación técnica | Riesgo de no decidir | Responsable institucional sugerido | Estado |
| --- | --- | --- | --- | --- | --- | --- |
| D-01 | Estado inicial de los 67 ejemplares importados | (a) `unavailable` hasta habilitación; (b) `maintenance` durante revisión; (c) mantener `available` con compuerta de publicación nueva. | (a) `unavailable`: reutiliza `available_catalog`, `reserve_copy` y las restricciones actuales sin estados nuevos. | La contención local ya evita la exposición y la reserva; sin decisión, el estado definitivo, la política y la habilitación siguen indefinidos. | Dirección de biblioteca / responsable de inventario | `PENDIENTE DE APROBACIÓN INSTITUCIONAL` |
| D-02 | Política de aceptación de estados físicos | (a) aceptar `good` y `fair`; (b) aceptar solo `good`; (c) aceptar `good`, `fair` y `poor` con revisión; (d) definir umbrales por daño. | Aprobar una regla explícita por estado y por tipo de daño; no inferir umbrales. | El procesador no puede convertir `Bueno/Regular/Malo` en una decisión institucional; todo queda pendiente. | Comité de biblioteca / conservación | `PENDIENTE DE APROBACIÓN INSTITUCIONAL` |
| D-03 | Materiales no admisibles | (a) lista taxativa; (b) lista abierta con comité; (c) prohibir solo por normativa legal. | Lista taxativa aprobada, con criterios de exclusión claros. | Se pueden aceptar materiales no pertinentes o rechazar material válido por criterios informales. | Dirección académica / biblioteca | `PENDIENTE DE APROBACIÓN INSTITUCIONAL` |
| D-04 | Criterios de pertinencia | (a) plan de estudios; (b) política de colección; (c) demanda; (d) combinación. | Política de colección documentada; el evaluador recomienda y el comité decide. | Decisiones inconsistentes y difíciles de auditar. | Comité de colección | `PENDIENTE DE APROBACIÓN INSTITUCIONAL` |
| D-05 | Anotaciones y subrayados | (a) aceptar sin restricción; (b) aceptar si no afectan legibilidad; (c) rechazar anotaciones extensas; (d) limpiar/restaurar. | Aceptar solo si no afectan legibilidad y no contienen datos personales; extensión sujeta a regla. | Ejemplares con información personal o deterioro oculto; decisiones ad hoc. | Biblioteca / conservación | `PENDIENTE DE APROBACIÓN INSTITUCIONAL` |
| D-06 | Duplicados | (a) conservar todos y habilitar todos; (b) conservar todos y habilitar uno; (c) retirar duplicados no admisibles. | Conservar todos; decidir cuántos se ofrecen. Nunca eliminar automáticamente. | Pérdida de ejemplares legítimos o saturación del catálogo. | Biblioteca / catalogación | `PENDIENTE DE APROBACIÓN INSTITUCIONAL` |
| D-07 | Responsables y segregación de funciones | (a) una persona puede verificar, evaluar y autorizar; (b) separar verificación y autorización; (c) separar las tres etapas. | Separar verificación, evaluación y autorización; excepción documentada si no hay personal. | Concentración de poder, errores no detectados y auditoría débil. | Dirección de biblioteca / talento humano | `PENDIENTE DE APROBACIÓN INSTITUCIONAL` |
| D-08 | Evidencias y su conservación | (a) solo Excel; (b) Excel + fotos; (c) expediente digital completo por ejemplar. | Excel + fotos + decisión y referencia de evidencia; retención definida. | Imposibilidad de defender una habilitación o un rechazo. | Biblioteca / archivo | `PENDIENTE DE APROBACIÓN INSTITUCIONAL` |
| D-09 | Autoridad que aprueba la habilitación | (a) bibliotecario; (b) coordinador; (c) comité; (d) dirección. | Una persona con `inventory.enable` y decisión colegiada para casos dudosos. | Nadie puede habilitar legítimamente o lo hace sin autoridad. | Dirección / secretaría académica | `PENDIENTE DE APROBACIÓN INSTITUCIONAL` |
| D-10 | Bloqueo y baja | (a) `maintenance` temporal; (b) `unavailable`; (c) `retired` definitivo; (d) combinación. | `maintenance` para bloqueo reversible; `retired` para baja aprobada; no borrar. | Ejemplares bloqueados siguen visibles o se pierde historial. | Biblioteca / patrimonio | `PENDIENTE DE APROBACIÓN INSTITUCIONAL` |
| D-11 | Conservación de datos y auditoría | (a) retención indefinida; (b) plazo definido; (c) mínimo legal. | Auditoría inmutable y retención institucional definida; no borrar movimientos ni decisiones. | Pérdida de trazabilidad o retención excesiva de datos. | Archivo / jurídica | `PENDIENTE DE APROBACIÓN INSTITUCIONAL` |
| D-12 | Tratamiento del ISBN ausente y corrección de metadatos | (a) rechazar sin ISBN; (b) aceptar y buscar por otros datos; (c) exigir ISBN para habilitar. | Aceptar sin ISBN; no inventarlo; corrección solo con evidencia. | Rechazo injustificado de ejemplares válidos o metadatos inventados. | Catalogación / biblioteca | `PENDIENTE DE APROBACIÓN INSTITUCIONAL` |
| D-13 | Almacenamiento privado de fotografías | (a) objeto privado S3/R2/GCS/Blobs; (b) filesystem local; (c) bytea en PostgreSQL. | Objeto privado con cifrado, lifecycle y acceso autenticado; no usar CDN público ni filesystem serverless. | Exposición de datos personales o pérdida de evidencias. | TI / seguridad / biblioteca | `PENDIENTE DE APROBACIÓN INSTITUCIONAL` |
| D-14 | Retención y borrado de evidencias | (a) plazo definido; (b) indefinida; (c) borrado al rechazar/cerrar. | Plazo definido, borrado seguro y auditoría de eliminación. | Retención excesiva o pérdida de evidencia. | Archivo / jurídica / biblioteca | `PENDIENTE DE APROBACIÓN INSTITUCIONAL` |
| D-15 | EXIF/GPS y antimalware | (a) eliminar metadatos y escanear; (b) conservar; (c) re-codificar. | Eliminar metadatos y escanear antes de almacenar. | Exposición de ubicación/datos y archivos maliciosos. | Seguridad / TI | `PENDIENTE DE APROBACIÓN INSTITUCIONAL` |
| D-16 | Retención y acceso a archivos Excel de lotes | (a) retención definida; (b) borrado al confirmar; (c) conservación indefinida. | Conservar el original bajo acceso administrativo y retención definida; nunca público. | Pérdida de trazabilidad o retención excesiva. | Archivo / TI / biblioteca | `PENDIENTE DE APROBACIÓN INSTITUCIONAL` |

> **Nota sobre D-01:** la contención P0 local ya pasó los 67 ejemplares a
> `unavailable` como mitigación técnica. Eso no aprueba la decisión institucional
> sobre el estado inicial ni la política de habilitación.

> **D-13 a D-16:** la comparación de proveedores, la arquitectura, los límites,
> la retención y los riesgos pendientes de EXIF/antimalware están en
> `docs/inventario/almacenamiento-privado.md`. Ninguna opción está contratada ni
> activada.

---

## 2. Recomendaciones técnicas (no son decisiones institucionales)

Estas ya están implementadas o son criterios de ingeniería; no requieren una
resolución de la institución, pero deben conocerse:

1. El procesador de conciliación es de solo lectura y no modifica la base.
2. El procesador rechaza hosts distintos de `localhost`, `127.0.0.1`, `::1` o
   `postgres`.
3. Los duplicados legítimos se conservan; no se eliminan automáticamente.
4. No se inventan ISBN, códigos, títulos, autores, editoriales ni estados.
5. La habilitación no se implementa en esta fase.
6. `enable_received_copy` no se reutiliza para ejemplares institucionales.
7. La habilitación futura debe usar `inventory.enable`, transacción, bloqueo,
   idempotencia y auditoría.
8. El informe de conciliación incluye hash del Excel y versión del procesador.
9. La verificación de la base local no cambia disponibilidad, movimientos,
   reservas ni auditoría.
10. La autenticación administrativa actual es de staging (`ADMIN_USERS`); el
    proveedor OIDC institucional sigue pendiente.

---

## 3. Decisiones que no pueden tomarse solo con criterios técnicos

| Tema | Por qué no es técnica | Documento que la desarrolla |
| --- | --- | --- |
| Qué estado físico se acepta | Depende de la misión, presupuesto y conservación. | `politica-aceptacion-institucional.md` |
| Qué materiales son admisibles | Depende de la política de colección. | `politica-aceptacion-institucional.md` |
| Quién autoriza | Depende de la estructura y delegación institucional. | `politica-aceptacion-institucional.md` |
| Cuántos duplicados se ofrecen | Depende de demanda y política bibliotecaria. | `politica-aceptacion-institucional.md` |
| Qué evidencia se conserva y por cuánto tiempo | Depende de archivo y normativa. | `politica-aceptacion-institucional.md` |
| Si se permite una sola persona en todas las etapas | Depende de control interno. | `politica-aceptacion-institucional.md` |
| Si se bloquea o se da de baja | Depende de patrimonio y conservación. | `politica-aceptacion-institucional.md` |

---

## 4. Ruta crítica recomendada

1. **D-01** primero: definir el estado inicial de los ejemplares importados.
2. **D-02, D-03, D-04, D-05, D-06, D-12**: definir qué se acepta y qué no.
3. **D-07, D-08, D-09**: definir quién decide, con qué evidencia y con qué
   segregación.
4. **D-10, D-11**: definir bloqueo, baja y retención.
5. Solo entonces programar la migración y las rutinas de
   `especificacion-habilitacion-inventario.md`.

Si D-01 no se resuelve, los ejemplares no verificados seguirán expuestos en la
base local como `available`. Si D-02 no se resuelve, el procesador no podrá
convertir una propuesta en una habilitación legítima.

---

## 5. Estado de aprobación

| Documento | Estado |
| --- | --- |
| `politica-aceptacion-institucional.md` | Propuesta; no aprobada. |
| `especificacion-habilitacion-inventario.md` | Propuesta técnica; no implementada. |
| `decisiones-pendientes-iub.md` | Decisiones abiertas; ninguna aprobada. |

No se declara aprobada ninguna política, umbral, rol ni autoridad. Cualquier
cambio de estado debe quedar en un acta o resolución institucional verificable.
