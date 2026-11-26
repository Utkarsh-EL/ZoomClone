import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { UUID_PATTERN } from "../coordination/wire.ts";
import { validateOperation, type Operation } from "../storage/engine.ts";
import type { GroupCatalog, GroupReplay, MeetingCommand, MeetingEvent, Outcome, ParticipantCredential, Replay } from "../storage/types.ts";
import { groupUUID, validCatalog, validGroupReplay } from "./group-validation.ts";
import type { ReplayCursor, SessionTarget } from "./types.ts";
import { validReplay } from "./replay-validation.ts";

interface Identity extends SessionTarget, ParticipantCredential { version: 1 | 2 }
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) < Number.MAX_SAFE_INTEGER - 4;
export function validOutcome(value: unknown): value is Outcome {
  const v = value as Outcome | null;
  return !!v && typeof v.code === "string" && /^[A-Z_]{1,64}$/.test(v.code) && integer(v.seq)
    && integer(v.generation) && v.generation > 0 && integer(v.grantVersion)
    && (v.groupId === undefined ? v.groupSeq === undefined : groupUUID(v.groupId) && integer(v.groupSeq));
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
        if (![1, 2].includes(identity.version) || identity.clusterId !== target.clusterId || identity.meetingId !== target.meetingId || identity.name !== target.name
          || !UUID_PATTERN.test(identity.participantId) || !/^[a-f0-9]{64}$/.test(identity.secret)) throw new Error("SESSION_TARGET");
      } else {
        // A partially missing journal must not silently become a new identity.
        if (db.prepare("SELECT key FROM metadata LIMIT 1").get() || db.prepare("SELECT id FROM commands LIMIT 1").get()
          || db.prepare("SELECT seq FROM inbox LIMIT 1").get()) throw new Error("SESSION_CORRUPT");
        identity = { version: 2, ...target, participantId: randomUUID(), secret: randomBytes(32).toString("hex") };
        db.prepare("INSERT INTO metadata VALUES('identity',?)").run(JSON.stringify(identity));
        db.prepare("INSERT INTO metadata VALUES('clock','0'),('cursor','0')").run();
        const journal = new SessionJournal(db, identity);
        journal.append({ type: "join", name: identity.name });
      }
      // Identity v2 gates old binaries before they can enqueue/send or interpret
      // scoped data. DDL and version bump share this FULL SQLite transaction.
      db.exec(`CREATE TABLE IF NOT EXISTS group_catalog(group_id TEXT PRIMARY KEY,name TEXT NOT NULL,membership TEXT NOT NULL,invitation_id TEXT,seen INTEGER NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS group_progress(group_id TEXT PRIMARY KEY,seq INTEGER NOT NULL,watermark INTEGER NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS group_inbox(group_id TEXT NOT NULL,seq INTEGER NOT NULL,event TEXT NOT NULL,PRIMARY KEY(group_id,seq)) STRICT;
        INSERT OR IGNORE INTO metadata VALUES('catalog_after',''),('catalog_epoch','0'),('group_poll_after','');`);
      if (identity.version === 1) {
        identity = { ...identity, version: 2 };
        db.prepare("UPDATE metadata SET value=? WHERE key='identity'").run(JSON.stringify(identity));
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

  catalogAfter(): string { return this.db.prepare("SELECT value FROM metadata WHERE key='catalog_after'").get()!.value as string; }
  recordCatalog(after: string, page: GroupCatalog): void {
    this.transaction(() => {
      if (after !== this.catalogAfter() || !validCatalog(page, after)) throw new Error("INVALID_GROUP_CATALOG");
      const epoch = this.number("catalog_epoch") + (after === "" ? 1 : 0);
      if (!integer(epoch)) throw new Error("CLOCK_EXHAUSTED");
      this.setNumber("catalog_epoch", epoch);
      for (const g of page.groups) {
        this.db.prepare(`INSERT INTO group_catalog VALUES(?,?,?,?,?) ON CONFLICT(group_id) DO UPDATE SET
          name=excluded.name,membership=excluded.membership,invitation_id=excluded.invitation_id,seen=excluded.seen`).run(g.groupId, g.name, g.membership, g.invitationId ?? null, epoch);
        this.db.prepare("INSERT OR IGNORE INTO group_progress VALUES(?,0,0)").run(g.groupId);
      }
      if (page.nextAfter === null) this.db.prepare("UPDATE group_catalog SET membership='left',invitation_id=NULL WHERE seen<>?").run(epoch);
      this.db.prepare("UPDATE metadata SET value=? WHERE key='catalog_after'").run(page.nextAfter ?? "");
    });
  }
  nextGroup(): string | undefined {
    return this.transaction(() => {
      const after = this.db.prepare("SELECT value FROM metadata WHERE key='group_poll_after'").get()!.value as string;
      const row = this.db.prepare("SELECT group_id FROM group_catalog WHERE membership='member' ORDER BY group_id<=?,group_id LIMIT 1").get(after);
      if (!row) return undefined;
      this.db.prepare("UPDATE metadata SET value=? WHERE key='group_poll_after'").run(row.group_id as string);
      return row.group_id as string;
    });
  }
  groupCursor(groupId: string): number {
    const row = this.db.prepare("SELECT seq FROM group_progress WHERE group_id=?").get(groupId);
    if (!row || !integer(row.seq)) throw new Error("INVALID_GROUP_CURSOR"); return row.seq;
  }
  groupUnavailable(groupId: string): void { this.db.prepare("UPDATE group_catalog SET membership='left',invitation_id=NULL WHERE group_id=?").run(groupId); }
  recordGroupReplay(groupId: string, after: number, page: GroupReplay): void {
    this.transaction(() => {
      if (this.db.prepare("SELECT membership FROM group_catalog WHERE group_id=?").get(groupId)?.membership !== "member") throw new Error("GROUP_ACCESS_DENIED");
      const progress = this.db.prepare("SELECT seq,watermark FROM group_progress WHERE group_id=?").get(groupId);
      if (!progress || progress.seq !== after || !validGroupReplay(page, groupId, after) || page.watermark < (progress.watermark as number)) throw new Error("INVALID_GROUP_CURSOR");
      let clock = this.number("clock");
      for (const event of page.events) {
        this.db.prepare("INSERT INTO group_inbox VALUES(?,?,?)").run(groupId, event.seq, JSON.stringify(event)); clock = Math.max(clock, event.lamport);
      }
      this.db.prepare("UPDATE group_progress SET seq=?,watermark=? WHERE group_id=?").run(page.scannedWatermark, page.watermark, groupId);
      this.setNumber("clock", clock);
    });
  }
  groupsView(afterGroupId = "", limit = 16) {
    if ((afterGroupId !== "" && !groupUUID(afterGroupId)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 16) throw new Error("INVALID_GROUP_CURSOR");
    const rows = this.db.prepare("SELECT * FROM group_catalog WHERE group_id>? ORDER BY group_id LIMIT ?").all(afterGroupId, limit + 1);
    const groups = rows.slice(0, limit).map(r => ({ groupId: r.group_id as string, name: r.name as string, membership: r.membership as "member" | "invited" | "left",
      ...(r.invitation_id ? { invitationId: r.invitation_id as string } : {}) }));
    return { groups, nextAfter: rows.length > limit ? groups.at(-1)!.groupId : null };
  }
  groupView(groupId: string, after = 0, limit = 16) {
    if (!groupUUID(groupId) || !integer(after) || !Number.isSafeInteger(limit) || limit < 1 || limit > 16) throw new Error("INVALID_GROUP_CURSOR");
    const row = this.db.prepare("SELECT name,membership FROM group_catalog WHERE group_id=?").get(groupId);
    if (!row) throw new Error("GROUP_ACCESS_DENIED");
    return { groupId, name: row.name as string, membership: row.membership as "member" | "invited" | "left", cursor: this.groupCursor(groupId),
      events: this.db.prepare("SELECT event FROM group_inbox WHERE group_id=? AND seq>? ORDER BY seq LIMIT ?").all(groupId, after, limit).map(r => JSON.parse(r.event as string) as MeetingEvent) };
  }

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
