import type { ControlArguments, HelperAccess, Operation } from "./helper-client.ts";

/** Provisioned routes only. Barrier reads may discover a new leader; writes
 * are sent once to the last successful read destination. Retry semantics and
 * command IDs belong to the caller, including after a lost commit reply. */
export class LeaderRoute implements HelperAccess {
  private readonly helpers: readonly HelperAccess[];
  private preferred = 0;
  constructor(helpers: readonly HelperAccess[]) {
    if (!helpers.length || helpers.length > 9) throw new Error("Expected 1–9 helper routes");
    this.helpers = [...helpers];
  }
  async call<T = unknown>(operation: Operation, args: ControlArguments = {}): Promise<T> {
    if (operation !== "read") return this.helpers[this.preferred].call<T>(operation, args);
    let failure: unknown;
    const first = this.preferred;
    for (let offset = 0; offset < this.helpers.length; offset++) {
      const index = (first + offset) % this.helpers.length;
      try {
        const state = await this.helpers[index].call<T>(operation, args);
        this.preferred = index;
        return state;
      } catch (error) { failure = error; }
    }
    throw failure;
  }
}
