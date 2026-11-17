import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, test } from "node:test";

import { auditMinutes, readMinutes } from "../minutes.ts";
import { Peer, RemoteError, request, requestOrder, rpc, type LockRequest, type PeerRef } from "../peer.ts";
import { message } from "../protocol.ts";

// Ring IDs: ora 811, sierra 13800, xray 40128, alpha 52303. alpha leads first, then xray.
const NAMES = ["alpha", "sierra", "ora", "xray"];

/** Peers started by one test, all writing the same minutes file. */
class Group {
  peers = new Map<string, Peer>();
  directory = mkdtempSync(join(tmpdir(), "zoomclone-minutes-"));
  minutes = join(this.directory, "minutes.jsonl");

  get(name: string): Peer {
    const peer = this.peers.get(name);
    assert.ok(peer, `no peer named ${name}`);
    return peer;
  }

  async peer(name: string, bootstrap?: string): Promise<Peer> {
    const peer = new Peer(name, { interval: 0.03, minutes: this.minutes });
    await peer.start(bootstrap ? this.get(bootstrap).address : null);
    this.peers.set(name, peer);
    return peer;
  }

  async ring(names = NAMES): Promise<void> {
    await this.peer(names[0]);
    for (const name of names.slice(1)) {
      await this.peer(name, names[0]);
    }
    // An election only reaches the peers the ring links, so wait until every pointer is in place.
    const order = [...this.peers.values()].sort((a, b) => a.me.id - b.me.id);
    await waitFor(() => order.every((peer, i) => peer.successors[0].id === order[(i + 1) % order.length].me.id
                                                 && peer.predecessor?.id === order.at(i - 1)!.me.id), "the ring");
  }

  crash(name: string): void {
    this.get(name).halt();
    this.peers.delete(name);
  }

  /** Wait until every live peer follows one leader (the expected one, if named) that has recovered the lock state. */
  async waitForLeader(expected?: string, seconds = 20): Promise<{ name: string; term: number }> {
    const agreed = (): Peer | undefined => {
      const name = this.peers.values().next().value?.leader?.name;
      const leader = name === undefined ? undefined : this.peers.get(name);
      const ok = leader !== undefined && (expected === undefined || name === expected) && leader.onStatus().lock.ready
                 && [...this.peers.values()].every((peer) => peer.leader?.name === name && peer.term === leader.term);
      return ok ? leader : undefined;
    };
    await waitFor(() => agreed() !== undefined, `every peer to follow ${expected ?? "one leader"}`, seconds);
    const leader = agreed()!;
    return { name: leader.me.name, term: leader.term };
  }

  /** Let the startup election settle, then run one from ora so the highest ID, alpha, leads; return its term. */
  async electAlpha(): Promise<number> {
    await this.waitForLeader();
    await this.get("ora").startElection(true);
    return (await this.waitForLeader("alpha")).term;
  }

  close(): void {
    for (const peer of this.peers.values()) {
      peer.halt();
    }
    rmSync(this.directory, { recursive: true, force: true });
  }
}

async function waitFor(predicate: () => boolean, what: string, seconds = 20): Promise<void> {
  const deadline = performance.now() + seconds * 1000;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      assert.fail(`Timed out waiting for ${what}`);
    }
    await sleep(20);
  }
}

function ref(id: number, name: string): PeerRef {
  return { id, name, host: "127.0.0.1", port: 1 };
}

