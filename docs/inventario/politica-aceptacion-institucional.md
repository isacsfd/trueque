# Política institucional de aceptación y habilitación de inventario

**Estado del documento:** propuesta técnica y funcional. **No aprobada por la institución.**
**Alcance:** inventario institucional de Trueque – IUB, sede Plaza de la Paz.
**Base de referencia:** 67 ejemplares, 65 registros bibliográficos, códigos `IUB-PAZ-001` a `IUB-PAZ-067`.
**Fecha:** 2026-10-28.

> Este documento no habilita ejemplares, no modifica disponibilidad, no altera el
> esquema ni los datos. Las etiquetas `PENDIENTE DE APROBACIÓN INSTITUCIONAL`
> identifican criterios que la institución debe decidir antes de programar la
> habilitación.

---

## 1. Alcance y principios

### 1.1 Qué cubre

Cubre la evaluación física y la decisión administrativa sobre los ejemplares
institucionales ya importados, incluidos los que se incorporen en el futuro con
procedencia `institutional`.

No cubre:

- libros ofrecidos por participantes (`offered_books`);
- ejemplares recibidos por intercambio (`exchange_received`);
- recepciones, custodias, devoluciones y entregas del flujo de intercambio;
- catalogación de libros donados o comprados fuera del inventario institucional.

Esos flujos tienen sus propias rutinas y permisos. La habilitación institucional
no debe reutilizar `enable_received_copy`, porque esa función exige una admisión
de intercambio y `provenance_type = 'exchange_received'`.

### 1.2 Registro bibliográfico y ejemplar físico

| Concepto | Tabla real | Significado |
| --- | --- | --- |
| Registro bibliográfico | `bibliographic_records` | Obra: título, autor, editorial, ISBN, edición, año. |
| Ejemplar físico | `copies` | Objeto concreto: código de inventario, ubicación, estado, disponibilidad y procedencia. |

Un registro puede tener varios ejemplares. Dos ejemplares del mismo título **no
son un error**: `La Celestina` y `Las Mujeres del Quijote` tienen dos ejemplares
legítimos cada uno. La conciliación trabaja por `copies.inventory_code`, nunca
por título o autor.

### 1.3 Recepción, evaluación, aceptación, catalogación y habilitación

| Etapa | Pregunta que responde | Evidencia | Efecto actual |
| --- | --- | --- | --- |
| Recepción | ¿Llegó el libro y quién lo custodia? | `receptions`, `reception_custody_events` | Solo flujo de intercambio. |
| Evaluación | ¿En qué estado está y se acepta? | `book_evaluations`, informe de conciliación | Solo flujo de intercambio; el inventario institucional usa el Excel. |
| Aceptación | ¿La institución decide incorporarlo? | Decisión administrativa justificada | **No existe rutina para institucional.** |
| Catalogación | ¿Los metadatos son correctos y están autorizados? | `cataloging_records` | Solo flujo de intercambio. |
| Habilitación | ¿Puede ofrecerse al público? | Autorización + control de disponibilidad | **No existe rutina para institucional.** |

La evaluación física no es aceptación. La aceptación no es catalogación. La
catalogación no es habilitación. Ninguna etapa debe saltarse.

### 1.4 Principios

1. **No inventar datos.** Títulos, autores, editoriales, ISBN, códigos y estados
   se conservan como están en la fuente o se corrigen con evidencia aprobada.
2. **No eliminar duplicados legítimos.** Cada ejemplar conserva su código.
3. **No habilitar por conveniencia.** La ausencia de un dato no se suple con una
   suposición.
4. **No confiar en el Excel como autorización.** El archivo es evidencia de
   inspección; la autorización se registra en el sistema con un actor identificado.
5. **No modificar el inventario maestro desde la conciliación.** El procesador es
   de solo lectura.
6. **Trazabilidad completa.** Cada decisión debe tener actor, fecha, motivo,
   evidencia y estado anterior/nuevo.
7. **Segregación de funciones.** Quien verifica no debería ser la única persona
   que autoriza; la institución debe aprobar la regla exacta.
