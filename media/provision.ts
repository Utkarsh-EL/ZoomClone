import { participantToken, participantURL } from "../coordination/participant-protocol.ts";
import { ControlWire, UUID_PATTERN } from "../coordination/wire.ts";
import { kernelClient } from "./kernel-client.ts";
import { observeEffects } from "./observations.ts";
import { RuntimeMedia } from "./runtime-media.ts";

export interface MediaRoute { meetingId: string; address: string; nodeId: string; token: string; observationPath: string }
export function provisionMedia(routes: MediaRoute[], wire: ControlWire): RuntimeMedia {
  const addresses = new Set<string>(), observations = new Set<string>();
  return new RuntimeMedia(routes.map(route => {
    const url = new URL(route.address);
    participantURL(url.host); participantToken(route.token);
    if (url.protocol !== "http:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password
      || !UUID_PATTERN.test(route.nodeId) || !route.observationPath || typeof route.observationPath !== "string"
      || addresses.has(url.href) || observations.has(route.observationPath)) throw new Error("INVALID_MEDIA_ROUTES");
    addresses.add(url.href); observations.add(route.observationPath);
    return { meetingId: route.meetingId, effect: observeEffects(route.observationPath,
      kernelClient({ ...route, identity: wire.identity }, wire)) };
  }));
}
