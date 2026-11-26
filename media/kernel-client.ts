import { ControlWire, boundedReply, type Identity } from "../coordination/wire.ts";
import type { MediaRequest } from "./room.ts";

/** Private adapter -> SFU boundary. No automatic retries: an effect timeout is
 * uncertain; reopen transient transports under a new fresh authorization. */
export function kernelClient(options: { address: string; token: string; identity: Identity; nodeId: string }, sharedWire?: ControlWire) {
  const wire = sharedWire ?? new ControlWire(options.identity);
  return async (request: MediaRequest): Promise<any> => {
    const packet = wire.request(request);
    const response = await fetch(`${options.address}/v1/control`, { method: "POST", headers: { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(packet), signal: AbortSignal.timeout(5000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error("SFU_UNAVAILABLE"); }
    const reply = wire.receive(await boundedReply(response), packet.requestId, options.nodeId);
    if (reply.error) throw new Error(reply.error.code);
    if (!reply.body || typeof reply.body !== "object" || (reply.body as { epoch?: unknown }).epoch !== reply.incarnation) throw new Error("INVALID_MEDIA_REPLY");
    return reply.body;
  };
}
