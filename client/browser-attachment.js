// Served as a native browser module. Configuration contains public wire identity,
// never participant resume credentials or the attachment capability.
const config = /*ATTACHMENT_CONFIG*/null;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class BrowserAttachment extends EventTarget {
  #socket;
  #pending = new Map();
  #clock = 0;
  #identity = { nodeId: crypto.randomUUID(), incarnation: crypto.randomUUID() };
  readyState = "connecting";
  attachment = null;
  captureState = { revision: 0, owner: null };

  static async connect() {
    const key = `zoom.attachment:${location.origin}`;
    const fragment = location.hash.slice(1);
    // Capability fragments never reach HTTP, referrers, or the server's logs.
    // sessionStorage keeps it in this tab across reload; clear the visible URL.
    if (fragment) history.replaceState(null, "", location.pathname);
    if (fragment && /^[A-Za-z0-9_-]{43}$/.test(fragment)) sessionStorage.setItem(key, fragment);
    const token = fragment || sessionStorage.getItem(key);
    if (!config || config.origin !== location.origin || !token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("ATTACHMENT_URL_REQUIRED");
    const client = new BrowserAttachment();
    client.#socket = new WebSocket(`${location.origin.replace("http:", "ws:")}/v1/attachment`, "zoom.attachment.v1");
    client.#socket.addEventListener("message", event => client.#receive(event));
    client.#socket.addEventListener("close", () => client.#closed());
    client.#socket.addEventListener("error", () => client.close());
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { client.close(); reject(new Error("ATTACHMENT_TIMEOUT")); }, config.timeoutMs);
      client.#socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      client.#socket.addEventListener("close", () => { clearTimeout(timer); reject(new Error("ATTACHMENT_CLOSED")); }, { once: true });
    });
    try {
      const result = await client.#call("attach", { token });
      client.attachment = result.attachment; client.captureState = result.capture; client.readyState = "attached";
      return client;
    } catch (error) { client.close(); throw error; }
  }

  #closed() {
    this.readyState = "closed";
    for (const request of this.#pending.values()) { clearTimeout(request.timer); request.reject(new Error("ATTACHMENT_CLOSED")); }
    this.#pending.clear(); this.dispatchEvent(new Event("close"));
  }

  #receive(event) {
    try {
      if (typeof event.data !== "string" || new TextEncoder().encode(event.data).length > 8 * 1024 * 1024) throw new Error("INVALID_ATTACHMENT_REPLY");
      const packet = JSON.parse(event.data);
      if (packet.version !== 2 || packet.clusterId !== config.clusterId || packet.nodeId !== config.nodeId || packet.incarnation !== config.incarnation
        || !uuid.test(packet.requestId) || !Number.isSafeInteger(packet.lamport) || packet.lamport < 1 || packet.lamport >= Number.MAX_SAFE_INTEGER - 2) throw new Error("INVALID_ATTACHMENT_REPLY");
      this.#clock = Math.max(this.#clock, packet.lamport) + 1;
      if (packet.kind === "control.event" && packet.body?.version === 1 && packet.body.event === "capture") {
        this.#capture(packet.body.capture); return;
      }
      const request = this.#pending.get(packet.requestId);
      if (packet.kind !== "control.reply" || !request) throw new Error("UNCORRELATED_ATTACHMENT_REPLY");
      this.#pending.delete(packet.requestId); clearTimeout(request.timer);
      if (packet.error) request.reject(new Error(packet.error.code));
      else { if (packet.body.capture) this.#capture(packet.body.capture); request.resolve(packet.body); }
    } catch { this.close(); }
  }

  #capture(capture) {
    if (capture.revision < this.captureState.revision) return;
    this.captureState = capture; this.dispatchEvent(new Event("capturechange"));
  }

  #call(action, body = {}) {
    if (this.#socket.readyState !== WebSocket.OPEN || this.#pending.size >= 32) return Promise.reject(new Error("ATTACHMENT_UNAVAILABLE"));
    const requestId = crypto.randomUUID();
    const packet = { version: 2, clusterId: config.clusterId, ...this.#identity, requestId, lamport: ++this.#clock, kind: "control",
      body: { version: 1, action, ...(this.attachment ? { attachment: this.attachment } : {}), ...body } };
    const text = JSON.stringify(packet);
    if (new TextEncoder().encode(text).length > 64 * 1024 || this.#socket.bufferedAmount > 64 * 1024) return Promise.reject(new Error("ATTACHMENT_INPUT_LIMIT"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(requestId); reject(new Error("ATTACHMENT_TIMEOUT")); this.close(); }, Math.min(config.timeoutMs, 10000));
      this.#pending.set(requestId, { resolve, reject, timer });
      try { this.#socket.send(text); } catch { this.close(); }
    });
  }

  view(after = 0, limit = 16) { return this.#call("view", { after, limit }); }
  // A failed submit can already be durable. Reattach and inspect commands;
  // never automatically resubmit an operation after uncertainty.
  submit(operation) { return this.#call("submit", { operation }); }
  claimCapture(captureRevision = this.captureState.revision) { return this.#call("capture.claim", { captureRevision }); }
  releaseCapture(captureRevision = this.captureState.revision) { return this.#call("capture.release", { captureRevision }); }
  media(request) { return this.#call("media", { media: request }).then(result => result.media); }
  get ownsCapture() { return this.readyState === "attached" && this.captureState.owner?.id === this.attachment?.id && this.captureState.owner?.revision === this.attachment?.revision; }
  close() { this.#socket.close(); }
}

export const pollIntervalMs = config ? Math.max(10, Math.min(500, Math.floor(config.timeoutMs / 3))) : 500;
export const mediaEnabled = !!config?.mediaEnabled;
