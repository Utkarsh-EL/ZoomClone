/**
 * Video sharing for a meeting: one presenter at a time. The right to present is the "presenter" lock that the
 * elected leader runs, so two peers can never share at once; frames travel through the meeting coordinator.
 */

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { Participant } from "./client.ts";
import type { Peer } from "./peer.ts";
import type { Body, Packet } from "./protocol.ts";
import { isFrame } from "./server.ts";

export const PRESENTER = "presenter";
export const PATTERN_FPS = 10;
const BROWSER_IDLE = 5.0;         // Seconds without a frame from the page before the presenter slot is given back.
const MAX_REMEMBERED = 5000;      // Received frames kept for the audit.
const MAX_POST_BYTES = 70000;
const PAGE = join(import.meta.dirname, "video.html");

export type ShareState = "off" | "waiting" | "presenting";
export type Source = "pattern" | "browser";

export interface ReceivedFrame {
  presenter: string;
  seq: number;
  at: number;  // Milliseconds on this process's monotonic clock.
}

export interface FrameRun {
  presenter: string;
  first: number;
  last: number;
  count: number;
}

export interface FrameAudit {
  frames: number;
  presenters: number;
  runs: number;
  interleaved: number;   // Extra runs: each one is a presenter's stream resuming after another's cut in.
  inOrder: boolean;      // Every presenter's frames arrived in sequence order.
}

