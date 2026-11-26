import { randomUUID } from "node:crypto";
import { HelperClient } from "../coordination/helper-client.ts";
import { LeaderRoute } from "../coordination/helper-route.ts";
import { DiscoveryClient } from "../coordination/discovery-client.ts";
import { DiscoveredHelpers } from "../coordination/discovered-helpers.ts";
import { ControlWire } from "../coordination/wire.ts";
import { ClientSession } from "./client-session.ts";
import { SessionJournal } from "./session-journal.ts";
import { participantResolver, type ParticipantRoute } from "./participant-transport.ts";
import type { SessionTarget } from "./types.ts";
import { serveBrowserAttachment, type BrowserOptions } from "./browser-attachment.ts";

export interface ParticipantAgentConfig {
  sessionPath: string;
  target: SessionTarget;
  helpers: { helperId: string; address: string }[];
  helperToken: string;
  helperTimeoutMs?: number;
  discovery?: { bootstraps: string[]; token: string; timeoutMs?: number };
  routes: ParticipantRoute[];
  timeoutMs?: number;
  intervalMs?: number;
  browser?: Omit<BrowserOptions, "wire">;
}

/** One agent owns the journal and ClientSession; every local adapter uses this
 * same session. No credential is exposed by its public view or status output. */
export function startParticipant(config: ParticipantAgentConfig, report: (error?: Error) => void = () => {}) {
  const journal = SessionJournal.open(config.sessionPath, config.target);
  try {
    const identity = { clusterId: config.target.clusterId, nodeId: journal.credential().participantId, incarnation: randomUUID() };
    const wire = new ControlWire(identity);
    const helper = config.discovery ? new DiscoveredHelpers({ identity, token: config.helperToken, timeoutMs: config.helperTimeoutMs,
      discovery: new DiscoveryClient({ ...config.discovery, identity }, wire) }, wire)
      : new LeaderRoute(config.helpers.map(route => new HelperClient({ ...route, ...identity, token: config.helperToken, timeoutMs: config.helperTimeoutMs }, wire)));
    const session = new ClientSession(journal, participantResolver({ ...identity, meetingId: config.target.meetingId, helper,
      routes: config.routes, timeoutMs: config.timeoutMs }, wire));
    const abort = new AbortController();
    const done = session.run(abort.signal, report, config.intervalMs);
    let closed: Promise<void> | undefined;
    let browser: ReturnType<typeof serveBrowserAttachment> | undefined;
    return { session, done,
      openBrowser() {
        if (closed) throw new Error("PARTICIPANT_CLOSED");
        return browser ??= serveBrowserAttachment(session, { ...(config.browser ?? { address: "127.0.0.1:0" }), wire });
      },
      close(): Promise<void> {
        return closed ??= (async () => {
          abort.abort();
          try { await (await browser?.catch(() => undefined))?.close(); await done; }
          finally { journal.close(); }
        })();
      } };
  } catch (error) { journal.close(); throw error; }
}
