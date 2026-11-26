import { HelperClient, type ControlArguments, type HelperAccess, type Operation } from "./helper-client.ts";
import { LeaderRoute } from "./helper-route.ts";
import { object } from "./discovery.ts";
import type { DiscoveryClient } from "./discovery-client.ts";
import { ControlWire, type Identity } from "./wire.ts";

/** Hints supply destinations only. HelperClient authenticates the actual
 * endpoint and Raft barrier reads still determine committed metadata. */
export class DiscoveredHelpers implements HelperAccess {
  private route: LeaderRoute | undefined;
  private readonly wire: ControlWire;
  private readonly options: { identity: Identity; token: string; discovery: Pick<DiscoveryClient, "lookup">; timeoutMs?: number };
  constructor(options: { identity: Identity; token: string; discovery: Pick<DiscoveryClient, "lookup">; timeoutMs?: number }, wire?: ControlWire) {
    this.options = options;
    this.wire = wire ?? new ControlWire({ clusterId: options.identity.clusterId, nodeId: options.identity.nodeId, incarnation: options.identity.incarnation });
  }
  async call<T = unknown>(operation: Operation, args: ControlArguments = {}): Promise<T> {
    if (operation !== "read") {
      if (!this.route) throw new Error("HELPER_READ_REQUIRED");
      return this.route.call<T>(operation, args);
    }
    if (this.route) {
      try { return await this.route.call<T>("read", args); }
      catch { /* Refresh destinations only after the cached barrier routes fail. */ }
    }
    {
      const hint = await this.options.discovery.lookup("service", "coordinators");
      if (!hint || !object(hint.value) || !Array.isArray(hint.value.helpers) || !hint.value.helpers.length || hint.value.helpers.length > 9) throw new Error("INVALID_HELPER_HINT");
      const helpers = hint.value.helpers.map(value => {
        if (!object(value) || typeof value.helperId !== "string" || typeof value.address !== "string") throw new Error("INVALID_HELPER_HINT");
        return new HelperClient({ ...this.options.identity, helperId: value.helperId, address: value.address,
          token: this.options.token, timeoutMs: this.options.timeoutMs }, this.wire);
      });
      const route = new LeaderRoute(helpers);
      const state = await route.call<T>("read", args);
      this.route = route;
      return state;
    }
  }
}