8. **Conservar lo dudoso.** Ante duda de identidad, procedencia o estado, se
   bloquea y se escala; no se habilita.

### 1.5 Situación actual y brecha mitigada localmente

Los 67 ejemplares importados tienen:

- `provenance_type = 'institutional'`;
- `physical_condition = 'unassessed'`;
- `availability = 'unavailable'` desde la contención P0 local;
- `verified_at`, `verified_by` y `verification_reference` en `NULL`;
- `location = 'PLAZA DE LA PAZ'`;
- sin `source_admission_id`, sin recepción y sin movimiento de inventario.

Antes de la contención, los 67 estaban en `available`, `available_catalog` los
publicaba y `reserve_copy` podía reservarlos aunque no tuvieran conciliación
física. La migración local `0007_institutional_containment.sql` corrigió ese
riesgo:

- añadió la verificación positiva (`verified_at`, actor y evidencia);
- pasó los 67 ejemplares a `unavailable`;
- dejó el catálogo en 0 ejemplares institucionales;
- bloqueó solicitudes y reservas sobre ejemplares no verificados;
- impidió que un cambio directo de disponibilidad los publique;
- registró un evento de auditoría de contención;
- no creó movimientos, inspecciones, aceptaciones ni habilitaciones.

`0008_containment_request_compat.sql` conserva el comportamiento previo de aceptar
una solicitud sobre un ejemplar no disponible, pero mantiene el bloqueo para
ejemplares institucionales no verificados y `reserve_copy` sigue rechazando la
reserva.

La contención local aplicó la opción 1 (dejarlos en `unavailable`) como medida
técnica de seguridad. La decisión institucional definitiva sobre el estado inicial,
la política de aceptación y la habilitación sigue pendiente.

---

## 2. Matriz de evaluación física

La matriz es una propuesta. No fija umbrales numéricos. Donde la institución debe
decidir un límite, se indica expresamente.

