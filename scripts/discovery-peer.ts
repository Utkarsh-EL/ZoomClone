import { randomUUID } from "node:crypto";
import { serveDiscovery, type DiscoveryConfig } from "../coordination/discovery-rpc.ts";
import { toHex } from "../coordination/discovery-id.ts";

try {
  const config: DiscoveryConfig = JSON.parse(process.env.ZOOM_DISCOVERY_CONFIG ?? "null");
  if (!config) throw new Error("DISCOVERY_CONFIG_REQUIRED");
  const service = await serveDiscovery({ ...config, incarnation: randomUUID() });
  console.log(JSON.stringify({ event: "discovery.started", clusterId: config.clusterId, nodeId: config.nodeId,
    incarnation: service.node.self.incarnation, id: toHex(service.node.self.id), address: service.address, time: new Date().toISOString() }));
  const stop = () => { process.stdin.pause(); void service.close().catch(() => { process.exitCode = 1; }); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  if (process.env.ZOOM_PARENT_LIFETIME === "stdin") { process.stdin.once("end", stop); process.stdin.resume(); }
} catch {
  console.error(JSON.stringify({ event: "discovery.failed", code: "STARTUP_FAILED" }));
  process.exitCode = 1;
}
