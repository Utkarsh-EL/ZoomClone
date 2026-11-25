/** Bounded crash-evidence child, not a deployed meeting runtime. IPC reports a
 * completed durable stage; the parent kills this process and resumes in a new one. */
import { HelperClient } from "../coordination/helper-client.ts";
import { RecoveryController } from "../coordination/recovery-controller.ts";
import { Database, createPool } from "../storage/database.ts";
import { MeetingStore } from "../storage/meeting-store.ts";

const config = JSON.parse(process.env.ZOOM_RECOVERY_STEP!);
const database = await Database.open({ connectionString: process.env.ZOOM_STORAGE_ADMIN_URL!, clusterId: config.clusterId });
const pool = createPool(process.env.ZOOM_STORAGE_ADMIN_URL!);
const store = new MeetingStore(database, pool);
try {
  const helper = new HelperClient(config.helper);
  const controller = new RecoveryController(helper, store, { clusterId: config.clusterId });
  const candidates = config.candidates.map((c: { runtimeId: string; incarnation: string }) => ({ ...c,
    prepare: async (owner: Parameters<MeetingStore["prepare"]>[0]) => { await store.prepare(owner); } }));
  const stage = await controller.tick(config.meetingId, candidates);
  process.send?.({ stage });
  // Stay alive so the test exercises SIGKILL, rather than orderly pool closure.
  setInterval(() => {}, 1000);
} catch (error) {
  process.send?.({ error: error instanceof Error ? error.message : String(error) });
  await pool.end(); await database.close(); process.exitCode = 1;
  process.disconnect?.();
}
