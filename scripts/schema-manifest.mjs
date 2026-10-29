import {
  compareObjectManifest,
  dedupeObjects,
  planManifestRefresh,
} from "./migration-safety.mjs";

export async function getPublicObjects(connection) {
  const result = await connection.query(`
    SELECT 'relation'::text AS object_type, c.relkind::text || ':' || c.relname AS object_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'i', 'I')
    UNION ALL
    SELECT 'routine'::text, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
    UNION ALL
    SELECT 'trigger'::text, c.relname || '.' || t.tgname
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal
    UNION ALL
    SELECT 'type'::text, t.typname
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype IN ('c', 'd', 'e', 'r')
    UNION ALL
    SELECT 'policy'::text, c.relname || '.' || p.polname
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
    ORDER BY object_type, object_name
  `);
  return result.rows;
}

export async function manifestExists(connection) {
  const result = await connection.query(
    "SELECT to_regclass('public.schema_object_manifest') AS relation",
  );
  return Boolean(result.rows[0]?.relation);
}

export async function assertManifestShape(connection) {
  const columns = await connection.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'schema_object_manifest'
     ORDER BY ordinal_position`,
  );
  const actualColumns = columns.rows.map((row) => `${row.column_name}:${row.data_type}`);
  const expectedColumns = ["object_type:text", "object_name:text", "introduced_by:text"];
  if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns)) {
    throw new Error("The schema object manifest has an unexpected structure; manual review required.");
  }

  const primaryKey = await connection.query(
    `SELECT a.attname
     FROM pg_index i
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = 'public.schema_object_manifest'::regclass AND i.indisprimary`,
  );
  const primaryKeyColumns = primaryKey.rows.map((row) => row.attname).sort();
  if (JSON.stringify(primaryKeyColumns) !== JSON.stringify(["object_name", "object_type"])) {
    throw new Error("The schema object manifest has an unexpected primary key; manual review required.");
  }
}

export async function assertManifest(connection) {
  const expected = await connection.query(
    "SELECT object_type, object_name FROM public.schema_object_manifest",
  );
  const actual = dedupeObjects(await getPublicObjects(connection));
  const diff = compareObjectManifest(actual, expected.rows);
  if (diff.unexpected.length || diff.missing.length) {
    throw new Error(
      `Schema object manifest differs (unexpected=${diff.unexpected.length}, missing=${diff.missing.length}); manual review required.`,
    );
  }
}

export async function refreshManifest(
  connection,
  version,
  baselineObjects = [],
  baselineVersion = null,
) {
  const actual = dedupeObjects(await getPublicObjects(connection));
  const existing = await connection.query(
    "SELECT object_type, object_name FROM public.schema_object_manifest",
  );
  const plan = planManifestRefresh(actual, existing.rows, {
    version,
    baselineObjects,
    baselineVersion,
  });
  for (const object of plan.stale) {
    await connection.query(
      `DELETE FROM public.schema_object_manifest
       WHERE object_type = $1 AND object_name = $2`,
      [object.object_type, object.object_name],
    );
  }
  for (const object of plan.inserts) {
    await connection.query(
      `INSERT INTO public.schema_object_manifest (object_type, object_name, introduced_by)
       VALUES ($1, $2, $3) ON CONFLICT (object_type, object_name) DO NOTHING`,
      [object.object_type, object.object_name, object.introduced_by],
    );
  }
  await assertManifest(connection);
}
