import { startParticipant, type ParticipantAgentConfig } from "../client/participant-agent.ts";
import type { Operation } from "../storage/engine.ts";

// JSON-lines stdin and optional loopback browser use this same ClientSession.
const output = (value: unknown) => {
  if (process.stdout.writableLength > 2 * 1024 * 1024) { process.exitCode = 1; void stop?.(); return; }
  process.stdout.write(JSON.stringify(value) + "\n");
};
let stop: (() => Promise<void>) | undefined;
try {
  const config: ParticipantAgentConfig = JSON.parse(process.env.ZOOM_PARTICIPANT_CONFIG ?? "null");
  if (!config) throw new Error("PARTICIPANT_CONFIG_REQUIRED");
  let lastStatus = "";
  const agent = startParticipant(config, error => {
    const view = agent.session.view();
    const code = error ? (/^[A-Z_]{1,64}$/.test(error.message) ? error.message : "DEPENDENCY_UNAVAILABLE") : undefined;
    const status = JSON.stringify({ connection: view.connection, cursor: view.cursor, ...(code ? { code } : {}) });
    if (status !== lastStatus) { lastStatus = status; output({ event: "participant.status", ...JSON.parse(status), time: new Date().toISOString() }); }
  });
  stop = async () => { process.stdin.pause(); await agent.close(); };
  process.once("SIGINT", () => { void stop!(); }); process.once("SIGTERM", () => { void stop!(); });
  process.stdin.once("end", () => { void stop!(); });
  const browser = config.browser ? await agent.openBrowser() : undefined;
  let buffered = Buffer.alloc(0);
  process.stdin.on("data", (data: Buffer) => {
    buffered = Buffer.concat([buffered, data]);
    for (;;) {
      const newline = buffered.indexOf(10);
      if (newline < 0) break;
      const line = buffered.subarray(0, newline); buffered = buffered.subarray(newline + 1);
      if (line.length > 64 * 1024) { output({ error: "INPUT_TOO_LARGE" }); void stop!(); return; }
      let id: unknown;
      try {
        const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
        id = value.id;
        if (typeof id !== "string" || id.length > 100) throw new Error("INVALID_REQUEST");
        let result: unknown;
        if (value.action === "submit") result = { commandId: agent.session.submit(value.operation as Operation) };
        else if (value.action === "view") result = agent.session.view(value.after, value.limit);
        else throw new Error("INVALID_REQUEST");
        output({ id, result });
      } catch { output({ ...(typeof id === "string" && id.length <= 100 ? { id } : {}), error: "INVALID_REQUEST" }); }
    }
    if (buffered.length > 64 * 1024) { output({ error: "INPUT_TOO_LARGE" }); void stop!(); }
  });
  output({ event: "participant.started", participantId: agent.session.view().participantId, meetingId: config.target.meetingId,
    ...(browser ? { browser: { url: browser.url } } : {}), time: new Date().toISOString() });
  await agent.done;
  await stop();
} catch {
  output({ event: "participant.failed", code: "STARTUP_OR_SESSION_FAILED" });
  await stop?.().catch(() => {}); process.exitCode = 1;
}
