import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

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

export class DatabaseQueryError extends Error {
  readonly sqlState: string;

  constructor(sqlState: string) {
    super("Database operation was rejected.");
    this.name = "DatabaseQueryError";
    this.sqlState = sqlState;
  }
}

type NeonClient = NeonQueryFunction<false, false>;

type DatabaseEnvironment = "DATABASE_URL" | "DATABASE_ADMIN_URL";
const cachedClients = new Map<DatabaseEnvironment, { connectionString: string; client: NeonClient }>();

function getClient(environment: DatabaseEnvironment): NeonClient {
  const connectionString = process.env[environment]?.trim();

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

  const cached = cachedClients.get(environment);
  if (!cached || cached.connectionString !== connectionString) {
    const client = neon(connectionString);
    cachedClients.set(environment, { connectionString, client });
    return client;
  }

  return cached.client;
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
async function queryWithDatabase<Row extends object = Record<string, unknown>>(
  environment: DatabaseEnvironment,
  text: string,
  values: readonly unknown[] = [],
): Promise<Row[]> {
  try {
    const results = await getClient(environment).query(text, [...values]);
    return results as Row[];
  } catch (error) {
    logDatabaseFailure(error);
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      /^[0-9A-Z]{5}$/.test(error.code)
    ) {
      throw new DatabaseQueryError(error.code);
    }
    throw new DatabaseUnavailableError();
  }
}

export function query<Row extends object = Record<string, unknown>>(
  text: string,
  values: readonly unknown[] = [],
): Promise<Row[]> {
  return queryWithDatabase("DATABASE_URL", text, values);
}

export function queryAdmin<Row extends object = Record<string, unknown>>(
  text: string,
  values: readonly unknown[] = [],
): Promise<Row[]> {
  return queryWithDatabase("DATABASE_ADMIN_URL", text, values);
}

/**
 * Run a predetermined batch in one non-interactive HTTP transaction.
 * For operations whose later SQL depends on earlier results, use one SQL CTE
 * or move to an explicit PostgreSQL session before implementing that workflow.
 */
export async function transaction<Row extends object = Record<string, unknown>>(
  statements: readonly SqlStatement[],
): Promise<Row[][]> {
  if (statements.length === 0) {
    throw new RangeError("A transaction requires at least one statement.");
  }

  try {
    const client = getClient("DATABASE_URL");
    const queries = statements.map(({ text, values = [] }) =>
      client.query(text, [...values]),
    );
    const results = await client.transaction(queries);
    return results as Row[][];
  } catch (error) {
    logDatabaseFailure(error);
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      /^[0-9A-Z]{5}$/.test(error.code)
    ) {
      throw new DatabaseQueryError(error.code);
    }
    throw new DatabaseUnavailableError();
  }
}

export async function transactionAdmin<Row extends object = Record<string, unknown>>(
  statements: readonly SqlStatement[],
): Promise<Row[][]> {
  if (statements.length === 0) {
    throw new RangeError("A transaction requires at least one statement.");
  }

  try {
    const client = getClient("DATABASE_ADMIN_URL");
    const queries = statements.map(({ text, values = [] }) =>
      client.query(text, [...values]),
    );
    const results = await client.transaction(queries);
    return results as Row[][];
  } catch (error) {
    logDatabaseFailure(error);
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      /^[0-9A-Z]{5}$/.test(error.code)
    ) {
      throw new DatabaseQueryError(error.code);
    }
    throw new DatabaseUnavailableError();
  }
}

/**
 * The HTTP query invokes a single PostgreSQL routine. Its PL/pgSQL body owns
 * the locks and transaction; do not emulate this with separate HTTP queries.
 */
export async function reserveCopy(input: {
  copyId: string;
  requestId: string;
  accessTokenSha256: Uint8Array;
  idempotencyKey: string;
}): Promise<{ reservation_id: string; expires_at: string }> {
  const rows = await query<{ reservation_id: string; expires_at: string }>(
    "SELECT * FROM public.reserve_copy($1, $2, $3, $4)",
    [input.copyId, input.requestId, input.accessTokenSha256, input.idempotencyKey],
  );
  if (!rows[0]) throw new DatabaseUnavailableError();
  return rows[0];
}

/** Atomic closure is delegated to one PL/pgSQL call over the admin-only URL. */
export async function completeExchange(input: {
  exchangeId: string;
  completionKey: string;
  actorUserId: string;
}): Promise<string> {
  const rows = await queryAdmin<{ complete_exchange: string }>(
    "SELECT public.complete_exchange($1, $2, $3)",
    [input.exchangeId, input.completionKey, input.actorUserId],
  );
  if (!rows[0]) throw new DatabaseUnavailableError();
  return rows[0].complete_exchange;
}

export async function pingDatabase(): Promise<void> {
  const result = await query<{ ok: number }>("SELECT 1::int AS ok");

  if (result[0]?.ok !== 1) {
    throw new DatabaseUnavailableError();
  }
}
