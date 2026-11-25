import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { emptyState, evaluate } from "../storage/engine.ts";

test("screen handoff is FIFO, keeps cameras independent, and changes one grant version", () => {
  const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
  let state = emptyState();
  for (const [id, name] of [
    [a, "Alice"],
    [b, "Bob"],
    [c, "Charlie"],
  ])
    state = evaluate(state, id, randomUUID(), { type: "join", name }).state;
  const [ra, rb, rc] = [randomUUID(), randomUUID(), randomUUID()];
  state = evaluate(state, a, ra, { type: "request-share" }).state;
  state = evaluate(state, b, rb, { type: "request-share" }).state;
  state = evaluate(state, c, rc, { type: "request-share" }).state;
  assert.deepEqual(
    state.queue.map((r) => r.participantId),
    [b, c],
  );
  const before = structuredClone(state);
  const handoff = evaluate(state, a, randomUUID(), {
    type: "release-share",
    requestId: ra,
  });
  assert.equal(handoff.state.holder?.participantId, b);
  assert.equal(handoff.state.holder?.requestId, rb);
  assert.equal(handoff.state.grantVersion, 2);
  assert.equal(handoff.mediaChanged, true);
  assert.deepEqual(
    handoff.state.queue.map((r) => r.participantId),
    [c],
  );
  assert.deepEqual(state, before, "engine mutated input before SQL commitment");
  assert.equal(
    evaluate(handoff.state, a, randomUUID(), {
      type: "chat",
      content: "still here",
    }).code,
    "OK",
  );
});

test("cancel, leave and stale release cannot steal a later screen grant", () => {
  const [a, b] = [randomUUID(), randomUUID()];
  let state = evaluate(emptyState(), a, randomUUID(), {
    type: "join",
    name: "A",
  }).state;
  state = evaluate(state, b, randomUUID(), { type: "join", name: "B" }).state;
  const ra = randomUUID(),
    rb = randomUUID();
  state = evaluate(state, a, ra, { type: "request-share" }).state;
  state = evaluate(state, b, rb, { type: "request-share" }).state;
  const canceled = evaluate(state, b, randomUUID(), {
    type: "release-share",
    requestId: rb,
  });
  assert.equal(canceled.state.queue.length, 0);
  assert.equal(canceled.mediaChanged, false);
  const next = randomUUID();
  state = evaluate(canceled.state, b, next, { type: "request-share" }).state;
  state = evaluate(state, a, randomUUID(), { type: "leave" }).state;
  assert.equal(state.holder?.requestId, next);
  assert.equal(
    evaluate(state, b, randomUUID(), { type: "release-share", requestId: rb })
      .code,
    "STALE_REQUEST",
  );
  assert.equal(
    evaluate(state, a, randomUUID(), { type: "chat", content: "after leaving" })
      .code,
    "NOT_MEMBER",
  );
});

test("repeated joins/requests do not duplicate membership or the queue", () => {
  const a = randomUUID();
  let state = evaluate(emptyState(), a, randomUUID(), {
    type: "join",
    name: "A",
  }).state;
  const joined = evaluate(state, a, randomUUID(), { type: "join", name: "A" });
  assert.equal(joined.event, undefined);
  state = evaluate(state, a, randomUUID(), { type: "request-share" }).state;
  const again = evaluate(state, a, randomUUID(), { type: "request-share" });
  assert.equal(again.event, undefined);
  assert.equal(again.state.grantVersion, 1);
});

test("malformed/oversized commands cannot consume a domain event", () => {
  const a = randomUUID();
  const state = evaluate(emptyState(), a, randomUUID(), {
    type: "join",
    name: "A",
  }).state;
  for (const operation of [
    { type: "chat", content: "" },
    { type: "chat", content: "x".repeat(8193) },
    { type: "join", name: " " },
    { type: "release-share", requestId: "bad" },
    { type: "chat", content: "x", unexpected: true },
  ]) {
    assert.throws(
      () => evaluate(state, a, randomUUID(), operation as never),
      /invalid/i,
    );
  }
});

test("departed identities do not consume live capacity and returning members cannot bypass it", () => {
  let state = emptyState();
  const returning = randomUUID();
  state = evaluate(state, returning, randomUUID(), {
    type: "join",
    name: "Returning",
  }).state;
  state = evaluate(state, returning, randomUUID(), { type: "leave" }).state;
  for (let i = 0; i < 130; i++) {
    const id = randomUUID();
    const joined = evaluate(state, id, randomUUID(), {
      type: "join",
      name: `Turnover ${i}`,
    });
    assert.equal(joined.code, "OK", `departed identities blocked join ${i}`);
    state = evaluate(joined.state, id, randomUUID(), { type: "leave" }).state;
  }
  for (let i = 0; i < 128; i++) {
    const joined = evaluate(state, randomUUID(), randomUUID(), {
      type: "join",
      name: `Active ${i}`,
    });
    assert.equal(joined.code, "OK");
    state = joined.state;
  }
  assert.equal(
    evaluate(state, randomUUID(), randomUUID(), { type: "join", name: "Extra" })
      .code,
    "MEETING_FULL",
  );
  assert.equal(
    evaluate(state, returning, randomUUID(), {
      type: "join",
      name: "Returning",
    }).code,
    "MEETING_FULL",
  );
});
