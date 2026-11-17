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

Node.js 24.16 or newer is the only requirement (see [Required software](#required-software)).

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

Start four peers as in [Start each service by hand](#start-each-service-by-hand). They share `logs/minutes.jsonl` unless `--minutes PATH` names another file, and peers that should coordinate must name the same file. Useful commands at a peer's terminal:

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
| Meeting page | `the meeting page serves, refuses stray frames, and shares the test pattern` | Page served; stray frame refused; slot given back on stop |

## Coordination protocol

These requests use the same JSON-lines wire format as the overlay (see [Peer protocol](#peer-protocol)), with a `lamport` field on every packet.

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
- **No audio.**
- **No security.** Any host that can reach a peer can claim to be the leader or send a grant.

# Milestone 3: Peer-to-Peer Overlay for Meeting Discovery

Milestone 3 added a peer-to-peer overlay to the video meeting prototype from Milestone 2. Peers form a Chord-style ring. A peer can host a meeting, and any participant can find that meeting by asking any peer, with no central directory. Once a participant has the address, it joins using the Milestone 2 TCP protocol unchanged.

## What the overlay does

| Assignment requirement | Where it is implemented |
| --- | --- |
| Peer node | `peer.ts`, class `Peer`: one OS process per peer |
| Join and leave | `Peer.start`, `Peer.leave` (key handoff and neighbor relinking) |
| Lookup mechanism | `Peer.lookup`, `onFindOwner`: request forwarded hop by hop around the ring |
| Overlay structure | Chord-style ring with SHA-1 IDs and a successor list of 3 |
| Data or service discovery | Meeting name maps to the coordinator's `host:port`, held by the peer that owns the key |
| Failure handling | Failed hops are routed around, stabilization repairs the ring, records are soft state |

```text
                 ora (811)
              /             \
     alpha (52303)        sierra (13800)  hosts demo-room
           |                     |
           |                     v
      xray (40128)  <---  echo (27791)  owns key 23745 (demo-room)

Arrows run clockwise: every peer knows its next 3 successors and its predecessor.
```

- **Ring position:** `SHA-1(name) mod 2^16`. Names give the same ring on every run, so the demo and these diagrams always match.
- **Key ownership:** a resource named `demo-room` has key `SHA-1("demo-room") mod 2^16` and belongs to the first peer clockwise from that key.
- **Records are soft state:** the hosting peer re-registers every `ttl / 3` seconds (3 s by default). The record expires after `ttl` seconds (9 s) without a refresh.

## Required software

- Node.js 24.16 or newer. Node runs the `.ts` files directly, with no build step.
- TCP networking on localhost. Separate computers also work (see below).

Check Node with `node --version`.

## Install dependencies

Running the services, the demos and the tests needs nothing beyond Node. Clone the repository and switch to the `milestone-3` branch:

```sh
git clone https://github.com/Utkarsh-EL/ZoomClone.git
cd ZoomClone
git switch milestone-4
```

`npm install` fetches the TypeScript compiler and the Node type definitions, which only `npm run typecheck` uses.

## Run the demo (one command)

```sh
node p2p_demo.ts
```

It takes about 15 seconds and prints `RESULT: PASS` at the end, exiting with code 0. The demo starts every peer as a separate OS process and checks each step:

1. `alpha`, `sierra`, `ora` and `xray` start and form a ring of four.
2. `sierra` hosts `demo-room` and registers it through the overlay.
3. A lookup from the owner's successor crosses three hops.
4. `echo` joins and takes over the key from `xray`.
5. `alice` and `bob` discover the meeting through two different peers, connect, and exchange a message.
6. `echo` leaves gracefully and hands the key back to `xray`.
7. `xray` is killed. The ring repairs itself, `sierra` re-registers the meeting at `alpha`, and the running meeting keeps working.
8. `sierra` is killed. Its record expires and the meeting stops being discoverable.

Output is saved in `evidence/p2p_run/`:

| File | Contents |
| --- | --- |
| `demo_transcript.txt` | Every process's log merged in timestamp order |
| `<peer>.console.txt` | One peer's own log |
| `demo.console.txt` | Demo steps, lookup results and checks |

A run committed to the repository is already there for reference. Running the demo replaces those files.

## Start each service by hand

Open one terminal per peer in the project directory. Peers read commands from the terminal while logging to it.

```sh
node peer.ts --name alpha  --port 7001
node peer.ts --name sierra --port 7002 --bootstrap 127.0.0.1:7001
node peer.ts --name ora    --port 7003 --bootstrap 127.0.0.1:7001
node peer.ts --name xray   --port 7004 --bootstrap 127.0.0.1:7001
```

The first peer has no `--bootstrap`, so it creates the ring. Any running peer works as a bootstrap. Add `--verbose` to also log periodic maintenance traffic, which is hidden by default so that lookups and membership changes stay readable.

Peer commands:

| Command | Effect |
| --- | --- |
| `status` | Print this peer's ID, neighbors, stored records and published resources |
| `host MEETING` | Start a meeting coordinator on this peer and register it in the overlay |
| `lookup NAME` | Route a lookup through the ring and print the owner, path and value |
| `leave` | Leave gracefully: hand off keys, relink neighbors, exit |
| `crash` | Exit immediately with no handoff, as a failed process would |

Ctrl+C also leaves gracefully.

Try this order:

1. At `sierra`, type `host demo-room`.
2. At `alpha`, type `lookup demo-room`. The path is `alpha>ora>sierra>xray`.
3. In a new terminal, start a fifth peer: `node peer.ts --name echo --port 7005 --bootstrap 127.0.0.1:7001`. Its log shows `JOIN`, and the `xray` log shows `KEYS_TRANSFER`.
4. Join the meeting through any peer, in one new terminal per participant:

   ```sh
   node client.ts --name alice --meeting demo-room --via 127.0.0.1:7003
   node client.ts --name bob   --meeting demo-room --via 127.0.0.1:7001
   ```

   Then use the client commands `members`, `say Hello`, `quit`.
5. At `echo`, type `leave`. The `xray` log shows `STORE` as the key returns.
6. At `xray`, type `crash`. Within about 3 seconds, `sierra` and `alpha` log the failure and `sierra` logs `REGISTER ... owner=alpha`.

### Separate computers

Bind each peer to its LAN address, which is also the address it advertises to other peers:

```sh
node peer.ts --name alpha  --host 192.168.1.10 --port 7001
node peer.ts --name sierra --host 192.168.1.11 --port 7001 --bootstrap 192.168.1.10:7001
```

Allow the peer port and the coordinator's ephemeral ports through the firewall. Do not expose this prototype to the public Internet: it has no encryption or authentication, and any host that can reach a peer can tell it to leave.

## Reproduce the test cases

```sh
npm test
```

All tests are local and use Node's built-in test runner, so `npm install` is not needed first. `tests/p2p.test.ts` runs the overlay in-process with a short stabilization interval.

| Scenario | Test in `tests/p2p.test.ts` | Expected result |
| --- | --- | --- |
| Ring interval math, including wraparound | `ring math` | Correct membership on both sides of ID 0 |
| At least four peers form a ring | `four peers form one ordered ring` | Peers ordered by ID with correct successor lists |
| Lookup routed through the overlay | `lookup is routed hop by hop to the owner` | Path visits each peer in ring order and ends at the owner |
| Resource discovered through peers | `every peer resolves a meeting and clients can use it` | Every peer resolves the address; 4 clients join and exchange a message |
| Peer joining | `joining peer receives the keys it now owns` | New owner receives the key and the old owner drops it |
| Peer leaving | `graceful leave hands off keys and relinks neighbors` | Successor holds the key at once; neighbors are linked to each other |
| Owner fails | `crashed owner is routed around and provider reregisters` | Ring repairs; the host's refresh moves the record to the new owner |
| Two consecutive peers fail | `ring survives two consecutive crashes` | Survivors link past both failed peers |
| Dead or hung next hop | `lookup routes around a dead successor before repair`, `lookup routes around a frozen successor` | Lookup still reaches the right owner |
| Host fails | `crashed provider record expires` | Lookup returns not found once the TTL passes |
| Restart on the same address | `crashed peer can rejoin on its old address` | Ring returns to its original order |
| Invalid input | `validation` | Error replies, refused duplicate IDs, and the peer keeps serving |

The Milestone 2 suites (`tests/protocol.test.ts`, `tests/integration.test.ts`) and the coordination suite (`tests/coordination.test.ts`) run in the same command. `npm run typecheck` runs the TypeScript compiler over every source and test file without emitting anything.

## Peer protocol

Peers use the Milestone 2 wire format from `protocol.ts`: one UTF-8 JSON object per line, at most 65,536 bytes, with a `type`, `id`, `timestamp` and `body`. Each request uses one short-lived TCP connection and gets one `reply` or `error` carrying a matching `request_id`.

```json
{"type":"find_owner","id":"49fe9d0e...","timestamp":"2026-11-03T04:40:00.736+00:00","sender":"sierra","quiet":false,"lamport":231,"body":{"key":23745,"path":["alpha","ora","sierra"],"ttl":29,"final":true}}
```

| Type | Purpose |
| --- | --- |
| `find_owner` | Forwarded around the ring until it reaches the peer responsible for `key` |
| `ping`, `neighbors`, `notify` | Failure detection and stabilization |
| `peer_left` | Graceful leave notice to both neighbors |
| `store`, `get`, `delete` | Record operations at the owner |
| `lookup`, `host`, `leave`, `status` | Requests from a terminal, a client or the demo |

Log lines worth watching: `JOIN`, `FORWARD`, `LOOKUP`, `KEYS_TRANSFER`, `STORE`, `REGISTER`, `SUCCESSOR_CHANGED`, `PREDECESSOR_CHANGED`, `SUCCESSOR_FAILED`, `PREDECESSOR_FAILED`, `PEER_LEFT`, `LEAVE_DONE`, `RECORD_EXPIRED`. `SEND` and `RECV` lines carry the same `id` on both sides of a message.

## Milestone 2 services

The meeting coordinator and clients still work without the overlay:

```sh
node demo.ts
node server.ts --host 127.0.0.1 --port 5000 --trace-marshalling
node client.ts --name alice --meeting demo-room --port 5000 --trace-marshalling
```

Client commands are `members`, `info`, `subscribe TOPIC`, `publish TOPIC TEXT`, `say TEXT` and `quit`. `node demo.ts` writes its evidence to `evidence/demo_run/`.

## Source files

| File | Responsibility |
| --- | --- |
| `peer.ts` | Peer node: ring membership, stabilization, routing, records, meeting hosting, Lamport clock, leader election, lock, command line |
| `minutes.ts` | Shared meeting minutes: read-modify-write entries and the collision audit |
| `video.ts` | Video sharing: the presenter slot, frame relay through the meeting, test pattern, frame audit, the meeting page's server |
| `video.html` | The meeting page: stage, presenter slot, camera and screen capture |
| `coord_demo.ts` | Multi-process coordination scenario with checks; saves evidence |
| `video_demo.ts` | Multi-process video-sharing scenario with checks; saves evidence |
| `p2p_demo.ts` | Multi-process overlay scenario with checks; saves evidence |
| `protocol.ts` | Packet creation, JSON encoding and decoding, framing, Lamport clock, UTC logging |
| `server.ts` | Meeting coordinator: membership, subscriptions, request routing, publish, group fan-out and video frame relay |
| `client.ts` | Participant API and command line; `--via` finds the meeting through a peer |
| `demo.ts`, `demo_node.ts` | Milestone 2 multi-process scenario |
| `tests/` | Protocol, socket integration, overlay and coordination tests |
| `package.json`, `tsconfig.json` | Test and type-check scripts; compiler settings limited to syntax Node can strip |

## Known limitations

- **Routing is linear.** Lookups follow successors one hop at a time, so a lookup costs O(N) hops. Chord finger tables would reduce this to O(log N) and are not implemented.
- **Discovery can pause after a failure.** Records have one copy, at the owner. If the owner fails, the record is missing until the host's next refresh (at most 3 s by default).
- **A dead host's address can linger.** Until the TTL passes (9 s by default), a lookup can return the address of a host that has failed, and connecting to it is refused.
- **Lookups during churn can miss.** A lookup can reach a peer before a new neighbor is fully linked. Running it again after stabilization (about 1 s) resolves it.
- **Simultaneous failures.** The ring survives up to 2 consecutive failed peers between stabilization rounds. Losing all 3 listed successors at once can split the ring until a peer rejoins.
- **Hosts are not replicated.** Meeting state lives on the hosting peer. If that peer fails, the meeting ends for its participants.
- **No security.** Traffic is unencrypted and unauthenticated, so a malicious peer could return false records or claim any ring position.
- **Duplicate meeting hosts.** `host` refuses a meeting name that resolves. Two peers hosting the same new name in the same instant could still race.
