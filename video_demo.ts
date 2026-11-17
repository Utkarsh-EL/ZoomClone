/** Run the video-sharing scenario across separate peer processes, check each step, and save the evidence. */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { checkEventOrder, peerLines, useLogger, waitForLeader } from "./coord_demo.ts";
import { prepareOutput, ROOT } from "./demo.ts";
import { check, Network, step, writeTranscript } from "./p2p_demo.ts";
import { RPC_TIMEOUT, rpc } from "./peer.ts";
import { configureLogging, parseCli, quietLogger, type Body, type Logger } from "./protocol.ts";
import { testPatternFrame, type FrameRun } from "./video.ts";

// Ring IDs: ora 811, sierra 13800, xray 40128, alpha 52303. alpha leads after the election, xray once alpha is gone.
const FIRST = "ora";
const OTHERS = ["sierra", "xray", "alpha"];
const PEERS = [FIRST, ...OTHERS];
const MEETING = "demo-room";
const HOST = "ora";                  // Hosts the meeting coordinator; never crashed.
const VIEWERS = ["ora", "alpha"];
const PRESENTERS = ["sierra", "xray"];
const FRAMES = 20;
const LONG_FRAMES = 60;              // Long enough to crash the leader in the middle.
const SHARE_TIMEOUT = 120;
let LOG: Logger = quietLogger;

function address(network: Network, name: string) {
  return network.addresses.get(name)!;
}

function stats(network: Network, name: string, frames = false): Promise<Body> {
  return rpc(address(network, name), "video_stats", { frames }, RPC_TIMEOUT, true);
}

function share(network: Network, name: string, frames: number, locked: boolean): Promise<Body> {
  return rpc(address(network, name), "video_share", { frames, locked }, SHARE_TIMEOUT);
}

const describeRuns = (runs: FrameRun[]): string => runs.map((run) => `${run.presenter} ${run.first}-${run.last}`).join(", ");

async function waitForFrames(network: Network, viewer: string, count: number, seconds = 30): Promise<Body> {
  const deadline = performance.now() + seconds * 1000;
  for (;;) {
    const result = await stats(network, viewer);
    if (result.received >= count) {
      return result;
    }
    if (performance.now() > deadline) {
      throw new Error(`${viewer} received ${result.received} of ${count} frames`);
    }
    await sleep(100);
  }
}

/** Audit what each viewer saw, log it, save the frame runs, and clear the viewers for the next run. */
async function auditViewers(network: Network, target: string, run: string, expected: number): Promise<Body[]> {
  const results: Body[] = [];
  const lines: string[] = [];
  for (const viewer of VIEWERS) {
    const result = await waitForFrames(network, viewer, expected);
    const { audit } = result;
    LOG.info(`VIDEO_AUDIT run=${run} viewer=${viewer} frames=${audit.frames} presenters=${audit.presenters} `
             + `runs=${audit.runs} interleaved=${audit.interleaved} in_order=${audit.inOrder}`);
    lines.push(`${viewer} saw ${audit.frames} frames in ${audit.runs} runs: ${describeRuns(result.runs)}`);
    results.push(result);
  }
  writeFileSync(join(target, `video_frames_${run}.txt`), `${lines.join("\n")}\n`, "utf8");
  for (const name of network.addresses.keys()) {
    await rpc(address(network, name), "video_reset", {}, RPC_TIMEOUT, true);
  }
  return results;
}

/** Check that locked presentations never overlap in Lamport time: each starts after the previous one stopped. */
function checkShareOrder(target: string): void {
  const lines = peerLines(target);
  const presentations: { peer: string; start: number; stop: number }[] = [];
  for (const [i, line] of lines.entries()) {
    if (!/^VIDEO_SHARE_START .*locked=true/.test(line.text)) {
      continue;
    }
    const stop = lines.slice(i + 1).find((later) => later.peer === line.peer && later.text.startsWith("VIDEO_SHARE_STOP"));
    if (stop) {
      const lamport = (text: string) => Number(/lamport=(\d+)/.exec(text)![1]);
      presentations.push({ peer: line.peer, start: lamport(line.text), stop: lamport(stop.text) });
    }
  }
  presentations.sort((a, b) => a.start - b.start);
  for (const item of presentations) {
    LOG.info(`PRESENTATION peer=${item.peer} start_lamport=${item.start} stop_lamport=${item.stop}`);
  }
  const overlapping = presentations.filter((item, i) => i > 0 && item.start <= presentations[i - 1].stop);
  check(presentations.length >= 4 && overlapping.length === 0,
        `${presentations.length} locked presentations follow each other in Lamport order with no overlap`);
}

