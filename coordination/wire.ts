import { randomUUID } from "node:crypto";
import { LamportClock } from "../protocol.ts";

export const MAX_ENVELOPE_BYTES = 1024 * 1024;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface Identity {
  clusterId: string;
  nodeId: string;
  incarnation: string;
}

export interface Envelope extends Identity {
  version: 2;
  requestId: string;
  lamport: number;
  kind: string;
  body: unknown;
  error?: { code: string; message: string };
}

export class ProtocolError extends Error {
  override name = "ProtocolError";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ControlWire {
  private readonly clock = new LamportClock();
  readonly identity: Readonly<Identity>;

  constructor(identity: Identity) {
    if (![identity.clusterId, identity.nodeId, identity.incarnation].every((id) => UUID_PATTERN.test(id))) {
      throw new ProtocolError("UUID identities required");
    }
    this.identity = Object.freeze({ ...identity });
  }

  get logicalTime(): number { return this.clock.time; }

  request(body: unknown): Envelope {
    if (this.clock.time >= Number.MAX_SAFE_INTEGER - 1) throw new ProtocolError("Logical clock exhausted");
    return { version: 2, ...this.identity, requestId: randomUUID(), lamport: this.clock.tick(), kind: "control", body };
  }

  receive(value: unknown, requestId: string, helperId: string): Envelope {
    if (!record(value) || value.version !== 2 || value.clusterId !== this.identity.clusterId || value.nodeId !== helperId
      || typeof value.incarnation !== "string" || !UUID_PATTERN.test(value.incarnation)
      || value.requestId !== requestId || value.kind !== "control.reply" || !("body" in value)
      || !Number.isSafeInteger(value.lamport) || (value.lamport as number) <= 0 || (value.lamport as number) >= Number.MAX_SAFE_INTEGER - 2) {
      throw new ProtocolError("Invalid or uncorrelated helper reply");
    }
    if (value.error !== undefined && (!record(value.error) || typeof value.error.code !== "string" || typeof value.error.message !== "string")) {
      throw new ProtocolError("Invalid helper error");
    }
    this.clock.receive(value.lamport);
    return value as unknown as Envelope;
  }
}

export async function boundedReply(response: Response): Promise<unknown> {
  if (!response.body) throw new ProtocolError("Missing helper reply");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_ENVELOPE_BYTES) throw new ProtocolError("Helper reply exceeds size bound");
      chunks.push(Buffer.from(value));
    }
    const data = Buffer.concat(chunks);
    if (data.at(-1) !== 10 || data.indexOf(10) !== data.length - 1) throw new ProtocolError("Incomplete or multiple helper reply frames");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError("Invalid helper reply", { cause: error });
  } finally {
    reader.releaseLock();
  }
}
