import assert from "node:assert/strict";
import { test } from "node:test";
import { runCoordinatorScenario } from "../scripts/coordinator-scenario.ts";

test("five helper processes retain metadata through leader crash, snapshot catch-up and quorum restoration", { timeout: 60000 }, async () => {
  const result = await runCoordinatorScenario();
  assert.notEqual(result.initialLeader, result.replacementLeader);
  assert.notEqual(result.initialIncarnation, result.restartedIncarnation);
  assert.equal(result.stableOutcome.code, "OK");
  assert.equal(result.assignmentGeneration, 1);
  assert.equal(result.snapshotInstalled, true);
  assert.equal(result.voters, 5);
  assert.equal(result.quorum, 3);
  assert.equal(result.minorityRejected, true);
  assert.equal(result.retainedAfterFullRestart, true);
});
