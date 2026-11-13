# CECS 327 Milestone 3: Peer-to-Peer Overlay for Meeting Discovery

This project adds a peer-to-peer overlay to the video meeting communication prototype from Milestone 2. Peers form a Chord-style ring. A peer can host a meeting, and any participant can find that meeting by asking any peer, with no central directory. Once a participant has the address, it joins using the Milestone 2 TCP protocol unchanged.

The prototype coordinates meetings and messages. It does not transmit microphone or camera data.

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
git switch milestone-3
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

The Milestone 2 suites (`tests/protocol.test.ts`, `tests/integration.test.ts`) run in the same command. `npm run typecheck` runs the TypeScript compiler over every source and test file without emitting anything.

## Peer protocol

Peers use the Milestone 2 wire format from `protocol.ts`: one UTF-8 JSON object per line, at most 65,536 bytes, with a `type`, `id`, `timestamp` and `body`. Each request uses one short-lived TCP connection and gets one `reply` or `error` carrying a matching `request_id`.

```json
{"type":"find_owner","id":"49fe9d0e...","timestamp":"2026-11-03T04:40:00.736+00:00","sender":"sierra","quiet":false,"body":{"key":23745,"path":["alpha","ora","sierra"],"ttl":29,"final":true}}
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
| `peer.ts` | Peer node: ring membership, stabilization, routing, records, meeting hosting, command line |
| `p2p_demo.ts` | Multi-process overlay scenario with checks; saves evidence |
| `protocol.ts` | Packet creation, JSON encoding and decoding, framing, UTC logging |
| `server.ts` | Meeting coordinator: membership, subscriptions, request routing, publish and group fan-out |
| `client.ts` | Participant API and command line; `--via` finds the meeting through a peer |
| `demo.ts`, `demo_node.ts` | Milestone 2 multi-process scenario |
| `tests/` | Protocol, socket integration and overlay tests |
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
