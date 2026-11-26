import { UUID_PATTERN, type Envelope, type Identity } from "../coordination/wire.ts";

/** Provisioned caller incarnations bound memory and prevent a returning process
 * from resetting another incarnation's replay fence. This is defense in depth;
 * fresh SQL authorization belongs to MediaRoom, never this effect executor. */
export class KernelFence {
  private readonly callers = new Map<string, number>();
  private readonly epoch: string;
  private readonly meetingId: string;
  constructor(options: { epoch: string; meetingId: string; callers: Pick<Identity, "nodeId" | "incarnation">[] }) {
    if (![options.epoch, options.meetingId].every(id => UUID_PATTERN.test(id)) || !options.callers.length || options.callers.length > 128
      || options.callers.some(c => ![c.nodeId, c.incarnation].every(id => UUID_PATTERN.test(id)))) throw new Error("INVALID_MEDIA_PROVISIONING");
    this.epoch = options.epoch; this.meetingId = options.meetingId;
    for (const c of options.callers) this.callers.set(`${c.nodeId}/${c.incarnation}`, 0);
  }
  accept(packet: Envelope): void {
    const key = `${packet.nodeId}/${packet.incarnation}`, previous = this.callers.get(key);
    if (previous === undefined) throw new Error("UNAUTHORIZED");
    const r = packet.body as Record<string, any>;
    if (!r || typeof r !== "object" || Array.isArray(r)) throw new Error("INVALID_MEDIA_ACTION");
    if (r.action !== "hello" && r.epoch !== this.epoch) throw new Error("SFU_RESTARTED");
    if (packet.lamport <= previous) throw new Error("STALE_MEDIA_CONTROL");
    this.callers.set(key, packet.lamport);
    if (r.action === "hello") return;
    if (!r.owner || r.owner.meetingId !== this.meetingId || r.owner.runtimeId !== packet.nodeId || r.owner.incarnation !== packet.incarnation
      || !Number.isSafeInteger(r.owner.generation) || r.owner.generation < 1 || !UUID_PATTERN.test(r.owner.attemptId)) throw new Error("FENCED");
  }
}
