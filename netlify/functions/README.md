# Netlify Functions

`database-diagnostics.ts` expone `GET /api/private/database-diagnostics`. Es un endpoint técnico protegido por `DATABASE_DIAGNOSTICS_TOKEN`; si el secreto no está configurado o es débil, responde 404. Ejecuta solo `SELECT 1` y devuelve un resultado genérico.

El acceso reutilizable está en `netlify/lib/database.ts`, fuera del directorio de funciones. Usa `@neondatabase/serverless` mediante HTTP sin estado. No registra SQL, parámetros, URLs ni datos personales. Las funciones futuras deben validar entradas y roles en servidor y usar `DATABASE_URL` de runtime con privilegios mínimos.

Las credenciales se configuran en variables privadas de Functions, nunca en `netlify.toml`, el código cliente ni variables `VITE_*`.
