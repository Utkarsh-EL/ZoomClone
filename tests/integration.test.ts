import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import { promisify } from "node:util";

import { Participant } from "../client.ts";
import { NetworkError, quietLogger } from "../protocol.ts";
import { MeetingServer, pair } from "../server.ts";

const ROOT = join(import.meta.dirname, "..");
const server = new MeetingServer(quietLogger);
let port = 0;
let participants: Participant[] = [];

before(async () => {
  port = (await server.listen("127.0.0.1", 0)).port;
});

after(() => server.close());

afterEach(() => {
  for (const user of participants) {
    user.close();
  }
  participants = [];
});

async function participant(name: string, meeting = "demo-room"): Promise<Participant> {
  const user = new Participant(name, { meeting, port });
  await user.connect();
  participants.push(user);
  return user;
}

test("request reply pubsub and group", async () => {
  const bob = await participant("bob");
  const charlie = await participant("charlie");
  const alice = await participant("alice");
  const outsider = await participant("dave", "other-room");
  assert.deepEqual((await alice.request("list_participants")).participants, ["alice", "bob", "charlie"]);
  assert.equal((await alice.request("meeting_info")).participant_count, 3);
  assert.deepEqual((await outsider.request("list_participants")).participants, ["dave"]);
  assert.equal((await bob.subscribe("meeting.announcements")).status, "subscribed");
  assert.equal((await charlie.subscribe("meeting.announcements")).status, "subscribed");
  const answer = await alice.publish("meeting.announcements", "Starting meeting");
  assert.equal(answer.subscriber_deliveries, 2);
  for (const receiver of [bob, charlie]) {
    const packet = await receiver.waitFor((p) => p.type === "event");
    assert.equal(packet.body.content, "Starting meeting");
    assert.equal(packet.sender, "alice");
  }
  assert.equal(outsider.inbox.length, 0);
  const groupAnswer = await alice.groupSend("Hello team");
  assert.equal(groupAnswer.group_deliveries, 3);  // Includes the sender.
  for (const receiver of [alice, bob, charlie]) {
    const packet = await receiver.waitFor((p) => p.type === "group_message");
    assert.equal(packet.body.content, "Hello team");
  }
  assert.equal(outsider.inbox.length, 0);
});

test("invalid command error", async () => {
  const user = await participant("invalid-test");
  await assert.rejects(user.request("no-such-operation"), /Unknown request operation/);
});

test("leave announced once to remaining meeting members", async () => {
  const alice = await participant("alice", "leave-room");
  const bob = await participant("bob", "leave-room");
  const leaver = await participant("charlie", "leave-room");
  const outsider = await participant("dave", "different-room");
  await leaver.subscribe("meeting.announcements");
  const session = server.members.get(pair("leave-room", "charlie"))!;

  leaver.close();

  // Neither remaining participant subscribed: departures are automatic.
  for (const observer of [alice, bob]) {
    const packet = await observer.nextPacket(3);
    assert.equal(packet.type, "participant_left");
    assert.equal(packet.sender, "server");
    assert.equal(packet.meeting, "leave-room");
    assert.deepEqual(packet.body, { username: "charlie", content: "charlie left the meeting." });
  }
  assert.deepEqual((await alice.request("list_participants")).participants, ["alice", "bob"]);
  assert.equal(server.subscriptions.has(pair("leave-room", "meeting.announcements")), false);

  // Cleanup can run through both a failed send and the handler's finally block.
  server.remove(session);
  for (const observer of [alice, bob, outsider]) {
    await assert.rejects(observer.nextPacket(0.1), /No packet arrived/);
  }
});

test("abrupt process exit announced", async () => {
  const alice = await participant("alice", "abrupt-room");
  const bob = await participant("bob", "abrupt-room");
  // process.exit skips Participant.close() and every pending cleanup.
  const script = `
    const { Participant } = await import("./client.ts");
    const user = new Participant("charlie", { meeting: "abrupt-room", port: ${port} });
    await user.connect();
    process.exit(0);
  `;
  // Asynchronous, because this process's event loop has to serve the child's join meanwhile.
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { cwd: ROOT, timeout: 10000 });
  for (const observer of [alice, bob]) {
    const packet = await observer.nextPacket(3);
    assert.equal(packet.type, "participant_left");
    assert.equal(packet.body.username, "charlie");
  }
  assert.deepEqual((await alice.request("list_participants")).participants, ["alice", "bob"]);
});

test("duplicate participant rejected", async () => {
  await participant("dupe-test");
  const second = new Participant("dupe-test", { port });
  await assert.rejects(second.connect(), NetworkError);
  second.close();
});
