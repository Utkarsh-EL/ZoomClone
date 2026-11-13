/** Wire protocol shared by every service: newline-delimited UTF-8 JSON over TCP. */

import { randomUUID } from "node:crypto";
import { mkdirSync, openSync, writeSync } from "node:fs";
import type { Socket } from "node:net";
import { join } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";

export const MAX_MESSAGE_BYTES = 65536;
const NEWLINE = 0x0a;
// Strict decoding rejects invalid UTF-8 instead of replacing it, and keeps a BOM so JSON.parse rejects it.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// Packet bodies arrive from the network, so every handler validates the fields it reads.
export type Body = Record<string, any>;

export interface Packet {
  type: string;
  id?: string;
  timestamp?: string;
  request_id?: string | null;
  sender?: string;
  meeting?: string;
  quiet?: boolean;
  body?: any;
  [field: string]: unknown;
}

/** A connection failed, timed out, or produced no usable reply. */
export class NetworkError extends Error {
  override name = "NetworkError";
}

export interface Logger {
  info(text: string): void;
  warning(text: string): void;
  error(text: string): void;
}

export const quietLogger: Logger = { info() {}, warning() {}, error() {} };

/** Return a UTC timestamp as an ISO 8601 string with an explicit offset. */
export function timestamp(): string {
  return new Date().toISOString().replace("Z", "+00:00");
}

/** Create a protocol message with a unique ID and creation timestamp. */
export function message(kind: string, fields: Omit<Packet, "type"> = {}): Packet & { id: string } {
  return { type: kind, id: randomUUID().replaceAll("-", ""), timestamp: timestamp(), ...fields };
}

/** Convert a packet to bytes. The LF byte frames each TCP message. */
export function marshal(packet: Packet): Buffer {
  if (typeof packet !== "object" || packet === null || Array.isArray(packet)) {
    throw new Error("Packet must be an object");
  }
  const encoded = Buffer.from(JSON.stringify(packet), "utf8");
  if (encoded.length > MAX_MESSAGE_BYTES - 1) {
    throw new Error("Message exceeds size limit");
  }
  return Buffer.concat([encoded, Buffer.from([NEWLINE])]);
}

/** Parse a complete line into a packet; reject invalid packets. */
export function unmarshal(raw: Buffer): Packet {
  if (!raw.length || raw.length > MAX_MESSAGE_BYTES || raw[raw.length - 1] !== NEWLINE) {
    throw new Error("Missing newline or invalid message length");
  }
  let packet: unknown;
  try {
    packet = JSON.parse(utf8.decode(raw.subarray(0, -1)));
  } catch {
    throw new Error("Invalid UTF-8 JSON");
  }
  if (typeof packet !== "object" || packet === null || Array.isArray(packet)
      || typeof (packet as Packet).type !== "string") {
    throw new Error("JSON must be an object with a string 'type'");
  }
  return packet as Packet;
}

/** Splits a socket's byte stream into frames, holding the socket paused while frames wait. */
export class FrameReader {
  private socket: Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private frames: Buffer[] = [];
  private ended = false;
  private failure: Error | null = null;
  private wake: (() => void) | null = null;

  constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
      let end: number;
      while ((end = this.buffer.indexOf(NEWLINE)) !== -1) {
        this.frames.push(this.buffer.subarray(0, end + 1));
        this.buffer = this.buffer.subarray(end + 1);
      }
      if (this.frames.length || this.buffer.length > MAX_MESSAGE_BYTES) {
        socket.pause();
      }
      this.notify();
    });
    socket.on("end", () => this.finish());
    socket.on("close", () => this.finish());
    socket.on("error", (error) => {
      this.failure = new NetworkError(error.message);
      this.notify();
    });
  }

  private finish(): void {
    this.ended = true;
    this.notify();
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  /** Return the next frame, an unframed remainder that fails parsing, or null on clean EOF. */
  async read(): Promise<Buffer | null> {
    for (;;) {
      const frame = this.frames.shift();
      if (frame) {
        if (!this.frames.length && this.buffer.length <= MAX_MESSAGE_BYTES) {
          this.socket.resume();
        }
        return frame;
      }
      if (this.buffer.length > MAX_MESSAGE_BYTES) {
        // A line this long can never be valid; hand back enough of it for unmarshal to reject.
        const oversized = this.buffer.subarray(0, MAX_MESSAGE_BYTES + 1);
        this.buffer = Buffer.alloc(0);
        return oversized;
      }
      if (this.failure) {
        throw this.failure;
      }
      if (this.ended) {
        const rest = this.buffer;
        this.buffer = Buffer.alloc(0);
        return rest.length ? rest : null;
      }
      await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
}

function describe(packet: Packet): string {
  return `type=${packet.type} id=${packet.id ?? "None"} request_id=${packet.request_id ?? "None"}`;
}

/** Write one complete framed packet. */
export function send(socket: Socket, packet: Packet, logger?: Logger, trace = false): void {
  const raw = marshal(packet);
  if (trace && logger) {
    logger.info(`MARSHAL object=${JSON.stringify(packet)} -> wire_bytes=${JSON.stringify(raw.toString("utf8"))}`);
  }
  if (socket.destroyed || !socket.writable) {
    throw new NetworkError("Connection is closed");
  }
  socket.write(raw);
  logger?.info(`SEND ${describe(packet)}`);
}

/** Read one framed packet. Return null on clean EOF. */
export async function receive(reader: FrameReader, logger?: Logger, trace = false): Promise<Packet | null> {
  const raw = await reader.read();
  if (raw === null) {
    return null;
  }
  const packet = unmarshal(raw);
  if (trace && logger) {
    logger.info(`UNMARSHAL wire_bytes=${JSON.stringify(raw.toString("utf8"))} -> object=${JSON.stringify(packet)}`);
  }
  logger?.info(`RECEIVE ${describe(packet)}`);
  return packet;
}

/** Format the current UTC time as `YYYY-MM-DD HH:MM:SS,mmm`, the layout the evidence transcripts sort on. */
function logTime(): string {
  const iso = new Date().toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)},${iso.slice(20, 23)}`;
}

/** Print a command-line error and exit with status 2, as argparse does. */
export function usageError(text: string): never {
  console.error(`error: ${text}`);
  process.exit(2);
}

/** Parse command-line flags, turning an unknown or malformed flag into a usage error. */
export function parseCli<T extends ParseArgsConfig>(config: T): ReturnType<typeof parseArgs<T>>["values"] {
  try {
    return parseArgs(config).values;
  } catch (error) {
    usageError((error as Error).message);
  }
}

/** Read an integer command-line value, exiting when it is missing or malformed. */
export function intOption(flag: string, text: string | undefined): number {
  if (text === undefined) {
    usageError(`the following argument is required: --${flag}`);
  }
  if (!/^\d+$/.test(text)) {
    usageError(`argument --${flag}: invalid int value: '${text}'`);
  }
  return Number(text);
}

/** Log to a per-process file and the console with UTC timestamps. */
export function configureLogging(role: string, logDir: string, trace = false): Logger {
  mkdirSync(logDir, { recursive: true });
  const file = openSync(join(logDir, `${role}.log`), "a");
  const write = (level: string, text: string): void => {
    const line = `${logTime()}Z ${level} ${role} ${text}\n`;
    // Synchronous, so a process.exit right after a log call cannot drop the line from the file.
    writeSync(file, line);
    process.stdout.write(line);
  };
  const logger: Logger = {
    info: (text) => write("INFO", text),
    warning: (text) => write("WARNING", text),
    error: (text) => write("ERROR", text),
  };
  logger.info(`Logging started; trace_marshalling=${trace}`);
  return logger;
}
