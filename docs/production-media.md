# Provisioned production media composition

Continues `be0dc1d`, the [capture feasibility checkpoint](media-feasibility.md) and the production composition in `3609d91`/`9240bce`. Media uses the same authenticated production runtime ingress as the durable participant session. When media is provisioned, the normal participant page now exposes supervised microphone/camera/display, playback and connection controls. Continuous backend intention reconciliation and broader deployment remain unfinished.

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

Bounded jittered retries apply only to explicit pre-effect `NOT_READY` and certified `MEDIA_ROUTE_UNAVAILABLE` lookup/connect rejection, including cleanup. At most 64 attempts may start within a four-second retry window; each individual request retains its existing timeout. Once a media packet has been sent, timeouts and unknown outcomes require transport rebuild instead of retrying that effect. Browser supervision bounds those rebuilds as described below. ClientSession's domain retries, uncertainty, command IDs, readiness and renewal settings are unchanged. Subscription revision zero remains unfiltered.

## Participant controls and lifecycle

Configure the optional bundle above, open the participant's private browser URL, and choose **Connect media** to receive remote sources. Claim the local capture lease, then explicitly turn on microphone/camera or select **Share display** while holding the committed share turn. Permission denial, missing/busy devices and canceled display selection show actionable status. Capture starts only from a user action. Microphone/camera off stops the device track; turning it on asks the browser again as needed. Display Stop stops locally and attempts to release the exact captured request through the shared submission guard. **Disconnect media** stops local capture and tears down the transient peer; it does not release the participant's SQL share turn.

The page distinguishes logical share ownership, capture awaiting permission, live capture with publication unavailable, acknowledged publication, transport connection and remote playback. Remote audio/video starts muted; **Play with sound** explicitly enables playback and reports a blocked attempt. Audible playback on physical devices remains unproved. A publication acknowledgement is not a measurement of another participant's reception.

One controller supervises each attachment. It polls producer availability every 1.5 seconds without overlapping ticks. Transport failure triggers at most three consecutive rebuild attempts; successful polling resets the budget only when transports required by current publication/reception are connected. Successful signaling alone cannot erase repeated ICE/DTLS establishment failures. Pending playback settles independently of polling, binds both the lifecycle revision and latest mute/play choice, and reports starting/blocked/playing without holding recovery open. After exhaustion, **Retry media** starts a new explicit budget. Rebuilds retain only exact live capture entries under the same lease revision and current observed screen grant; they never reopen permission prompts, rejoin, allocate a domain command or retry a lost domain submission. This is bounded interruption recovery, not seamless media failover.

Opening/rebuilding and explicit teardown are serialized. A monotonically increasing browser operation revision pins every signaling callback and its SFU epoch; late open/load/connect/produce/consume/reconnect completions cannot install work into a newer lifecycle. Current snapshots cancel capture on grant/request/version changes, membership loss and pending/resolved leave. Lease revision changes cancel pending permission and live tracks, including same-tab loss/reclaim. Snapshots only withdraw local work; each new effect still freshly authorizes through SQL/runtime fences. A backend failure alone does not prove existing external RTP stopped.

Track-ended and explicit display Stop use ParticipantModel's persisted uncertainty guard and original command review. Lost acceptance replies remain uncertain through reload. If another submission is busy, shared leave/release is pending, the current grant differs, or the view/acceptance is uncertain, capture stops locally and the page asks the participant to review the shared commands/current turn. It never waits to automatically submit a replacement release. Capture loss or membership/grant revocation creates no release command.

Release review belongs to one stopped display and its exact holder/request/grant version. Observing that turn resolved or replaced, membership loss or departure clears its banner; installing a later display track also supersedes it. Reviewing command uncertainty alone, unrelated camera capture and canceled display selection retain review of the same unresolved turn. Late release replies cannot restore obsolete review or overwrite a newer release attempt. The original accepted release ID remains observable across turn resolution, including resolution observed before acceptance returns. These display transitions never clear the shared model's persisted uncertainty or submit another command.

SQL checks current ACTIVE ownership and authenticates the participant before returning `NOT_MEMBER`. An explicit departed-participant `closePeer` may then retire only its previously admitted peer under that peer's exact stored owner/epoch. It cannot sync, publish or admit new resources from retained state. Unknown peers create no cleanup effect and invalid credentials still fail. Unconfirmed external teardown is reported instead of claiming quiescence.

## Effect observations

The provisioned observation file atomically replaces a bounded latest-run JSON list of at most 64 `starting`, `applied` or `uncertain` records. It contains only action, observation time, SFU epoch and generation. Resume secrets, SFU capabilities, peer IDs, RTP, ICE and DTLS data are excluded. Transient Windows `EPERM`/`EBUSY` replacement failures retry only the rename, at most ten attempts with 50ms waits; the SFU effect is not replayed. A persistent filesystem failure rejects the control with a sanitized `MEDIA_OBSERVATION_*` code. Crash-surviving `starting` records have an unknown effect outcome. This diagnostic journal is separate from SQL's committed intentions, is reset for a new runtime run, and never authorizes or automatically retries work.

## Acceptance and next increment

Run `npm run test:media` with Docker Desktop, Go, Node >=24.16 and Chromium. It uses two production runtime compositions, real helper/SQL fences and two durable participant agents with the optional production media bridge. It retains native permission denial, picker cancel, source-ended exact release, local lease replacement, inbound audio bytes and decoded camera/display frames. Directed TCP cuts isolate the old runtime's coordinator path and the successor's SFU path while keeping SQL reachable; chat takes over, old SQL authority is refused, and healing reconciles the same SFU. Old-runtime drain cannot close successor transports. The test explicitly checks participant shutdown drain. The [evidence](../evidence/production_media_run/result.json) records exact checked results and limits.

The supervised controller increment is described in the [plan and review ledger](superpowers/plans/2026-11-26-participant-media.md) and [checked evidence](../evidence/participant_media_run/result.json). Its native acceptance operates the actual page controls, received audio bytes/decoded camera/display frames, browser-generated ended release, automatic SFU recovery, directed runtime isolation/takeover, immediate local leave stop and shutdown drain. The subsequent bounded release-review correction and verification are recorded in the ledger and current handoff. Physical devices, audible playback, browser toolbar Stop sharing automation, arbitrary packet loss, independently hosted runtimes and SFU, multi-device networking, committed subscription eligibility, disconnect grace and full deployment remain unproved or unfinished. The native runtimes run in one host test process; media worker and browsers are independent processes. TCP cuts are real directed faults, not independent-host resilience.
