import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, test } from "node:test";

import { Participant } from "../client.ts";
import { freeLocalPort, ROOT } from "../demo.ts";
import { Peer } from "../peer.ts";
import { quietLogger, type Packet } from "../protocol.ts";
import { isFrame, MAX_FRAME_CHARS, MeetingServer } from "../server.ts";
import { attachVideo, auditFrames, frameRuns, startWebUi, testPatternFrame, type VideoSession } from "../video.ts";

// Ring IDs: ora 811, sierra 13800, xray 40128, alpha 52303. alpha leads, then xray once alpha is gone.
const NAMES = ["alpha", "sierra", "ora", "xray"];
const MEETING = "demo-room";

async function waitFor(predicate: () => boolean, what: string, seconds = 20): Promise<void> {
  const deadline = performance.now() + seconds * 1000;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      assert.fail(`Timed out waiting for ${what}`);
    }
    await sleep(20);
  }
}

/** Four peers in a meeting hosted by ora, with alpha as leader and every peer watching. */
class Room {
  peers = new Map<string, Peer>();
  videos = new Map<string, VideoSession>();

  get(name: string): Peer {
    return this.peers.get(name)!;
  }

  video(name: string): VideoSession {
    return this.videos.get(name)!;
  }

  async open(): Promise<void> {
    for (const name of NAMES) {
      const peer = new Peer(name, { interval: 0.03 });
      await peer.start(this.peers.size ? this.get(NAMES[0]).address : null);
      this.peers.set(name, peer);
      this.videos.set(name, attachVideo(peer));
    }
    const order = [...this.peers.values()].sort((a, b) => a.me.id - b.me.id);
    await waitFor(() => order.every((peer, i) => peer.successors[0].id === order[(i + 1) % order.length].me.id
                                                 && peer.predecessor?.id === order.at(i - 1)!.me.id), "the ring");
    await this.get("ora").startElection(true);
    await this.waitForLeader("alpha");
    await this.get("ora").hostMeeting(MEETING);
    for (const video of this.videos.values()) {
      await video.join(MEETING);
    }
  }

  async waitForLeader(name: string): Promise<void> {
    await waitFor(() => [...this.peers.values()].every((peer) => peer.leader?.name === name
                                                               && peer.term === this.get(name).term)
                        && this.get(name).onStatus().lock.ready, `every peer to follow ${name}`);
  }

  crash(name: string): void {
    this.get(name).halt();
    this.peers.delete(name);
    this.videos.delete(name);
  }

  close(): void {
    for (const peer of this.peers.values()) {
      peer.halt();
    }
  }
}

describe("video frames", () => {
  test("test-pattern frames are valid frames, and the audit spots mixed streams", () => {
    const frame = testPatternFrame("sierra", 7);
    assert.ok(isFrame(frame), "a pattern frame passes the coordinator's check");
    assert.ok(Buffer.from(frame.split(",")[1], "base64").toString("utf8").includes("frame 7"));
    const whole = [1, 2, 3].map((seq) => ({ presenter: "sierra", seq })).concat([1, 2].map((seq) => ({ presenter: "xray", seq })));
    assert.deepEqual(auditFrames(whole), { frames: 5, presenters: 2, runs: 2, interleaved: 0, inOrder: true });
    const mixed = [["sierra", 1], ["xray", 1], ["sierra", 2], ["xray", 2]].map(([presenter, seq]) => ({ presenter: String(presenter), seq: Number(seq) }));
    assert.equal(auditFrames(mixed).interleaved, 2);
    assert.deepEqual(frameRuns(whole).map((run) => `${run.presenter} ${run.first}-${run.last}`), ["sierra 1-3", "xray 1-2"]);
    for (const bad of ["data:text/html;base64,PGgxPg==", "data:image/jpeg;base64,<script>",
                       `data:image/jpeg;base64,${"A".repeat(MAX_FRAME_CHARS)}`, 42]) {
      assert.equal(isFrame(bad), false, String(bad).slice(0, 30));
    }
  });

  test("the meeting relays a frame to everyone but its presenter", async () => {
    const server = new MeetingServer(quietLogger);
    const { port } = await server.listen("127.0.0.1", 0);
    const people = ["a", "b", "c"].map((name) => new Participant(name, { meeting: MEETING, port }));
    try {
      for (const person of people) {
        await person.connect();
      }
      const seen: Record<string, Packet[]> = { a: [], b: [], c: [] };
      for (const person of people) {
        person.onFrame = (packet) => seen[person.name].push(packet);
      }
      const reply = await people[0].shareFrame(1, testPatternFrame("a", 1));
      assert.equal(reply.deliveries, 2);
      await waitFor(() => seen.b.length === 1 && seen.c.length === 1, "both viewers to get the frame");
      assert.equal(seen.a.length, 0);
      assert.equal(seen.b[0].sender, "a");
      await assert.rejects(people[1].shareFrame(1, "data:text/html;base64,PGgxPg=="), /Invalid frame/);
    } finally {
      for (const person of people) {
        person.close();
      }
      server.close();
    }
  });
});

