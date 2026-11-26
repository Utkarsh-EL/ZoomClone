# ZoomClone

A local distributed meeting project built around Raft coordinator metadata, PostgreSQL meeting state, one fenced runtime per meeting, and namespaced 128-bit Chord discovery. The backend is headless. Durable participant sessions, the production participant protocol, and media/UI integration remain unfinished.

Start with the [current handoff](docs/superpowers/handoffs/2026-11-25-distributed-meeting-redesign.md) for implemented behavior, evidence, limitations, and the exact next action. The [current design](docs/superpowers/specs/2026-11-21-distributed-meeting-redesign.md) describes the intended product.

## Setup

Install Node.js 24.16 or newer, npm dependencies, Go 1.26 or newer for coordinator helpers, and Docker Desktop for PostgreSQL integration checks.

```sh
npm install
npm run build:coordinator
npm test
npm run typecheck
```

TypeScript entry points use Node's built-in TypeScript support. PostgreSQL provisioning and credentials are documented in the storage and runtime guides; see `.env.example` and `compose.yaml`.

## Backend entry points

| Command | Purpose |
| --- | --- |
| `npm run start:discovery` | Run a configured discovery peer using protected `ZOOM_DISCOVERY_CONFIG` JSON. |
| `node scripts/meeting-runtime.ts` | Run a configured meeting runtime using protected `ZOOM_RUNTIME_CONFIG` JSON. |
| `npm run demo:coordinator` | Run the checked Raft coordinator process scenario. |

There is no participant-facing application yet. The retired TCP participant/server, 16-bit overlay, ring election/file locks, still-frame video page and their demos are available in Git history before the legacy retirement commit. They are not alternative application entry points.

## Verification

| Command | Coverage |
| --- | --- |
| `npm test` | Current TypeScript backend, wire, discovery, engine and runtime adapter tests. |
| `npm run typecheck` | TypeScript checks for current source, scripts and tests. |
| `npm run test:coordinator` | Raft dependency safety regressions, helper suite, vet, build and process scenario. |
| `npm run test:consensus` | Additional dependency/helper race and process checks. |
| `npm run test:storage` | Real PostgreSQL fencing, transactions, inspection and restart tests. |
| `npm run test:recovery` | Storage checks plus crash/lost-reply ownership recovery. |
| `npm run test:runtimes` | Storage/recovery checks plus independent runtimes consuming discovered helper routes and surviving failures. |

## Current implementation guides

- [Coordinator foundation](docs/coordinator-foundation.md)
- [Raft consensus repair and provenance](docs/consensus-safety.md)
- [PostgreSQL durability and fencing](docs/postgresql-fencing.md)
- [Ownership activation and recovery](docs/ownership-activation.md)
- [Authenticated runtimes and renewal](docs/remote-runtimes.md)
- [128-bit Chord discovery and helper routing](docs/chord-discovery.md)
- [Assignment requirements](docs/assignment-reqs.txt)

Checkpoint evidence under `evidence/` records the code and checks at each checkpoint. Older milestone evidence and superseded design records are historical; they do not establish the current backend's guarantees.
