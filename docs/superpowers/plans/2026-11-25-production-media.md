# Bounded production media composition

Continues `be0dc1d` and the approved distributed meeting spec, sections 7 and 9–11. The existing handoff delegates implementation judgment and verified commits; execute inline on the existing `milestone-5` checkout. Use the executing-plans, test-driven-development and verification-before-completion workflows.

**Goal:** Integrate real media through provisioned runtime/SFU routes without changing ClientSession identity, command uncertainty, revision-zero replay, SQL schema, readiness or ownership activation.

**Architecture:** A configured meeting has exactly one private SFU route per runtime, with the same SFU node shared across takeover candidates. The authenticated participant gateway owns the serialized MediaRoom and performs fresh SQL/runtime authorization for every ordinary operation. A bounded local agent bridge serializes requests and teardown across runtime routing changes. Kernel epoch negotiation precedes fresh authorization; all effects bind that epoch, exact owner and peer identity. Kernel ownership/grant fences remain monotonic within an epoch. Cleanup cannot create transports or relax a fence. SFU routes, caller allowlists and advertised addresses are provisioned, never discovered from browser input.

**Alternatives considered:** Direct browser access to the kernel would bypass the runtime authorization boundary. Giving participant agents the kernel capability would distribute privileged effect access. The selected runtime gateway reuses the existing private participant protocol and keeps SFU capabilities on the backend.

## Constraints and review focus

- Capture is explicit, one local lease, with the lease revision pinned at admission (including loss/reclaim of the same tab).
- Reject old epoch operations, stale runtime generations, unavailable authorization and stale SQL screen grants. New epoch reconciliation requires a new read; no retained sync can initialize a restarted SFU.
- Takeover and SQL changes can overlap previously authorized work until serialized media fencing completes. Existing RTP may continue during dependency failure. No instantaneous SQL-to-media revocation claim.
- Bound rooms, peers, queues, cleanup, reconnect attempts and observations. Drain shutdown; report failure if the SFU cannot confirm teardown.
- Persist bounded, sanitized effect observations separately from committed domain intentions; neither observations nor retained browser state authorize work.
- Review kernel restart between negotiation/authorization/sync/effect, old owner plus isolated SFU, interleaved runtimes and queued local lease replacement before enabling participant capture controls.

## Tasks

1. **Protocol fences and local lifecycle.** Add failing regressions for epoch changes, cross-owner interleavings, local capture ABA and drain/admission. Implement negotiated epochs and bounded serial lifecycle. Run targeted tests, default suite and typecheck; commit.
2. **Production composition.** Extend ParticipantConnection/gateway with validated media operations; compose configured per-meeting SFU routes in startMeetingRuntime and the shared participant agent. Persist sanitized bounded observations. Verify fresh credential/owner reads, cross-participant isolation, no automatic uncertain retries, teardown and omitted-route refusal. Run default/typecheck and production native media with takeover/SFU restart; commit.
3. **Review and acceptance.** Fresh independent read-only protocol review of the whole branch. Reproduce/fix Important findings with RED→GREEN. Only expose participant capture controls if the review and acceptance support them; otherwise retain an explicitly enabled media API and document the exact gate. Run affected browser/runtime/native suites, retain sanitized evidence, update spec/handoff/guide and commit.

## Execution ledger

Planning: inspected baseline `be0dc1d`, production runtime/participant composition, SQL reads, kernel, capture lifecycle and existing evidence. No user changes in checkout. Git uses command-local safe.directory because the sandbox account differs from repository owner; no global configuration change.

Task 1: complete. Epoch negotiation precedes SQL authorization and every effect pins the negotiated epoch. Provisioned kernel caller incarnations enforce monotonic control order; owner identity must match the caller and configured meeting. Local capture checks pin the admission revision, closing the loss/reclaim ABA. Room close seals admission and drains cleanup. New epoch/drain/capture ABA/kernel boundary regressions passed after RED runs; the restart-during-read test was strengthened to assert negotiation and the fresh read actually occurred. Default 94/94 and typecheck passed. Native production integration remains Task 2; no native success claimed for this increment.
Task 2: pending.
Task 3: pending.
