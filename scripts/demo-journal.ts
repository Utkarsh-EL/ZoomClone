import { DatabaseSync } from "node:sqlite";
import { SessionJournal } from "../client/session-journal.ts";
import type { SessionTarget } from "../client/types.ts";

export function verifyDemoJournal(path: string, expectedId: string): void {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const raw = db.prepare("SELECT value FROM metadata WHERE key='identity'").get();
    if (!raw || JSON.parse(raw.value as string).participantId !== expectedId) throw new Error("identity mismatch");
  } catch { throw new Error("PARTICIPANT_JOURNAL_MISSING_OR_DAMAGED_RESTORE_REQUIRED"); }
  finally { db?.close(); }
}
export function prepareDemoJournal(path: string, target: SessionTarget, expectedId: string | null): string {
  if (expectedId) verifyDemoJournal(path, expectedId);
  const journal = SessionJournal.open(path, target);
  try { return journal.credential().participantId; } finally { journal.close(); }
}
