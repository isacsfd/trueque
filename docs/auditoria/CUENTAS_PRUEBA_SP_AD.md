# Cuentas locales de prueba SP/AD

**Fecha:** 2026-10-29  
**Ámbito:** PostgreSQL local desechable.  
**No usar en staging ni producción.**  
**No contiene contraseñas, tokens ni secretos.**

---

## 1. Mecanismo

Script reproducible:

```sh
TEST_ADMIN_DATABASE_URL="postgresql://iub_schema_migrator@127.0.0.1:55441/iub_accounts_test" \
  npm run test:admins:provision
```

Para rotar credenciales existentes:

```sh
TEST_ADMIN_DATABASE_URL="postgresql://iub_schema_migrator@127.0.0.1:55441/iub_accounts_test" \
  npm run test:admins:provision -- --rotate
```

El script:

- exige host local y nombre de base de prueba/desechable;
- crea únicamente actores `local-test`;
- no crea ni modifica credenciales reales;
- no toca producción, staging, inventario ni migraciones;
- escribe credenciales en un archivo **fuera del repositorio**;
- aplica permisos restrictivos al archivo;
- no imprime contraseñas por stdout.

Archivo generado por defecto:

`%USERPROFILE%\trueque-test-admin-credentials.json`

Contiene `adminUsers`, `sessionSecret` y las contraseñas de prueba. No debe copiarse al repositorio, correo, documentación ni logs.

---

## 2. Identidades

| Rol | Usuario | Emisor | Estado | Rol RBAC |
|---|---|---|---|---|
| SP | `test-sp` | `local-test` | Activo | `local_test_sp` |
| AD | `test-ad` | `local-test` | Activo | `local_test_ad` |

Los actores son distintos (`actorUserId` diferentes). Ambos tienen una sola asignación de rol de prueba.

### Permisos SP

`local_test_sp` tiene 24 permisos explícitos, correspondientes a los módulos administrativos existentes:

`account.manage`, `requests.review`, `offered_books.review`, `inventory.batches.import`, `inventory.batches.confirm`, `inventory.batches.read`, `stats.read`, `inventory.admit`, `inventory.enable`, `exchange.plan`, `exchange.start`, `exchange.complete`, `exchange.cancel`, `delivery.schedule`, `delivery.confirm`, `reception.evaluate`, `reception.return`, `custody.transfer`, `cataloging.validate`, `cataloging.authorize`, `participants.read_contact`, `privacy.withdraw`, `reservations.configure`, `reservations.expire`.

### Permisos AD

`local_test_ad` tiene exactamente:

`requests.review`

AD puede consultar la bandeja, aprobar y rechazar solicitudes con motivo. AD no puede administrar cuentas, lotes ni estadísticas.

---

## 3. Inicio de sesión local

Con el clúster local iniciado y las variables de base de datos apuntando a la base de prueba:

```powershell
$cred = Get-Content "$env:USERPROFILE\trueque-test-admin-credentials.json" | ConvertFrom-Json
$env:ADMIN_USERS = ($cred.adminUsers | ConvertTo-Json -Compress)
$env:SESSION_SECRET = $cred.sessionSecret
$env:DATABASE_URL = "postgresql://iub_public_runtime@127.0.0.1:55441/iub_accounts_test"
$env:DATABASE_ADMIN_URL = "postgresql://iub_admin_runtime@127.0.0.1:55441/iub_accounts_test"
```

Usuario SP: `test-sp`  
Usuario AD: `test-ad`  
Las contraseñas se leen desde el archivo local; **no se incluyen aquí**.

La aplicación actual requiere Netlify Functions para servir `/api/admin/session`; `npm run dev` (Vite) por sí solo no expone esa Function. Para una prueba HTTP local se necesita un runtime que sirva Functions con las variables anteriores.

---

## 4. Verificación ejecutada

Se probó contra PostgreSQL 18 local desechable:

- login real de SP y AD con los hashes de `ADMIN_USERS`;
- sesiones distintas;
- actor activo revalidado;
- SP puede consultar cuentas y estadísticas;
- AD recibe `403` en cuentas y estadísticas;
- AD puede consultar la bandeja;
- AD aprueba y rechaza con motivo;
- historial registra estado, motivo y actor;
- aprobación no crea recepción, admisión ni movimiento;
- contraseñas y actores son distintos;
- SP tiene los permisos explícitos definidos; AD solo `requests.review`.

Evidencia: `netlify/tests/test-admins-postgres.test.ts` (se ejecuta solo si existe el archivo de credenciales y `IUB_TEST_DATABASE_URL`).

---

## 5. Limitaciones

- Las cuentas viven en la base local desechable, no en Neon/staging/producción.
- Si se elimina el clúster, deben volver a provisionarse con el script.
- `ADMIN_USERS` y `SESSION_SECRET` son configuración local; no son secretos de producción.
- No se implementó OIDC ni credenciales propias en la base.
- El archivo de credenciales está fuera del repositorio y no debe compartirse.
