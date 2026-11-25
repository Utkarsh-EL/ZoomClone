import { createHash, timingSafeEqual } from "node:crypto";
import { type Pool, type PoolClient } from "pg";
import { UUID_PATTERN } from "../coordination/wire.ts";
import { Database, transaction } from "./database.ts";
import {
  emptyState,
  evaluate,
  validateOperation,
  type MeetingState,
} from "./engine.ts";
import {
  StoreError,
  type Authority,
  type MeetingCommand,
  type Owner,
  type Outcome,
  type Observation,
  type ParticipantCredential,
  type Replay,
} from "./types.ts";
export type {
  Authority,
  MeetingCommand,
  Owner,
  Outcome,
  Observation,
  ParticipantCredential,
  Replay,
} from "./types.ts";

interface FenceRow {
  meeting_id: string;
  code: string;
  generation: string;
  runtime_id: string | null;
  incarnation: string | null;
  attempt_id: string | null;
  phase: Observation["phase"];
  seq: string;
}

function uuid(id: string): void {
  if (typeof id !== "string" || !UUID_PATTERN.test(id))
    throw new StoreError("INVALID_ID");
}
function validOwner(owner: Owner, clusterId: string): void {
  for (const id of [
    owner.clusterId,
    owner.meetingId,
    owner.runtimeId,
    owner.incarnation,
    owner.attemptId,
  ])
    uuid(id);
  if (
    owner.clusterId !== clusterId ||
    !Number.isSafeInteger(owner.generation) ||
    owner.generation < 1
  )
    throw new StoreError("INVALID_OWNER");
}
function ready(authority: Authority): void {
  if (authority.ready() !== true) throw new StoreError("NOT_READY");
}
function same(row: FenceRow, owner: Owner): boolean {
  return (
    Number(row.generation) === owner.generation &&
    row.runtime_id === owner.runtimeId &&
    row.incarnation === owner.incarnation &&
    row.attempt_id === owner.attemptId
  );
}
function enabled(row: FenceRow, owner: Owner): void {
  if (row.phase === "CLOSED") throw new StoreError("CLOSED");
  if (!same(row, owner) || row.phase !== "ACTIVE")
    throw new StoreError("FENCED");
}
function verifier(credential: ParticipantCredential): string {
  uuid(credential.participantId);
  if (
    typeof credential.secret !== "string" ||
    !/^[a-f0-9]{64}$/.test(credential.secret)
  )
    throw new StoreError("AUTH_REQUIRED");
  return createHash("sha256").update(credential.secret).digest("hex");
}
function digest(command: MeetingCommand): string {
  const operation = Object.fromEntries(
    Object.entries(command.operation).sort(([a], [b]) => a.localeCompare(b)),
  );
  return createHash("sha256").update(JSON.stringify(operation)).digest("hex");
}

/** Trusted in-process storage boundary. Controller calls do not prove a Raft
 * assignment: the future recovery controller must authorize them first.
 * Domain methods use a restricted runtime pool; no network side effects occur
 * inside these transactions. A transport failure can leave the outcome unknown.
 */
export class MeetingStore {
  private readonly database: Database;
  private readonly runtime: Pool;
  constructor(database: Database, runtime: Pool) {
    this.database = database;
    this.runtime = runtime;
  }

  private async run<T>(
    pool: Pool,
    work: (client: PoolClient) => Promise<T>,
    readOnly = false,
  ): Promise<T> {
    return transaction(
      pool,
      async (client) => {
        const identity = await client.query(
          "SELECT cluster_id FROM zoom.cluster_identity",
        );
        if (
          identity.rowCount !== 1 ||
          identity.rows[0].cluster_id !== this.database.clusterId
        )
          throw new StoreError("CLUSTER_MISMATCH");
        return work(client);
      },
      readOnly,
    );
  }
  private async fence(
    client: PoolClient,
    meetingId: string,
    lock = false,
  ): Promise<FenceRow> {
    const result = await client.query<FenceRow>(
      "SELECT * FROM zoom.meeting_fences WHERE meeting_id=$1" +
        (lock ? " FOR UPDATE" : ""),
      [meetingId],
    );
    if (!result.rowCount) throw new StoreError("MISSING_MEETING");
    return result.rows[0];
  }
  private async state(
    client: PoolClient,
    meetingId: string,
  ): Promise<MeetingState> {
    const result = await client.query(
      "SELECT state FROM zoom.meeting_state WHERE meeting_id=$1",
      [meetingId],
    );
    if (!result.rowCount) throw new StoreError("MISSING_DURABLE_STATE");
    return result.rows[0].state;
  }
  private async authenticate(
    client: PoolClient,
    meetingId: string,
    credential: ParticipantCredential,
    allowNew = false,
  ): Promise<{ known: boolean; hash: string }> {
    const hash = verifier(credential);
    const result = await client.query(
      "SELECT verifier FROM zoom.participant_credentials WHERE meeting_id=$1 AND participant_id=$2",
      [meetingId, credential.participantId],
    );
    if (!result.rowCount) {
      if (!allowNew) throw new StoreError("AUTH_REQUIRED");
      return { known: false, hash };
    }
    if (
      !timingSafeEqual(
        Buffer.from(hash, "hex"),
        Buffer.from(result.rows[0].verifier, "hex"),
      )
    )
      throw new StoreError("AUTH_REQUIRED");
    return { known: true, hash };
  }

