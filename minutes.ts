/** Shared meeting minutes: the resource that peers must not edit at the same time. */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

export const MINUTE_HOLD = 0.05;  // Seconds a writer spends composing an entry between reading and writing.

export interface MinuteEntry {
  n: number;        // Entry number: the writer's count of existing entries, plus one.
  peer: string;
  lamport: number;  // Writer's Lamport time when it entered the critical section.
  text: string;
}

export interface MinutesAudit {
  entries: number;
  duplicates: number;       // Entries that reused a number another writer had already taken.
  collisions: number;       // Entries another writer appended to between this writer's read and its write.
  lamportOrdered: boolean;  // Each entry's Lamport time is larger than the one written before it.
}

/** Read every complete entry, in the order they were written. */
export function readMinutes(path: string): MinuteEntry[] {
  if (!existsSync(path)) {
    return [];
  }
  const text = readFileSync(path, "utf8");
  // A line still being appended has no newline yet and is not an entry.
  return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * Add one entry with a read-modify-write: count the entries, compose, then append entry count + 1.
 * Two writers that interleave read the same count and both write the same number.
 */
export async function writeMinute(path: string, peer: string, lamport: number, text: string,
                                  hold = MINUTE_HOLD): Promise<MinuteEntry> {
  const n = readMinutes(path).length + 1;
  await sleep(hold * 1000);
  const entry: MinuteEntry = { n, peer, lamport, text };
  appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

/**
 * Check a minutes file for the effects of concurrent writers. An entry's number is the count its writer read, plus
 * one, so a number that differs from the entry's position means another append landed inside that read-modify-write.
 * This needs no clock: two processes' wall clocks can disagree by a millisecond or more.
 */
export function auditMinutes(entries: MinuteEntry[]): MinutesAudit {
  const numbers = new Set<number>();
  let duplicates = 0;
  for (const entry of entries) {
    if (numbers.has(entry.n)) {
      duplicates += 1;
    }
    numbers.add(entry.n);
  }
  return {
    entries: entries.length,
    duplicates,
    collisions: entries.filter((entry, i) => entry.n !== i + 1).length,
    lamportOrdered: entries.every((entry, i) => i === 0 || entry.lamport > entries[i - 1].lamport),
  };
}
