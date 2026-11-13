/** Reusable TCP meeting participant, with asynchronous event reception. */

import { createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

import { discover, parseAddress } from "./peer.ts";
import {
  configureLogging, FrameReader, intOption, message, NetworkError, receive, send, usageError,
  type Body, type Logger, type Packet,
} from "./protocol.ts";

const CONNECT_TIMEOUT = 5;
const REPLY_TIMEOUT = 5;

export interface ParticipantOptions {
  meeting?: string;
  host?: string;
  port?: number;
  logger?: Logger;
  trace?: boolean;
}

/** Reject with `text` unless the promise settles within `seconds`. */
function withTimeout<T>(promise: Promise<T>, seconds: number, text: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(text)), seconds * 1000);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

export class Participant {
  name: string;
  meeting: string;
  host: string;
  port: number;
  log: Logger | undefined;
  trace: boolean;
  socket: Socket | null = null;
  reader: FrameReader | null = null;
  pending = new Map<string, (packet: Packet) => void>();
  inbox: Packet[] = [];
  closed = false;
  private arrival: (() => void) | null = null;

  constructor(name: string, options: ParticipantOptions = {}) {
    this.name = name;
    this.meeting = options.meeting ?? "demo-room";
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 5000;
    this.log = options.logger;
    this.trace = options.trace ?? false;
  }

  async connect(): Promise<Body> {
    const socket = createConnection({ host: this.host, port: this.port });
    const timer = setTimeout(() => socket.destroy(new Error(`Timed out connecting to ${this.host}:${this.port}`)),
                             CONNECT_TIMEOUT * 1000);
    socket.once("connect", () => clearTimeout(timer));
    this.socket = socket;
    this.reader = new FrameReader(socket);
    let answer: Packet | null;
    try {
      const join = message("join", { body: { username: this.name, meeting: this.meeting } });
      send(socket, join, this.log, this.trace);
      answer = await receive(this.reader, this.log, this.trace);
      if (answer === null || answer.type !== "reply" || answer.request_id !== join.id) {
        this.close();
        throw new NetworkError(`Join failed: ${JSON.stringify(answer)}`);
      }
    } finally {
      clearTimeout(timer);
    }
    void this.listen();
    return answer.body;
  }

  private async listen(): Promise<void> {
    try {
      while (!this.closed) {
        const packet = await receive(this.reader as FrameReader, this.log, this.trace);
        if (packet === null) {
          break;
        }
        const requestId = packet.request_id;
        if ((packet.type === "reply" || packet.type === "error") && requestId) {
          const waiter = this.pending.get(requestId);
          if (waiter !== undefined) {
            waiter(packet);
            continue;
          }
        }
        this.inbox.push(packet);
        const arrival = this.arrival;
        this.arrival = null;
        arrival?.();
        if (packet.type === "participant_left") {
          this.log?.info(`ANNOUNCEMENT meeting=${packet.meeting}: ${packet.body?.content}`);
        }
        if (packet.type === "event" || packet.type === "group_message") {
          this.log?.info(`DELIVERED ${packet.type} from=${packet.sender} meeting=${packet.meeting} `
                         + `body=${JSON.stringify(packet.body)}`);
        }
      }
    } catch (error) {
      this.log?.warning(`Receiver disconnected: ${(error as Error).message}`);
    } finally {
      this.closed = true;
    }
  }

  async call(kind: string, body: Body = {}): Promise<Body> {
    if (this.closed || this.socket === null) {
      throw new NetworkError("Participant is not connected");
    }
    const packet = message(kind, { body });
    const reply = new Promise<Packet>((resolve) => this.pending.set(packet.id, resolve));
    try {
      send(this.socket, packet, this.log, this.trace);
      const response = await withTimeout(reply, REPLY_TIMEOUT, `No reply to ${kind}`);
      if (response.type === "error") {
        throw new Error(response.body?.error ?? "Unknown error");
      }
      return response.body ?? {};
    } finally {
      this.pending.delete(packet.id);
    }
  }

