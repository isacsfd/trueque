import { neon } from "@neondatabase/serverless";

export interface SqlStatement {
  text: string;
  values?: readonly unknown[];
}

export class DatabaseUnavailableError extends Error {
  constructor() {
    super("Database service is unavailable.");
    this.name = "DatabaseUnavailableError";
  }
}

type NeonClient = ReturnType<typeof neon>;

let cachedConnectionString: string | undefined;
let cachedClient: NeonClient | undefined;

function getClient(): NeonClient {
  const connectionString = process.env.DATABASE_URL?.trim();

  if (!connectionString) {
    throw new DatabaseUnavailableError();
  }

  try {
    const parsedUrl = new URL(connectionString);
    if (
      !["postgres:", "postgresql:"].includes(parsedUrl.protocol) ||
      !parsedUrl.hostname
    ) {
      throw new Error("Invalid database URL.");
    }
  } catch {
    throw new DatabaseUnavailableError();
  }

  if (!cachedClient || cachedConnectionString !== connectionString) {
    cachedClient = neon(connectionString);
    cachedConnectionString = connectionString;
  }

  return cachedClient;
}

function logDatabaseFailure(error: unknown): void {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
  const safeCode =
    typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;

  console.error(
    JSON.stringify({
      event: "database_operation_failed",
      code: safeCode ?? "unavailable",
    }),
  );
}

/** Run a parameterized, non-session query through Neon's stateless HTTP driver. */
export async function query<Row extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  values: readonly unknown[] = [],
): Promise<Row[]> {
  try {
    const results = await getClient().query(text, [...values]);
    return results as Row[];
  } catch (error) {
    logDatabaseFailure(error);
    throw new DatabaseUnavailableError();
  }
}

/**
 * Run a predetermined batch in one non-interactive HTTP transaction.
 * For operations whose later SQL depends on earlier results, use one SQL CTE
 * or move to an explicit PostgreSQL session before implementing that workflow.
 */
export async function transaction<Row extends Record<string, unknown> = Record<string, unknown>>(
  statements: readonly SqlStatement[],
): Promise<Row[][]> {
  if (statements.length === 0) {
    throw new RangeError("A transaction requires at least one statement.");
  }

  try {
    const client = getClient();
    const queries = statements.map(({ text, values = [] }) =>
      client.query(text, [...values]),
    );
    const results = await client.transaction(queries);
    return results as Row[][];
  } catch (error) {
    logDatabaseFailure(error);
    throw new DatabaseUnavailableError();
  }
}

export async function pingDatabase(): Promise<void> {
  const result = await query<{ ok: number }>("SELECT 1::int AS ok");

  if (result[0]?.ok !== 1) {
    throw new DatabaseUnavailableError();
  }
}