| Criterio | Método de inspección | Resultado posible | Riesgo | Acción recomendada | Responsable | Evidencia requerida |
| --- | --- | --- | --- | --- | --- | --- |
| Presencia física | Búsqueda en estantería, depósito y ubicaciones alternas; confrontar con `inventory_code`. | `Sí` / `No` / `Dudoso` | Ejemplar perdido, oculto o mal ubicado. | `No` o `Dudoso` ⇒ no habilitar; abrir incidencia y buscar. | Verificador físico | Foto de estantería, ubicación y fecha; firma del verificador. |
| Coincidencia de título y autor | Comparar portada, lomo y página de título con `bibliographic_records`. | `Coincide` / `Coincide parcialmente` / `No coincide` | Habilitar una obra distinta a la registrada. | `No coincide` ⇒ bloqueo e incidencia; `parcial` ⇒ revisión catalográfica. | Verificador / evaluador | Foto de portada y página de título; nota de diferencias. |
| Identificación del ejemplar | Verificar etiqueta, código y número de ejemplar contra el registro. | `Coincide` / `Ilegible` / `Ausente` / `No coincide` | Suplantación o confusión entre ejemplares. | No habilitar si no hay identificación confiable; reetiquetar solo con procedimiento aprobado. | Verificador físico | Foto de etiqueta y código; ubicación. |
| Integridad de páginas | Revisar faltantes, páginas sueltas, cortes y sustituiciones. | `Sin daño aparente` / `Daño leve` / `Daño grave` / `No verificable` | Pérdida de contenido o manipulación. | `Daño grave` o `No verificable` ⇒ evaluación especializada; umbral de aceptación: `PENDIENTE DE APROBACIÓN INSTITUCIONAL`. | Evaluador | Lista de hallazgos; fotos de páginas afectadas; no contar páginas si no hay política. |
| Legibilidad | Comprobar texto, ilustraciones y reproducciones. | `Legible` / `Parcialmente legible` / `No legible` | Ejemplar inutilizable para consulta. | `No legible` ⇒ rechazo o evaluación especializada; `parcial` ⇒ decisión institucional. | Evaluador | Fotos de muestra; justificación. |
| Humedad, hongos, plagas o contaminación | Inspección visual y olfativa; separar el ejemplar del resto. | `Sin evidencia` / `Sospecha` / `Confirmado` / `No verificable` | Contagio al resto de la colección y riesgo sanitario. | `Confirmado` o `Sospecha` ⇒ aislamiento inmediato y evaluación especializada; no habilitar. | Evaluador / conservación | Foto, descripción, ubicación de aislamiento; referencia de especialista. |
| Cubierta y encuadernación | Revisar desprendimientos, costuras, lomo y tapas. | `Íntegra` / `Suelta` / `Desprendida` / `No verificable` | Pérdida de páginas y deterioro acelerado. | `Desprendida` ⇒ reparación o evaluación; umbral: `PENDIENTE DE APROBACIÓN INSTITUCIONAL`. | Evaluador | Fotos de cubierta, lomo y interior. |
| Anotaciones, subrayados y marcas | Hojear el ejemplar y registrar tipo y extensión. | `Sin marcas` / `Aisladas` / `Extensas` / `No verificable` | Afectación estética o de legibilidad; posible dato personal. | `Extensas` ⇒ revisión institucional; no borrar sin autorización. Criterio: `PENDIENTE DE APROBACIÓN INSTITUCIONAL`. | Evaluador | Fotos de muestras; extensión descriptiva, sin umbral inventado. |
| Pertinencia del material | Contrastar con la política de colección y el uso previsto. | `Pertinente` / `Revisar` / `No pertinente` | Incorporar material fuera de alcance. | `No pertinente` ⇒ rechazo; `Revisar` ⇒ comité de colección. Criterio: `PENDIENTE DE APROBACIÓN INSTITUCIONAL`. | Evaluador / biblioteca | Referencia a la política de colección y justificación. |
| Duplicados bibliográficos | Comparar título, autor, edición e ISBN; verificar si son ejemplares distintos. | `Ejemplar único` / `Duplicado de título` / `Duplicado de ejemplar` | Eliminar un ejemplar legítimo o duplicar el catálogo. | Conservar todos; decidir cuántos ejemplares se ofrecen. No eliminar automáticamente. | Catalogador | Lista de ejemplares y códigos; decisión documentada. |
| Condiciones de conservación | Revisar estantería, humedad, temperatura, plagas y seguridad del depósito. | `Adecuada` / `Limitada` / `Inadecuada` | Deterioro futuro y pérdida. | `Limitada` o `Inadecuada` ⇒ plan de conservación; no es motivo automático de rechazo del ejemplar. | Responsable de conservación | Informe de condiciones y fotos del espacio. |
| Identificación institucional | Verificar código, etiqueta, ubicación y registro en el sistema. | `Completa` / `Parcial` / `Ausente` | Ejemplar no trazable o con código inventado. | `Parcial` o `Ausente` ⇒ no habilitar hasta resolver; no inventar códigos. | Verificador / catalogador | Foto de etiqueta; código fuente; registro de asignación aprobado. |

### 2.1 Correspondencia propuesta entre el Excel y los estados de la base

La tabla `copies.physical_condition` admite: `excellent`, `good`, `fair`, `poor`,
`unassessed`. El Excel usa `Pendiente`, `Bueno`, `Regular`, `Malo`.

| Excel | `copies.physical_condition` propuesto | Observación |
| --- | --- | --- |
| `Pendiente` | `unassessed` | Valor actual de los 67 ejemplares. |
| `Bueno` | `good` | Propuesta técnica, sujeta a validación institucional. |
| `Regular` | `fair` | Propuesta técnica, sujeta a validación institucional. |
| `Malo` | `poor` | Propuesta técnica, sujeta a validación institucional. |
| No existe en el Excel | `excellent` | Reservado para una evaluación futura; no asignarlo por inferencia. |

La correspondencia no crea umbrales de aceptación. `good`, `fair` y `poor` siguen
necesitando una regla institucional sobre qué se acepta.

