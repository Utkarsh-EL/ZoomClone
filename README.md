# ZoomClone

A small peer-to-peer meeting prototype built in three milestones: a TCP meeting service, a Chord-style discovery overlay, and coordination for shared resources and video presentation. The project runs locally with Node.js and has no build step.

## Setup

Requirements: Node.js 24.16 or newer and npm.

```sh
git clone https://github.com/Utkarsh-EL/ZoomClone.git
cd ZoomClone
```

For Linux systems
```
npm install
```

For windows systems
```
winget install OpenJS.NodeJS.LTS
```

`npm install` is only needed for type checking. The demos and services use Node's built-in TypeScript support and can run without installing dependencies.

## Use the meeting service

### Start a local peer network

Open a terminal in the project folder for each peer. The first peer creates the ring; the others join through it:

```sh
node peer.ts --name alpha --port 7001
node peer.ts --name sierra --port 7002 --bootstrap 127.0.0.1:7001
node peer.ts --name ora --port 7003 --bootstrap 127.0.0.1:7001
```

At `sierra`, host a meeting. At any peer, look it up by name:

```text
host demo-room
lookup demo-room
```

### Join from a terminal client

Start a client in another terminal. `--via` can point to any peer in the ring:

```sh
node client.ts --name alice --meeting demo-room --via 127.0.0.1:7001
```

Use `members`, `say Hello`, and `quit` in the client. For the direct Milestone 2 service, start `node server.ts --host 127.0.0.1 --port 5000`, then connect with `node client.ts --name alice --meeting demo-room --port 5000`.

### Share video in a browser

Start peers with an HTTP page port (use `--http` on each peer), host the meeting at one peer, and open that peer's local page:

```sh
node peer.ts --name alpha --port 7001 --http 8001
node peer.ts --name sierra --port 7002 --http 8002 --bootstrap 127.0.0.1:7001
```

Type `host demo-room` at `alpha`, then open `http://127.0.0.1:8001/` and `http://127.0.0.1:8002/`. Press **Join** and choose camera, screen, or test-pattern sharing. The prototype relays still image frames and has no audio.

## Try the demos

Each script starts its own peers, runs a checked scenario, and writes logs under `evidence/`:

```sh
node p2p_demo.ts       # discovery, joining, lookup, and recovery
node coord_demo.ts     # leader election, locked writes, and failover
node video_demo.ts     # presenter ordering and video failover
```

Keep these scripts as repeatable, end-to-end demonstrations; they complement the hands-on commands above. Run all automated tests with `npm test`, or type-check the project with `npm run typecheck`.

## Project guides

- [Peer-to-peer overlay](docs/peer-to-peer-overlay.md): ring behavior, manual peer commands, protocol, tests, and limitations.
- [Coordination and video sharing](docs/coordination.md): Lamport clocks, leader election, locks, video presentation, demos, tests, and limitations.
- [Durable coordinator checkpoint](docs/coordinator-foundation.md): the first `milestone-5` redesign batch, with real Raft helpers, persistent metadata, crash/restart evidence, and current limits. Run `npm run test:coordinator` or `npm run demo:coordinator` with Go 1.26+ installed.
- [Consensus repair checkpoint](docs/consensus-safety.md): an auditable local Raft dependency repair, always-enabled regressions, live partition and snapshot-publication crash tests. Run `npm run test:consensus` for the full race/process checks.
- [PostgreSQL fencing checkpoint](docs/postgresql-fencing.md): persistent Compose storage, fenced commands, atomic screen-share handoff, bounded read-only inspection and real pause/restart tests. Run `npm run test:storage` with Docker Desktop running.
- [Ownership activation checkpoint](docs/ownership-activation.md): resumable Raft-to-SQL activation, runtime readiness, headless reconciliation and conditional failure suspicion. Run `npm run test:recovery` for real helper/PostgreSQL crash and lost-reply checks.
- [Remote runtime checkpoint](docs/remote-runtimes.md): authenticated preparation adapters, guarded registration, scheduled renewals and independent-process takeover. Run `npm run test:runtimes` for the full helper/PostgreSQL/runtime checks. Discovery and participant migration remain in progress.
- [Current redesign](docs/superpowers/specs/2026-11-21-distributed-meeting-redesign.md) and [implementation plan](docs/superpowers/plans/2026-11-25-coordinator-foundation.md): shared PostgreSQL, replaceable meeting runtimes, and real SFU media. These are not yet the application running above.
- [Historical video MVP design](docs/superpowers/specs/2026-09-10-video-meeting-mvp-design.md): superseded architecture notes.
