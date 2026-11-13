/** Launch a coordinator and three actual participant processes and save evidence. */

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

export const ROOT = import.meta.dirname;

export function freeLocalPort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => done(port));
    });
  });
}

function canConnect(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (connected: boolean): void => {
      clearTimeout(timer);
      socket.destroy();
      done(connected);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export async function waitForBroker(child: ChildProcess, port: number, seconds = 7): Promise<void> {
  const deadline = performance.now() + seconds * 1000;
  while (performance.now() < deadline) {
    if (exited(child)) {
      throw new Error("Broker terminated during startup");
    }
    if (await canConnect(port, 100)) {
      return;
    }
    await sleep(50);
  }
  throw new Error("Broker did not start");
}

async function waitForReady(path: string, child: ChildProcess, seconds = 7): Promise<void> {
  const deadline = performance.now() + seconds * 1000;
  while (performance.now() < deadline) {
    if (existsSync(path)) {
      return;
    }
    if (exited(child)) {
      throw new Error(`${child.spawnargs.join(" ")} exited before subscribing`);
    }
    await sleep(50);
  }
  throw new Error(`No readiness signal from ${path}`);
}

/** Resolve with the exit code, or reject when the process outlives `seconds`. */
export function waitForExit(child: ChildProcess, seconds: number): Promise<number | null> {
  if (exited(child)) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`${child.spawnargs.join(" ")} did not exit`)), seconds * 1000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      done(code);
    });
  });
}

/** Resolve the output directory, refusing the project root, and clear only files a demo generates. */
export function prepareOutput(directory: string, generated: (file: string) => boolean): string {
  const target = resolve(directory);
  if (target === ROOT || target === resolve(ROOT, "..")) {
    throw new Error("Output directory cannot be the project root");
  }
  mkdirSync(target, { recursive: true });
  // Only remove demo-generated files; do not delete unrelated user files.
  for (const file of readdirSync(target)) {
    const path = join(target, file);
    if (generated(file) && statSync(path).isFile()) {
      rmSync(path);
    }
  }
  return target;
}

const TRANSCRIPT_MARKERS = [
  "JOIN_REPLY:", "SUBSCRIBE_REPLY:", "REQUEST_REPLY:", "PUBLISH_REPLY:", "GROUP_SEND_REPLY:", "PUBSUB_RECEIVED:",
  "GROUP_RECEIVED:", "RESULT: PASS", "MARSHAL object=", "UNMARSHAL wire_bytes=", "PUBLISH meeting=", "GROUP_SEND meeting=",
];

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { "output-dir": { type: "string", default: join(ROOT, "evidence", "demo_run") } },
  });
  const target = prepareOutput(values["output-dir"], (file) =>
    file.endsWith(".ready") || file.endsWith(".log") || file.endsWith(".console.txt") || file === "demo_transcript.txt");
  const port = await freeLocalPort();
  const processes: ChildProcess[] = [];
  const handles: number[] = [];

  const launch = (label: string, script: string, extra: string[]): ChildProcess => {
    const output = openSync(join(target, `${label}.console.txt`), "w");
    handles.push(output);
    const child = spawn(process.execPath, [join(ROOT, script), ...extra],
                        { cwd: ROOT, stdio: ["ignore", output, output] });
    processes.push(child);
    return child;
  };

  try {
    const broker = launch("server", "server.ts", ["--host", "127.0.0.1", "--port", String(port),
                                                  "--log-dir", target, "--trace-marshalling"]);
    await waitForBroker(broker, port);
    const subscribers: ChildProcess[] = [];
    for (const name of ["bob", "charlie"]) {
      const ready = join(target, `${name}.ready`);
      const child = launch(name, "demo_node.ts", ["--name", name, "--role", "subscriber", "--host", "127.0.0.1",
                                                  "--port", String(port), "--log-dir", target, "--ready-file", ready]);
      await waitForReady(ready, child);
      subscribers.push(child);
    }
    const publisher = launch("alice", "demo_node.ts", ["--name", "alice", "--role", "publisher", "--host", "127.0.0.1",
                                                       "--port", String(port), "--log-dir", target]);
    for (const child of [publisher, ...subscribers]) {
      if (await waitForExit(child, 12) !== 0) {
        throw new Error(`A participant failed: ${child.spawnargs.join(" ")}`);
      }
    }
    for (const name of ["alice", "bob", "charlie"]) {
      if (!readFileSync(join(target, `${name}.console.txt`), "utf8").includes("RESULT: PASS")) {
        throw new Error(`Missing PASS marker in ${name}`);
      }
    }
    console.log("PASS: request/reply, two subscriber deliveries, and group deliveries");
  } finally {
    for (const child of processes) {
      if (!exited(child)) {
        child.kill();
      }
    }
    for (const child of processes) {
      try {
        await waitForExit(child, 3);
      } catch {
        child.kill("SIGKILL");
        await waitForExit(child, 3);
      }
    }
    for (const handle of handles) {
      closeSync(handle);
    }
    let summary = "CECS 327 Milestone 2 - actual process output (UTC timestamps)\n";
    for (const name of ["server", "bob", "charlie", "alice"]) {
      const log = join(target, `${name}.console.txt`);
      summary += `\n${"=".repeat(25)} ${name.toUpperCase()} ${"=".repeat(25)}\n`;
      if (existsSync(log)) {
        for (const line of readFileSync(log, "utf8").split(/\r?\n/)) {
          if (TRANSCRIPT_MARKERS.some((marker) => line.includes(marker))) {
            summary += `${line}\n`;
          }
        }
      }
    }
    const transcript = join(target, "demo_transcript.txt");
    writeFileSync(transcript, summary, "utf8");
    console.log("Evidence:", transcript);
  }
}

if (import.meta.main) {
  await main();
}
