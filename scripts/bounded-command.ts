import { spawn } from "node:child_process";
import { projectRoot } from "./coordinator-build.ts";

/** Async external work with exact-handle cancellation, bounded output and a
 * deadline. A timeout never retries an uncertain Docker effect. */
export function boundedCommand(executable: string, args: string[], options: { timeoutMs: number; signal?: AbortSignal; env?: Record<string, string> }): Promise<string> {
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 300000) return Promise.reject(new Error("INVALID_COMMAND_DEADLINE"));
  if (options.signal?.aborted) return Promise.reject(new Error("COMMAND_ABORTED"));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: projectRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...options.env } });
    let stdout = "", stderr = "", bytes = 0, failure: string | undefined;
    const kill = (code: string) => { failure ??= code; child.kill("SIGKILL"); };
    const abort = () => kill("COMMAND_ABORTED"), timer = setTimeout(() => kill("COMMAND_TIMEOUT"), options.timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) kill("COMMAND_OUTPUT_LIMIT"); else stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4096); });
    child.on("error", error => { failure ??= error.message; });
    child.once("close", code => {
      clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
      if (failure || code !== 0) reject(new Error((failure ?? "COMMAND_FAILED") + (stderr ? ": " + stderr : "")));
      else resolve(stdout.trim());
    });
  });
}