  async create(meetingId: string, code: string): Promise<void> {
    uuid(meetingId);
    if (typeof code !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(code))
      throw new StoreError("INVALID_CODE");
    await this.run(this.database.pool, async (client) => {
      const inserted = await client.query(
        "INSERT INTO zoom.meeting_fences(meeting_id,code) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [meetingId, code],
      );
      const fence = await this.fence(client, meetingId, true);
      if (fence.code !== code) throw new StoreError("MEETING_CONFLICT");
      if (inserted.rowCount)
        await client.query("INSERT INTO zoom.meeting_state VALUES($1,$2)", [
          meetingId,
          emptyState(),
        ]);
      else await this.state(client, meetingId); // Never heal missing state with an empty room.
    });
  }
  async install(owner: Owner): Promise<void> {
    await this.transition(owner, "RECOVERING");
  }
  async close(owner: Owner): Promise<void> {
    await this.transition(owner, "CLOSED");
  }
  private async transition(
    owner: Owner,
    phase: "RECOVERING" | "CLOSED",
  ): Promise<void> {
    owner = { ...owner };
    validOwner(owner, this.database.clusterId);
    await this.run(this.database.pool, async (client) => {
      const old = await this.fence(client, owner.meetingId, true);
      if (old.phase === "CLOSED") {
        if (phase === "CLOSED" && same(old, owner)) return;
        throw new StoreError("CLOSED");
      }
      if (
        Number(old.generation) === owner.generation &&
        same(old, owner) &&
        phase === "RECOVERING"
      )
        return;
      if (owner.generation <= Number(old.generation))
        throw new StoreError("FENCED");
      await client.query(
        "UPDATE zoom.meeting_fences SET generation=$2,runtime_id=$3,incarnation=$4,attempt_id=$5,phase=$6 WHERE meeting_id=$1",
        [
          owner.meetingId,
          owner.generation,
          owner.runtimeId,
          owner.incarnation,
          owner.attemptId,
          phase,
        ],
      );
    });
  }
  async activate(owner: Owner): Promise<void> {
    owner = { ...owner };
    validOwner(owner, this.database.clusterId);
    await this.run(this.database.pool, async (client) => {
      const fence = await this.fence(client, owner.meetingId, true);
      if (fence.phase === "CLOSED") throw new StoreError("CLOSED");
      if (
        !same(fence, owner) ||
        !["RECOVERING", "ACTIVE"].includes(fence.phase)
      )
        throw new StoreError("FENCED");
      await this.state(client, owner.meetingId);
      await client.query(
        "UPDATE zoom.meeting_fences SET phase='ACTIVE' WHERE meeting_id=$1",
        [owner.meetingId],
      );
    });
  }

  /** Candidate preparation uses one bounded consistent view. Durable outcomes,
   * events and media intentions stay in SQL and are read on demand after cutover. */
  async prepare(owner: Owner): Promise<Observation> {
    owner = { ...owner };
    validOwner(owner, this.database.clusterId);
    return this.run(this.runtime, async client => {
      const fence = await this.fence(client, owner.meetingId);
      if (!same(fence, owner) || !["RECOVERING", "ACTIVE"].includes(fence.phase)) throw new StoreError("FENCED");
      return this.observation(client, fence);
    }, true);
  }

