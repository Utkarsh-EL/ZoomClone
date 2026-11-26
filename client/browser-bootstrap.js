import { BrowserAttachment, pollIntervalMs, mediaEnabled } from "/attachment.js";
import { ParticipantModel } from "/participant-model.js";

const $ = id => document.getElementById(id);
const text = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };
const node = (tag, content, className) => { const el = document.createElement(tag); el.textContent = content; if (className) el.className = className; return el; };
const signatures = new Map();
const commandNodes = new Map();
function list(id, data, render) {
  const signature = JSON.stringify(data);
  if (signatures.get(id) === signature) return false;
  signatures.set(id, signature); $(id).replaceChildren(...render()); return true;
}
const labels = { join: "Join meeting", chat: "Send message", "request-share": "Request share turn", "release-share": "Release share turn", leave: "Leave meeting" };

try {
  const attachment = await BrowserAttachment.connect();
  globalThis.attachment = attachment;
  const model = new ParticipantModel(attachment, {
    load: key => JSON.parse(sessionStorage.getItem(key) || "null"),
    save: (key, value) => sessionStorage.setItem(key, JSON.stringify(value)),
  });
  let timer, stopped = false, wasFollowing = false, participantMedia;
  const participantName = id => model.state?.members[id]?.name ?? (id === model.view?.participantId ? model.view.name : `Participant ${String(id).slice(0, 8)}`);
  function render() {
    const v = model.view, state = model.state;
    text("attachment-status", model.attached ? "attached" : "closed");
    $("reattach").hidden = model.attached;
    const connection = model.left ? "left" : model.leaving ? "leave pending" : v?.connection ?? "connecting";
    text("session-status", connection); $("session-status").dataset.state = connection;
    $("error").hidden = !model.error; text("error", model.error);
    $("uncertainty").hidden = !model.uncertain || model.busy;
    $("reviewed").disabled = model.busy || !model.attached || !v;
    $("leave").disabled = !model.canSubmit;
    $("leave-submit").disabled = !model.canSubmit;
    if (model.leaving || model.left) $("leave-confirm").hidden = true;
    $("chat-input").disabled = !model.canSubmit;
    $("send").disabled = !model.canSubmit || !$("chat-input").value.trim();
    text("composer-help", model.left ? "You have left. Retained history is still available." : model.leaving ? "Leave is pending. Your agent will resolve its original command." : !model.attached ? "Agent connection closed. Reload to inspect pending commands." : model.uncertain ? "Review the interrupted submission before sending again." : "Messages are saved by your agent before delivery. Maximum 8192 UTF-8 bytes.");
    if (!v) return;
    text("meeting-title", `Meeting ${v.observation?.code ?? v.meetingId.slice(0, 8)}`);
    text("identity", `${v.name} · shared browser and CLI participant`);
    const members = Object.entries(state?.members ?? {}).filter(([, m]) => m.joined);
    text("roster-count", state ? String(members.length) : "");
    list("roster", members, () => members.length ? members.map(([id, member]) => {
      const li = document.createElement("li"); li.append(node("span", member.name)); li.title = id;
      if (id === v.participantId) li.append(node("span", "You", "tag")); return li;
    }) : [node("li", state ? "No joined participants in the last snapshot." : "Waiting for a meeting snapshot.", "empty")]);
    const historyChanged = list("history", [model.events, members, v.participantId], () => model.events.length ? model.events.map(event => {
      const li = document.createElement("li"), p = event.payload, sequence = node("span", `#${event.seq}`, "sequence");
      if (event.kind === "chat") {
        const heading = node("div", "", "event-heading"); heading.append(node("strong", participantName(p.participantId)), sequence);
        li.append(heading, node("p", p.content, "message"));
      } else {
        li.className = "system-event";
        const description = event.kind === "joined" ? `${p.name} joined the meeting` : event.kind === "left" ? `${participantName(p.participantId)} left the meeting` : event.kind === "share-changed" ? `${p.holder ? `${participantName(p.holder.participantId)} holds the share turn` : "Share turn is available"} · ${p.queue.length} waiting` : event.kind;
        const heading = node("div", "", "event-heading"); heading.append(node("span", description), sequence); li.append(heading);
      }
      return li;
    }) : [node("li", "No retained events yet. Messages will appear here after your agent receives them.", "empty")]);
    if (model.followLatest && (historyChanged || !wasFollowing)) $("history").scrollTop = $("history").scrollHeight;
    wasFollowing = model.followLatest;
    const first = model.events[0]?.seq, last = model.events.at(-1)?.seq;
    text("page-status", `${first ? `Events ${first}–${last}` : "No events"} · ${model.followLatest ? "following latest" : "browsing history"}`);
    $("older").disabled = !model.attached || model.paging || model.after === 0;
    $("newer").disabled = !model.attached || model.paging || !last || last >= v.cursor.seq;
    $("latest").disabled = !model.attached || model.paging || model.followLatest;
    text("share-status", !state ? "Waiting for a meeting snapshot." : state.holder ? `${participantName(state.holder.participantId)} holds the turn.${model.sharePosition ? ` You are #${model.sharePosition} in the queue.` : ""}` : "The share turn is available.");
    list("share-queue", [state?.queue, members], () => (state?.queue ?? []).map(request => node("li", `${participantName(request.participantId)}${request.participantId === v.participantId ? " (you)" : ""}`)));
    $("share-request").hidden = !!model.ownShare;
    $("share-request").disabled = !model.canSubmit || model.sharePending || !state;
    text("share-request", model.sharePending ? "Share command pending…" : "Request share turn");
    $("share-release").hidden = !model.ownShare;
    $("share-release").disabled = !model.canSubmit || model.sharePending;
    text("share-release", model.sharePending ? "Share command pending…" : model.sharePosition ? "Cancel queued request" : "Release share turn");
    const owner = attachment.captureState.owner;
    text("capture-status", !model.attached ? "Ownership unknown while this tab is detached. Reattach to inspect it." : attachment.ownsCapture ? "This tab owns the local capture lease." : owner ? `Another tab owns the local capture lease (${owner.id.slice(0, 8)}).` : "No browser owns capture.");
    $("capture-claim").hidden = attachment.ownsCapture;
    $("capture-claim").disabled = !model.canSubmit || model.captureBusy;
    text("capture-claim", owner ? "Replace owner with this tab" : "Claim for this tab");
    $("capture-release").hidden = !attachment.ownsCapture;
    $("capture-release").disabled = !model.canSubmit || model.captureBusy;
    const pending = v.commands.filter(c => !c.outcome).length;
    text("command-status", `${pending} pending · ${v.commands.length - pending} outcomes`);
    // Keep keyed command nodes so CLI/outcome updates cannot interrupt a
    // participant inspecting original contents or moving through summaries.
    const retained = new Set(v.commands.map(c => c.id));
    for (const [id, element] of commandNodes) if (!retained.has(id)) { element.remove(); commandNodes.delete(id); }
    let previous = null;
    for (const command of [...v.commands].reverse()) {
      let li = commandNodes.get(command.id);
      if (!li) {
        li = document.createElement("li");
        const details = document.createElement("details"), summary = document.createElement("summary");
        summary.append(node("span", labels[command.operation.type] ?? command.operation.type), node("span", "", "command-state"), node("code", command.id, "command-id"));
        details.append(summary, document.createElement("pre")); li.append(details); commandNodes.set(command.id, li);
      }
      const signature = JSON.stringify(command);
      if (li.dataset.record !== signature) {
        li.dataset.record = signature;
        const status = li.querySelector(".command-state"); status.textContent = command.outcome?.code ?? "Pending";
        status.className = `command-state ${!command.outcome ? "pending" : command.outcome.code === "OK" ? "" : "rejected"}`;
        li.querySelector("pre").textContent = JSON.stringify({ operation: command.operation, outcome: command.outcome }, null, 2);
      }
      const expected = previous ? previous.nextElementSibling : $("commands").firstElementChild;
      if (li !== expected) $("commands").insertBefore(li, expected);
      previous = li;
    }
    const observation = v.observation;
    text("snapshot-status", observation ? `Last meeting snapshot: ${observation.observedAt} · event watermark ${observation.watermark}. Local inbox through ${v.cursor.seq}. ${v.connection !== "connected" || !model.attached ? "Retained state may be out of date." : ""}` : "No meeting snapshot yet. Your agent is connecting; saved commands remain pending.");
    const details = { Participant: v.participantId, Meeting: v.meetingId, Cluster: v.clusterId, "Subscription revision": "0 · all meeting events", "Local attachment": `${attachment.attachment.id} · revision ${attachment.attachment.revision}`, "Capture revision": String(attachment.captureState.revision) };
    list("session-details", details, () => Object.entries(details).flatMap(([key, value]) => [node("dt", key), node("dd", value)]));
    renderMedia();
  }
  function renderMedia() {
    if (!participantMedia) return;
    const controller = participantMedia, media = controller.media, capture = media.capture;
    text('media-status', controller.exhausted ? 'Media unavailable. Automatic retries stopped.' : !controller.enabled ? 'Media is off.' : media.state === 'ready' ? 'Media connected. Sources publish only when started below.' : `Media ${media.state} · rebuild attempt ${controller.attempts} of 3.`);
    $('media-connect').hidden = controller.enabled && !controller.exhausted;
    $('media-connect').disabled = !controller.eligible;
    text('media-connect', controller.exhausted ? 'Retry media' : 'Connect media');
    $('media-disconnect').hidden = !controller.enabled;
    const names = { mic: 'Microphone', camera: 'Camera', screen: 'Display' };
    for (const source of ['mic', 'camera', 'screen']) {
      const entry = capture.tracks.get(source), pending = capture.pending.has(source), active = entry?.track.readyState === 'live';
      text(`${source}-status`, `${names[source]} ${pending ? 'awaiting permission' : active ? media.state === 'ready' && media.producers.has(entry.producer?.id) ? 'publishing' : 'captured · publication unavailable' : 'off'}`);
      text(`media-${source}`, pending ? `Cancel ${names[source].toLowerCase()}` : active ? source === 'screen' ? 'Stop display and release turn' : `Turn ${names[source].toLowerCase()} off` : source === 'screen' ? 'Share display' : `Turn ${names[source].toLowerCase()} on`);
      $(`media-${source}`).disabled = !active && !pending && (!controller.canStart || (source === 'screen' && model.state?.holder?.participantId !== model.view?.participantId));
    }
    $('media-release-review').hidden = !capture.releaseNeedsReview;
    text('playback-status', `Remote playback ${media.playback} · ${media.consumers.size} received sources.`);
    text('media-play', ['playing', 'starting'].includes(media.playback) ? 'Mute playback' : 'Play with sound');
    $('media-play').disabled = !media.consumers.size;
    $('media-error').hidden = !controller.error; text('media-error', controller.error);
  }
  model.addEventListener("change", render);
  $("chat-input").addEventListener("input", () => { $("send").disabled = !model.canSubmit || !$("chat-input").value.trim(); });
  $("chat-form").addEventListener("submit", async event => {
    event.preventDefault(); const content = $("chat-input").value;
    const id = await model.submit({ type: "chat", content });
    if (id && $("chat-input").value === content) $("chat-input").value = "";
    render(); if (model.canSubmit) $("chat-input").focus();
  });
  for (const action of ["older", "newer", "latest"]) $(action).addEventListener("click", () => model[action]());
  $("share-request").addEventListener("click", () => model.submit({ type: "request-share" }));
  $("share-release").addEventListener("click", () => { if (model.ownShare) model.submit({ type: "release-share", requestId: model.ownShare.requestId }); });
  $("capture-claim").addEventListener("click", () => model.capture("claim"));
  $("capture-release").addEventListener("click", () => model.capture("release"));
  $("leave").addEventListener("click", () => { $("leave-confirm").hidden = false; $("leave-cancel").focus(); });
  $("leave-cancel").addEventListener("click", () => { $("leave-confirm").hidden = true; $("leave").focus(); });
  $("leave-submit").addEventListener("click", () => model.submit({ type: "leave" }));
  $("reviewed").addEventListener("click", () => model.reviewUncertain());
  $("reattach").addEventListener("click", () => location.reload());
  async function poll() {
    await model.refresh();
    if (!stopped && model.attached) timer = setTimeout(poll, pollIntervalMs);
  }
  addEventListener("pagehide", () => { stopped = true; clearTimeout(timer); participantMedia?.dispose(); model.dispose(); attachment.close(); }, { once: true });
  render(); await poll();
  if (mediaEnabled && !stopped) {
    const [{ MediaLab }, { ParticipantMedia }] = await Promise.all([import('/media-lab.js'), import('/participant-media.js')]);
    if (!stopped) {
      const media = new MediaLab(attachment, { release: grant => model.releaseCaptured(grant), container: $('remote-media') });
      participantMedia = new ParticipantMedia(model, attachment, media); globalThis.participantMedia = participantMedia;
      participantMedia.addEventListener('change', renderMedia); $('media-section').hidden = false;
      $('media-connect').addEventListener('click', () => { void participantMedia.enable(); });
      $('media-disconnect').addEventListener('click', () => participantMedia.disable());
      for (const source of ['mic', 'camera', 'screen']) $(`media-${source}`).addEventListener('click', () => {
        if (media.capture.tracks.has(source) || media.capture.pending.has(source)) void participantMedia.stop(source);
        else void participantMedia.start(source);
      });
      $('media-play').addEventListener('click', () => { if (['playing', 'starting'].includes(media.playback)) media.mute(); else media.play(); });
      renderMedia();
    }
  }
} catch (error) {
  text("attachment-status", "unavailable");
  $("error").hidden = false;
  text("error", `${error.message}. Open the private browser URL from your running participant agent to attach.`);
  $("reattach").hidden = false; $("reattach").addEventListener("click", () => location.reload());
}
