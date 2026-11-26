import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { prepareDemoJournal, verifyDemoJournal } from "../scripts/demo-journal.ts";
import { SessionJournal } from "../client/session-journal.ts";

test("expected demo journals are checked read-only; empty/replaced files cannot become a new identity", async () => {
  const root = await mkdtemp(join(process.cwd(), ".local", "demo-journal-test-")), path = join(root, "Alice.sqlite");
  const target = { clusterId: randomUUID(), meetingId: randomUUID(), name: "Alice" };
  const id = prepareDemoJournal(path, target, null), journal = SessionJournal.open(path, target);
  const command = journal.pending()[0]; journal.close();
  assert.equal(prepareDemoJournal(path, target, id), id);
  const restored = SessionJournal.open(path, target); assert.deepEqual(restored.pending(), [command]); restored.close();
  const bytes = await readFile(path);
  assert.throws(() => verifyDemoJournal(path, randomUUID()), /PARTICIPANT_JOURNAL/);
  assert.deepEqual(await readFile(path), bytes);
  await writeFile(path, "");
  assert.throws(() => prepareDemoJournal(path, target, id), /PARTICIPANT_JOURNAL/);
  assert.equal((await readFile(path)).length, 0);
});