  async execute(
    authority: Authority,
    command: MeetingCommand,
  ): Promise<Outcome> {
    const owner = { ...authority.owner };
    command = structuredClone(command);
    validOwner(owner, this.database.clusterId);
    uuid(command.id);
    verifier(command);
    validateOperation(command.operation);
    if (
      !Number.isSafeInteger(command.lamport) ||
      command.lamport <= 0 ||
      command.lamport >= Number.MAX_SAFE_INTEGER
    )
      throw new StoreError("INVALID_LAMPORT");
    ready(authority);
    return this.run(this.runtime, async (client) => {
      const fence = await this.fence(client, owner.meetingId, true);
      enabled(fence, owner);
      ready(authority);
      const credential = await this.authenticate(
        client,
        owner.meetingId,
        command,
        command.operation.type === "join",
      );
      const hash = digest(command);
      const prior = await client.query(
        "SELECT digest,outcome FROM zoom.command_outcomes WHERE meeting_id=$1 AND participant_id=$2 AND command_id=$3",
        [owner.meetingId, command.participantId, command.id],
      );
      if (prior.rowCount) {
        if (prior.rows[0].digest !== hash) throw new StoreError("ID_CONFLICT");
        ready(authority);
        return prior.rows[0].outcome;
      }
      const state = await this.state(client, owner.meetingId);
      const evaluated = evaluate(
        state,
        command.participantId,
        command.id,
        command.operation,
      );
      if (!credential.known)
        await client.query(
          "INSERT INTO zoom.participant_credentials VALUES($1,$2,$3)",
          [owner.meetingId, command.participantId, credential.hash],
        );
      let seq = Number(fence.seq);
      if (evaluated.event) {
        if (seq >= Number.MAX_SAFE_INTEGER - 1)
          throw new StoreError("SEQUENCE_EXHAUSTED");
        seq++;
        await client.query(
          "UPDATE zoom.meeting_fences SET seq=$2 WHERE meeting_id=$1",
          [owner.meetingId, seq],
        );
        await client.query(
          "UPDATE zoom.meeting_state SET state=$2 WHERE meeting_id=$1",
          [owner.meetingId, evaluated.state],
        );
        await client.query(
          "INSERT INTO zoom.events(meeting_id,seq,generation,participant_id,command_id,lamport,kind,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            owner.meetingId,
            seq,
            owner.generation,
            command.participantId,
            command.id,
            command.lamport,
            evaluated.event.kind,
            evaluated.event.payload,
          ],
        );
        if (evaluated.mediaChanged)
          await client.query(
            "INSERT INTO zoom.media_intentions VALUES($1,$2,$3,$4)",
            [
              owner.meetingId,
              seq,
              owner.generation,
              {
                holder: evaluated.state.holder,
                grantVersion: evaluated.state.grantVersion,
              },
            ],
          );
      }
      const outcome: Outcome = {
        code: evaluated.code,
        seq,
        generation: owner.generation,
        grantVersion: evaluated.state.grantVersion,
      };
      await client.query(
        "INSERT INTO zoom.command_outcomes VALUES($1,$2,$3,$4,$5)",
        [owner.meetingId, command.participantId, command.id, hash, outcome],
      );
      ready(authority);
      return outcome;
    });
  }

  private async observation(
    client: PoolClient,
    fence: FenceRow,
  ): Promise<Observation> {
    const state = await this.state(client, fence.meeting_id);
    return {
      meetingId: fence.meeting_id,
      code: fence.code,
      generation: Number(fence.generation),
      runtimeId: fence.runtime_id,
      incarnation: fence.incarnation,
      attemptId: fence.attempt_id,
      phase: fence.phase,
      watermark: Number(fence.seq),
      state,
      observedAt: new Date().toISOString(),
    };
  }
  /** Administrative observation; never grants permission to act on its owner. */
  async observe(meetingId: string): Promise<Observation> {
    uuid(meetingId);
    return this.run(
      this.database.pool,
      async (client) =>
        this.observation(client, await this.fence(client, meetingId)),
      true,
    );
  }
  async read(
    authority: Authority,
    participant: ParticipantCredential,
    after = 0,
    limit = 100,
  ): Promise<Replay> {
    const owner = { ...authority.owner };
    participant = { ...participant };
    validOwner(owner, this.database.clusterId);
    verifier(participant);
    ready(authority);
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200
    )
      throw new StoreError("INVALID_CURSOR");
    return this.run(
      this.runtime,
      async (client) => {
        const fence = await this.fence(client, owner.meetingId);
        enabled(fence, owner);
        ready(authority);
        await this.authenticate(client, owner.meetingId, participant);
        const observed = await this.observation(client, fence);
        if (!observed.state.members[participant.participantId]?.joined)
          throw new StoreError("NOT_MEMBER");
        if (after > observed.watermark) throw new StoreError("INVALID_CURSOR");
        const rows = await client.query(
          "SELECT seq,generation,lamport,kind,payload FROM zoom.events WHERE meeting_id=$1 AND seq>$2 AND seq<=$3 ORDER BY seq LIMIT $4",
          [owner.meetingId, after, observed.watermark, limit],
        );
        const events = rows.rows.map((row) => ({
          ...row,
          seq: Number(row.seq),
          generation: Number(row.generation),
          lamport: Number(row.lamport),
        }));
        ready(authority);
        return {
          ...observed,
          events,
          scannedWatermark:
            events.length === limit ? events.at(-1)!.seq : observed.watermark,
        };
      },
      true,
    );
  }
}