test("the peer command serves its meeting page", async () => {
  // Runs the real entry point: its video module is loaded while peer.ts is still the starting module.
  const directory = mkdtempSync(join(tmpdir(), "zoomclone-page-"));
  const http = await freeLocalPort();
  const child = spawn(process.execPath, [join(ROOT, "peer.ts"), "--name", "solo", "--port", String(await freeLocalPort()),
                                         "--http", String(http), "--log-dir", directory], { stdio: "ignore" });
  try {
    const deadline = performance.now() + 15000;
    for (;;) {
      try {
        const page = await fetch(`http://127.0.0.1:${http}/`);
        assert.equal(page.status, 200);
        assert.match(await page.text(), /Presenter slot/);
        break;
      } catch (error) {
        if (performance.now() > deadline) {
          throw error;
        }
        await sleep(100);
      }
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((done) => child.once("exit", done));
      child.kill();
      await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("presenter slot", () => {
  let room: Room;

  beforeEach(() => { room = new Room(); });
  afterEach(() => room.close());

  test("without the presenter lock, two streams interleave at a viewer", async () => {
    await room.open();
    await Promise.all(["sierra", "xray"].map((name) => room.video(name).share("pattern", { locked: false, frames: 10 })));
    await waitFor(() => room.video("ora").received.length === 20, "20 frames at ora");
    const audit = auditFrames(room.video("ora").received);
    assert.ok(audit.interleaved > 0, `streams mixed (${frameRuns(room.video("ora").received).length} runs)`);
  });

  test("with the presenter lock, presenters take turns and viewers see whole streams", async () => {
    await room.open();
    await Promise.all(["sierra", "xray"].map((name) => room.video(name).share("pattern", { frames: 10 })));
    for (const viewer of ["ora", "alpha"]) {
      await waitFor(() => room.video(viewer).received.length === 20, `20 frames at ${viewer}`);
      assert.deepEqual(auditFrames(room.video(viewer).received),
                       { frames: 20, presenters: 2, runs: 2, interleaved: 0, inOrder: true });
    }
  });

  test("a presentation keeps going through a leader crash, and the next presenter keeps its place", async () => {
    await room.open();
    const ora = room.video("ora");
    const first = room.video("sierra").share("pattern", { frames: 30 });
    await waitFor(() => ora.received.length >= 8, "sierra's first frames");
    const second = room.video("xray").share("pattern", { frames: 10 });
    await waitFor(() => room.get("alpha").onStatus().lock.grants.presenter?.queue.length === 1, "xray to queue");
    room.crash("alpha");
    await room.waitForLeader("xray");
    assert.equal(room.get("xray").onStatus().lock.grants.presenter.holder, "sierra");
    await Promise.all([first, second]);
    await waitFor(() => ora.received.length === 40, "40 frames at ora");
    assert.deepEqual(frameRuns(ora.received).map((run) => `${run.presenter} ${run.first}-${run.last}`),
                     ["sierra 1-30", "xray 1-10"]);
    const sierra = ora.received.filter((frame) => frame.presenter === "sierra");
    const gap = Math.max(...sierra.slice(1).map((frame, i) => frame.at - sierra[i].at));
    assert.ok(gap < 1000, `video never stalled for a second (longest gap ${gap.toFixed(0)} ms)`);
  });

  test("the meeting page serves, refuses stray frames, and shares the test pattern", async () => {
    await room.open();
    const server = await startWebUi(room.video("sierra"), 0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const page = await fetch(`${base}/`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /Presenter slot/);
      const stray = await fetch(`${base}/frame`, { method: "POST", body: "data:image/jpeg;base64,AAAA" });
      assert.equal(stray.status, 409, "a peer that is not presenting refuses frames");
      const share = await fetch(`${base}/share`, { method: "POST", body: JSON.stringify({ source: "pattern" }) });
      assert.equal(share.status, 202);
      await waitFor(() => room.video("ora").received.length >= 3, "pattern frames at ora");
      const stop = await fetch(`${base}/stop`, { method: "POST" });
      assert.equal(((await stop.json()) as { state: string }).state, "off");
      assert.equal(room.get("sierra").lockState("presenter"), "idle", "the slot was given back");
    } finally {
      server.close();
    }
  });
});
