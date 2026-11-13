/** TCP meeting coordinator, pub-sub broker, and group message distributor. */

import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { parseArgs } from "node:util";

import {
  configureLogging, FrameReader, intOption, message, NetworkError, receive, send,
  type Body, type Logger, type Packet,
} from "./protocol.ts";

export const IDENTIFIER_RE = /^[A-Za-z0-9_.-]{1,32}$/;
const MAX_CONTENT_CHARS = 4096;

/** Key a (meeting, name) pair in one map; identifiers never contain NUL, so keys sort like the pairs. */
export function pair(meeting: string, name: string): string {
  return `${meeting}\0${name}`;
}

function isObject(value: unknown): value is Body {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_RE.test(value);
}

function isContent(value: unknown): value is string {
  // Counts code points rather than UTF-16 units, so an emoji is one character.
  return typeof value === "string" && [...value].length <= MAX_CONTENT_CHARS;
}

export class MeetingServer {
  log: Logger;
  trace: boolean;
  members = new Map<string, Session>();          // pair(meeting, username) -> Session
  subscriptions = new Map<string, Set<string>>(); // pair(meeting, topic) -> member keys
  private server: Server;
  private sockets = new Set<Socket>();

  constructor(logger: Logger, trace = false) {
    this.log = logger;
    this.trace = trace;
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      void new Session(this, socket).handle();
    });
  }

  listen(host: string, port: number): Promise<AddressInfo> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen({ host, port, backlog: 64 }, () => {
        this.server.off("error", reject);
        this.server.on("error", (error) => this.log.warning(`Server error: ${error.message}`));
        resolve(this.address);
      });
    });
  }

  get address(): AddressInfo {
    return this.server.address() as AddressInfo;
  }

  /** Stop accepting and drop every open connection. */
  close(): void {
    this.server.close();
    for (const socket of this.sockets) {
      socket.destroy();
    }
  }

  join(session: Session, meeting: string, username: string): boolean {
    const key = pair(meeting, username);
    if (this.members.has(key)) {
      return false;
    }
    this.members.set(key, session);
    this.log.info(`JOIN meeting=${meeting} participant=${username}`);
    return true;
  }

  remove(session: Session): void {
    if (session.username === null || session.meeting === null) {
      return;
    }
    const { meeting, username } = session;
    const key = pair(meeting, username);
    if (this.members.get(key) !== session) {
      return;
    }
    this.members.delete(key);
    for (const [topic, listeners] of this.subscriptions) {
      listeners.delete(key);
      if (!listeners.size) {
        this.subscriptions.delete(topic);
      }
    }
    const targets = this.group(meeting);
    this.log.info(`LEAVE meeting=${meeting} participant=${username}`);
    const announcement = message("participant_left", {
      sender: "server", meeting, body: { username, content: `${username} left the meeting.` },
    });
    this.distribute(targets, announcement);
  }

  membersIn(meeting: string): string[] {
    return this.group(meeting).map((session) => session.username as string).sort();
  }

  subscribe(meeting: string, username: string, topic: string): void {
    const topicKey = pair(meeting, topic);
    const listeners = this.subscriptions.get(topicKey) ?? new Set<string>();
    listeners.add(pair(meeting, username));
    this.subscriptions.set(topicKey, listeners);
    this.log.info(`SUBSCRIBE meeting=${meeting} topic=${topic} participant=${username}`);
  }

  subscribers(meeting: string, topic: string): Session[] {
    const keys = [...(this.subscriptions.get(pair(meeting, topic)) ?? [])].sort();
    return keys.flatMap((key) => this.members.get(key) ?? []);
  }

  group(meeting: string): Session[] {
    return [...this.members.values()].filter((session) => session.meeting === meeting);
  }

  distribute(targets: Session[], packet: Packet): number {
    let delivered = 0;
    for (const session of targets) {
      try {
        session.sendPacket(packet);
        delivered += 1;
      } catch (error) {
        if (!(error instanceof NetworkError)) {
          throw error;
        }
        this.log.warning(`Delivery failed to ${session.username}`);
        session.closeConnection();
        this.remove(session);
      }
    }
    return delivered;
  }
}

/** One participant's connection to the coordinator. */
export class Session {
  server: MeetingServer;
  socket: Socket;
  reader: FrameReader;
  log: Logger;
  username: string | null = null;
  meeting: string | null = null;

  constructor(server: MeetingServer, socket: Socket) {
    this.server = server;
    this.socket = socket;
    this.reader = new FrameReader(socket);
    this.log = server.log;
  }

  sendPacket(packet: Packet): void {
    send(this.socket, packet, this.log, this.server.trace);
  }

  closeConnection(): void {
    this.socket.destroy();
  }

  reply(incoming: Packet, body: Body): void {
    this.sendPacket(message("reply", { request_id: incoming.id ?? null, body }));
  }

