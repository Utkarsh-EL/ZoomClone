import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { UUID_PATTERN } from "./wire.ts";

export const ID_BITS = 128;
export const RING_SIZE = 1n << 128n;
export type Namespace = "peer" | "service" | "meeting";

export function discoveryId(clusterId: string, namespace: Namespace, name: string): bigint {
  if (!UUID_PATTERN.test(clusterId) || !["peer", "service", "meeting"].includes(namespace)
    || typeof name !== "string" || !name.length || Buffer.byteLength(name) > 256) throw new Error("INVALID_DISCOVERY_KEY");
  return fromHex(createHash("sha256").update(JSON.stringify(["zoom-discovery-v1", clusterId, namespace, name])).digest("hex").slice(0, 32));
}
export function toHex(id: bigint): string {
  if (typeof id !== "bigint" || id < 0n || id >= RING_SIZE) throw new Error("INVALID_DISCOVERY_ID");
  return id.toString(16).padStart(32, "0");
}
export function fromHex(value: unknown): bigint {
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/.test(value)) throw new Error("INVALID_DISCOVERY_ID");
  return BigInt(`0x${value}`);
}
export function distance(from: bigint, to: bigint): bigint { return (to - from + RING_SIZE) % RING_SIZE; }
export function between(id: bigint, start: bigint, end: bigint): boolean {
  return start === end ? id !== start : distance(start, id) > 0n && distance(start, id) < distance(start, end);
}
export function addressUrl(address: string, allowZero = false): URL {
  if (typeof address !== "string") throw new Error("INVALID_DISCOVERY_ADDRESS");
  const url = new URL(`http://${address}/v1/discovery`), host = url.hostname.replace(/^\[|\]$/g, "");
  if (!((isIP(host) === 4 && host.startsWith("127.")) || host === "::1")
    || (!url.port && !address.endsWith(":80")) || (!allowZero && url.port === "0")
    || url.username || url.password || url.search || url.hash || url.pathname !== "/v1/discovery") throw new Error("INVALID_DISCOVERY_ADDRESS");
  return url;
}
