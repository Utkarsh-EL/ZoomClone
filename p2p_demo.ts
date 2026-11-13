/** Run the overlay scenario across separate peer processes and save the evidence. */

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { Participant } from "./client.ts";
import { exited, freeLocalPort, prepareOutput, ROOT, waitForBroker, waitForExit } from "./demo.ts";
import { MAX_HOPS, RemoteError, RPC_TIMEOUT, discover, rpc, type Address } from "./peer.ts";
import { configureLogging, NetworkError, quietLogger, type Body, type Logger } from "./protocol.ts";

const MEETING = "demo-room";
const FIRST_PEERS = ["alpha", "sierra", "ora", "xray"];
const JOINING_PEER = "echo";  // Its ring position takes over the meeting's key when it joins.
const PROVIDER = "sierra";    // Stays clear of the peers that leave and crash until the final step.
const LOG_LINE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3}Z /;
let LOG: Logger = quietLogger;

type Statuses = Record<string, Body>;

/** Peer processes owned by the demo, reachable by name. */
class Network {
  target: string;
  processes = new Map<string, ChildProcess>();
  addresses = new Map<string, Address>();
  handles: number[] = [];

  constructor(target: string) {
    this.target = target;
  }

  async startPeer(name: string, bootstrap?: string): Promise<void> {
    const port = await freeLocalPort();
    const output = openSync(join(this.target, `${name}.console.txt`), "w");
    this.handles.push(output);
    const command = [join(ROOT, "peer.ts"), "--name", name, "--port", String(port), "--log-dir", this.target];
    if (bootstrap) {
      command.push("--bootstrap", `127.0.0.1:${this.addresses.get(bootstrap)![1]}`);
    }
    const child = spawn(process.execPath, command, { cwd: ROOT, stdio: ["ignore", output, output] });
    this.processes.set(name, child);
    await waitForBroker(child, port);
    this.addresses.set(name, ["127.0.0.1", port]);
  }

  async lookup(name: string, meeting = MEETING): Promise<Body> {
    const answer = await rpc(this.addresses.get(name)!, "lookup", { name: meeting }, RPC_TIMEOUT * MAX_HOPS);
    LOG.info(`LOOKUP_RESULT asked=${name} found=${answer.found} owner=${answer.owner} hops=${answer.path.length - 1} `
             + `path=${answer.path.join(">")} value=${JSON.stringify(answer.value)}`);
    return answer;
  }

  async leave(name: string): Promise<void> {
    await rpc(this.take(this.addresses, name), "leave");
    const code = await waitForExit(this.take(this.processes, name), 15);
    check(code === 0, `${name} exited cleanly after leaving`);
  }

  crash(name: string): void {
    this.addresses.delete(name);
    this.take(this.processes, name).kill("SIGKILL");
  }

  private take<T>(map: Map<string, T>, name: string): T {
    const value = map.get(name)!;
    map.delete(name);
    return value;
  }

  async statuses(): Promise<Statuses> {
    const entries = await Promise.all([...this.addresses].map(
      async ([name, address]) => [name, await rpc(address, "status", {}, RPC_TIMEOUT, true)] as const));
    return Object.fromEntries(entries);
  }

  /** Wait until every peer's neighbor pointers form one ring ordered by ID. */
  async waitForRing(seconds = 20): Promise<[Statuses, string[]]> {
    const deadline = performance.now() + seconds * 1000;
    for (;;) {
      try {
        const statuses = await this.statuses();
        const order = Object.keys(statuses).sort((a, b) => statuses[a].me.id - statuses[b].me.id);
        if (order.every((name, i) => statuses[name].successors[0].name === order[(i + 1) % order.length]
                                     && statuses[name].predecessor?.name === order.at(i - 1))) {
          const ring = order.map((name) => `${name}(${statuses[name].me.id})`).join(" -> ");
          LOG.info(`RING peers=${order.length} ${ring} -> ${order[0]}`);
          return [statuses, order];
        }
      } catch (error) {
        if (!(error instanceof NetworkError || error instanceof RemoteError)) {
          throw error;
        }
      }
      if (performance.now() >= deadline) {
        throw new Error("The ring did not stabilize");
      }
      await sleep(100);
    }
  }

