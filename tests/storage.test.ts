import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { Database } from "../storage/database.ts";

const connectionString = process.env.ZOOM_STORAGE_ADMIN_URL;
if (!connectionString) throw new Error("Run npm run test:storage to provision the isolated PostgreSQL lab");
const clusterId = process.env.ZOOM_STORAGE_CLUSTER_ID!;

test("database bootstrap is explicit, durable, and bound to the cluster", async () => {
  await assert.rejects(Database.open({ connectionString, clusterId, initialize: false }), /initializ|identity/i);
  const db = await Database.open({ connectionString, clusterId, initialize: true });
  try {
    const again = await Database.open({ connectionString, clusterId, initialize: false });
    await again.close();
    await assert.rejects(Database.open({ connectionString, clusterId: randomUUID(), initialize: true }), /cluster/i);
    const health = await db.pool.query("SELECT current_setting('server_version_num')::int AS version, current_setting('fsync') AS fsync, current_setting('synchronous_commit') AS sync");
    assert.ok(health.rows[0].version >= 180000);
    assert.equal(health.rows[0].fsync, "on");
    assert.equal(health.rows[0].sync, "on");
    const inspector = await db.pool.query("SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname='zoom_inspector'");
    assert.deepEqual(inspector.rows[0], { rolsuper: false, rolcreatedb: false, rolcreaterole: false });
  } finally { await db.close(); }
});
