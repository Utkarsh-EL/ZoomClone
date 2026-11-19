# CECS 327 Milestone 4: Coordination for Distributed Decision-Making

This milestone adds coordination to the Milestone 3 peer-to-peer overlay. Every peer keeps a Lamport logical clock and stamps it on every message. The peers elect a leader with a ring election that runs over the overlay's own successor pointers. The leader runs a lock that protects a shared resource: the meeting minutes, a file that every peer appends to. When the leader fails, the survivors elect a new one, and it rebuilds the lock state before it grants anything. No two peers ever edit the minutes at once.

The same leader also runs a second lock, the presenter slot, which makes video sharing safe: one peer at a time shares a camera, a screen or a test pattern with everyone in the meeting. Each peer can serve a page on `127.0.0.1` to watch and share.

The prototype shares video frames (JPEG or SVG images, about 8 to 10 per second). It does not carry audio.

## What the coordination layer does

| Assignment requirement | Where it is implemented |
| --- | --- |
| Logical clock on each node | `protocol.ts`, class `LamportClock`; one per `Peer` (`peer.clock`) |
| Messages carry logical timestamps | `Peer.call` and `Peer.serve`: every request and reply has a `lamport` field |
| Leader election | Ring election: `Peer.startElection`, `onElection`, `onElected`, `onCoordinator` |
| Mutual exclusion | Centralized lock run by the leader: `Peer.acquire`, `Peer.release`, `onLockRequest`, `grantNext` |
| Event ordering | Lock queue ordered by (Lamport time, ring ID); `coord_demo.ts` writes a Lamport-ordered log |
| Shared resource | `minutes.ts`: meeting minutes numbered by a read-modify-write; `video.ts`: the presenter slot for video sharing |
| Leader failure | Followers ping the leader; a failure starts an election, and the coordinator message recovers the lock state |

Ring IDs come from `SHA-1(name) mod 2^16`, so the same names always give the same ring: `ora` 811, `sierra` 13800, `xray` 40128, `alpha` 52303. An election picks the highest ID, so `alpha` wins, and `xray` wins once `alpha` is gone.

## Run the coordination demo (one command)

