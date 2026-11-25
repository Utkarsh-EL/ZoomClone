import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { UUID_PATTERN } from "../coordination/wire.ts";

export interface DatabaseOptions { connectionString: string; clusterId: string; initialize?: boolean }

export function createPool(connectionString: string, max = 8): Pool {
  const pool = new Pool({ connectionString, max, connectionTimeoutMillis: 1500, idleTimeoutMillis: 1000,
    application_name: "zoomclone-storage", options: "-c statement_timeout=2000 -c lock_timeout=750 -c idle_in_transaction_session_timeout=2000 -c transaction_timeout=5000" });
  // pg evicts broken idle clients. Handle its error event so a database restart
  // cannot terminate the runtime; active operations still receive their errors.
  pool.on("error", () => {});
  return pool;
}

export async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>, readOnly = false): Promise<T> {
  const client = await pool.connect();
  let failure: Error | undefined;
  try {
    await client.query(readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { failure = error instanceof Error ? error : new Error("Database connection lost"); }
    throw error;
  } finally { client.release(failure); }
}

export class Database {
  readonly pool: Pool;
  readonly clusterId: string;
  private constructor(pool: Pool, clusterId: string) { this.pool = pool; this.clusterId = clusterId; }

  static async open(options: DatabaseOptions): Promise<Database> {
    if (!UUID_PATTERN.test(options.clusterId)) throw new Error("Cluster UUID required");
    const pool = createPool(options.connectionString);
    try {
      await transaction(pool, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(841785239)");
        const exists = await client.query("SELECT to_regclass('public.zoom_schema_migrations') AS name");
        if (!exists.rows[0].name && !options.initialize) throw new Error("Storage initialization required; durable identity missing");
        await client.query("CREATE TABLE IF NOT EXISTS public.zoom_schema_migrations(version int PRIMARY KEY, digest text NOT NULL)");
        const sql = await readFile(new URL("./migrations/001-meetings.sql", import.meta.url), "utf8");
        const digest = createHash("sha256").update(sql.replaceAll("\r\n", "\n")).digest("hex");
        const prior = await client.query("SELECT digest FROM public.zoom_schema_migrations WHERE version=1");
        if (prior.rowCount) {
          if (prior.rows[0].digest !== digest) throw new Error("Applied migration digest changed");
        } else {
          if (!options.initialize) throw new Error("Storage migration/initialization required");
          await client.query(sql);
          await client.query("INSERT INTO public.zoom_schema_migrations VALUES(1,$1)", [digest]);
        }
        const identity = await client.query("SELECT cluster_id FROM zoom.cluster_identity");
        if (identity.rowCount === 0) {
          if (!options.initialize || prior.rowCount) throw new Error("Durable cluster identity missing; explicit isolated restore/replacement required");
          await client.query("INSERT INTO zoom.cluster_identity(cluster_id) VALUES($1)", [options.clusterId]);
        } else if (identity.rows[0].cluster_id !== options.clusterId) throw new Error("Database belongs to a different cluster");
      });
      return new Database(pool, options.clusterId);
    } catch (error) { await pool.end(); throw error; }
  }

  async close(): Promise<void> { await this.pool.end(); }
}
