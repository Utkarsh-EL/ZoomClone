import type { Pool } from "pg";
import { UUID_PATTERN } from "../coordination/wire.ts";
import { createPool, transaction } from "./database.ts";

/** Approved views only; the future SQL panel needs its own bounded query path. */
export class StorageInspector {
  private readonly pool: Pool;
  private readonly clusterId: string;
  constructor(connectionString: string, clusterId: string) {
    if (!UUID_PATTERN.test(clusterId)) throw new Error("Cluster UUID required");
    this.clusterId = clusterId;
    this.pool = createPool(connectionString, 2);
  }
  async read(meetingId: string, limit = 100) {
    if (!UUID_PATTERN.test(meetingId)) throw new Error("Meeting UUID required");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Inspection limit must be 1–100");
    return transaction(
      this.pool,
      async (client) => {
        await client.query(
          "SET LOCAL statement_timeout='500ms'; SET LOCAL lock_timeout='100ms'; SET LOCAL idle_in_transaction_session_timeout='750ms'; SET LOCAL transaction_timeout='1500ms'",
        );
        const identity = await client.query(
          "SELECT cluster_id FROM zoom.inspect_identity",
        );
        if (
          identity.rowCount !== 1 ||
          identity.rows[0].cluster_id !== this.clusterId
        )
          throw new Error("Inspection cluster mismatch");
        const fence = await client.query(
          "SELECT * FROM zoom.inspect_ownership WHERE meeting_id=$1",
          [meetingId],
        );
        if (!fence.rowCount) throw new Error("Meeting unavailable");
        const rows = await client.query(
          "SELECT state FROM zoom.inspect_state WHERE meeting_id=$1",
          [meetingId],
        );
        if (!rows.rowCount) throw new Error("Durable state missing");
        const events = await client.query(
          "SELECT * FROM zoom.inspect_events WHERE meeting_id=$1 ORDER BY seq DESC LIMIT $2",
          [meetingId, limit],
        );
        const outcomes = await client.query(
          "SELECT * FROM zoom.inspect_outcomes WHERE meeting_id=$1 ORDER BY participant_id,command_id LIMIT $2",
          [meetingId, limit],
        );
        const owner = fence.rows[0];
        const result = {
          ownership: {
            ...owner,
            generation: Number(owner.generation),
            seq: Number(owner.seq),
          },
          state: rows.rows[0].state,
          events: events.rows,
          outcomes: outcomes.rows,
          observedAt: new Date().toISOString(),
          limit,
        };
        if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024)
          throw new Error("Inspection result exceeds byte bound");
        return result;
      },
      true,
    );
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
}