  request(operation: string): Promise<Body> {
    return this.call("request", { operation });
  }

  subscribe(topic: string): Promise<Body> {
    return this.call("subscribe", { topic });
  }

  publish(topic: string, content: string): Promise<Body> {
    return this.call("publish", { topic, content });
  }

  groupSend(content: string): Promise<Body> {
    return this.call("group_send", { content });
  }

  /** Take the next asynchronous packet, waiting up to `timeout` seconds. */
  async nextPacket(timeout = 7): Promise<Packet> {
    if (!this.inbox.length) {
      await withTimeout(new Promise<void>((resolve) => { this.arrival = resolve; }), timeout, "No packet arrived");
    }
    return this.inbox.shift() as Packet;
  }

  /** Wait for an asynchronous event matching a predicate, discarding the ones before it. */
  async waitFor(predicate: (packet: Packet) => boolean, timeout = 7): Promise<Packet> {
    const deadline = performance.now() + timeout * 1000;
    for (;;) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw new Error("Expected event was not received");
      }
      const packet = await this.nextPacket(remaining / 1000);
      if (predicate(packet)) {
        return packet;
      }
    }
  }

  close(): void {
    this.closed = true;
    this.socket?.destroy();
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      name: { type: "string" },
      meeting: { type: "string", default: "demo-room" },
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "5000" },
      // HOST:PORT of any P2P peer; finds the meeting through the overlay and replaces --host and --port.
      via: { type: "string" },
      "log-dir": { type: "string", default: "logs" },
      "trace-marshalling": { type: "boolean", default: false },
    },
  });
  const name = values.name ?? usageError("the following argument is required: --name");
  const trace = values["trace-marshalling"];
  let host = values.host;
  let port = intOption("port", values.port);
  const log = configureLogging(name, values["log-dir"], trace);
  if (values.via) {
    let via;
    try {
      via = parseAddress(values.via);
    } catch (error) {
      usageError(`argument --via: ${(error as Error).message}`);
    }
    try {
      [host, port] = await discover(values.meeting, via);
    } catch (error) {
      console.error(`Could not discover ${values.meeting}: ${(error as Error).message}`);
      process.exit(1);
    }
    log.info(`DISCOVERED meeting=${values.meeting} via=${via[0]}:${via[1]} coordinator=${host}:${port}`);
  }
  const user = new Participant(name, { meeting: values.meeting, host, port, logger: log, trace });
  try {
    console.log("Joined:", await user.connect());
    console.log("Commands: members | info | subscribe TOPIC | publish TOPIC TEXT | say TEXT | quit");
    // Created after the join: stdin holds piped input until a reader attaches, so no line is lost meanwhile.
    const terminal = createInterface({ input: process.stdin, output: process.stdout, prompt: `${name}> ` });
    let open = true;
    terminal.on("close", () => { open = false; });
    terminal.on("SIGINT", () => terminal.close());
    const prompt = (): void => {
      if (open) {
        terminal.prompt();
      }
    };
    prompt();
    for await (const line of terminal) {
      const command = line.trim();
      if (command === "quit") {
        break;
      }
      if (command === "members") {
        console.log(await user.request("list_participants"));
      } else if (command === "info") {
        console.log(await user.request("meeting_info"));
      } else if (command.startsWith("subscribe ")) {
        console.log(await user.subscribe(command.slice("subscribe ".length).trim()));
      } else if (command.startsWith("publish ")) {
        const parts = command.match(/^publish\s+(\S+)\s+(.+)$/);
        console.log(parts ? await user.publish(parts[1], parts[2]) : "Usage: publish TOPIC TEXT");
      } else if (command.startsWith("say ")) {
        console.log(await user.groupSend(command.slice(4).trim()));
      } else if (command) {
        console.log("Unknown command; use members, info, subscribe, publish, say, quit");
      }
      prompt();
    }
    terminal.close();
  } finally {
    user.close();
  }
}

if (import.meta.main) {
  await main();
}
