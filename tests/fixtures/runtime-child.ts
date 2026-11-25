/** Local evidence harness only; production runtime exposes no participant RPC. */
import { startMeetingRuntime } from "../../coordination/runtime-service.ts";

try {
  const runtime = await startMeetingRuntime(JSON.parse(process.env.ZOOM_RUNTIME_CONFIG!), () => {});
  process.send!({ address: runtime.address });
  process.on("message", async (message: any) => {
    try {
      const gate = runtime.agent.authority(message.meetingId);
      let result: unknown;
      if (message.operation === "ready") result = gate?.ready() ?? false;
      else if (message.operation === "execute") {
        if (!gate) throw new Error("NOT_READY");
        result = await runtime.store.execute(gate, message.command);
      } else throw new Error("UNKNOWN_EVIDENCE_OPERATION");
      process.send!({ id: message.id, result });
    } catch (error) { process.send!({ id: message.id, error: error instanceof Error ? error.message : "FAILED" }); }
  });
  process.on("disconnect", () => { void runtime.close().then(() => process.exit()); });
} catch (error) { process.send!({ error: error instanceof Error ? error.message : "STARTUP_FAILED" }); process.exitCode = 1; }
