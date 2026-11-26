import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { UUID_PATTERN } from "../coordination/wire.ts";
import { validateOperation, type Operation } from "../storage/engine.ts";
import type { MeetingCommand, MeetingEvent, Outcome, ParticipantCredential, Replay } from "../storage/types.ts";
import type { ReplayCursor, SessionTarget } from "./types.ts";
import { validReplay } from "./replay-validation.ts";

interface Identity extends SessionTarget, ParticipantCredential { version: 1 }
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) < Number.MAX_SAFE_INTEGER - 4;
export function validOutcome(value: unknown): value is Outcome {
  const v = value as Outcome | null;
  return !!v && typeof v.code === "string" && /^[A-Z_]{1,64}$/.test(v.code) && integer(v.seq)
    && integer(v.generation) && v.generation > 0 && integer(v.grantVersion);
}

/** One private local database per participant/meeting. FULL commits precede all
 * sends. No route, readiness decision or authority is persisted here. */
export class SessionJournal {
  private readonly db: DatabaseSync;
  private readonly identity: Identity;
  private constructor(db: DatabaseSync, identity: Identity) { this.db = db; this.identity = identity; }

  static open(path: string, target: SessionTarget): SessionJournal {
    if (typeof path !== "string" || !path || path === ":memory:" || path.startsWith("file:")) throw new Error("DURABLE_SESSION_PATH");
    if (![target.clusterId, target.meetingId].every(id => typeof id === "string" && UUID_PATTERN.test(id))) throw new Error("SESSION_TARGET");
    validateOperation({ type: "join", name: target.name });
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Pre-create the file privately before SQLite creates its journal beside it.
    closeSync(openSync(path, "a", 0o600)); chmodSync(path, 0o600);
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA busy_timeout=2000; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE");
      db.exec(`CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS commands(ordinal INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL,command TEXT NOT NULL,outcome TEXT) STRICT;
        CREATE TABLE IF NOT EXISTS inbox(seq INTEGER PRIMARY KEY,event TEXT NOT NULL) STRICT;`);
      const raw = db.prepare("SELECT value FROM metadata WHERE key='identity'").get();
      let identity: Identity;
      if (raw) {
        identity = JSON.parse(raw.value as string);
        if (identity.version !== 1 || identity.clusterId !== target.clusterId || identity.meetingId !== target.meetingId || identity.name !== target.name
          || !UUID_PATTERN.test(identity.participantId) || !/^[a-f0-9]{64}$/.test(identity.secret)) throw new Error("SESSION_TARGET");
      } else {
        // A partially missing journal must not silently become a new identity.
        if (db.prepare("SELECT key FROM metadata LIMIT 1").get() || db.prepare("SELECT id FROM commands LIMIT 1").get()
          || db.prepare("SELECT seq FROM inbox LIMIT 1").get()) throw new Error("SESSION_CORRUPT");
        identity = { version: 1, ...target, participantId: randomUUID(), secret: randomBytes(32).toString("hex") };
        db.prepare("INSERT INTO metadata VALUES('identity',?)").run(JSON.stringify(identity));
        db.prepare("INSERT INTO metadata VALUES('clock','0'),('cursor','0')").run();
        const journal = new SessionJournal(db, identity);
        journal.append({ type: "join", name: identity.name });
      }
      db.exec("COMMIT");
      return new SessionJournal(db, identity);
    } catch (error) { try { db.exec("ROLLBACK"); } catch {} db.close(); throw error; }
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private number(key: string): number {
    const row = this.db.prepare("SELECT value FROM metadata WHERE key=?").get(key);
    if (!row || !integer(Number(row.value))) throw new Error("SESSION_CORRUPT");
    return Number(row.value);
  }
  private setNumber(key: string, value: number): void {
    this.db.prepare("UPDATE metadata SET value=? WHERE key=?").run(String(value), key);
  }
  get target(): SessionTarget { const { clusterId, meetingId, name } = this.identity; return { clusterId, meetingId, name }; }
  credential(): ParticipantCredential { return { participantId: this.identity.participantId, secret: this.identity.secret }; }
  private append(operation: Operation): string {
    if ((this.db.prepare("SELECT count(*) AS n FROM commands WHERE outcome IS NULL").get()!.n as number) >= 128) throw new Error("PENDING_LIMIT");
    const lamport = this.number("clock") + 1;
    if (!integer(lamport)) throw new Error("CLOCK_EXHAUSTED");
    const command: MeetingCommand = { ...this.credential(), id: randomUUID(), lamport, operation };
    this.db.prepare("INSERT INTO commands(id,command) VALUES(?,?)").run(command.id, JSON.stringify(command));
    this.setNumber("clock", lamport);
    return command.id;
  }
  enqueue(input: Operation): string {
    const operation = structuredClone(input); validateOperation(operation);
    return this.transaction(() => {
      if (this.left) throw new Error("SESSION_LEFT");
      if (this.pending().some(command => command.operation.type === "leave")) throw new Error("SESSION_LEAVING");
      return this.append(operation);
    });
  }
  pending(): MeetingCommand[] {
    return this.db.prepare("SELECT command FROM commands WHERE outcome IS NULL ORDER BY ordinal LIMIT 128").all().map(row => JSON.parse(row.command as string));
  }
  complete(id: string, outcome: Outcome): void {
    if (!validOutcome(outcome)) throw new Error("INVALID_OUTCOME");
    this.transaction(() => {
      const row = this.db.prepare("SELECT outcome FROM commands WHERE id=?").get(id);
      if (!row) throw new Error("UNKNOWN_COMMAND");
      if (row.outcome && row.outcome !== JSON.stringify(outcome)) throw new Error("OUTCOME_CONFLICT");
      this.db.prepare("UPDATE commands SET outcome=? WHERE id=?").run(JSON.stringify(outcome), id);
    });
  }
  get left(): boolean {
    const last = this.db.prepare("SELECT command,outcome FROM commands WHERE outcome IS NOT NULL ORDER BY ordinal DESC LIMIT 1").get();
    return !!last && JSON.parse(last.command as string).operation.type === "leave" && JSON.parse(last.outcome as string).code === "OK";
  }
  cursor(): ReplayCursor { return { meetingId: this.identity.meetingId, subscriptionRevision: 0, seq: this.number("cursor") }; }

