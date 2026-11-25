import { randomUUID } from "node:crypto";
import { Database, createPool } from "../storage/database.ts";
import { MeetingStore } from "../storage/meeting-store.ts";
import { HelperClient } from "./helper-client.ts";
import { LeaderRoute } from "./helper-route.ts";
import { RuntimeAgent, type RuntimeOptions } from "./runtime-agent.ts";
import { serveRuntime } from "./runtime-rpc.ts";
import { ControlWire } from "./wire.ts";

export interface MeetingRuntimeConfig extends Omit<RuntimeOptions, "incarnation"> {
  incarnation?: string;
  address: string;
  token: string;
  callers: string[];
  helpers: { helperId: string; address: string }[];
  helperToken: string;
  helperTimeoutMs?: number;
  connectionString: string;
  runtimeConnectionString: string;
}

/** Composition only: the activation protocol remains in RecoveryController,
 * SQL ownership stays in MeetingStore, and authority stays in RuntimeAuthority. */
export async function startMeetingRuntime(config: MeetingRuntimeConfig, report: (meetingId: string, error?: Error) => void) {
  const identity = { clusterId: config.clusterId, nodeId: config.runtimeId, incarnation: config.incarnation ?? randomUUID() };
  const wire = new ControlWire(identity);
  const helper = new LeaderRoute(config.helpers.map(route => new HelperClient({ ...route, ...identity,
    token: config.helperToken, timeoutMs: config.helperTimeoutMs }, wire)));
  const db = await Database.open({ clusterId: config.clusterId, connectionString: config.connectionString });
  const pool = createPool(config.runtimeConnectionString);
  const store = new MeetingStore(db, pool);
  // Do not copy credentials or endpoint configuration into the public identity.
  const abort = new AbortController();
  let agent: RuntimeAgent | undefined;
  try {
    agent = new RuntimeAgent(helper, store, { ...identity, runtimeId: config.runtimeId, expectedRevision: config.expectedRevision,
      intervalMs: config.intervalMs, readinessMs: config.readinessMs, maxMeetings: config.maxMeetings });
    const service = await serveRuntime(agent, { address: config.address, token: config.token, callers: config.callers, wire });
    const scheduled = agent.run({ signal: abort.signal, report });
    let closing: Promise<void> | undefined;
    const close = () => {
      closing ??= (async () => {
        abort.abort(); agent!.stop();
        try { await service.close(); await scheduled.catch(() => {}); }
        finally { await pool.end(); await db.close(); }
      })();
      return closing;
    };
    // Terminal registration/revocation also releases resources when no external
    // supervisor is present. close waits for the raw scheduler, never itself.
    const done = scheduled.then(close, async error => { await close().catch(() => {}); throw error; });
    void done.catch(() => {});
    return { agent, store, address: service.address, done, close };
  } catch (error) { agent?.stop(); await pool.end(); await db.close(); throw error; }
}
