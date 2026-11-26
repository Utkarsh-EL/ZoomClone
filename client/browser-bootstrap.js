import { BrowserAttachment, pollIntervalMs } from "/attachment.js";

const status = document.getElementById("status");
try {
  const attachment = await BrowserAttachment.connect();
  globalThis.attachment = attachment;
  // This diagnostic page exercises the attachment API; the meeting UI will
  // consume the same adapter and own its display position in the local inbox.
  async function refresh() {
    try { status.textContent = JSON.stringify(await attachment.view(), null, 2); }
    catch (error) { status.textContent = error.message; }
    if (attachment.readyState === "attached") setTimeout(refresh, pollIntervalMs);
  }
  attachment.addEventListener("close", () => { status.textContent = "Agent connection closed. Reload to reattach."; });
  addEventListener("pagehide", () => attachment.close(), { once: true });
  await refresh();
} catch (error) { status.textContent = error.message; }
