import { join } from "node:path";
import { UUID_PATTERN } from "../coordination/wire.ts";
import { readJSON } from "./demo-state.ts";

export async function demoRequest(root: string, action = "status") {
  const control = await readJSON(join(root, "control.json"));
  if (!control) return undefined;
  if (!Number.isInteger(control.port) || control.port < 1 || control.port > 65535 || !UUID_PATTERN.test(control.runId)
    || typeof control.token !== "string" || !/^[a-f0-9]{64}$/.test(control.token)) throw new Error("INVALID_DEMO_CONTROL_MANIFEST");
  const response = await fetch(`http://127.0.0.1:${control.port}/${action}`, { method: action === "status" ? "GET" : "POST", redirect: "error",
    headers: { Authorization: `Bearer ${control.token}`, "X-Demo-Run": control.runId }, signal: AbortSignal.timeout(action === "status" ? 10000 : action === "stop" ? 180000 : 100000) });
  const result = await response.json() as any;
  if (!response.ok) throw new Error(result.error ?? "DEMO_CONTROL_FAILED");
  if (result.runId !== control.runId) throw new Error("DEMO_CONTROL_RUN_MISMATCH");
  return result;
}
