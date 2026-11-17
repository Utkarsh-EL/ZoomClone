import assert from "node:assert/strict";
import { test } from "node:test";

import { LamportClock, MAX_MESSAGE_BYTES, marshal, message, unmarshal } from "../protocol.ts";

test("roundtrip unicode and newline", () => {
  const original = message("event", { sender: "bob", body: { content: "Hi 🌍\nNext line" } });
  assert.deepEqual(unmarshal(marshal(original)), original);
});

test("message is delimited", () => {
  const packed = marshal(message("request", { body: { operation: "meeting_info" } }));
  assert.equal(packed.filter((byte) => byte === 0x0a).length, 1);
  assert.equal(packed.at(-1), 0x0a);
});

test("malformed data rejected", () => {
  const bad = [
    Buffer.from("no newline"), Buffer.from("{bad}\n"), Buffer.from("[]\n"), Buffer.from("{}\n"),
    Buffer.from([0xff, 0x0a]), Buffer.from(`{"type":"x"}${"x".repeat(MAX_MESSAGE_BYTES)}\n`),
  ];
  for (const raw of bad) {
    assert.throws(() => unmarshal(raw), Error, `accepted ${JSON.stringify(raw.subarray(0, 10).toString())}`);
  }
});

test("oversize outgoing rejected", () => {
  assert.throws(() => marshal(message("publish", { body: { content: "x".repeat(MAX_MESSAGE_BYTES) } })), /size limit/);
});

test("lamport clock ticks on local events and jumps past received timestamps", () => {
  const clock = new LamportClock();
  assert.equal(clock.tick(), 1);
  assert.equal(clock.tick(), 2);
  assert.equal(clock.receive(10), 11);  // max(2, 10) + 1
  assert.equal(clock.receive(4), 12);   // An older timestamp still counts as an event.
  assert.equal(clock.receive(undefined), 13);
  for (const bad of [-1, 1.5, "7", null, Number.MAX_VALUE]) {
    assert.throws(() => clock.receive(bad), /Invalid Lamport/, String(bad));
  }
  assert.equal(clock.time, 13);
});
