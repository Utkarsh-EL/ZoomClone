/** Lamport time for the current backend's stamped control messages. */
export class LamportClock {
  time = 0;

  tick(): number {
    this.time += 1;
    return this.time;
  }

  receive(remote: unknown): number {
    if (remote !== undefined && !(Number.isSafeInteger(remote) && (remote as number) >= 0)) {
      throw new Error("Invalid Lamport timestamp");
    }
    this.time = Math.max(this.time, (remote as number | undefined) ?? 0) + 1;
    return this.time;
  }
}
