import { addressUrl, discoveryId, type Namespace } from "./discovery-id.ts";
import { discoveryTransport } from "./discovery-rpc.ts";
import { object, type DiscoveryHint } from "./discovery.ts";
import type { ControlWire, Identity } from "./wire.ts";

/** Bootstrap-only reader; participants never become overlay/voting members. */
export class DiscoveryClient {
  private readonly options: { identity: Identity; token: string; bootstraps: readonly string[]; timeoutMs?: number };
  private readonly transport: ReturnType<typeof discoveryTransport>;
  private preferred = 0;
  constructor(options: { identity: Identity; token: string; bootstraps: readonly string[]; timeoutMs?: number }, wire?: ControlWire) {
    if (!options.bootstraps.length || options.bootstraps.length > 16) throw new Error("INVALID_BOOTSTRAPS");
    options.bootstraps.forEach(address => addressUrl(address));
    const timeoutMs = options.timeoutMs ?? 4000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error("INVALID_DISCOVERY_TIMEOUT");
    this.options = { ...options, identity: { ...options.identity }, bootstraps: [...options.bootstraps], timeoutMs };
    this.transport = discoveryTransport(options.identity, options.token, wire);
  }
  async lookup(namespace: Exclude<Namespace, "peer">, name: string): Promise<DiscoveryHint | null> {
    discoveryId(this.options.identity.clusterId, namespace, name);
    const deadline = AbortSignal.timeout(this.options.timeoutMs!);
    const start = this.preferred;
    const attemptMs = Math.max(1, Math.floor(this.options.timeoutMs! / (this.options.bootstraps.length + 1)));
    for (let offset = 0; offset < this.options.bootstraps.length; offset++) {
      if (deadline.aborted) break;
      const index = (start + offset) % this.options.bootstraps.length;
      const address = this.options.bootstraps[index];
      this.preferred = (index + 1) % this.options.bootstraps.length;
      try {
        const signal = AbortSignal.any([deadline, AbortSignal.timeout(attemptMs)]);
        const result = await this.transport(address, { operation: "lookup", namespace, name }, signal);
        if (result === null) { this.preferred = index; return null; }
        if (!object(result) || !Number.isSafeInteger(result.generation) || (result.generation as number) < 1
          || !Number.isSafeInteger(result.expiresAt) || (result.expiresAt as number) <= Date.now()
          || (result.expiresAt as number) > Date.now() + 60000 || !("value" in result)
          || Buffer.byteLength(JSON.stringify(result)) > 8192) throw new Error("INVALID_DISCOVERY_HINT");
        this.preferred = index;
        return result as unknown as DiscoveryHint;
      } catch { /* Another bootstrap can still route this lookup. */ }
    }
    throw new Error("DISCOVERY_UNAVAILABLE");
  }
}
