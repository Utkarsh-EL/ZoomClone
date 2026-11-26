import { MediaRoom, type MediaContext, type MediaRequest } from "./room.ts";
import { UUID_PATTERN } from "../coordination/wire.ts";

/** Only explicitly provisioned meetings allocate a room. No browser field can
 * select an SFU address/capability or create an unbounded room registry. */
export class RuntimeMedia {
  private readonly rooms = new Map<string, MediaRoom>();
  constructor(routes: { meetingId: string; effect(request: MediaRequest): Promise<unknown> }[]) {
    if (!routes.length || routes.length > 128) throw new Error("INVALID_MEDIA_ROUTES");
    for (const route of routes) {
      if (!UUID_PATTERN.test(route.meetingId) || this.rooms.has(route.meetingId)) throw new Error("INVALID_MEDIA_ROUTES");
      this.rooms.set(route.meetingId, new MediaRoom(route.effect));
    }
  }
  handle(meetingId: string, context: MediaContext, request: MediaRequest): Promise<unknown> {
    const room = this.rooms.get(meetingId);
    if (!room) return Promise.reject(new Error("MEDIA_UNPROVISIONED"));
    return room.handle(context, request);
  }
  async close(): Promise<void> {
    const results = await Promise.allSettled([...this.rooms.values()].map(room => room.close()));
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}