/** A generated test-pattern frame: an SVG data URL with the presenter's name, the frame number and a moving bar. */
export function testPatternFrame(presenter: string, seq: number): string {
  let hue = 0;
  for (const char of presenter) {
    hue = (hue * 31 + char.charCodeAt(0)) % 360;
  }
  const x = (seq * 14) % 300;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">`
    + `<rect width="320" height="180" fill="hsl(${hue},45%,22%)"/>`
    + [0, 1, 2, 3, 4, 5, 6].map((i) => `<rect x="${i * 46}" y="128" width="46" height="18" `
      + `fill="hsl(${(hue + i * 51) % 360},70%,60%)"/>`).join("")
    + `<rect x="${x}" y="0" width="20" height="120" fill="hsla(0,0%,100%,0.18)"/>`
    + `<text x="16" y="52" font-family="Arial" font-size="30" font-weight="bold" fill="#fff">${presenter}</text>`
    + `<text x="16" y="84" font-family="Arial" font-size="16" fill="hsl(${hue},80%,82%)">test pattern</text>`
    + `<text x="304" y="170" text-anchor="end" font-family="Courier New" font-size="13" fill="#fff">frame ${seq}</text>`
    + `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

/** Group frames into runs of consecutive frames from one presenter. */
export function frameRuns(frames: Pick<ReceivedFrame, "presenter" | "seq">[]): FrameRun[] {
  const runs: FrameRun[] = [];
  for (const frame of frames) {
    const run = runs.at(-1);
    if (run && run.presenter === frame.presenter) {
      run.last = frame.seq;
      run.count += 1;
    } else {
      runs.push({ presenter: frame.presenter, first: frame.seq, last: frame.seq, count: 1 });
    }
  }
  return runs;
}

/** Check a viewer's frame sequence for two streams mixed together. */
export function auditFrames(frames: Pick<ReceivedFrame, "presenter" | "seq">[]): FrameAudit {
  const runs = frameRuns(frames);
  const presenters = new Set(frames.map((frame) => frame.presenter));
  const last = new Map<string, number>();
  let inOrder = true;
  for (const frame of frames) {
    if ((last.get(frame.presenter) ?? 0) >= frame.seq) {
      inOrder = false;
    }
    last.set(frame.presenter, frame.seq);
  }
  return { frames: frames.length, presenters: presenters.size, runs: runs.length,
           interleaved: runs.length - presenters.size, inOrder };
}

/** One peer's part in a meeting's video: it watches every presenter and can present itself. */
export class VideoSession {
  readonly peer: Peer;
  meeting: string | null = null;
  state: ShareState = "off";
  source: Source | null = null;
  received: ReceivedFrame[] = [];
  lastFrame: { presenter: string; seq: number } | null = null;
  private participant: Participant | null = null;
  private locked = true;
  private seq = 0;
  private stopRequested = false;
  private finishing = false;
  private sending: Promise<void> | null = null;  // The one frame in flight.
  private nextFrame: string | null = null;       // Newest browser frame waiting for the one in flight.
  private lastBrowserFrame = 0;
  private finished: PromiseWithResolvers<void> | null = null;
  private listeners = new Set<(event: string, data: Body) => void>();

  constructor(peer: Peer) {
    this.peer = peer;
  }

  /** Find a meeting through the overlay and join it as a participant named after this peer. */
  async join(meeting: string): Promise<Body> {
    if (this.participant && !this.participant.closed) {
      if (meeting === this.meeting) {
        return this.status();
      }
      throw new Error(`Already in meeting ${this.meeting}`);
    }
    const found = await this.peer.lookup(meeting);
    if (!found.found) {
      throw new Error(`No peer knows meeting '${meeting}'`);
    }
    const { host, port } = found.value ?? {};
    // No logger: the participant would otherwise log every packet, including each relayed frame.
    const participant = new Participant(this.peer.me.name, { meeting, host, port });
    await participant.connect();
    participant.onFrame = (packet) => this.onFrame(packet);
    this.participant = participant;
    this.meeting = meeting;
    this.peer.log.info(`VIDEO_JOIN meeting=${meeting} coordinator=${host}:${port}`);
    this.emitState();
    return this.status();
  }

  /**
   * Present until stopped, or for `frames` frames when given. With `locked` (the default) this first waits for the
   * presenter lock; unlocked sharing exists only to show what the lock prevents.
   */
  async share(source: Source, options: { locked?: boolean; frames?: number } = {}): Promise<number> {
    if (!this.participant || this.participant.closed) {
      throw new Error("Join a meeting first");
    }
    if (this.state !== "off") {
      throw new Error(`Already ${this.state}`);
    }
    const { locked = true, frames } = options;
    this.state = "waiting";
    this.source = source;
    this.locked = locked;
    this.stopRequested = false;
    this.seq = 0;
    this.finished = Promise.withResolvers<void>();
    this.emitState();
    if (locked) {
      await this.peer.acquire(PRESENTER);
    }
    if (this.stopRequested) {  // Stopped while waiting: give the slot straight back.
      await this.finish();
      return 0;
    }
    this.state = "presenting";
    this.lastBrowserFrame = performance.now() / 1000;
    this.peer.log.info(`VIDEO_SHARE_START lamport=${this.peer.clock.tick()} source=${source} locked=${locked}`);
    this.emitState();
    if (source === "pattern") {
      const started = performance.now();
      while (!this.stopRequested && (frames === undefined || this.seq < frames)) {
        await this.send(testPatternFrame(this.peer.me.name, this.seq + 1));
        await sleep(Math.max(0, started + (this.seq * 1000) / PATTERN_FPS - performance.now()));
      }
      await this.finish();
    } else {
      await this.finished.promise;
    }
    return this.seq;
  }

  /** Stop presenting, or stop waiting to present. */
  async stop(): Promise<Body> {
    if (this.state === "off") {
      return this.status();
    }
    this.stopRequested = true;
    if (this.state === "waiting") {
      return this.status();  // share() gives the slot back as soon as it is granted.
    }
    if (this.source === "browser") {
      await this.finish();
    }
    await this.finished?.promise;
    return this.status();
  }

  /** Take a frame from the browser page. Only the newest frame waits behind the one in flight; older ones drop. */
  pushBrowserFrame(data: unknown): void {
    if (this.state !== "presenting" || this.source !== "browser") {
      throw new Error("Not presenting from the browser");
    }
    if (typeof data !== "string" || !data.startsWith("data:image/jpeg;base64,") || !isFrame(data)) {
      throw new Error("Frame must be a JPEG data URL of at most 60000 characters");
    }
    this.lastBrowserFrame = performance.now() / 1000;
    if (this.sending) {
      this.nextFrame = data;
      return;
    }
    void this.pump(data);
  }

  private async pump(first: string): Promise<void> {
    let data: string | null = first;
    while (data !== null && this.state === "presenting" && !this.stopRequested) {
      await this.send(data);
      data = this.nextFrame;
      this.nextFrame = null;
    }
  }

  /** Send one frame and wait for the coordinator's reply, so the next frame or the release cannot overtake it. */
  private async send(data: string): Promise<void> {
    const sending = (async () => {
      this.seq += 1;
      const seq = this.seq;
      this.emit("frame", { presenter: this.peer.me.name, seq, data, self: true });
      try {
        await this.participant!.shareFrame(seq, data);
      } catch (error) {
        this.peer.log.warning(`VIDEO_FRAME_FAILED seq=${seq} error=${(error as Error).message}`);
        this.stopRequested = true;
      }
    })();
    this.sending = sending;
    await sending;
    this.sending = null;
  }

  /** Release the presenter slot after the last frame has been delivered. */
  private async finish(): Promise<void> {
    if (this.state === "off" || this.finishing) {
      return;
    }
    this.finishing = true;
    this.stopRequested = true;
    await this.sending;
    const presented = this.state === "presenting";
    this.state = "off";
    this.nextFrame = null;
    if (presented) {
      this.peer.log.info(`VIDEO_SHARE_STOP lamport=${this.peer.clock.tick()} frames=${this.seq}`);
    }
    if (this.locked) {
      await this.peer.release(PRESENTER);
    }
    this.source = null;
    this.finishing = false;
    this.emitState();
    this.finished?.resolve();
  }

  /** Give the slot back when the presenting page has gone quiet, as when its tab was closed. */
  async checkIdle(): Promise<void> {
    if (this.state === "presenting" && this.source === "browser"
        && performance.now() / 1000 - this.lastBrowserFrame > BROWSER_IDLE) {
      this.peer.log.warning(`VIDEO_IDLE no browser frame for ${BROWSER_IDLE}s; releasing the presenter slot`);
      await this.finish();
    }
  }

  private onFrame(packet: Packet): void {
    const presenter = String(packet.sender);
    const seq = Number(packet.body?.seq);
    if (this.received.length >= MAX_REMEMBERED) {
      this.received.shift();
    }
    this.received.push({ presenter, seq, at: performance.now() });
    this.lastFrame = { presenter, seq };
    this.emit("frame", { presenter, seq, data: packet.body?.data });
  }

  /** Subscribe to frames and state changes; returns the unsubscribe function. */
  subscribe(listener: (event: string, data: Body) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: string, data: Body): void {
    for (const listener of this.listeners) {
      listener(event, data);
    }
  }

  private emitState(): void {
    this.emit("state", this.status());
  }

  status(): Body {
    const peer = this.peer.onStatus();
    return {
      peer: this.peer.me.name, meeting: this.meeting, state: this.state, source: this.source, sent: this.seq,
      leader: peer.leader?.name ?? null, term: peer.term, lamport: peer.lamport, received: this.received.length,
      last: this.lastFrame, slot: peer.lock.grants[PRESENTER] ?? null,
    };
  }

  close(): void {
    this.participant?.close();
  }
}

/** Give a peer video requests, so a demo or script can drive it the way the page does. */
export function attachVideo(peer: Peer): VideoSession {
  const video = new VideoSession(peer);
  const checkName = (value: unknown): string => {
    if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{1,32}$/.test(value)) {
      throw new Error("Invalid meeting name");
    }
    return value;
  };
  peer.on("video_join", (body) => video.join(checkName(body.meeting)));
  peer.on("video_share", async (body) => {
    const { locked = true, frames } = body;
    if (typeof locked !== "boolean" || !(Number.isInteger(frames) && frames >= 1 && frames <= 10000)) {
      throw new Error("Invalid share request (frames 1-10000, locked true or false)");
    }
    return { sent: await video.share("pattern", { locked, frames }) };
  });
  peer.on("video_stop", () => video.stop());
  peer.on("video_stats", (body) => ({
    ...video.status(), audit: auditFrames(video.received), runs: frameRuns(video.received),
    frames: body.frames ? video.received : undefined,
  }));
  peer.on("video_reset", () => {
    video.received = [];
    return { status: "reset" };
  });
  const watchdog = setInterval(() => void video.checkIdle(), 1000);
  watchdog.unref();
  void peer.whenStopped.then(() => {
    clearInterval(watchdog);
    video.close();
  });
  return video;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_POST_BYTES) {
        reject(new Error("Request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function json(response: ServerResponse, code: number, body: Body): void {
  response.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

/** Serve the meeting page on localhost: watch the presenter, share a camera, a screen or the test pattern. */
export function startWebUi(video: VideoSession, port: number, host = "127.0.0.1"): Promise<Server> {
  const page = readFileSync(PAGE, "utf8");
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    try {
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(page);
      } else if (request.method === "GET" && url.pathname === "/events") {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        const write = (event: string, data: Body): void => {
          response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        write("state", video.status());
        const unsubscribe = video.subscribe(write);
        const ticker = setInterval(() => write("state", video.status()), 1000);
        request.on("close", () => {
          unsubscribe();
          clearInterval(ticker);
        });
      } else if (request.method === "POST" && url.pathname === "/join") {
        const { meeting } = JSON.parse(await readBody(request) || "{}");
        json(response, 200, await video.join(String(meeting)));
      } else if (request.method === "POST" && url.pathname === "/share") {
        const { source } = JSON.parse(await readBody(request) || "{}");
        if (!["camera", "screen", "pattern"].includes(source)) {
          json(response, 400, { error: "source must be camera, screen or pattern" });
          return;
        }
        // Waiting for the slot can take a while; the page follows the state over /events.
        video.share(source === "pattern" ? "pattern" : "browser")
          .catch((error) => video.peer.log.warning(`VIDEO_SHARE_FAILED error=${(error as Error).message}`));
        json(response, 202, video.status());
      } else if (request.method === "POST" && url.pathname === "/stop") {
        json(response, 200, await video.stop());
      } else if (request.method === "POST" && url.pathname === "/frame") {
        video.pushBrowserFrame(await readBody(request));
        json(response, 202, { status: "queued" });
      } else {
        json(response, 404, { error: "Not found" });
      }
    } catch (error) {
      if (!response.headersSent) {
        json(response, 409, { error: (error as Error).message });
      }
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      video.peer.log.info(`VIDEO_UI http://${host}:${port}/`);
      resolve(server);
    });
  });
}
