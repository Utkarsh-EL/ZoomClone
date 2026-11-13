import assert from "node:assert/strict";
import { createConnection, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, test } from "node:test";

import { Participant } from "../client.ts";
import {
  MAX_HOPS, Peer, RemoteError, discover, inHalfOpen, inOpen, parseAddress, ringId, rpc, type Address, type PeerRef,
} from "../peer.ts";
import { FrameReader, MAX_MESSAGE_BYTES, NetworkError } from "../protocol.ts";

const NAMES = ["alpha", "sierra", "ora", "xray"];
const MEETING = "demo-room";

describe("ring math", () => {
  test("open interval wraps around zero", () => {
    assert.equal(inOpen(5, 1, 9), true);
    assert.equal(inOpen(1, 1, 9), false);
    assert.equal(inOpen(9, 1, 9), false);
    assert.equal(inOpen(65000, 60000, 10), true);
    assert.equal(inOpen(3, 60000, 10), true);
    assert.equal(inOpen(30000, 60000, 10), false);
  });

  test("half open interval includes its right end only", () => {
    assert.equal(inHalfOpen(9, 1, 9), true);
    assert.equal(inHalfOpen(1, 1, 9), false);
    assert.equal(inHalfOpen(10, 60000, 10), true);
    assert.equal(inHalfOpen(60000, 60000, 10), false);
  });

  test("equal ends span the whole ring", () => {
    assert.equal(inHalfOpen(7, 7, 7), true);
    assert.equal(inHalfOpen(8, 7, 7), true);
    assert.equal(inOpen(7, 7, 7), false);
    assert.equal(inOpen(8, 7, 7), true);
  });

  test("ring id is stable and in range", () => {
    assert.equal(ringId(MEETING), ringId(MEETING));
    assert.ok(ringId(MEETING) >= 0 && ringId(MEETING) < 2 ** 16);
    // The positions the README's ring diagram shows.
    assert.deepEqual(["alpha", "sierra", "ora", "xray", "echo", MEETING].map(ringId),
                     [52303, 13800, 811, 40128, 27791, 23745]);
  });

  test("parse address", () => {
    assert.deepEqual(parseAddress("127.0.0.1:7001"), ["127.0.0.1", 7001]);
    for (const bad of ["nohost", ":7001", "host:", "host:port", "host:70000"]) {
      assert.throws(() => parseAddress(bad), Error, bad);
    }
  });
});

/** Peers started by one test, by name, with the helpers every overlay test shares. */
class Overlay {
  peers = new Map<string, Peer>();

  get(name: string): Peer {
    const peer = this.peers.get(name);
    assert.ok(peer, `no peer named ${name}`);
    return peer;
  }

  /** Remove a peer from the live set and return it. */
  take(name: string): Peer {
    const peer = this.get(name);
    this.peers.delete(name);
    return peer;
  }

  async peer(name: string, bootstrap?: string, recordTtl = 60.0): Promise<Peer> {
    const peer = new Peer(name, { interval: 0.03, recordTtl });
    await peer.start(bootstrap ? this.get(bootstrap).address : null);
    this.peers.set(name, peer);
    return peer;
  }

  async ring(names = NAMES, recordTtl = 60.0): Promise<string[]> {
    await this.peer(names[0], undefined, recordTtl);
    for (const name of names.slice(1)) {
      await this.peer(name, names[0], recordTtl);
    }
    return this.waitForRing();
  }

  order(): string[] {
    return [...this.peers.keys()].sort((a, b) => this.get(a).me.id - this.get(b).me.id);
  }

  /** Wait until the live peers' pointers form one ring ordered by ID. */
  async waitForRing(): Promise<string[]> {
    const deadline = performance.now() + 15000;
    for (;;) {
      const order = this.order();
      if (order.every((name, i) => this.get(name).successors[0].name === order[(i + 1) % order.length]
                                   && this.get(name).predecessor?.name === order.at(i - 1))) {
        return order;
      }
      if (performance.now() >= deadline) {
        assert.fail(`Ring did not stabilize; expected order ${order}`);
      }
      await sleep(10);
    }
  }

