import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MediaRequest } from "./room.ts";

/** A bounded latest-run diagnostic journal, separate from SQL intentions.
 * Starting/uncertain records never authorize effects or cause command retries.
 * Caller serializes effects; paths are provisioned per runtime/meeting. */
export function observeEffects(path: string, effect: (request: MediaRequest) => Promise<any>) {
  const records: { action: string; status: string; observedAt: string; epoch?: string; generation?: number }[] = [];
  async function save(request: MediaRequest, status: string, epoch?: string) {
    const generation = (request.owner as { generation?: number } | undefined)?.generation;
    records.push({ action: request.action, status, observedAt: new Date().toISOString(),
      ...(typeof epoch === "string" ? { epoch } : {}), ...(Number.isSafeInteger(generation) ? { generation } : {}) });
    if (records.length > 64) records.splice(0, records.length - 64);
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(`${path}.tmp`, JSON.stringify(records) + "\n", { mode: 0o600 });
      // Windows readers may briefly omit FILE_SHARE_DELETE. Retry only the
      // atomic filesystem replacement, never the already executed SFU effect.
      for (let attempt = 0; ; attempt++) {
        try { await rename(`${path}.tmp`, path); break; }
        catch (error) {
          if (attempt >= 9 || !["EPERM", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new Error(`MEDIA_OBSERVATION_${typeof code === "string" && /^[A-Z]{1,16}$/.test(code) ? code : "FAILED"}`, { cause: error });
    }
  }
  return async (request: MediaRequest) => {
    await save(request, "starting", request.epoch as string | undefined);
    try { const result = await effect(request); await save(request, "applied", result.epoch); return result; }
    catch (error) { await save(request, "uncertain", request.epoch as string | undefined); throw error; }
  };
}
