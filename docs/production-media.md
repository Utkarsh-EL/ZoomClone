# Provisioned production media composition

Continues `be0dc1d` and the [capture feasibility checkpoint](media-feasibility.md). Media now uses the same authenticated production runtime ingress as the durable participant session. This is a bounded backend/API integration; the normal participant page still exposes logical share and capture-lease controls. Camera/microphone/display widgets, playback status, continuous reconciliation and automatic browser reconnect supervision remain the next increment.

## Provisioning

Build the pinned SFU image and browser module:

```powershell
docker build --file services/media/Dockerfile --tag zoomclone-media-feasibility:3.32.2 .
npm run build:media
```

Each SFU process hosts **one provisioned meeting**. Supply private environment variables `MEDIA_CLUSTER_ID`, `MEDIA_NODE_ID`, `MEDIA_MEETING_ID`, `MEDIA_TOKEN` (at least 64 bytes), `MEDIA_PORT` and `MEDIA_CALLERS`. The last is a JSON array of `{nodeId, incarnation}` for the exact runtime processes allowed to control it, including takeover candidates; at most 128 entries. `MEDIA_CALLER_ID` from the old feasibility harness is superseded. Read actual runtime startup identities before starting the SFU; restarting a runtime requires reprovisioning its new incarnation. A caller-list change currently requires restarting the SFU and rebuilding media.

Publish the SFU's HTTP control port 8080 on a literal loopback host port, plus the single configured media port for both UDP and TCP. `MEDIA_ANNOUNCED_ADDRESS` defaults to `127.0.0.1`; provision an address reachable by browsers for another deployment. Non-loopback control access, TURN and school-network addressing are unproved.

Add this optional field to every candidate's protected `ZOOM_RUNTIME_CONFIG`:

```json
{
  "participants": {"address": "127.0.0.1:58081", "token": "<private participant ingress token>"},
  "media": {"routes": [{
    "meetingId": "<meeting UUID>",
    "address": "http://127.0.0.1:58080",
    "nodeId": "<SFU node UUID>",
    "token": "<private SFU capability>",
    "observationPath": ".local/media/runtime-a-meeting.json"
  }]}
}
```

Routes are literal-loopback HTTP endpoints, bounded to 128 distinct meetings/endpoints. All candidates for a meeting must reach the **same SFU**, with the same provisioned meeting/node/capability. Use a separate observation file per runtime incarnation/meeting, never one shared file between processes. Unconfigured meetings return `MEDIA_UNPROVISIONED`; runtime media requires participant ingress. No browser input can allocate a new room or select an endpoint/capability.

Keep the participant's existing provisioned runtime routes, journal, target and browser configuration. Add `"media": {"bundlePath": ".local/media-lab.js"}` to protected `ZOOM_PARTICIPANT_CONFIG` to enable the optional media module and API. SFU control credentials remain on the runtimes. Browser media requests use the existing socket-bound attachment, private agent journal credential and shared ControlWire identity; they create no second ClientSession, join or command stream. `/media-lab.js` is absent by default. The module retains the `MediaLab` name but now exercises the production gateway.

## Authorization and fencing

Each ordinary media request freshly resolves READY metadata to a provisioned runtime incarnation. The gateway checks the exact requested owner and current RuntimeAuthority, then queues the room operation. When it executes, the room negotiates the SFU epoch **before** performing `MeetingStore.read` with that current authority and participant credential. The read checks ACTIVE SQL ownership, membership and screen holder/request/grant version in a short consistent transaction. No SQL transaction spans a media call. Retained inboxes, inspection observations and prior authorizations grant no permission.

After the read, serialized sync and the requested effect bind the negotiated epoch. Restart between negotiation/read/sync/effect yields `SFU_RESTARTED`; no previous-epoch packet can initialize an empty worker. Ordinary controls also bind the browser's opened epoch. The kernel enforces exact caller incarnation, owner/caller identity, configured meeting, monotonic caller timestamps, owner generations and grant versions. Increasing ownership closes old peers; screen replacement closes the previous screen first. Delayed old-owner cleanup checks each peer's installed owner and cannot tear down successor transports. Caller ordering also rejects a delayed open arriving after newer teardown.

