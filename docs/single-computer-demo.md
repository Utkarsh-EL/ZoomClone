# Single-computer assignment demo

This is the supported Windows/localhost demo. It runs three durable Raft helpers, four Chord discovery peers, two independent meeting runtimes, four participant agents and a Docker SFU, with PostgreSQL in Docker. All participant pages share their own agent's durable browser/CLI session. The demo is local; it does not claim independent-host resilience or production deployment readiness.

## Launch and controls

Install the repository prerequisites once: Node.js 24.16+, Go 1.26+, Docker Desktop running with Linux containers, and `npm install`. Chrome or Edge is needed for the automated rehearsal. Then run from the repository root:

```powershell
npm run demo:start
npm run demo:status
npm run demo:stop
```

Start builds the current helper and browser media bundle, provisions PostgreSQL and the SFU image if needed, waits for a committed READY assignment matching ACTIVE SQL ownership and connected agents, and opens Alice, Bob, Charlie and Outsider pages in the default browser. Initial image creation can take several minutes. The printed private URLs are the fallback if default-browser opening is unavailable. `npm run demo:start -- --no-open` prints URLs without opening pages. `npm run demo:open` opens the current URLs again.

Stop drains participant/media work before shutting down runtimes, discovery, helpers and the owned SFU/PostgreSQL containers. It keeps PostgreSQL volumes, helper logs/state and participant journals. A clean result has no cleanup errors. Failed or forced cleanup is printed and returns a failing stop exit status; ownership records remain held rather than permitting a second supervisor to reuse uncertain resources. Do not delete `.local/demo` or volumes to repair a startup problem.

Status reports current helper/SQL observations, process counts and participant progress. `ready` means the meeting and current participants are usable; after failover, the reduced runtime count shows the missing spare. `unreachable` means supervisor control and cleanup are unconfirmed, not a successful shutdown. Media `listening` reports its control process; actual reception is shown in the pages and verified by rehearsal.

## Rehearsal (about ten minutes)

1. Start, check status, and arrange Alice/Bob side by side. Keep Charlie and Outsider available for group delivery/privacy checks.
2. In Alice and Bob, choose **Claim for this tab**, **Connect media**, then turn on microphone and camera. Grant browser permissions. Click **Play with sound** on one page. On one computer, mute the other playback or use headphones to avoid feedback. Starting the application, connecting media or holding a share turn never starts capture automatically.
3. Send a meeting message from Alice. Bob, Charlie and Outsider should receive it.
4. Alice requests the share turn; Bob requests next and appears in the queue. Alice chooses **Share display** and selects a source in the browser picker. Bob receives it. Stop display capture; the exact turn releases and passes to Bob. Bob's display does not start automatically. Release Bob's unused turn.
5. Under **Private groups**, Alice creates a group and sends an early message. Invite Bob and Charlie using the participant selector. Each explicitly accepts and sees the earlier message. Alice publishes another message; both receive it. Outsider has no group or private message payload. Invitations alone give no message-history access.
6. Crash the active runtime and wait for the command to report recovery:

   ```powershell
   npm run demo:fail-runtime
   npm run demo:status
   ```

   The generation advances, participant identities remain, and chat/groups continue. Media rebuilds under the successor; check publishing/received playback in the pages. If the bounded automatic media budget is exhausted, **Retry media** is explicit. One spare supports one runtime-crash demonstration per start. Stop/start replenishes the spare.

7. Bob leaves the private group. Later group messages reach Charlie but not Bob; Bob can inspect his downloaded earlier history. This leaves his meeting membership and media alone.
8. Demonstrate participant recovery:

   ```powershell
   npm run demo:fail-participant -- Bob
   npm run demo:restart-participant -- Bob
   ```

   Bob's new page has the same identity, original pending outcomes and retained history. Deliberate group leave remains effective. Capture does not restart without explicit browser interaction. Restart without a prior crash is also supported.
9. Stop, start again, and inspect the same meeting/history/subscriptions. Stop/start is not meeting leave. If someone explicitly chooses **Leave meeting**, their completed session stays left. To bring that name back with a new identity, preserving the old journal:

   ```powershell
   npm run demo:new-participant -- Bob
   ```

   This action is allowed only after durable meeting leave. Old private memberships are not restored. Normal restart never replaces an identity.
10. Finish with `npm run demo:stop` and confirm clean shutdown.

## Automated acceptance and evidence

```powershell
npm test
npm run typecheck
npm run test:runtimes
npm run test:groups
npm run test:browser
npm run test:media
npm run test:consensus
npm run test:demo
npm run demo:rehearse
```

`test:consensus` includes broad Raft/helper race suites, vet/build and the coordinator process scenario; it is broader than `test:coordinator`. `test:runtimes` includes storage and ownership recovery, uncertain original-ID replies and participant process takeover. `test:demo` checks real start/status/authorization/crash/restart/stop/resume and missing-journal refusal. `demo:rehearse` runs the real launcher and browser flow with synthetic microphone/camera and automated display selection, then checks retained full-stack restart and clean shutdown. Test demos use isolated directories under `.local/demo-rehearsals`, never the default demo's journals.

Sanitized checked results are recorded under `evidence/single_computer_demo_run/`. Private runtime manifests, journal credentials, attachment URLs and full diagnostic logs remain ignored under `.local/`. Timestamped component frames/logs carry Lamport clocks; Raft replicates coordinator metadata, while chat/group history is transactional and durable in the single PostgreSQL instance. PostgreSQL replication is not claimed.

## Limits and recovery policy

- Automated media evidence uses synthetic devices and proves received audio bytes/decoded frames, plus browser playback state. Physical microphones/cameras, audible output and interactive display selection need a short device preflight on the presentation machine.
- Local Docker networking is supported. TURN, independent hosts, internet deployment, disconnect grace and meeting-code entry are unfinished. Participants enter through the generated local pages.
- Group privacy is enforced by membership on every new SQL-authorized page/publication. Already downloaded or authorized-in-flight data cannot be recalled. The server/database handles private contents; this is not end-to-end encryption.
- Never run old participant processes against the upgraded database/journal. The one supported participant protocol is v2; old binaries/formats fail explicitly. Missing, empty, replaced or incompatible journals are refused instead of creating new identities.
- Use the stop command, rather than killing the supervisor. Abrupt supervisor death can leave uncertain resources and a stale lock. The launcher refuses automatic lock reclamation, PID-based process killing, or destructive reset; ownership recovery is then a genuine manual blocker. Retain state and logs. A missing helper/SQL identity also requires restoration, not automatic rebootstrap.