---

## 3. Estados y transiciones

### 3.1 Estados que ya existen en la base

| Entidad | Valores reales | Uso |
| --- | --- | --- |
| `copies.availability` | `available`, `reserved`, `unavailable`, `maintenance`, `retired` | Disponibilidad operativa y publicación en `available_catalog`. |
| `copies.physical_condition` | `excellent`, `good`, `fair`, `poor`, `unassessed` | Estado físico del ejemplar. |
| `inventory_admissions.status` | `pending`, `authorized`, `admitted`, `enabled`, `reversed`, `rejected` | Solo admisiones de intercambio. |
| `cataloging_records.status` | `pending`, `validated`, `authorized` | Solo catalogación de recepciones. |
| `receptions.status` | `awaiting_delivery`, `received`, `in_custody`, `evaluated`, `accepted`, `rejected`, `return_pending`, `returned`, `cancelled` | Flujo de intercambio. |
| `book_evaluations.outcome` | `accepted`, `rejected` | Evaluación de recepciones. |
| `reservations.status` | `active`, `expired`, `released`, `converted` | Reservas. |
| `exchanges.status` | `planned`, `in_process`, `cancellation_pending`, `completed`, `cancelled` | Intercambios. |
| `exchange_requests.status` | `pending`, `under_review`, `approved`, `rejected`, `scheduled`, `in_process`, `cancellation_pending`, `completed`, `cancelled` | Solicitudes. |
| `inventory_movements.movement_type` | `received`, `reserved`, `reservation_released`, `availability_changed`, `location_changed`, `exchange_out`, `exchange_in`, `retired` | Movimientos append-only. |

### 3.2 Estados documentales propuestos

Ninguno se crea en la base en esta fase.

| Estado propuesto | ¿Existe hoy? | Equivalencia / propuesta |
| --- | --- | --- |
| Pendiente de inspección | No como estado de `copies`. | Excel sin columnas H–K; procesador: `Pendiente de conteo`. |
| Inspeccionado | No. | Columnas H–K completas y evidencia; el procesador clasifica el resultado. |
| Pendiente de evaluación | No. | Inspección completa sin decisión de aceptación. |
| Aceptado | No para institucional. | Futura decisión administrativa `accepted`; no cambia disponibilidad por sí sola. |
| Rechazado | No para institucional. | Futura decisión `rejected`; puede implicar bloqueo o baja. |
| Pendiente de catalogación | Parcial: `cataloging_records.status='pending'`, solo para recepciones. | Para institucional no hay rutina equivalente. |
| Catalogado | Parcial: `cataloging_records.status='authorized'`, solo para recepciones. | Para institucional requiere corrección/validación de metadatos. |
| Habilitado | No como valor único. | `copies.availability='available'` **más** una autorización registrada; hoy `available` no distingue verificado de no verificado. |
| Bloqueado | No como valor único. | `maintenance` (temporal) o `unavailable` (no habilitable); la decisión debe quedar en auditoría. |
| Retirado o dado de baja | Sí: `copies.availability='retired'`. | Baja definitiva; no borrar el ejemplar ni su historial. |

### 3.3 Transiciones propuestas

