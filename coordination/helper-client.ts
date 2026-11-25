import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { ControlWire, MAX_ENVELOPE_BYTES, ProtocolError, UUID_PATTERN, boundedReply } from "./wire.ts";
export { ProtocolError } from "./wire.ts";

export type Operation = "status" | "read" | "apply" | "configuration" | "add-nonvoter" | "promote" | "remove" | "snapshot";

export interface MetadataCommand {
  id: string;
  kind: "reserve" | "register" | "assign" | "activation-intent" | "confirm-ready" | "renew";
  meetingId?: string;
  code?: string;
  runtimeId?: string;
  incarnation?: string;
  attemptId?: string;
  expectedGeneration?: number;
  expectedRevision?: number;
}

export interface ControlArguments {
  command?: MetadataCommand;
  nodeId?: string;
  address?: string;
  expectedIndex?: number;
}

/** Narrow control boundary, also implemented by provisioned leader routing. */
export interface HelperAccess {
  call<T = unknown>(operation: Operation, args?: ControlArguments): Promise<T>;
}

export interface CommandResult { code: string; id: string; index: number; generation?: number; revision?: number }
export interface Configuration { index: number; servers: { ID: string; Address: string; Suffrage: number }[]; voters: number; quorum: number }
export interface HelperStatus {
  term: string;
  id: string; incarnation: string; address: string; role: string;
  leaderId: string; leaderAddress: string; applied: number; commit: number;
  configuration: Configuration; observation: string;
}
export interface Assignment { runtimeId: string; incarnation: string; attemptId: string; phase: "CANDIDATE" | "INTENT" | "READY"; renewalRevision: number }
export interface MeetingMetadata { id: string; code: string; generation: number; assignment?: Assignment }
export interface MetadataState {
  version: number; cluster: string; highWater: number;
  meetings: Record<string, MeetingMetadata>;
  runtimes: Record<string, { id: string; incarnation: string; revision: number }>;
}

export class RemoteError extends Error {
  override name = "RemoteError";
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export class HelperUnavailableError extends Error {
  override name = "HelperUnavailableError";
}

export interface HelperClientOptions {
  clusterId: string;
  nodeId: string;
  incarnation?: string;
  helperId: string;
  address: string;
  token: string;
  timeoutMs?: number;
}

/** One caller incarnation/clock. Never retries or invents a fresh command ID. */
export class HelperClient {
  private readonly wire: ControlWire;
  private readonly url: string;
  private readonly options: Readonly<HelperClientOptions>;

  constructor(options: HelperClientOptions, wire?: ControlWire) {
    const url = new URL(`http://${options.address}/v1/control`);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!((isIP(host) === 4 && host.startsWith("127.")) || host === "::1") || !url.port || url.username || url.password || url.pathname !== "/v1/control" || url.search || url.hash) {
      throw new ProtocolError("Only literal loopback helper addresses are enabled");
    }
    if (Buffer.byteLength(options.token) < 32) throw new ProtocolError("Cluster token must contain at least 32 bytes");
    if (!UUID_PATTERN.test(options.helperId)) throw new ProtocolError("Helper UUID required");
    const timeout = options.timeoutMs ?? 4000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60000) throw new ProtocolError("Invalid helper timeout");
    this.options = Object.freeze({ ...options, timeoutMs: timeout });
    if (wire && (wire.identity.clusterId !== options.clusterId || wire.identity.nodeId !== options.nodeId)) throw new ProtocolError("Shared wire identity mismatch");
    this.wire = wire ?? new ControlWire({ clusterId: options.clusterId, nodeId: options.nodeId, incarnation: options.incarnation ?? randomUUID() });
    this.url = url.href;
  }

  get logicalTime(): number { return this.wire.logicalTime; }

  /** Switching destination keeps this caller's incarnation and logical clock. */
  forHelper(helperId: string, address: string): HelperClient {
    return new HelperClient({ ...this.options, helperId, address }, this.wire);
  }

  async call<T = unknown>(operation: Operation, args: ControlArguments = {}): Promise<T> {
    const packet = this.wire.request({ ...args, operation });
    const data = JSON.stringify(packet) + "\n";
    if (Buffer.byteLength(data) > MAX_ENVELOPE_BYTES) throw new ProtocolError("Helper request exceeds size bound");
    let response: Response;
    try {
      response = await fetch(this.url, { method: "POST", redirect: "error",
        headers: { Authorization: `Bearer ${this.options.token}`, "Content-Type": "application/json" },
        body: data, signal: AbortSignal.timeout(this.options.timeoutMs!),
      });
    } catch (error) {
      throw new HelperUnavailableError("Helper unavailable; command outcome may be unknown. Retry the same command ID and contents.", { cause: error });
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new RemoteError(`HTTP_${response.status}`, `Helper returned HTTP ${response.status}`);
    }
    const reply = this.wire.receive(await boundedReply(response), packet.requestId, this.options.helperId);
    if (reply.error) throw new RemoteError(reply.error.code, reply.error.message);
    return reply.body as T;
  }
}