  error(incoming: Packet, reason: string): void {
    this.sendPacket(message("error", { request_id: incoming.id ?? null, body: { error: reason } }));
  }

  async handle(): Promise<void> {
    this.log.info(`CONNECTION remote=${this.socket.remoteAddress}:${this.socket.remotePort}`);
    try {
      for (;;) {
        let packet: Packet | null;
        try {
          packet = await receive(this.reader, this.log, this.server.trace);
        } catch (error) {
          if (error instanceof NetworkError) {
            throw error;
          }
          this.log.warning(`Invalid packet: ${(error as Error).message}`);
          this.sendPacket(message("error", { body: { error: (error as Error).message } }));
          break;
        }
        if (packet === null) {
          break;
        }
        if (this.username === null) {
          if (!this.join(packet)) {
            break;
          }
          continue;
        }
        this.dispatch(packet);
      }
    } catch (error) {
      this.log.warning(`Connection ended for ${this.username}: ${(error as Error).message}`);
    } finally {
      this.server.remove(this);
      this.closeConnection();
    }
  }

  /** Admit the first packet as a join; return false when the connection must close. */
  private join(packet: Packet): boolean {
    if (packet.type !== "join") {
      this.error(packet, "First packet must be join");
      return false;
    }
    const body = packet.body === undefined ? {} : packet.body;
    if (!isObject(body)) {
      this.error(packet, "Invalid join body");
      return false;
    }
    const { username, meeting } = body;
    if (!isIdentifier(username)) {
      this.error(packet, "Invalid username (1-32: letters, digits, . _ -)");
      return false;
    }
    if (!isIdentifier(meeting)) {
      this.error(packet, "Invalid meeting ID (1-32: letters, digits, . _ -)");
      return false;
    }
    if (!this.server.join(this, meeting, username)) {
      this.error(packet, "Username already in this meeting");
      return false;
    }
    this.username = username;
    this.meeting = meeting;
    this.reply(packet, { status: "joined", meeting, username });
    return true;
  }

  private dispatch(packet: Packet): void {
    const kind = packet.type;
    const body = packet.body === undefined ? {} : packet.body;
    const meeting = this.meeting as string;
    const username = this.username as string;
    if (!isObject(body)) {
      this.error(packet, "Body must be a JSON object");
      return;
    }
    if (kind === "request") {
      const operation = body.operation;
      if (operation === "list_participants") {
        this.reply(packet, { status: "ok", operation, meeting, participants: this.server.membersIn(meeting) });
      } else if (operation === "meeting_info") {
        this.reply(packet, {
          status: "ok", operation, meeting, participant_count: this.server.membersIn(meeting).length,
        });
      } else {
        this.error(packet, "Unknown request operation");
      }
    } else if (kind === "subscribe") {
      const topic = body.topic;
      if (!isIdentifier(topic)) {
        this.error(packet, "Invalid topic");
        return;
      }
      this.server.subscribe(meeting, username, topic);
      this.reply(packet, { status: "subscribed", topic });
    } else if (kind === "publish") {
      const { topic, content } = body;
      if (!isIdentifier(topic) || !isContent(content)) {
        this.error(packet, "Invalid topic/content (content: at most 4096 chars)");
        return;
      }
      const event = message("event", { sender: username, meeting, body: { topic, content } });
      const count = this.server.distribute(this.server.subscribers(meeting, topic), event);
      this.log.info(`PUBLISH meeting=${meeting} topic=${topic} publisher=${username} delivered=${count}`);
      this.reply(packet, { status: "published", subscriber_deliveries: count });
    } else if (kind === "group_send") {
      const content = body.content;
      if (!isContent(content)) {
        this.error(packet, "Invalid group content (at most 4096 chars)");
        return;
      }
      const groupPacket = message("group_message", { sender: username, meeting, body: { content } });
      const count = this.server.distribute(this.server.group(meeting), groupPacket);
      this.log.info(`GROUP_SEND meeting=${meeting} sender=${username} delivered=${count}`);
      this.reply(packet, { status: "distributed", group_deliveries: count });
    } else {
      this.error(packet, "Unknown message type");
    }
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      host: { type: "string", default: "127.0.0.1" },  // Bind IP; use 0.0.0.0 for LAN access.
      port: { type: "string", default: "5000" },
      "log-dir": { type: "string", default: "logs" },
      "trace-marshalling": { type: "boolean", default: false },
    },
  });
  const trace = values["trace-marshalling"];
  const logger = configureLogging("server", values["log-dir"], trace);
  const server = new MeetingServer(logger, trace);
  const address = await server.listen(values.host, intOption("port", values.port));
  logger.info(`Listening on ${address.address}:${address.port}`);
  process.on("SIGINT", () => {
    logger.info("Stopping server");
    process.exit(0);
  });
}

if (import.meta.main) {
  await main();
}
