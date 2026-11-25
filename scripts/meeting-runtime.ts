import { randomUUID } from "node:crypto";
import { startMeetingRuntime, type MeetingRuntimeConfig } from "../coordination/runtime-service.ts";

// Provisioning and secrets stay in the environment, never command-line flags.
try {
  const config: MeetingRuntimeConfig = JSON.parse(process.env.ZOOM_RUNTIME_CONFIG ?? "null");
  if (!config) throw new Error("RUNTIME_CONFIG_REQUIRED");
  const runtime = await startMeetingRuntime({ ...config, incarnation: randomUUID() }, (meetingId, error) => {
    console.log(JSON.stringify({ event: error ? "runtime.refresh-failed" : "runtime.renewed", meetingId,
      time: new Date().toISOString(), ...(error ? { code: /^[A-Z_]+$/.test(error.message) ? error.message : "DEPENDENCY_UNAVAILABLE" } : {}) }));
  });
  console.log(JSON.stringify({ event: "runtime.started", clusterId: config.clusterId, runtimeId: config.runtimeId,
    incarnation: runtime.agent.identity.incarnation, address: runtime.address, time: new Date().toISOString() }));
  const stop = () => { void runtime.close().catch(() => { process.exitCode = 1; }); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  await runtime.done;
} catch {
  console.error(JSON.stringify({ event: "runtime.failed", code: "STARTUP_OR_SCHEDULER_FAILED" }));
  process.exitCode = 1;
}