  recordReplay(after: ReplayCursor, page: Replay): void {
    // Revision zero is deliberately unfiltered. Future topics need a new
    // committed-order eligibility protocol, never a silently reused cursor.
    this.transaction(() => {
      const seq = this.number("cursor");
      if (!validReplay(page) || after.meetingId !== this.identity.meetingId || after.subscriptionRevision !== 0 || after.seq !== seq
        || page.meetingId !== after.meetingId || !integer(page.watermark) || !integer(page.scannedWatermark)
        || page.scannedWatermark < seq || page.scannedWatermark > page.watermark || page.phase !== "ACTIVE"
        || !Array.isArray(page.events) || page.events.length > 200 || page.events.length !== page.scannedWatermark - seq
        || !page.state || !page.state.members) throw new Error("INVALID_CURSOR");
      let clock = this.number("clock");
      for (let i = 0; i < page.events.length; i++) {
        const event = page.events[i];
        if (!event || event.seq !== seq + i + 1 || !integer(event.lamport) || event.lamport < 1
          || !integer(event.generation) || event.generation < 1 || typeof event.kind !== "string" || !event.payload || typeof event.payload !== "object") throw new Error("INVALID_CURSOR");
        this.db.prepare("INSERT INTO inbox VALUES(?,?)").run(event.seq, JSON.stringify(event));
        clock = Math.max(clock, event.lamport);
      }
      const prior = this.db.prepare("SELECT value FROM metadata WHERE key='observation'").get();
      if (prior && page.watermark < JSON.parse(prior.value as string).watermark) throw new Error("INVALID_CURSOR");
      const { events: _, scannedWatermark: __, ...observation } = page;
      this.db.prepare("INSERT INTO metadata VALUES('observation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(observation));
      this.setNumber("cursor", page.scannedWatermark); this.setNumber("clock", clock);
    });
  }
  view(after = 0, limit = 200) {
    if (!integer(after) || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("INVALID_CURSOR");
    const observed = this.db.prepare("SELECT value FROM metadata WHERE key='observation'").get();
    return { ...this.target, participantId: this.identity.participantId, cursor: this.cursor(), left: this.left,
      observation: observed ? JSON.parse(observed.value as string) : null,
      events: this.db.prepare("SELECT event FROM inbox WHERE seq>? ORDER BY seq LIMIT ?").all(after, limit).map(row => JSON.parse(row.event as string) as MeetingEvent),
      commands: this.db.prepare("SELECT id,command,outcome FROM commands ORDER BY ordinal DESC LIMIT 128").all().reverse().map(row => ({
        id: row.id as string, operation: JSON.parse(row.command as string).operation as Operation,
        outcome: row.outcome ? JSON.parse(row.outcome as string) as Outcome : null,
      })),
    };
  }
  close(): void { this.db.close(); }
}
