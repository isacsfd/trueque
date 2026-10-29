# Flujo público sin registro y decisiones administrativas

**Fecha:** 2026-10-29.  
**Estado:** implementación local; no desplegada.  
**Regla:** el solicitante no crea cuenta ni contraseña.

---

## 1. Flujo del solicitante

1. Entra al catálogo público.
2. Selecciona un ejemplar habilitado.
3. Completa los datos del libro que ofrece y sube las fotografías requeridas.
4. Completa nombre, correo, documento y consentimiento.
5. Envía la solicitud.
6. Recibe código de solicitud y clave de acceso opaca.
7. Consulta el estado con código + clave.
8. El personal autorizado revisa, aprueba o rechaza.
9. La decisión queda registrada; recepción, evaluación, admisión, entrega y habilitación siguen siendo etapas separadas.

No se crea usuario, contraseña ni sesión de participante. El acceso se prueba con un token opaco almacenado en el navegador y nunca con un identificador predecible.

---

## 2. Datos y minimización

- Nombre, correo y documento se cifran antes de persistir.
- El documento no se devuelve a la interfaz.
- El estado público no muestra nombre, correo ni documento.
- La bandeja administrativa no muestra datos personales; las imágenes se sirven por Function autorizada.
- La aprobación no crea recepción, admisión, movimiento, entrega ni habilitación.
- El documento sigue siendo un dato sensible; su necesidad debe revisarse en la política de privacidad institucional.

---

## 3. Protección contra abuso

Se añadió un rate limit local por IP para endpoints públicos:

| Endpoint | Límite orientativo |
|---|---|
| Crear/editar borrador | 30/hora |
| Subir/borrar evidencia | 60/hora |
| Enviar solicitud | 10/hora |
| Reservar | 60/hora |
| Consultar estado | 120/hora |
| Leer evidencia con token | 120/hora |

También se conservan:

- idempotency keys en creación, reserva y envío;
- límites de tamaño y validación de MIME real;
- token opaco para seguimiento;
- bloqueo de solicitudes duplicadas por participante/ejemplar;
- rate limit de login administrativo.

**Limitación:** los contadores de endpoints públicos son best-effort por instancia de Netlify Functions. No son distribuidos ni duraderos. El rate limiting de borde/WAF sigue pendiente.

---

## 4. Decisiones administrativas

- Consultar bandeja: `requests.review`.
- Aprobar/denegar: `requests.review`, motivo obligatorio y confirmación explícita.
- Historial: `request_status_history` con actor, fecha, estado y motivo.
- Aprobación concurrente: bloqueo por solicitud y transición idempotente.
- Aprobación no crea recepción, admisión, movimiento, reserva, entrega ni habilitación.
- Un ejemplar no disponible o no verificado no puede aprobarse.
- La aprobación no reserva el ejemplar; la reserva se obtiene con el token del solicitante y `plan_exchange` exige que siga activa.

---

## 5. Seguimiento

`MyRequest` consulta por código + token. Si `sessionStorage` no está disponible, la clave se muestra una vez en la pantalla de confirmación y se conserva en memoria de React para la pestaña actual. No se coloca en URL ni en parámetros de consulta.

La decisión se muestra como estado. El motivo de rechazo no se expone actualmente al solicitante porque `get_request_status` no lo devuelve; ampliarlo requiere una función/migración autorizada.

---

## 6. Pruebas

- `RequestForm.test.tsx`: borrador, fotografías, datos, consentimiento, envío y reserva.
- `requests.test.ts`: creación heredada cerrada, validaciones, reserva/estado.
- `api-postgres.test.ts`: flujo completo API–PostgreSQL y decisión administrativa.
- `public-rate-limit.test.ts`: límites, expiración, aislamiento y 429.
- `admin-session.test.ts` / `admin-identity.test.ts`: sesiones y actores activos.
- `test-admins-postgres.test.ts`: SP/AD reales, RBAC, aprobación/denegación.

Las pruebas de carga/DAST formal no se ejecutaron.