describe("coordination", () => {
  let group: Group;

  beforeEach(() => { group = new Group(); });
  afterEach(() => group.close());

  test("messages carry Lamport timestamps and receivers move past them", async () => {
    const peer = await group.peer("alpha");
    const reply = await request(peer.address, message("ping", { lamport: 500 }));
    assert.equal(reply.type, "reply");
    assert.ok(peer.clock.time > 500, "receiver jumped past the sender's timestamp");
    assert.ok(reply.lamport! > 500, "reply is stamped after the receive event");
    const plain = await request(peer.address, message("ping"));
    assert.ok(plain.lamport! > reply.lamport!, "a message without a timestamp still advances the clock");
    const bad = await request(peer.address, message("ping", { lamport: -3 }));
    assert.equal(bad.type, "error");
  });

  test("ring election picks the highest ring id and replaces the sitting leader", async () => {
    await group.ring(["sierra", "ora", "xray", "alpha"]);
    const { term } = await group.waitForLeader();
    await group.get("ora").startElection(true);
    assert.ok((await group.waitForLeader("alpha")).term > term);
  });

  test("a joining peer learns the leader without a new election", async () => {
    await group.ring(["sierra", "ora", "xray"]);
    const { name, term } = await group.waitForLeader();
    await group.peer("alpha", "ora");  // Highest ID, but it joins under the sitting leader.
    await waitFor(() => group.get("alpha").leader?.name === name, "alpha to learn the leader");
    await sleep(300);
    assert.equal(group.get(name).term, term, "no election ran");
    assert.equal(group.get("alpha").leader?.name, name);
  });

  test("leader crash elects the highest surviving id", async () => {
    await group.ring();
    const term = await group.electAlpha();
    group.crash("alpha");
    assert.ok((await group.waitForLeader("xray")).term > term, "the new leader runs a newer term");
  });

  test("requests are ordered by Lamport time, then ring id", () => {
    const requests: LockRequest[] = [
      { peer: ref(5, "e"), requested_at: 7, resource: "minutes" }, { peer: ref(9, "i"), requested_at: 3, resource: "minutes" },
      { peer: ref(2, "b"), requested_at: 7, resource: "minutes" },
    ];
    assert.deepEqual(requests.sort(requestOrder).map((item) => item.peer.name), ["i", "b", "e"]);
  });

  test("without the lock, concurrent writers conflict", async () => {
    await group.ring();
    await Promise.all(NAMES.map((name) => group.get(name).appendMinutes(3, false)));
    const audit = auditMinutes(readMinutes(group.minutes));
    assert.equal(audit.entries, 12);
    assert.ok(audit.duplicates > 0, "writers reused entry numbers");
    assert.ok(audit.collisions > 0, "writers appended inside each other's read-modify-write");
  });

  test("the lock serializes concurrent writers in Lamport order", async () => {
    await group.ring();
    await group.electAlpha();
    const written = await Promise.all(NAMES.map((name) => group.get(name).appendMinutes(4)));
    assert.deepEqual(written.flat().sort((a, b) => a - b), Array.from({ length: 16 }, (_, i) => i + 1));
    assert.deepEqual(auditMinutes(readMinutes(group.minutes)), {
      entries: 16, duplicates: 0, collisions: 0, lamportOrdered: true,
    });
  });

  test("leader crash during contention keeps the minutes consistent", async () => {
    await group.ring();
    const term = await group.electAlpha();
    const writers = ["sierra", "ora", "xray"].map((name) => group.get(name).appendMinutes(6));
    await waitFor(() => readMinutes(group.minutes).length >= 4, "the first entries");
    group.crash("alpha");
    await Promise.all(writers);
    assert.ok((await group.waitForLeader("xray")).term > term);
    assert.deepEqual(auditMinutes(readMinutes(group.minutes)), {
      entries: 18, duplicates: 0, collisions: 0, lamportOrdered: true,
    });
  });

  test("a lock held when the leader crashes stays with its holder", async () => {
    await group.ring();
    await group.electAlpha();
    const sierra = group.get("sierra");
    const ora = group.get("ora");
    await sierra.acquire();
    group.crash("alpha");
    let oraHolds = false;
    const waiting = ora.acquire().then(() => { oraHolds = true; });
    await group.waitForLeader("xray");
    assert.equal(group.get("xray").onStatus().lock.grants.minutes.holder, "sierra", "recovery found the holder");
    await sleep(300);
    assert.equal(oraHolds, false, "the lock was not given out a second time");
    await sierra.release();
    await waiting;
    assert.equal(ora.lockState(), "held");
    await ora.release();
  });

  test("named locks are independent: holding presenter does not block minutes", async () => {
    await group.ring();
    await group.electAlpha();
    await group.get("sierra").acquire("presenter");
    const written = await group.get("ora").appendMinutes(2);
    assert.deepEqual(written, [1, 2]);
    assert.equal(group.get("sierra").lockState("presenter"), "held");
    let xrayPresents = false;
    const waiting = group.get("xray").acquire("presenter").then(() => { xrayPresents = true; });
    await sleep(300);
    assert.equal(xrayPresents, false, "presenter has one holder at a time");
    await group.get("sierra").release("presenter");
    await waiting;
    assert.equal(group.get("xray").lockState("presenter"), "held");
  });

  test("the presenter keeps the slot across a leader crash, and a waiter keeps its place", async () => {
    await group.ring();
    await group.electAlpha();
    await group.get("sierra").acquire("presenter");
    let oraPresents = false;
    const waiting = group.get("ora").acquire("presenter").then(() => { oraPresents = true; });
    await waitFor(() => group.get("alpha").onStatus().lock.grants.presenter?.queue.length === 1, "ora to queue");
    group.crash("alpha");
    await group.waitForLeader("xray");
    const grants = group.get("xray").onStatus().lock.grants;
    assert.equal(grants.presenter.holder, "sierra");
    assert.deepEqual(grants.presenter.queue, ["ora"]);
    await sleep(300);
    assert.equal(oraPresents, false);
    await group.get("sierra").release("presenter");
    await waiting;
  });

  test("a crashed lock holder does not block the others", async () => {
    await group.ring();
    await group.electAlpha();
    await group.get("sierra").acquire();
    group.crash("sierra");
    const started = performance.now();
    await group.get("ora").acquire();
    assert.equal(group.get("ora").lockState(), "held");
    assert.ok(performance.now() - started < 10000);
    await group.get("ora").release();
  });

  test("a grant from a peer that is not the leader is refused", async () => {
    await group.ring();
    await group.electAlpha();
    const ora = group.get("ora");
    const fake = { leader: group.get("xray").me, term: ora.term, resource: "minutes" };
    await assert.rejects(rpc(ora.address, "lock_grant", fake), RemoteError);
    await assert.rejects(rpc(ora.address, "lock_grant", { leader: group.get("alpha").me, term: ora.term, resource: "minutes" }),
                         /Not waiting/);
    assert.equal(ora.lockState(), "idle");
  });
});
