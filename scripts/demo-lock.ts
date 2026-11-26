import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { readJSON } from "./demo-state.ts";

/** Exclusive creation is the only ownership claim. A stale lock is evidence of
 * uncertain cleanup, never permission to unlink a possible new owner's lock. */
export async function claimDemoLock(path: string, owner: { runId: string; pid: number }) {
  let handle;
  try { handle = await open(path, "wx", 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("DEMO_LOCK_EXISTS_OWNERSHIP_RECOVERY_REQUIRED"); throw error; }
  try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); }
  finally { await handle.close(); }
}
export async function releaseDemoOwnership(root: string, runId: string, cleanupErrors: readonly string[]): Promise<boolean> {
  if (cleanupErrors.length) return false;
  const paths = [join(root, "control.json"), join(root, "supervisor.lock")];
  const records = await Promise.all(paths.map(readJSON));
  if (records.some(record => record && record.runId !== runId)) throw new Error("DEMO_LOCK_OWNERSHIP_CHANGED");
  for (let i = 0; i < paths.length; i++) if (records[i]) await unlink(paths[i]);
  return true;
}
