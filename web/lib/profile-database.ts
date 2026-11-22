import postgres from "postgres";
import { ensureSchema, type UnsafeRunner } from "./schema";
import { resolveDatabaseUrl, DATABASE_URL_HINT } from "./database-url";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;
export type SqlTag = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]>;
  json: <T>(value: T) => unknown;
};
type Client = ReturnType<typeof postgres>;
type Query = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<ArrayLike<Row>>;

let client: Client | null = null;
const tags = new Map<string, SqlTag>();

export function profileSchema(id: string): string {
  if (id === "default") return "public";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
    throw new Error("Invalid profile identifier.");
  }
  return "h2g_" + id.replaceAll("-", "");
}

/** The one connection pool every profile shares, opened with the configured URL as is. */
export function profileClient(): Client {
  if (!client) {
    const url = resolveDatabaseUrl();
    if (!url) throw new Error(`No Postgres connection string. Set one of: ${DATABASE_URL_HINT}`);
    client = postgres(url, { prepare: false });
  }
  return client;
}

/**
 * Run one statement in an added profile's schema. Poolers in transaction mode (Neon's,
 * PgBouncer) refuse search_path as a startup option and can hand a session-level SET to
 * another client, so the schema is set inside the statement's own transaction.
 */
function inSchema<T>(schema: string, run: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return profileClient().begin(async (tx) => {
    // The schema comes from profileSchema(), which accepts only a generated UUID.
    await tx.unsafe(`SET LOCAL search_path TO "${schema}"`);
    return run(tx);
  }) as Promise<T>;
}

export function profileSql(id = "default"): SqlTag {
  const schema = profileSchema(id);
  let tag = tags.get(schema);
  if (tag) return tag;
  const db = profileClient();
  // The default profile keeps the plain connection, exactly as before profiles existed.
  const runner: UnsafeRunner = schema === "public" ? db : { unsafe: (text) => inSchema(schema, (tx) => tx.unsafe(text)) };
  const query: Query = schema === "public"
    ? (strings, ...values) => (db as unknown as Query)(strings, ...values)
    : (strings, ...values) => inSchema(schema, (tx) => (tx as unknown as Query)(strings, ...values));
  tag = ((strings: TemplateStringsArray, ...values: unknown[]) => ensureSchema(runner)
    .then(() => query(strings, ...values))
    .then((rows) => Array.from(rows))) as SqlTag;
  tag.json = <T,>(value: T) => db.json(value as Parameters<typeof db.json>[0]);
  tags.set(schema, tag);
  return tag;
}

export async function closeProfileDatabases(): Promise<void> {
  await client?.end();
  client = null;
  tags.clear();
}
