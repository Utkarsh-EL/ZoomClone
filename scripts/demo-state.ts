import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { projectRoot } from "./coordinator-build.ts";
import { UUID_PATTERN } from "../coordination/wire.ts";
import { participantURL } from "../coordination/participant-protocol.ts";

export const people = ["Alice", "Bob", "Charlie", "Outsider"] as const;
export const secret = () => randomBytes(32).toString("hex");
export function demoRoot() {
  const root = resolve(process.env.ZOOM_DEMO_ROOT ?? join(projectRoot, ".local", "demo"));
  const inside = relative(resolve(projectRoot, ".local"), root);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("DEMO_ROOT_MUST_BE_INSIDE_PROJECT_LOCAL");
  return root;
}
export async function writeJSON(path: string, value: unknown) {
  const temporary = path + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  try {
    for (let i = 0; ; i++) {
      try { await rename(temporary, path); return; }
      catch (error) { if (i >= 14 || !["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; await delay(20); }
    }
  } finally { await unlink(temporary).catch(() => {}); }
}
export async function readJSON(path: string): Promise<any | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export interface DemoState {
  version: 2; protocol: 2; clusterId: string; meetingId: string; storageRoot: string;
  helperToken: string; discoveryToken: string; runtimeToken: string; participantToken: string; runtimePassword: string;
  controllerId: string; mediaNodeId: string; mediaToken: string;
  helpers: { id: string; address: string; initialized: boolean }[];
  runtimeIds: string[];
  participantRevisions: Record<string, number>;
  participantIds: Record<string, string | null>;
}
export async function loadDemoState(root: string): Promise<DemoState | undefined> {
  const state = await readJSON(join(root, "demo.json"));
  if (!state) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const unexpected = (await readdir(root)).filter(p => !["control.json", "supervisor.lock", "last-stop.json", "supervisor.log", "logs"].includes(p));
    if (unexpected.length) throw new Error("DEMO_MANIFEST_MISSING_RESTORE_REQUIRED");
    return undefined;
  }
  if (state.version !== 2 || state.protocol !== 2 || ![state.clusterId, state.meetingId, state.controllerId, state.mediaNodeId, ...state.runtimeIds].every(id => typeof id === "string" && UUID_PATTERN.test(id))
    || state.helpers?.length !== 3 || state.runtimeIds.length !== 2 || people.some(name => !Number.isSafeInteger(state.participantRevisions?.[name]) || state.participantRevisions[name] < 0)
    || people.some(name => state.participantIds?.[name] !== null && !UUID_PATTERN.test(state.participantIds?.[name] ?? ""))
    || [state.helperToken, state.discoveryToken, state.runtimeToken, state.participantToken, state.runtimePassword, state.mediaToken].some(s => typeof s !== "string" || !/^[a-f0-9]{64}$/.test(s))) throw new Error("INCOMPATIBLE_OR_DAMAGED_DEMO_MANIFEST");
  for (const h of state.helpers) { if (!UUID_PATTERN.test(h.id) || typeof h.initialized !== "boolean") throw new Error("INVALID_HELPER_MANIFEST"); participantURL(h.address); }
  return state;
}
