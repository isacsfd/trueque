# Fuentes Excel del proyecto

**Fecha:** 2026-10-29.  
**Estado:** documentos fuente conservados sin modificación. No importados en esta fase.

## Resguardo y publicación

El remoto GitHub del proyecto es público. Por ello, los dos binarios se
conservan localmente en la raíz de trabajo y están excluidos explícitamente
por `.gitignore`. No se incluyen en commits, despliegues Netlify ni el bundle
público. Este documento es el manifiesto público de procedencia: contiene solo
nombre, estructura, clasificación y hash SHA-256 de cada fuente.

El análisis estructural no encontró encabezados ni valores con correo,
teléfono, documento de identidad o dirección. Aun así, los archivos se tratan
como fuentes institucionales privadas y no se publican sin una decisión
institucional específica.

No existe un directorio `Matriz` en el repositorio. Los dos archivos acordados están en la raíz del proyecto y se mantienen allí para no romper scripts ni duplicar fuentes.

---

## 1. `INVENTARIO TRUEQUE.xlsx`

| Atributo | Valor |
|---|---|
| Ruta | `INVENTARIO TRUEQUE.xlsx` |
| Tamaño | 16 254 bytes |
| SHA-256 | `86d6602a23aa6d95045c5a40eece9c3dd3ce14e7349adf59e19ce37110bd846d` |
| Hojas | 1 (`Hoja1`) |
| Encabezados | `BIBLIOTECA ACTUAL`, `No.`, `AUTOR`, `TITULO`, `EJEMPLAR`, `EDITORIAL` |
| Filas con datos | 137 filas; 67 con título bibliográfico |
| ISBN | No contiene columna ISBN |
| Clasificación | **C. Fuente de datos del inventario histórico** |

Es la fuente original de los 67 ejemplares. No debe reimportarse como lote nuevo ni modificarse. La conciliación y el resultado derivados están en `docs/inventario/`.

---

## 2. `Libros para el Trueque Literario CH.xlsx`

| Atributo | Valor |
|---|---|
| Ruta | `Libros para el Trueque Literario CH.xlsx` |
| Tamaño | 11 190 bytes |
| SHA-256 | `433d0246f3266374cae0a5ccaab28fad05246ec121f9b6ca648661671c5c9bb3` |
| Hojas | 1 (`Hoja1`) |
| Encabezados | `ITEM`, `NOMBRE DE LIBRO`, `AUTOR`, `EDITORIAL`, `ISBN`, `OBSERVACION` |
| Filas con datos | 17 filas con título; 17 con ISBN |
| Clasificación | **C. Fuente de datos candidata para un lote nuevo** |

No es una matriz de decisiones ni una plantilla de conciliación. Parece una lista estructurada de libros para revisión/importación, pero su finalidad institucional y su mapeo definitivo deben ser confirmados por la fundación antes de importarla.

---

## 3. Tratamiento

- Los originales permanecen intactos en la raíz.
- No se copiaron ni duplicaron.
- No se importaron filas al inventario.
- No se crearon permisos ni decisiones a partir de estos archivos.
- Cualquier importación futura debe usar el módulo de lotes, prevalidación, confirmación explícita y las autorizaciones correspondientes.
- La segunda fuente no debe publicarse ni convertirse en catálogo sin conciliación, revisión y habilitación institucional.

---

## 4. Verificación

```sh
Get-FileHash "INVENTARIO TRUEQUE.xlsx" -Algorithm SHA256
Get-FileHash "Libros para el Trueque Literario CH.xlsx" -Algorithm SHA256
```

Los hashes deben coincidir con los de este documento antes de cualquier procesamiento.
