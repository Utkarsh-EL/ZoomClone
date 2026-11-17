/** Run the coordination scenario across separate peer processes, check each step, and save the evidence. */

import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { prepareOutput, ROOT } from "./demo.ts";
import { auditMinutes, readMinutes, type MinutesAudit } from "./minutes.ts";
import { check, Network, step, useLogger as useSharedLogger, writeTranscript } from "./p2p_demo.ts";
import { RemoteError, RPC_TIMEOUT, rpc } from "./peer.ts";
import { configureLogging, NetworkError, parseCli, quietLogger, type Body, type Logger } from "./protocol.ts";

// Ring IDs: ora 811, sierra 13800, xray 40128, alpha 52303. ora starts alone, so it leads until an election runs.
const FIRST = "ora";
const OTHERS = ["sierra", "xray", "alpha"];
const PEERS = [FIRST, ...OTHERS];
const HIGHEST = "alpha";
const SURVIVOR_LEADER = "xray";  // Highest ID once alpha is gone.
const ENTRIES_PER_PEER = 5;
const FAILOVER_ENTRIES_PER_PEER = 8;
const APPEND_TIMEOUT = 120;      // Seconds; an append call returns only after every entry is written.
const LINE = /^(\S+ \S+)Z (INFO|WARNING|ERROR) (\S+) (.*)$/;
const MESSAGE = /^(SEND|RECV) (?:to|from)=\S+ type=(\S+) id=(\w+) lamport=(\d+)/;
let LOG: Logger = quietLogger;

/** Send this module's and the shared demo helpers' log lines to this logger. */
export function useLogger(logger: Logger): void {
  LOG = logger;
  useSharedLogger(logger);
}

interface Leader {
  name: string;
  term: number;
}

/** Wait until every peer follows one leader (the expected one, if named) whose lock recovery has finished. */
export async function waitForLeader(network: Network, expected?: string, seconds = 30): Promise<Leader> {
  const deadline = performance.now() + seconds * 1000;
  for (;;) {
    try {
      const statuses = await network.statuses();
      const views = Object.values(statuses);
      const name: string | undefined = views[0].leader?.name;
      if (name !== undefined && (expected === undefined || name === expected) && statuses[name]?.lock.ready
          && views.every((status) => status.leader?.name === name && status.term === statuses[name].term)) {
        const leader = { name, term: statuses[name].term };
        LOG.info(`LEADER_AGREED leader=${leader.name} term=${leader.term} peers=${Object.keys(statuses).join(",")}`);
        return leader;
      }
    } catch (error) {
      if (!(error instanceof NetworkError || error instanceof RemoteError)) {
        throw error;
      }
    }
    if (performance.now() >= deadline) {
      throw new Error(`The peers never agreed on ${expected ?? "a leader"}`);
    }
    await sleep(50);
  }
}

function appendAll(network: Network, names: string[], count: number, locked: boolean): Promise<Body[]> {
  return Promise.all(names.map((name) => rpc(network.addresses.get(name)!, "append", { count, locked }, APPEND_TIMEOUT)));
}

function audit(path: string, run: string): MinutesAudit {
  const result = auditMinutes(readMinutes(path));
  LOG.info(`MINUTES_AUDIT run=${run} entries=${result.entries} duplicates=${result.duplicates} `
           + `collisions=${result.collisions} lamport_ordered=${result.lamportOrdered}`);
  return result;
}

function checkSerialized(result: MinutesAudit, entries: number, run: string): void {
  check(result.entries === entries && result.duplicates === 0, `${run}: ${entries} entries, no number used twice`);
  check(result.collisions === 0, `${run}: no write landed inside another writer's read-modify-write`);
  check(result.lamportOrdered, `${run}: entry order matches Lamport order`);
}

interface LogLine {
  time: string;
  peer: string;
  text: string;
}