| Desde | Hacia | Condición | Responsable | Evidencia | Efecto en base |
| --- | --- | --- | --- | --- | --- |
| Pendiente de inspección | Inspeccionado | Conteo, identidad, estado y evidencia registrados. | Verificador físico | Excel + fotos + fecha. | Ninguno. |
| Inspeccionado | Pendiente de evaluación | Datos completos; sin decisión. | Verificador / evaluador | Informe del procesador. | Ninguno. |
| Pendiente de evaluación | Aceptado | Identidad y presencia confirmadas; estado evaluado; sin incidencias bloqueantes. | Evaluador | Decisión con motivo y evidencia. | Futura tabla de decisiones; no disponibilidad. |
| Pendiente de evaluación | Rechazado | No encontrado, identidad no corregible, daño grave o no admisible. | Evaluador | Decisión con motivo y evidencia. | Futura decisión; no borrar. |
| Pendiente de evaluación | Revisión especializada | Humedad, hongos, plagas, daño grave o duda de pertinencia. | Evaluador / conservación | Informe especializado. | Bloqueo temporal si aplica. |
| Aceptado | Pendiente de catalogación | Metadatos incompletos, ISBN ausente o duplicado a revisar. | Catalogador | Corrección documentada. | Ninguno / futura validación. |
| Pendiente de catalogación | Catalogado | Metadatos validados y autorizados. | Catalogador / autorizador | Registro de validación. | Futuro registro; no disponibilidad. |
| Aceptado + Catalogado | Habilitado | Autorización explícita, sin reservas ni intercambios activos, disponibilidad de origen `unavailable` o `maintenance`. | Administrador autorizador | Autorización, motivo, evidencia, `inventory.enable`. | `availability='available'`, movimiento y auditoría. |
| Aceptado / Habilitado | Bloqueado | Incidencia bloqueante, daño sobrevenido, revisión o decisión institucional. | Administrador autorizador | Incidencia y resolución. | `availability='maintenance'` (temporal) o `unavailable`. |
| Bloqueado | Habilitado | Incidencia resuelta y nueva autorización. | Administrador autorizador | Resolución + autorización. | `availability='available'`, movimiento y auditoría. |
| Habilitado / Bloqueado | Retirado | Baja aprobada. | Administrador autorizador | Resolución de baja. | `availability='retired'`, movimiento y auditoría. |

No se propone un estado `enabled` en `copies` ni en `inventory_admissions` para
institucional. `inventory_admissions` no es la entidad adecuada porque exige
recepción, evaluación y catalogación de intercambio.

---

## 4. Reglas de aceptación

### 4.1 Aceptación física

Un ejemplar puede considerarse **aceptado físicamente** solo si:

1. existe y fue localizado en la sede;
2. su código institucional coincide con `copies.inventory_code`;
3. título y autor coinciden con el registro, o la diferencia fue corregida y
   aprobada;
4. el estado físico fue evaluado y no está `unassessed`;
5. no tiene incidencias bloqueantes abiertas o en revisión;
6. cumple la política institucional de estado físico;
7. la evidencia y el responsable están registrados.

La aceptación física **no** habilita el ejemplar. Solo lo hace elegible para la
decisión de habilitación.

### 4.2 Rechazo

Motivos propuestos de rechazo:

- no encontrado después de una búsqueda documentada;
- identificación no coincidente que no puede corregirse;
- daño irreversible o no admisible según la política institucional;
- humedad, hongos, plagas o contaminación confirmados;
- material no pertinente según la política de colección;
- duplicado no admisible según la decisión institucional (sin eliminar el
  ejemplar automáticamente);
- imposibilidad de identificar el ejemplar sin inventar datos.

El rechazo debe registrar motivo, evidencia y responsable. No se borra el
ejemplar ni su código.

### 4.3 Evaluación especializada

Se escala a evaluación especializada cuando:

- hay humedad, hongos, plagas o contaminación;
- hay daño estructural grave;
- la legibilidad es dudosa;
- la identidad del ejemplar no puede resolverse con la fuente;
- hay anotaciones extensas o material potencialmente sensible;
- la pertinencia requiere comité de colección.

La evaluación especializada no habilita por sí sola: produce una recomendación
que el autorizador debe decidir.

### 4.4 Corrección de metadatos

- Toda corrección debe basarse en el ejemplar físico o en una fuente verificable.
- No se corrige un título, autor, editorial, año o ISBN “a ojo”.
- La corrección se registra como decisión con evidencia; no se sobrescribe el
  dato original sin historial.
- Si el ISBN está ausente, se deja `NULL`; no se inventa ni se completa por
  parecido.
- Los valores `N/A` y `N/E` se conservan tal como aparecen en la fuente; no se
  convierten en cadenas vacías ni en datos inventados.
- La corrección de metadatos no cambia la disponibilidad.

### 4.5 Ejemplares sin ISBN

