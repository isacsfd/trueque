# Consulta pública con un solo token

## Estado

- Producción mantiene temporalmente el flujo anterior: código de solicitud + clave de acceso.
- El cambio local prepara la consulta con **un único campo**.
- La migración `0019_secure_public_status.sql` **no está aplicada** en la base compartida.
- El bundle candidato está en `release/candidate/` y **no está publicado**.

## Credencial

La credencial de consulta es el **token de acceso** de la solicitud:

- 32 bytes aleatorios generados por `generateAccessToken()`.
- Se entrega al crear la solicitud.
- Se almacena únicamente como SHA-256 en
  `exchange_requests.request_access_token_sha256`.
- No se acepta el código corto `IUB-...` como credencial pública.
- No se acepta el ID de reserva como credencial.

La base actual tiene 7 solicitudes, todas con token de acceso distinto. La
columna no tenía índice único; `0019` lo agrega.

## Recuperación de acceso

Si el titular perdió su token, un administrador con `requests.review` puede
emitir un token de recuperación:

- El backend genera 32 bytes aleatorios.
- Se almacena solo el SHA-256 en `request_lookup_tokens`.
- El token en claro se devuelve una sola vez al administrador para entregarlo.
- El token de recuperación se puede revocar sin afectar el token de acceso
  original ni la reserva.
- La auditoría registra `token_id`, no el token.

Acción administrativa:

```text
POST /api/admin/action
{
  "action": "request.issue_lookup_token",
  "requestId": "...",
  "label": "recuperación"
}
```

La respuesta contiene `{ token, token_id }` una sola vez. No debe registrarse.

## Endpoint público

```text
POST /api/requests/status
{ "token": "<token>" }
```

También acepta clientes antiguos que envíen `code` junto con `token`; el
código se ignora y la validación se hace exclusivamente por token.

La función SQL devuelve solo:

- código de solicitud;
- estado;
- fecha de solicitud;
- libro ofrecido y solicitado;
- estado de reserva;
- estado de intercambio;
- estado de recepción;
- próximos pasos.

No devuelve nombre, correo, documento, participante, motivos internos,
auditoría ni datos de otros usuarios.

## Límites

`public_status_rate_limits` guarda buckets hasheados, no IP ni tokens en claro:

- 30 intentos/hora por IP.
- 10 intentos/hora por token.

La función `consume_public_status_rate_limit` actualiza el bucket de forma
atómica en PostgreSQL. Esto reemplaza el límite exclusivamente en memoria.

## Pruebas locales

- `db/migrations/0019_secure_public_status.test.ts`
- `netlify/tests/requests.test.ts`
- `netlify/tests/admin-action.test.ts`
- `src/components/MyRequest.test.tsx`
- `src/App.test.tsx`

## Publicación (no ejecutada)

1. Crear backup verificable.
2. Aplicar `0019` con `SET ROLE iub_schema_migrator` y transacción.
3. Verificar índice único, tablas, funciones y grants.
4. Desplegar el backend nuevo.
5. Cambiar `release/index.html` al bundle candidato.
6. Verificar un solo campo, consulta con token sintético y rate limit.
7. Monitorear 404/429/5xx.

No usar `npm run db:migrate:apply` mientras el ledger no esté reconciliado.

## Rollback

- Restaurar el deploy anterior de Netlify.
- Mantener `0019` si ya hay tokens emitidos; las funciones son aditivas.
- Si se revierte `0019`, eliminar primero los tokens de recuperación emitidos y
  verificar que no existan dependencias.
- El token de acceso original no se modifica al emitir/revocar recuperaciones.