SQL commitment and physical media cutover are distinct. An operation authorized before SQL cutover can overlap that transition until the serialized media fence completes. There is no instantaneous physical revocation promise. Current intentions are coalesced by a fresh read before controls; a continuous background intention reconciler is not implemented. Established RTP can continue when SQL/quorum or a new owner's SFU route is unavailable, but those failures admit no new media work.

Peer IDs are scoped by participant UUID, agent incarnation and attachment UUID. Publication requires the agent's local capture lease, pinned to its admission revision, so loss/reclaim of the same tab cannot revive old work. A bounded local bridge serializes controls and revocation across fresh runtime route selection. Failed cleanup blocks successor publication and remains available for explicit drain; a full set of failed cleanup slots can be drained before a new attachment is admitted. Cleanup does not release the shared participant's SQL share grant.

There are eight peer slots and sixteen queued ordinary controls per room/agent bridge, two pending requests per browser attachment, and a separate sixteen-request media budget at runtime ingress. SFU waits do not spend the durable command/replay admission budget. Definitive pre-effect rejection releases unused room reservations; uncertain effects retain cleanup state. Shutdown seals admission and waits for admitted work and teardown before closing the agent journal or runtime database pools. A failed drain reports an error; it never proves an unreachable SFU quiescent.

Bounded jittered retries apply only to explicit pre-effect `NOT_READY` and certified `MEDIA_ROUTE_UNAVAILABLE` lookup/connect rejection, including cleanup. At most 64 attempts may start within a four-second retry window; each individual request retains its existing timeout. Once a media packet has been sent, timeouts and unknown outcomes require explicit rebuild. ClientSession's domain retries, uncertainty, command IDs, readiness and renewal settings are unchanged. Subscription revision zero remains unfiltered.

## Effect observations

The provisioned observation file atomically replaces a bounded latest-run JSON list of at most 64 `starting`, `applied` or `uncertain` records. It contains only action, observation time, SFU epoch and generation. Resume secrets, SFU capabilities, peer IDs, RTP, ICE and DTLS data are excluded. Transient Windows `EPERM`/`EBUSY` replacement failures retry only the rename, at most ten attempts with 50ms waits; the SFU effect is not replayed. A persistent filesystem failure rejects the control with a sanitized `MEDIA_OBSERVATION_*` code. Crash-surviving `starting` records have an unknown effect outcome. This diagnostic journal is separate from SQL's committed intentions, is reset for a new runtime run, and never authorizes or automatically retries work.

## Acceptance and next increment

Run `npm run test:media` with Docker Desktop, Go, Node >=24.16 and Chromium. It uses two production runtime compositions, real helper/SQL fences and two durable participant agents with the optional production media bridge. It retains native permission denial, picker cancel, source-ended exact release, local lease replacement, inbound audio bytes and decoded camera/display frames. Directed TCP cuts isolate the old runtime's coordinator path and the successor's SFU path while keeping SQL reachable; chat takes over, old SQL authority is refused, and healing reconciles the same SFU. Old-runtime drain cannot close successor transports. The test explicitly checks participant shutdown drain. The [evidence](../evidence/production_media_run/result.json) records exact checked results and limits.

The next product increment should supervise a single browser media controller, invalidate stale transport callbacks across opens/reconnects, reconcile local tracks on membership/grant changes, preserve the UI's durable submission uncertainty guard for ended/release, and add explicit capture/mute/playback status with bounded reconnect. Physical devices, audible playback, browser toolbar Stop sharing automation, arbitrary packet loss, independently hosted runtimes and SFU, multi-device networking, disconnect grace and full deployment remain unproved or unfinished. The native runtimes run in one host test process; media worker and browsers are independent processes. TCP cuts are real directed faults, not independent-host resilience.