La ausencia de ISBN:

- **no es motivo de rechazo por sí sola**;
- no impide la habilitación si la identificación por título, autor, editorial,
  edición y ejemplar es suficiente;
- debe quedar registrada como dato ausente, no como dato inventado;
- puede requerir revisión catalográfica adicional.

### 4.6 Ejemplares duplicados

- Se conservan todos los ejemplares y sus códigos.
- Dos ejemplares del mismo título son copias distintas; no se fusionan.
- Se puede decidir ofrecer solo uno, pero la decisión debe ser explícita y
  reversible.
- Nunca se elimina automáticamente un duplicado legítimo.
- La decisión sobre duplicados es `PENDIENTE DE APROBACIÓN INSTITUCIONAL`.

### 4.7 Ejemplares con discrepancias

Una discrepancia de título, autor, editorial, número de ejemplar,
ubicación o disponibilidad:

- impide la clasificación como candidato;
- exige incidencia y revisión;
- no se corrige automáticamente desde el procesador;
- no se resuelve por coincidencia de título o autor.

### 4.8 Ejemplar encontrado sin código

- No se le asigna un código inventado.
- Se identifica por título, autor, editorial y características físicas.
- Se abre incidencia de identificación.
- Se resuelve con el procedimiento institucional de asignación de códigos.
- Hasta entonces, no se habilita.

### 4.9 Ejemplar no encontrado

- Se marca `No encontrado`.
- Se documenta la búsqueda y la fecha.
- Se abre incidencia.
- No se habilita ni se elimina.
- Si aparece después, se reabre la evaluación con evidencia.

### 4.10 Incidencias bloqueantes

Son bloqueantes, como mínimo:

- incidencia `Abierta` o `En revisión`;
- incidencia `Resuelta` sin resolución aprobada;
- discrepancia de identidad no corregida;
- estado físico `Pendiente`;
- ejemplar no encontrado;
- reserva activa o intercambio en curso;
- disponibilidad distinta de la esperada para habilitar.

Una incidencia `Rechazada` no bloquea por sí sola, pero debe revisarse si afecta
la identidad o el estado.

---

## 5. Responsabilidades y segregación de funciones

### 5.1 Perfiles propuestos

| Perfil | Función | Permisos existentes relacionados | Brecha |
| --- | --- | --- | --- |
| Verificador físico | Conteo, ubicación, identificación y evidencia. | Ninguno específico. | No existe permiso de verificación física. |
| Evaluador | Estado, daños, pertinencia y recomendación. | `reception.evaluate` es solo para recepciones. | No aplica a institucional. |
| Responsable de catalogación | Título, autor, ISBN, editorial, duplicados. | `cataloging.validate`, `cataloging.authorize` son de recepciones. | No hay rutina para institucional. |
| Administrador autorizador | Aprueba lote y habilita ejemplares. | `inventory.enable` existe. | La función actual solo aplica a `exchange_received`. |
| Auditor / supervisor | Revisa evidencia, muestras y trazabilidad. | Lectura administrativa (`SELECT`). | No hay rol de auditor creado. |

### 5.2 Roles reales

En la base local no hay roles ni usuarios creados: `roles`, `app_users` y
`user_roles` están vacíos en `iub_local`. Los permisos existen en
`public.permissions`, pero la asignación es institucional.

No se deben crear roles por defecto ni inventar `role_key`. La institución debe
definir los roles y asignar permisos mediante `role_permissions` y `user_roles`.

### 5.3 Segregación

Propuesta:

- El verificador físico no aprueba la habilitación.
- El evaluador no es la única persona que autoriza.
- El catalogador no habilita.
- El autorizador no altera la evidencia de inspección.
- El auditor no muta estados.

La tabla `cataloging_records` ya impone `validated_by <> authorized_by` para
catalogación de recepciones. Es un precedente útil, pero **no** cubre el inventario
institucional.

La regla exacta de segregación es `PENDIENTE DE APROBACIÓN INSTITUCIONAL`. Si la
institución permite que una sola persona complete todas las etapas, debe
aprobarlo expresamente y registrar la excepción.