  async stop(): Promise<void> {
    for (const child of this.processes.values()) {
      if (!exited(child)) {
        child.kill("SIGKILL");
        await waitForExit(child, 5);
      }
    }
    for (const handle of this.handles) {
      closeSync(handle);
    }
  }
}

function check(condition: boolean, description: string): void {
  if (!condition) {
    throw new Error(`Check failed: ${description}`);
  }
  LOG.info(`CHECK ok: ${description}`);
}

function ownerSuccessor(statuses: Statuses, owner: string): string {
  return statuses[owner].successors[0].name;
}

function step(text: string): void {
  LOG.info(`===== ${text} =====`);
}

async function runScenario(network: Network): Promise<void> {
  step("STEP 1: four peers start and form a ring");
  await network.startPeer(FIRST_PEERS[0]);
  for (const name of FIRST_PEERS.slice(1)) {
    await network.startPeer(name, FIRST_PEERS[0]);
  }
  let [statuses, order] = await network.waitForRing();
  check(order.length === 4, "ring holds four peers");

  step(`STEP 2: ${PROVIDER} hosts ${MEETING} and registers it in the overlay`);
  const hosted = await rpc(network.addresses.get(PROVIDER)!, "host", { meeting: MEETING }, RPC_TIMEOUT * MAX_HOPS);
  LOG.info(`HOST_RESULT ${JSON.stringify(hosted)}`);

  step("STEP 3: a lookup is routed through the overlay");
  const owner: string = (await network.lookup(PROVIDER)).owner;
  const origin = ownerSuccessor(statuses, owner);
  let answer = await network.lookup(origin);
  check(answer.found && answer.owner === owner, `${origin} resolves ${MEETING} at ${owner}`);
  check(answer.path.length - 1 === 3, "lookup from the owner's successor crosses three hops");

  step(`STEP 4: ${JOINING_PEER} joins and takes over the key`);
  await network.startPeer(JOINING_PEER, FIRST_PEERS[0]);
  [statuses, order] = await network.waitForRing();
  check(order.length === 5, "ring holds five peers");
  check(MEETING in statuses[JOINING_PEER].records, `${JOINING_PEER} received ${MEETING} on join`);
  check(!(MEETING in statuses[owner].records), `${owner} handed ${MEETING} off`);
  answer = await network.lookup(origin);
  check(answer.owner === JOINING_PEER && answer.found, `lookup now resolves at ${JOINING_PEER}`);

  step("STEP 5: participants discover the meeting through two different peers and talk");
  const users: Participant[] = [];
  for (const [user, via] of [["alice", FIRST_PEERS[0]], ["bob", FIRST_PEERS[2]]]) {
    const [host, port] = await discover(MEETING, network.addresses.get(via)!);
    LOG.info(`DISCOVERED participant=${user} via=${via} coordinator=${host}:${port}`);
    const participant = new Participant(user, { meeting: MEETING, host, port });
    await participant.connect();
    users.push(participant);
  }
  const [alice, bob] = users;
  const members = (await alice.request("list_participants")).participants;
  check(JSON.stringify(members) === JSON.stringify(["alice", "bob"]), "both participants reached the same coordinator");
  check((await alice.groupSend("Found this meeting through the overlay")).group_deliveries === 2,
        "group message delivered through the discovered coordinator");
  await bob.waitFor((packet) => packet.type === "group_message");

  step(`STEP 6: ${JOINING_PEER} leaves gracefully and hands its key to its successor`);
  const heir = ownerSuccessor(statuses, JOINING_PEER);
  await network.leave(JOINING_PEER);
  [statuses, order] = await network.waitForRing();
  check(order.length === 4, "ring holds four peers");
  answer = await network.lookup(FIRST_PEERS[0]);
  check(answer.found && answer.owner === heir, `${heir} serves ${MEETING} after the handoff`);

  step(`STEP 7: ${heir} crashes without warning`);
  const nextOwner = ownerSuccessor(statuses, heir);
  network.crash(heir);
  let started = performance.now();
  [statuses, order] = await network.waitForRing();
  check(order.length === 3, "ring repaired itself to three peers");
  LOG.info(`RING_REPAIRED seconds=${((performance.now() - started) / 1000).toFixed(1)}`);
  for (;;) {
    answer = await network.lookup(FIRST_PEERS[0]);
    if (answer.found) {
      break;
    }
    if (performance.now() - started > 20000) {
      throw new Error("The provider never re-registered");
    }
    await sleep(500);
  }
  LOG.info(`DISCOVERY_RESTORED seconds=${((performance.now() - started) / 1000).toFixed(1)}`);
  check(answer.owner === nextOwner, `${PROVIDER} re-registered ${MEETING} at ${nextOwner}`);
  check((await alice.groupSend("Still here after the crash")).group_deliveries === 2,
        "the running meeting was not affected by the overlay failure");
  for (const user of users) {
    user.close();
  }

  step(`STEP 8: the provider ${PROVIDER} crashes and its record expires`);
  network.crash(PROVIDER);
  started = performance.now();
  [statuses, order] = await network.waitForRing();
  check(order.length === 2, "ring repaired itself to two peers");
  while ((await network.lookup(nextOwner)).found) {
    if (performance.now() - started > 20000) {
      throw new Error("The dead provider's record never expired");
    }
    await sleep(1000);
  }
  LOG.info(`RECORD_GONE seconds=${((performance.now() - started) / 1000).toFixed(1)}`);
  LOG.info("CHECK ok: a meeting whose host died stops being discoverable");
}