  async waitFor(predicate: () => boolean | Promise<boolean>, what: string, seconds = 15): Promise<void> {
    const deadline = performance.now() + seconds * 1000;
    while (!(await predicate())) {
      if (performance.now() >= deadline) {
        assert.fail(`Timed out waiting for ${what}`);
      }
      await sleep(20);
    }
  }

  ownerOf(name: string): string {
    const key = ringId(name);
    const order = this.order();
    return order.find((peer) => this.get(peer).me.id >= key) ?? order[0];
  }

  /** Return a peer name whose ID takes over a key from the current ring. */
  nameCapturing(key: number): string {
    const owner = this.get(this.ownerOf(MEETING)).me.id;
    for (let i = 0; ; i++) {
      if (inOpen(ringId(`candidate${i}`), key - 1, owner)) {
        return `candidate${i}`;
      }
    }
  }

  crashAll(): void {
    for (const peer of this.peers.values()) {
      peer.halt();
    }
  }
}

function listen(server: Server): Promise<Address> {
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(["127.0.0.1", (server.address() as AddressInfo).port])));
}

describe("overlay", () => {
  let net: Overlay;

  beforeEach(() => { net = new Overlay(); });
  afterEach(() => net.crashAll());

  test("lone peer owns everything", async () => {
    const peer = await net.peer("alpha");
    const answer = await peer.lookup("nothing-here");
    assert.deepEqual([answer.owner, answer.found, answer.path], ["alpha", false, ["alpha"]]);
    await peer.publish("thing", { where: "here" });
    assert.deepEqual((await peer.lookup("thing")).value, { where: "here" });
  });

  test("four peers form one ordered ring", async () => {
    const order = await net.ring();
    assert.equal(order.length, 4);
    const ids = order.map((name) => net.get(name).me.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
    for (const [index, name] of order.entries()) {
      const expected = [1, 2, 3].map((step) => order[(index + step) % 4]);
      await net.waitFor(() => JSON.stringify(net.get(name).successors.map((ref) => ref.name)) === JSON.stringify(expected),
                        `${name}'s successor list`);
    }
  });

  test("lookup is routed hop by hop to the owner", async () => {
    const order = await net.ring();
    await net.get(order[0]).publish(MEETING, { host: "h", port: 1 });
    const owner = net.ownerOf(MEETING);
    const origin = order[(order.indexOf(owner) + 1) % 4];
    const answer = await net.get(origin).lookup(MEETING);
    const walk = [0, 1, 2, 3].map((step) => order[(order.indexOf(origin) + step) % 4]);
    assert.deepEqual(answer.path, walk);
    assert.equal(answer.owner, owner);
    assert.equal(answer.found, true);
  });

  test("every peer resolves a meeting and clients can use it", async () => {
    const order = await net.ring();
    const provider = net.get(order[0]);
    const hosted = await provider.hostMeeting(MEETING);
    const users: Participant[] = [];
    try {
      for (const [index, name] of order.entries()) {
        assert.deepEqual(await discover(MEETING, net.get(name).address), [hosted.host, hosted.port]);
        const user = new Participant(`user${index}`, { meeting: MEETING, host: hosted.host, port: hosted.port });
        users.push(user);
        await user.connect();
      }
      assert.equal((await users[0].request("meeting_info")).participant_count, 4);
      assert.equal((await users[0].groupSend("found through the ring")).group_deliveries, 4);
      await assert.rejects(discover("no-such-meeting", provider.address), /No peer knows/);
    } finally {
      for (const user of users) {
        user.close();
      }
    }
  });

  test("second host for a meeting is refused", async () => {
    const order = await net.ring();
    await net.get(order[0]).hostMeeting(MEETING);
    await assert.rejects(net.get(order[1]).hostMeeting(MEETING), /already hosted/);
  });

  test("joining peer receives the keys it now owns", async () => {
    const order = await net.ring();
    const previousOwner = net.ownerOf(MEETING);
    await net.get(order[0]).publish(MEETING, { host: "h", port: 1 });
    const name = net.nameCapturing(ringId(MEETING));
    const joiner = await net.peer(name, order[0]);
    await net.waitForRing();
    assert.equal(net.ownerOf(MEETING), name);
    await net.waitFor(() => joiner.records.has(MEETING), "the key to move to the joining peer");
    assert.equal(net.get(previousOwner).records.has(MEETING), false);
    assert.equal((await net.get(order[0]).lookup(MEETING)).owner, name);
  });

  test("graceful leave hands off keys and relinks neighbors", async () => {
    const order = await net.ring();
    const owner = net.ownerOf(MEETING);
    const provider = order.find((name) => name !== owner)!;
    // The record TTL is far above the test's run time, so only the handoff can move the key.
    await net.get(provider).publish(MEETING, { host: "h", port: 1 });
    const heir = order[(order.indexOf(owner) + 1) % 4];
    const before = order.at(order.indexOf(owner) - 1)!;
    const leaver = net.take(owner);
    await leaver.leave();
    assert.equal(leaver.stopped, true);
    assert.equal(net.get(heir).records.has(MEETING), true);
    assert.equal(net.get(before).successors[0].name, heir);
    assert.equal(net.get(heir).predecessor?.name, before);
    await net.waitForRing();
    const answer = await net.get(provider).lookup(MEETING);
    assert.deepEqual([answer.owner, answer.found], [heir, true]);
    await leaver.leave();  // A second call is harmless.
  });

  test("provider leaving removes its record", async () => {
    const order = await net.ring();
    const owner = net.ownerOf(MEETING);
    const provider = order.find((name) => name !== owner)!;
    await net.get(provider).hostMeeting(MEETING);
    await net.take(provider).leave();
    await net.waitForRing();
    assert.equal((await net.get(owner).lookup(MEETING)).found, false);
  });

  test("last two peers can part", async () => {
    await net.ring(["alpha", "sierra"]);
    await net.take("alpha").leave();
    const survivor = net.get("sierra");
    assert.equal(survivor.successors[0].name, "sierra");
    assert.equal(survivor.predecessor, null);
  });

  test("crashed owner is routed around and provider reregisters", async () => {
    const order = await net.ring(NAMES, 0.6);
    const owner = net.ownerOf(MEETING);
    const heir = order[(order.indexOf(owner) + 1) % 4];
    const provider = order.find((name) => name !== owner && name !== heir)!;
    await net.get(provider).publish(MEETING, { host: "h", port: 1 });
    await net.waitFor(() => net.get(owner).records.has(MEETING), "the key to reach its owner");
    net.take(owner).halt();
    await net.waitForRing();
    await net.waitFor(() => net.get(heir).records.has(MEETING), "the provider to re-register");
    const answer = await net.get(provider).lookup(MEETING);
    assert.deepEqual([answer.owner, answer.found], [heir, true]);
  });

  test("ring survives two consecutive crashes", async () => {
    const order = await net.ring([...NAMES, "echo"]);
    net.take(order[1]).halt();
    net.take(order[2]).halt();
    assert.deepEqual(await net.waitForRing(), [order[0], ...order.slice(3)]);
  });

  test("lookup routes around a dead successor before repair", async () => {
    const order = await net.ring();
    const peer = net.get(order[0]);
    peer.stopping.abort();  // This peer's repair loop stays out of the way.
    net.take(order[1]).halt();
    const owner = net.ownerOf(MEETING);
    assert.equal((await peer.findOwner(ringId(MEETING))).owner.name, owner);
    assert.equal(peer.successors[0].name, order[2]);
  });

  test("lookup routes around a frozen successor", async () => {
    const order = await net.ring();
    const peer = net.get(order[0]);
    peer.stopping.abort();
    // A listener that accepts but never answers behaves like a hung process.
    const held: Socket[] = [];
    const frozen = createServer((socket) => { held.push(socket); });
    try {
      const [host, port] = await listen(frozen);
      const ref: PeerRef = { id: (peer.me.id + 1) % 2 ** 16, name: "frozen", host, port };
      peer.successors = [ref, ...peer.successors];
      const started = performance.now();
      const answer = await peer.findOwner(ringId(MEETING));
      assert.equal(answer.owner.name, net.ownerOf(MEETING));
      assert.equal(answer.path.includes("frozen"), false);
      assert.ok(performance.now() - started < 5000);
    } finally {
      frozen.close();
      for (const socket of held) {
        socket.destroy();
      }
    }
  });

  test("crashed peer can rejoin on its old address", async () => {
    const order = await net.ring();
    const name = order[1];
    const port = net.get(name).me.port;
    net.take(name).halt();
    // The rejoin starts at once, while the ring still lists the old instance.
    const peer = new Peer(name, { port, interval: 0.03 });
    const started = performance.now();
    await peer.start(net.get(order[0]).address);
    net.peers.set(name, peer);
    assert.ok(performance.now() - started < 5000);
    assert.deepEqual(await net.waitForRing(), order);
  });

  test("crashed provider record expires", async () => {
    const order = await net.ring(NAMES, 0.3);
    const owner = net.ownerOf(MEETING);
    const provider = order.find((name) => name !== owner)!;
    await net.get(provider).publish(MEETING, { host: "h", port: 1 });
    assert.equal((await net.get(owner).lookup(MEETING)).found, true);
    net.take(provider).halt();
    await net.waitFor(async () => !(await net.get(owner).lookup(MEETING)).found, "the record to expire");
    await net.waitFor(() => !net.get(owner).records.has(MEETING), "the expiry sweep");
  });
});

/** Send raw bytes to a peer and return the first line it answers with. */
async function rawLine(address: Address, raw: Buffer): Promise<string> {
  const socket = createConnection({ host: address[0], port: address[1] });
  try {
    const reader = new FrameReader(socket);
    socket.write(raw);
    return String(await reader.read());
  } finally {
    socket.destroy();
  }
}

describe("validation", () => {
  let net: Overlay;

  beforeEach(() => { net = new Overlay(); });
  afterEach(() => net.crashAll());

  test("taken ring id is refused", async () => {
    await net.peer("alpha");
    await assert.rejects(net.peer("alpha", "alpha"), /already taken/);
  });

  test("join through an unreachable peer fails", async () => {
    const probe = createServer();
    const address = await listen(probe);
    await new Promise((done) => probe.close(done));
    await assert.rejects(new Peer("alpha").start(address), NetworkError);
  });

  test("bad requests get errors and the peer keeps serving", async () => {
    const peer = await net.peer("alpha");
    const badRequests: [string, Record<string, unknown>][] = [
      ["no_such_kind", {}],
      ["lookup", { name: "bad name!" }],
      ["lookup", {}],
      ["notify", { peer: { id: "x" } }],
      ["store", { records: "nope" }],
      ["store", { records: [{ name: "a", value: 1, ttl: -1 }] }],
      ["find_owner", { key: 2 ** 16, path: [], ttl: 1 }],
      ["find_owner", { key: 1, path: Array(MAX_HOPS + 1).fill("x"), ttl: 1 }],
    ];
    for (const [kind, body] of badRequests) {
      await assert.rejects(rpc(peer.address, kind, body), RemoteError, `${kind} ${JSON.stringify(body)}`);
    }
    for (const raw of [Buffer.from("{not json}\n"), Buffer.from(`${"x".repeat(MAX_MESSAGE_BYTES + 10)}\n`)]) {
      assert.match(await rawLine(peer.address, raw), /"error"/);
    }
    assert.equal((await rpc(peer.address, "ping")).status, "ok");
  });

  test("routing stops at the hop limit", async () => {
    const order = await net.ring();
    const origin = net.get(order[0]);
    const key = net.get(order[2]).me.id;
    await assert.rejects(rpc(origin.address, "find_owner", { key, path: [], ttl: 0 }), /Hop limit/);
  });
});