### 5.4 Autoridad de habilitación

La habilitación requiere:

- una persona con `inventory.enable`;
- una decisión institucional previa;
- evidencia de inspección;
- ausencia de incidencias bloqueantes;
- control de concurrencia y disponibilidad.

La identidad administrativa actual es una sesión de staging con `ADMIN_USERS` y
`SESSION_SECRET`. El proveedor OIDC institucional sigue pendiente. Hasta que
exista, no debe usarse para habilitar inventario real fuera de local.

---

## 6. Evidencias y trazabilidad

Cada ejemplar debe tener, como mínimo:

| Evidencia | Contenido | Conservación |
| --- | --- | --- |
| Registro de inspección | Código, presencia, estado, identificación, responsable, fecha. | Excel + informe con hash. |
| Evidencia fotográfica | Portada, etiqueta, daño relevante, ubicación. | Almacenamiento institucional; referencia, no datos personales. |
| Decisión | Aceptado/rechazado/revisión, motivo, actor, fecha. | Tabla futura + `audit_events`. |
| Incidencias | Tipo, descripción, evidencia, responsable, estado y resolución. | Excel + futura tabla de incidencias. |
| Habilitación | Actor, fecha, disponibilidad anterior/nueva, lote, hash del informe. | `audit_events` + `inventory_movements`. |
| Reversión | Actor, fecha, motivo, estado anterior/nuevo. | Append-only; no borrar. |

Reglas:

- No incluir nombres, correos, documentos ni datos de participantes en el informe
  de inventario.
- Usar identificadores de actor (`actor_user_id`) y referencias de evidencia.
- El hash SHA-256 del Excel de entrada debe quedar en el lote de habilitación.
- No se permite “resolver” una incidencia borrando la fila.
- La auditoría es inmutable: `audit_events` rechaza `UPDATE` y `DELETE`.

---

## 7. Criterios de habilitación

Un ejemplar solo puede proponerse para habilitación si:

1. existe en `copies` con `provenance_type = 'institutional'`;
2. su código coincide exactamente;
3. presencia física confirmada;
4. identificación bibliográfica conciliada;
5. estado físico evaluado y distinto de `unassessed`;
6. sin incidencias bloqueantes;
7. sin reserva activa ni intercambio en curso;
8. disponibilidad de origen compatible con la habilitación;
9. decisión institucional de aceptación registrada;
10. evidencia y actor autorizador registrados.

La propuesta del procesador (`Candidato a habilitación`) **no** cumple por sí sola
el punto 9. Es una recomendación.

---

## 8. Relación con el procesador de conciliación

El procesador `scripts/process-inventory-reconciliation.py` es de solo lectura y
produce `docs/inventario/Resultado_Conciliacion_Trueque_IUB.xlsx`.

| Clasificación del procesador | Interpretación para esta política |
| --- | --- |
| `Pendiente de conteo` | Pendiente de inspección. |
| `No encontrado` | Rechazo físico o bloqueo; no habilitar. |
| `Identificación no coincidente` | Bloqueo; corregir o rechazar. |
| `Estado físico pendiente` | Pendiente de evaluación. |
| `Con discrepancia` | Bloqueo hasta resolver. |
| `Pendiente de decisión administrativa` | Requiere decisión. |
| `Candidato a habilitación` | Propuesta; requiere autorización. |
| `No habilitable con la información disponible` | No habilitar. |
| `Error de validación` | Corregir el Excel y reprocesar. |

El informe no cambia la base. La habilitación se hará, en el futuro, mediante una
rutina transaccional separada, documentada en
`docs/inventario/especificacion-habilitacion-inventario.md`.

---

## 9. Decisiones pendientes

Las decisiones institucionales concretas, con opciones, recomendación y riesgo,
están en `docs/inventario/decisiones-pendientes-iub.md`.

Ninguna política de este documento se considera aprobada hasta que la institución
lo declare formalmente. Las propuestas técnicas no sustituyen esa aprobación.