export function peerLines(target: string): LogLine[] {
  const lines: LogLine[] = [];
  for (const file of readdirSync(target).filter((name) => name.endsWith(".console.txt") && name !== "demo.console.txt")) {
    for (const raw of readFileSync(join(target, file), "utf8").split(/\r?\n/)) {
      const match = LINE.exec(raw);
      if (match) {
        lines.push({ time: match[1], peer: match[3], text: match[4] });
      }
    }
  }
  return lines;
}

/** Count lock messages sent between two log times. */
function lockMessages(lines: LogLine[], from: string, to: string): number {
  return lines.filter((line) => line.time >= from && line.time <= to
                                && /^SEND .* type=lock_(request|grant|release) /.test(line.text)).length;
}

function logTime(): string {
  const iso = new Date().toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)},${iso.slice(20, 23)}`;
}

/** Check that every message's receive is later than its send on the Lamport clock, and write the Lamport-ordered log. */
export function checkEventOrder(target: string): void {
  const lines = peerLines(target);
  const sends = new Map<string, number>();
  const receives = new Map<string, number>();
  for (const line of lines) {
    const match = MESSAGE.exec(line.text);
    if (match) {
      (match[1] === "SEND" ? sends : receives).set(match[3], Number(match[4]));
    }
  }
  const pairs = [...sends].filter(([id]) => receives.has(id));
  const late = pairs.filter(([id, sent]) => receives.get(id)! <= sent);
  LOG.info(`LAMPORT_PAIRS messages=${pairs.length} receive_not_after_send=${late.length}`);
  check(pairs.length > 0 && late.length === 0, `all ${pairs.length} logged messages were received at a later Lamport time`);

  const stamped = lines.flatMap((line) => {
    const match = / lamport=(\d+)/.exec(` ${line.text}`);
    return match ? [{ ...line, lamport: Number(match[1]) }] : [];
  });
  // Lamport time, then peer name, is a total order that agrees with every send-before-receive pair.
  stamped.sort((a, b) => a.lamport - b.lamport || (a.peer < b.peer ? -1 : a.peer > b.peer ? 1 : 0));
  const rendered = stamped.map((line) => `L=${String(line.lamport).padStart(5)}  ${line.peer.padEnd(6)}  ${line.text}  `
                                         + `[${line.time.slice(11)}]`);
  writeFileSync(join(target, "lamport_order.txt"), "CECS 327 Milestone 4: every event that carries a Lamport time, "
                + "ordered by (Lamport time, peer name). Wall-clock time in brackets.\n\n" + `${rendered.join("\n")}\n`,
                "utf8");
  LOG.info(`LAMPORT_ORDER lines=${rendered.length} file=lamport_order.txt`);
}

async function runScenario(network: Network, target: string): Promise<void> {
  const minutes = join(target, "minutes.jsonl");
  const args = ["--minutes", minutes];

  step(`STEP 1: ${FIRST} starts alone and elects itself; ${OTHERS.join(", ")} join and learn the leader`);
  await network.startPeer(FIRST, undefined, args);
  const first = await waitForLeader(network, FIRST);
  for (const name of OTHERS) {
    await network.startPeer(name, FIRST, args);
  }
  await network.waitForRing();
  check((await waitForLeader(network, FIRST)).term === first.term, `joining peers adopted ${FIRST} without an election`);

  step(`STEP 2: sierra runs a ring election; the highest ID, ${HIGHEST}, replaces ${FIRST}`);
  await rpc(network.addresses.get("sierra")!, "elect", {}, RPC_TIMEOUT * 5);
  const elected = await waitForLeader(network, HIGHEST);
  check(elected.term > first.term, `${HIGHEST} leads in a newer term (${elected.term})`);

  step(`STEP 3: without the lock, all four peers write ${ENTRIES_PER_PEER} minutes at once`);
  await appendAll(network, PEERS, ENTRIES_PER_PEER, false);
  const unprotected = audit(minutes, "unprotected");
  check(unprotected.duplicates > 0 && unprotected.collisions > 0,
        `unprotected writers collided (${unprotected.collisions} of ${unprotected.entries} entries, `
        + `${unprotected.duplicates} reused numbers)`);
  renameSync(minutes, join(target, "minutes_unprotected.jsonl"));

  step(`STEP 4: with the lock, all four peers write ${ENTRIES_PER_PEER} minutes at once`);
  const lockedStart = logTime();
  await appendAll(network, PEERS, ENTRIES_PER_PEER, true);
  const lockedEnd = logTime();
  checkSerialized(audit(minutes, "locked"), PEERS.length * ENTRIES_PER_PEER, "locked run");
  renameSync(minutes, join(target, "minutes_locked.jsonl"));
  const nonLeaderEntries = (PEERS.length - 1) * ENTRIES_PER_PEER;
  const messages = lockMessages(peerLines(target), lockedStart, lockedEnd);
  LOG.info(`LOCK_COST messages=${messages} non_leader_entries=${nonLeaderEntries} `
           + `per_entry=${(messages / nonLeaderEntries).toFixed(2)} (the leader's own entries need no messages)`);

  step(`STEP 5: leader ${HIGHEST} crashes while ${PEERS.filter((name) => name !== HIGHEST).join(", ")} contend for the lock`);
  const writers = PEERS.filter((name) => name !== HIGHEST);
  const writing = appendAll(network, writers, FAILOVER_ENTRIES_PER_PEER, true);
  while (readMinutes(minutes).length < 5) {
    await sleep(20);
  }
  LOG.info(`CRASH peer=${HIGHEST} entries_written=${readMinutes(minutes).length}`);
  network.crash(HIGHEST);
  const crashed = performance.now();
  const replacement = await waitForLeader(network, SURVIVOR_LEADER);
  LOG.info(`FAILOVER seconds=${((performance.now() - crashed) / 1000).toFixed(1)} (crash to new leader ready)`);
  check(replacement.term > elected.term, `${SURVIVOR_LEADER}, the highest surviving ID, leads in term ${replacement.term}`);
  await writing;
  checkSerialized(audit(minutes, "failover"), writers.length * FAILOVER_ENTRIES_PER_PEER, "failover run");
  const recovered = readFileSync(join(target, `${SURVIVOR_LEADER}.console.txt`), "utf8").split(/\r?\n/)
    .find((line) => line.includes(`LOCK_STATE_RECOVERED`) && line.includes(`term=${replacement.term}`));
  check(recovered !== undefined, `${SURVIVOR_LEADER} rebuilt the lock state before granting`);
  LOG.info(`RECOVERY ${recovered!.slice(recovered!.indexOf("LOCK_STATE_RECOVERED"))}`);
  renameSync(minutes, join(target, "minutes_failover.jsonl"));

  step(`STEP 6: ${HIGHEST} restarts and rejoins under the sitting leader`);
  await network.startPeer(HIGHEST, FIRST, args);
  await network.waitForRing();
  const after = await waitForLeader(network, SURVIVOR_LEADER);
  check(after.term === replacement.term, `${HIGHEST} learned ${SURVIVOR_LEADER} without starting an election`);

  step("STEP 7: event ordering across every peer's log");
  checkEventOrder(target);
}

async function main(): Promise<void> {
  const values = parseCli({
    options: { "output-dir": { type: "string", default: join(ROOT, "evidence", "coord_run") } },
  });
  const target = prepareOutput(values["output-dir"], (file) => file.endsWith(".log") || file.endsWith(".console.txt")
    || file.endsWith(".jsonl") || file === "demo_transcript.txt" || file === "lamport_order.txt");
  useLogger(configureLogging("demo", target));
  const network = new Network(target);
  let code: number;
  try {
    await runScenario(network, target);
    LOG.info("RESULT: PASS");
    code = 0;
  } catch (error) {  // Any failure must still produce the transcript and a FAIL result.
    LOG.error(`RESULT: FAIL ${String(error)}`);
    code = 1;
  } finally {
    await network.stop();
  }
  writeFileSync(join(target, "demo.console.txt"), readFileSync(join(target, "demo.log"), "utf8"), "utf8");
  console.log("Evidence:", writeTranscript(target, "CECS 327 Milestone 4: merged peer logs"));
  process.exit(code);
}

if (import.meta.main) {
  await main();
}