async function runScenario(network: Network, target: string): Promise<void> {
  writeFileSync(join(target, "frame_sample.svg"),
                Buffer.from(testPatternFrame("sierra", 12).split(",")[1], "base64").toString("utf8"), "utf8");

  step(`STEP 1: ${FIRST} starts and the others join; sierra runs an election and alpha leads`);
  await network.startPeer(FIRST);
  await waitForLeader(network, FIRST);
  for (const name of OTHERS) {
    await network.startPeer(name, FIRST);
  }
  await network.waitForRing();
  await rpc(address(network, "sierra"), "elect", {}, RPC_TIMEOUT * 5);
  const elected = await waitForLeader(network, "alpha");

  step(`STEP 2: ${HOST} hosts ${MEETING}; every peer joins it to watch`);
  LOG.info(`HOST_RESULT ${JSON.stringify(await rpc(address(network, HOST), "host", { meeting: MEETING }, RPC_TIMEOUT * 10))}`);
  for (const name of PEERS) {
    await rpc(address(network, name), "video_join", { meeting: MEETING }, RPC_TIMEOUT * 10);
  }
  check(true, "all four peers joined the meeting");

  step(`STEP 3: without the presenter lock, ${PRESENTERS.join(" and ")} share ${FRAMES} frames at the same time`);
  await Promise.all(PRESENTERS.map((name) => share(network, name, FRAMES, false)));
  for (const result of await auditViewers(network, target, "unprotected", FRAMES * 2)) {
    check(result.audit.interleaved > 0, `${result.peer} saw two streams mixed (${result.audit.runs} runs)`);
  }

  step(`STEP 4: with the presenter lock, ${PRESENTERS.join(" and ")} ask to share ${FRAMES} frames at the same time`);
  await Promise.all(PRESENTERS.map((name) => share(network, name, FRAMES, true)));
  for (const result of await auditViewers(network, target, "locked", FRAMES * 2)) {
    check(result.audit.runs === 2 && result.audit.interleaved === 0 && result.audit.inOrder,
          `${result.peer} saw one whole presentation after the other: ${describeRuns(result.runs)}`);
  }

  step("STEP 5: leader alpha crashes while sierra presents and xray waits for the slot");
  const first = share(network, "sierra", LONG_FRAMES, true);
  await waitForFrames(network, "ora", 10);
  const second = share(network, "xray", FRAMES, true);
  for (;;) {
    const grants = (await rpc(address(network, "alpha"), "status", {}, RPC_TIMEOUT, true)).lock.grants;
    if (grants.presenter?.queue.includes("xray")) {
      break;
    }
    await sleep(50);
  }
  LOG.info(`CRASH peer=alpha frames_seen_by_ora=${(await stats(network, "ora")).received}`);
  network.crash("alpha");
  const crashed = performance.now();
  const replacement = await waitForLeader(network, "xray");
  LOG.info(`FAILOVER seconds=${((performance.now() - crashed) / 1000).toFixed(1)} (crash to new leader ready)`);
  const slot = (await rpc(address(network, "xray"), "status", {}, RPC_TIMEOUT, true)).lock.grants.presenter;
  LOG.info(`SLOT_AFTER_RECOVERY holder=${slot.holder} queue=${JSON.stringify(slot.queue)}`);
  check(replacement.term > elected.term && slot.holder === "sierra" && slot.queue.join() === "xray",
        "the new leader xray found sierra presenting and itself next in line");
  await Promise.all([first, second]);
  const ora = await waitForFrames(network, "ora", LONG_FRAMES + FRAMES);
  const frames: { presenter: string; at: number }[] = (await stats(network, "ora", true)).frames;
  const sierra = frames.filter((frame) => frame.presenter === "sierra");
  const gap = Math.max(...sierra.slice(1).map((frame, i) => frame.at - sierra[i].at));
  LOG.info(`VIDEO_GAP viewer=ora presenter=sierra longest_ms=${gap.toFixed(0)} frame_interval_ms=100`);
  writeFileSync(join(target, "video_frames_failover.txt"), `ora saw ${ora.audit.frames} frames in ${ora.audit.runs} runs: `
                + `${describeRuns(ora.runs)}\n`, "utf8");
  check(describeRuns(ora.runs) === `sierra 1-${LONG_FRAMES}, xray 1-${FRAMES}`,
        "the presentation ran to the end, then xray presented: no frame lost, none mixed");
  check(gap < 1000, `sierra's video never paused for a second during the failover (longest gap ${gap.toFixed(0)} ms)`);

  step("STEP 6: event ordering across every peer's log");
  checkEventOrder(target);
  checkShareOrder(target);
}

async function main(): Promise<void> {
  const values = parseCli({
    options: { "output-dir": { type: "string", default: join(ROOT, "evidence", "video_run") } },
  });
  const target = prepareOutput(values["output-dir"], (file) => file.endsWith(".log") || file.endsWith(".console.txt")
    || file.startsWith("video_frames_") || file === "frame_sample.svg" || file === "demo_transcript.txt"
    || file === "lamport_order.txt");
  LOG = configureLogging("demo", target);
  useLogger(LOG);
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
  console.log("Evidence:", writeTranscript(target, "CECS 327 Milestone 4: merged peer logs, video sharing"));
  process.exit(code);
}

if (import.meta.main) {
  await main();
}