/** Merge every process's log into one file ordered by timestamp. */
function writeTranscript(target: string): string {
  const lines: string[] = [];
  for (const file of readdirSync(target).filter((name) => name.endsWith(".console.txt")).sort()) {
    for (const line of readFileSync(join(target, file), "utf8").split(/\r?\n/)) {
      if (LOG_LINE.test(line)) {
        lines.push(line);
      }
    }
  }
  // The sort is stable and keys only on the timestamp, so each process keeps its own order.
  lines.sort((a, b) => (a.slice(0, 23) < b.slice(0, 23) ? -1 : a.slice(0, 23) > b.slice(0, 23) ? 1 : 0));
  const transcript = join(target, "demo_transcript.txt");
  writeFileSync(transcript, `CECS 327 Milestone 3: merged peer logs (UTC timestamps)\n\n${lines.join("\n")}\n`, "utf8");
  return transcript;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { "output-dir": { type: "string", default: join(ROOT, "evidence", "p2p_run") } },
  });
  const target = prepareOutput(values["output-dir"], (file) =>
    file.endsWith(".log") || file.endsWith(".console.txt") || file === "demo_transcript.txt");
  LOG = configureLogging("demo", target);
  const network = new Network(target);
  let code: number;
  try {
    await runScenario(network);
    LOG.info("RESULT: PASS");
    code = 0;
  } catch (error) {  // Any failure must still produce the transcript and a FAIL result.
    LOG.error(`RESULT: FAIL ${String(error)}`);
    code = 1;
  } finally {
    await network.stop();
  }
  // The demo's own log joins the merge under the same naming as the peers' console files.
  writeFileSync(join(target, "demo.console.txt"), readFileSync(join(target, "demo.log"), "utf8"), "utf8");
  console.log("Evidence:", writeTranscript(target));
  process.exit(code);
}

if (import.meta.main) {
  await main();
}