Node.js 24.16 or newer is the only requirement (see [Required software](peer-to-peer-overlay.md#required-software)).

```sh
node coord_demo.ts
```

It takes about 6 seconds and prints `RESULT: PASS` at the end, exiting with code 0. Every peer is a separate OS process, and the demo checks each step:

1. `ora` starts alone and elects itself. `sierra`, `xray` and `alpha` join and learn that `ora` leads, with no new election.
2. `sierra` runs a ring election. The message visits all four peers, `alpha` (the highest ID) wins term 2, and `ora` steps down.
3. Without the lock, all four peers write 5 minutes each at the same time. Writers collide: entry numbers repeat.
4. With the lock, the same 20 writes produce entries 1 to 20 in order, with no collision, in Lamport order.
5. While `ora`, `sierra` and `xray` are writing under the lock, the leader `alpha` is killed. The survivors elect `xray`. It collects the waiting requests from the ring and resumes granting. All 24 entries come out in order.
6. `alpha` restarts and rejoins. It learns that `xray` leads and does not start an election.
7. The demo reads every peer's log and checks that each message was received at a later Lamport time than it was sent.

Output is saved in `evidence/coord_run/`:

| File | Contents |
| --- | --- |
| `demo_transcript.txt` | Every process's log merged in wall-clock order |
| `lamport_order.txt` | Every event that carries a Lamport time, ordered by (Lamport time, peer name) |
| `minutes_unprotected.jsonl`, `minutes_locked.jsonl`, `minutes_failover.jsonl` | The shared minutes after steps 3, 4 and 5 |
| `<peer>.console.txt`, `demo.console.txt` | One process's own log; the demo's log holds the step checks and measurements |

Results of the committed run:

| Measurement | Value |
| --- | --- |
| Unprotected run | 16 of 20 entries collided, 14 entry numbers used twice |
| Locked run | 20 entries, 0 collisions, entry order equals Lamport order |
| Lock cost | 3 messages per entry for a peer that is not the leader (request, grant, release); the leader's own entries need none |
| Leader crash to new leader ready | 0.2 s on localhost, where a dead port refuses connections at once |
| Failover run | 24 entries, 0 collisions, entry order equals Lamport order |
| Message pairs checked | 124, every receive later than its send |

## How it works

### Logical clocks

Each peer has one `LamportClock` and applies three rules:

- **Local event** (a lock request, entering or leaving the critical section, a leader change): add 1.
- **Send:** add 1 and put the value in the message's `lamport` field.
- **Receive:** set the clock to `max(local, message.lamport) + 1`.

Replies follow the same rules, so a request and its reply both move both clocks. A message without a timestamp, such as one from a terminal client, counts as 0. A timestamp that is not a non-negative integer is rejected. Peer logs print the clock on every `SEND`, `RECV` and coordination event:

```text
sierra SEND to=xray type=election id=28c1eb0b... lamport=222 body={...}
xray   RECV from=sierra type=election id=28c1eb0b... lamport=223 body={...}
```

Maintenance messages (`ping`, `neighbors`, `notify`) also tick the clock but are not logged unless `--verbose` is set, so the logged values have gaps.

### Leader election: ring algorithm

A Chord peer only knows its successors and its predecessor, not every member, so the Bully algorithm (which messages every higher ID) does not fit. The ring algorithm needs only the next live peer, which the overlay already maintains.

1. A peer that finds no live leader sends `election` to its successor with itself as the first candidate.
2. Each peer adds itself and passes the message on. A successor that does not answer is dropped, and the message goes to the next one in the successor list.
3. When the message returns to its initiator, the list holds every live peer. The highest ring ID wins, and the initiator sends `elected` to the winner.
4. The winner starts a new term (one higher than any term the candidates knew) and sends `coordinator` around the ring. Each peer accepts the new leader as the message passes, and a former leader steps down.

Concurrent elections (several peers notice the same failure) all pick the same winner. The winner acts on the first `elected` notice and ignores the rest, which name an older term. A peer that joins later learns the leader from its successor's `neighbors` reply, which carries the leader and term. It adopts only a leader with a newer term than its own, so a joining peer never displaces the sitting leader. Each follower pings the leader once per maintenance round (every 0.5 s). If the ping fails, the follower starts an election.

### Mutual exclusion: centralized lock run by the leader

The elected leader is the lock coordinator. Each lock protects one named resource (`minutes` or `presenter`) and has its own holder and queue, so a long presentation never blocks the minutes. To enter the critical section, a peer sends `lock_request` with `resource` and `requested_at`, the Lamport time of the request. The leader queues requests in (Lamport time, ring ID) order, which is the same total order on every peer, and sends `lock_grant` to the first one when the lock is free. The holder sends `lock_release` when it leaves. That makes 3 messages per entry, against 2(N-1) for Ricart-Agrawala, and nothing circulates while the lock is idle, unlike token ring.

The leader is a single point of failure, so the lock is built to survive losing it:

- **Recovery before granting.** The new leader's `coordinator` message collects each peer's lock state as it goes around: the holder, if any, and every waiting request with its original `requested_at`. The leader grants nothing until the message returns, so a lock held under the old leader is never given out twice. Waiting peers keep their place in the queue.
- **Grants only from the current leader.** A peer accepts `lock_grant` only from the leader and term it follows. A deposed leader that is still running cannot hand the lock to a peer that has moved on.
- **Holder failure.** Each round, the leader asks the holder `lock_held`. A holder that has died, or whose release was lost, gives the lock back, and the next request is granted.
- **Lost requests.** A waiting peer resends its request every 2 s; the leader ignores duplicates.

### Shared resource: the meeting minutes

`minutes.ts` keeps the minutes as one JSON entry per line. A writer counts the entries, spends 50 ms composing (the hold time widens the race window), then appends entry `count + 1`. Two writers that overlap read the same count and write the same number: one of them has edited a minute the other was editing. The entry also records the writer's Lamport time on entry.

The audit needs no clock. An entry's number is the count its writer read, plus one. If the number differs from the entry's position in the file, another append landed inside that read-modify-write: a collision. Wall-clock times are not used, because two processes' clocks can disagree by a millisecond or more.

### Event ordering

Lamport times give a total order: sort by Lamport time, and break ties by peer name. The order agrees with causality, so a send always comes before its receive, and one writer's `CS_EXIT` always comes before the next writer's `CS_ENTER`. The release, the grant and the acquire form a chain of messages between them. `lamport_order.txt` shows the whole run in this order. The wall-clock transcript cannot do the same. Lines from different processes in the same millisecond can appear out of causal order, and the minutes check in step 4 shows that entry order and Lamport order agree.

## Video sharing: one presenter at a time

A meeting has one stage. Every peer in the meeting watches it, and the right to present is the `presenter` lock, run by the elected leader like the minutes lock. A peer that asks to share while someone else presents waits in the leader's queue, in Lamport order, and starts as soon as the presenter stops.

1. A peer joins a meeting by looking it up in the overlay and connecting to its coordinator as a participant.
2. To share, it acquires the `presenter` lock, sends `video_frame` messages, then releases the lock.
3. The coordinator relays each frame to every other member before it replies. The presenter waits for that reply before sending the next frame or releasing the lock, so its last frame reaches every viewer before the next presenter's first frame.
4. Frames are JPEG or SVG data URLs of at most 60,000 characters, so each fits one protocol line. The coordinator rejects anything else.

The leader carries no video, so a leader crash does not interrupt a presentation. The new leader's recovery finds the presenter still holding the slot and keeps everyone else's place in the queue. If a presenter's page stops sending frames for 5 s (a closed tab, for example), its peer gives the slot back. If the presenting peer itself dies, the leader's holder check frees the slot.

### Run the video demo (one command)

```sh
node video_demo.ts
```

It takes about 17 seconds and prints `RESULT: PASS`. `ora` hosts the meeting, all four peers join, and `ora` and `alpha` watch:

1. The peers form a ring and elect `alpha`.
2. `ora` hosts `demo-room`, and every peer joins it.
3. Without the lock, `sierra` and `xray` share 20 test-pattern frames each at the same time. The viewers see the two streams cut into each other (33 runs instead of 2).
4. With the lock, both ask at once. The viewers see all of `sierra`'s 20 frames, then all of `xray`'s.
5. `sierra` starts a 60-frame presentation, and `xray` asks to share and waits. The leader `alpha` is killed in the middle. `xray` becomes leader in 0.1 s, finds `sierra` still presenting and itself next, and the viewers see `sierra` 1 to 60, then `xray` 1 to 20. The longest pause in `sierra`'s video at a viewer was 113 ms, against 100 ms between frames.
6. Every logged message is checked for send-before-receive in Lamport time, and the four locked presentations are checked to follow each other in Lamport order with no overlap.

Output goes to `evidence/video_run/`: the logs as for the coordination demo, `video_frames_<run>.txt` (what each viewer saw, as runs of frames), and `frame_sample.svg` (one test-pattern frame).

### Share from a browser

Start each peer with `--http PORT`, host a meeting at one of them, then open each peer's page:

```sh
node peer.ts --name ora    --port 7001 --http 8001
node peer.ts --name sierra --port 7002 --http 8002 --bootstrap 127.0.0.1:7001
node peer.ts --name xray   --port 7003 --http 8003 --bootstrap 127.0.0.1:7001
```

At `ora`'s terminal, type `host demo-room`. Then open `http://127.0.0.1:8001/`, `http://127.0.0.1:8002/` and `http://127.0.0.1:8003/`, and press **Join** on each page. The page shows:

- The stage, with the presenter's name and frame number on the bar at the bottom.
- A tally light across the top: red while you present, amber while you wait for the slot.
- **Share camera**, **Share screen** and **Share test pattern**.
- The leader, the term and this peer's Lamport clock. On the leader's page, also the slot's holder and queue.

The page captures the camera or screen into 480 by 270 JPEG frames at about 8 per second, keeping one frame in flight. It plays incoming frames as images. Pages are served only on `127.0.0.1`, which is also what lets the browser allow camera and screen capture.

## Run the coordinating peers by hand

Start four peers as in [Start each service by hand](peer-to-peer-overlay.md#start-each-service-by-hand). They share `logs/minutes.jsonl` unless `--minutes PATH` names another file, and peers that should coordinate must name the same file. Useful commands at a peer's terminal:

| Command | Effect |
| --- | --- |
| `status` | Also prints the leader, term, Lamport clock and lock state |
| `elect` | Start a ring election from this peer |
| `append COUNT` | Write COUNT entries to the minutes, each under the lock |
| `append COUNT unsafe` | Write COUNT entries with no lock, to see collisions |
| `host MEETING` | Host a meeting; peers join it from their pages to watch and share video |
| `crash` | Kill this peer; crash the leader to watch the survivors elect a new one |

The log lines to watch are `ELECTION_START`, `ELECTION_RESULT`, `LEADER_ELECTED`, `LEADER_ACCEPTED`, `LEADER_LEARNED`, `LEADER_STEPPED_DOWN`, `LEADER_FAILED`, `LOCK_STATE_RECOVERED`, `LOCK_REQUEST`, `LOCK_QUEUED`, `LOCK_GRANT`, `LOCK_ACQUIRED`, `CS_ENTER`, `CS_EXIT`, `LOCK_RELEASE`, `LOCK_RELEASED`, `LOCK_HOLDER_LOST`, `VIDEO_JOIN`, `VIDEO_SHARE_START`, `VIDEO_SHARE_STOP` and, at the meeting host, `VIDEO_FRAME` (first frame and every 50th). Each LOCK line ends with the `resource` it is about.

## Coordination tests

`npm test` runs `tests/coordination.test.ts` and `tests/video.test.ts` with the other suites:

| Scenario | Test | Expected result |
| --- | --- | --- |
| Lamport clock rules | `lamport clock ticks on local events...` (`tests/protocol.test.ts`) | Ticks by 1; receive takes `max + 1`; invalid timestamps rejected |
| Timestamps on the wire | `messages carry Lamport timestamps and receivers move past them` | Receiver and reply jump past 500; a malformed timestamp gets an error |
| Election | `ring election picks the highest ring id and replaces the sitting leader` | `alpha` leads in a newer term |
| Joining | `a joining peer learns the leader without a new election` | Term unchanged after `alpha` joins |
| Leader failure | `leader crash elects the highest surviving id` | `xray` leads in a newer term |
| Request order | `requests are ordered by Lamport time, then ring id` | Sorted by Lamport time, ties by ID |
| Resource needs the lock | `without the lock, concurrent writers conflict` | Repeated numbers and collisions |
| Mutual exclusion | `the lock serializes concurrent writers in Lamport order` | 16 entries, no collision, Lamport order |
| Failover under load | `leader crash during contention keeps the minutes consistent` | 18 entries, no collision, Lamport order |
| Holder survives failover | `a lock held when the leader crashes stays with its holder` | New leader finds the holder; nobody else gets the lock until it releases |
| Independent locks | `named locks are independent: holding presenter does not block minutes` | Minutes written while the slot is held; one presenter at a time |
| Slot survives failover | `the presenter keeps the slot across a leader crash, and a waiter keeps its place` | New leader finds the presenter and the queue |
| Holder fails | `a crashed lock holder does not block the others` | The next peer gets the lock |
| Stale grant | `a grant from a peer that is not the leader is refused` | Error reply; peer stays idle |
| Frames and audit | `test-pattern frames are valid frames, and the audit spots mixed streams` (`tests/video.test.ts`) | Valid frames pass, others fail; mixed streams counted |
| Relay | `the meeting relays a frame to everyone but its presenter` | Two deliveries, none back to the presenter; bad frames refused |
| Page from the command line | `the peer command serves its meeting page` | `node peer.ts --http` serves the page |
| Video needs the lock | `without the presenter lock, two streams interleave at a viewer` | Streams mixed |
| Presenter slot | `with the presenter lock, presenters take turns and viewers see whole streams` | 2 whole runs at each viewer |
| Video through failover | `a presentation keeps going through a leader crash, and the next presenter keeps its place` | `sierra 1-30, xray 1-10`; no pause of a second |
| Leaving the queue | `a peer that leaves the queue gives up its place to the next one` | The next peer presents; the one that left can ask again |
| Meeting page | `the meeting page serves, refuses stray frames, and shares the test pattern` | Page served; stray frame refused; slot given back on stop |

## Coordination protocol

These requests use the same JSON-lines wire format as the overlay (see [Peer protocol](peer-to-peer-overlay.md#peer-protocol)), with a `lamport` field on every packet.

| Type | Purpose |
| --- | --- |
| `election` | Collects candidates on its way around the ring |
| `elected` | Initiator tells the winner it won |
| `coordinator` | New leader's announcement; collects lock state on its way around |
| `lock_request`, `lock_grant`, `lock_release` | Centralized lock |
| `lock_held` | Leader asks the holder whether it still holds the lock |
| `append`, `elect` | Requests from the demo or a script: write minutes, start an election |
| `video_join`, `video_share`, `video_stop`, `video_stats`, `video_reset` | Requests from the demo or a script: join a meeting, present the test pattern, read what this peer saw |
| `video_frame` | Meeting coordinator message (not peer to peer): one frame from the presenter, relayed to every other member |

## Coordination limitations

- **The leader is a bottleneck.** Every lock request goes through one peer. That suits a meeting-sized group; a large system would partition resources across several coordinators.
- **Failure detection uses timeouts.** A leader or holder that stalls past the 1 s request timeout is treated as dead. A holder that stalls inside the critical section that long loses the lock while still writing. Fencing tokens at the resource would close this gap.
- **Recovery trusts the ring.** The coordinator message must visit every live peer. A live peer wrongly skipped as dead while it holds the lock would not be reported.
- **Elections need a stable ring.** An election reaches only the peers the ring links at that moment. One run during heavy churn can miss a peer, and a later election corrects it.
- **The minutes file must be reachable by every peer.** The demo runs on one machine. On separate computers, the file would have to be on a shared drive.
- **Video goes through one coordinator.** The meeting's host relays every frame, so its upload grows with the number of viewers, and the meeting ends if the host fails. Frames are images, not a compressed video stream, so they use more bandwidth than a real codec.
- **Camera and screen capture need a secure page.** Browsers allow them on `http://127.0.0.1` and `http://localhost`, not on plain `http://` to a LAN address. The pages bind only to `127.0.0.1`.
- **The page has no access control.** Binding to `127.0.0.1` keeps other machines out, but any website open in the same browser can still send the page requests, such as starting a test-pattern share. Run it only for demos.
- **No audio.**
- **No security.** Any host that can reach a peer can claim to be the leader or send a grant.


