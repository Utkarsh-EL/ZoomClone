import assert from "node:assert/strict";
import { test } from "node:test";
import { LamportClock } from "../coordination/logical-clock.ts";

test("lamport clock ticks on local events and jumps past received timestamps", () => {
  const clock = new LamportClock();
  assert.equal(clock.tick(), 1);
  assert.equal(clock.tick(), 2);
  assert.equal(clock.receive(10), 11);
  assert.equal(clock.receive(4), 12);
  assert.equal(clock.receive(undefined), 13);
  for (const bad of [-1, 1.5, "7", null, Number.MAX_VALUE]) {
    assert.throws(() => clock.receive(bad), /Invalid Lamport/, String(bad));
  }
  assert.equal(clock.time, 13);
});
