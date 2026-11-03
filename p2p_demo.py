"""Run the overlay scenario across separate peer processes and save the evidence."""

import argparse
import logging
import re
import subprocess
import sys
import time
from pathlib import Path

from client import Participant
from demo import ROOT, free_local_port, wait_for_broker
from peer import MAX_HOPS, RPC_TIMEOUT, RemoteError, discover, rpc
from protocol import configure_logging

MEETING = "demo-room"
FIRST_PEERS = ("alpha", "sierra", "ora", "xray")
JOINING_PEER = "echo"  # Its ring position takes over the meeting's key when it joins.
PROVIDER = "sierra"    # Stays clear of the peers that leave and crash until the final step.
LOG_LINE = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3}Z ")
LOG = logging.getLogger("demo")


class Network:
    """Peer processes owned by the demo, reachable by name."""

    def __init__(self, target):
        self.target = target
        self.processes, self.addresses, self.handles = {}, {}, []

    def start_peer(self, name, bootstrap=None):
        port = free_local_port()
        handle = (self.target / f"{name}.console.txt").open("w", encoding="utf-8")
        self.handles.append(handle)
        command = [sys.executable, str(ROOT / "peer.py"), "--name", name, "--port", str(port),
                   "--log-dir", str(self.target)]
        if bootstrap:
            command += ["--bootstrap", f"127.0.0.1:{self.addresses[bootstrap][1]}"]
        process = subprocess.Popen(command, cwd=ROOT, stdin=subprocess.DEVNULL, stdout=handle,
                                   stderr=subprocess.STDOUT)
        self.processes[name] = process
        wait_for_broker(process, port)
        self.addresses[name] = ("127.0.0.1", port)

    def lookup(self, name, meeting=MEETING):
        answer = rpc(self.addresses[name], "lookup", {"name": meeting}, timeout=RPC_TIMEOUT * MAX_HOPS)
        LOG.info("LOOKUP_RESULT asked=%s found=%s owner=%s hops=%d path=%s value=%s", name, answer["found"],
                 answer["owner"], len(answer["path"]) - 1, ">".join(answer["path"]), answer["value"])
        return answer

    def leave(self, name):
        rpc(self.addresses.pop(name), "leave")
        code = self.processes.pop(name).wait(timeout=15)
        check(code == 0, f"{name} exited cleanly after leaving")

    def crash(self, name):
        self.addresses.pop(name)
        self.processes.pop(name).kill()

    def statuses(self):
        return {name: rpc(address, "status", quiet=True) for name, address in self.addresses.items()}

    def wait_for_ring(self, seconds=20):
        """Wait until every peer's neighbor pointers form one ring ordered by ID."""
        deadline = time.monotonic() + seconds
        while True:
            try:
                statuses = self.statuses()
                order = sorted(statuses, key=lambda name: statuses[name]["me"]["id"])
                if all(statuses[name]["successors"][0]["name"] == order[(i + 1) % len(order)]
                       and (statuses[name]["predecessor"] or {}).get("name") == order[i - 1]
                       for i, name in enumerate(order)):
                    ring = " -> ".join(f"{name}({statuses[name]['me']['id']})" for name in order)
                    LOG.info("RING peers=%d %s -> %s", len(order), ring, order[0])
                    return statuses, order
            except (OSError, RemoteError):
                pass
            if time.monotonic() >= deadline:
                raise TimeoutError("The ring did not stabilize")
            time.sleep(0.1)

    def stop(self):
        for process in self.processes.values():
            if process.poll() is None:
                process.kill()
                process.wait()
        for handle in self.handles:
            handle.close()


def check(condition, description):
    if not condition:
        raise AssertionError(description)
    LOG.info("CHECK ok: %s", description)


def owner_successor(statuses, owner):
    return statuses[owner]["successors"][0]["name"]


def step(text):
    LOG.info("===== %s =====", text)


def run_scenario(network):
    step("STEP 1: four peers start and form a ring")
    network.start_peer(FIRST_PEERS[0])
    for name in FIRST_PEERS[1:]:
        network.start_peer(name, bootstrap=FIRST_PEERS[0])
    statuses, order = network.wait_for_ring()
    check(len(order) == 4, "ring holds four peers")

    step(f"STEP 2: {PROVIDER} hosts {MEETING} and registers it in the overlay")
    LOG.info("HOST_RESULT %s", rpc(network.addresses[PROVIDER], "host", {"meeting": MEETING},
                                   timeout=RPC_TIMEOUT * MAX_HOPS))

    step("STEP 3: a lookup is routed through the overlay")
    owner = network.lookup(PROVIDER)["owner"]
    origin = owner_successor(statuses, owner)
    answer = network.lookup(origin)
    check(answer["found"] and answer["owner"] == owner, f"{origin} resolves {MEETING} at {owner}")
    check(len(answer["path"]) - 1 == 3, "lookup from the owner's successor crosses three hops")

    step(f"STEP 4: {JOINING_PEER} joins and takes over the key")
    network.start_peer(JOINING_PEER, bootstrap=FIRST_PEERS[0])
    statuses, order = network.wait_for_ring()
    check(len(order) == 5, "ring holds five peers")
    check(MEETING in statuses[JOINING_PEER]["records"], f"{JOINING_PEER} received {MEETING} on join")
    check(MEETING not in statuses[owner]["records"], f"{owner} handed {MEETING} off")
    answer = network.lookup(origin)
    check(answer["owner"] == JOINING_PEER and answer["found"], f"lookup now resolves at {JOINING_PEER}")

    step("STEP 5: participants discover the meeting through two different peers and talk")
    users = []
    for user, via in (("alice", FIRST_PEERS[0]), ("bob", FIRST_PEERS[2])):
        host, port = discover(MEETING, network.addresses[via])
        LOG.info("DISCOVERED participant=%s via=%s coordinator=%s:%d", user, via, host, port)
        participant = Participant(user, MEETING, host, port)
        participant.connect()
        users.append(participant)
    alice, bob = users
    members = alice.request("list_participants")["participants"]
    check(members == ["alice", "bob"], "both participants reached the same coordinator")
    check(alice.group_send("Found this meeting through the overlay")["group_deliveries"] == 2,
          "group message delivered through the discovered coordinator")
    bob.wait_for(lambda packet: packet["type"] == "group_message")

    step(f"STEP 6: {JOINING_PEER} leaves gracefully and hands its key to its successor")
    heir = owner_successor(statuses, JOINING_PEER)
    network.leave(JOINING_PEER)
    statuses, order = network.wait_for_ring()
    check(len(order) == 4, "ring holds four peers")
    answer = network.lookup(FIRST_PEERS[0])
    check(answer["found"] and answer["owner"] == heir, f"{heir} serves {MEETING} after the handoff")

    step(f"STEP 7: {heir} crashes without warning")
    next_owner = owner_successor(statuses, heir)
    network.crash(heir)
    started = time.monotonic()
    statuses, order = network.wait_for_ring()
    check(len(order) == 3, "ring repaired itself to three peers")
    LOG.info("RING_REPAIRED seconds=%.1f", time.monotonic() - started)
    while True:
        answer = network.lookup(FIRST_PEERS[0])
        if answer["found"]:
            break
        if time.monotonic() - started > 20:
            raise TimeoutError("The provider never re-registered")
        time.sleep(0.5)
    LOG.info("DISCOVERY_RESTORED seconds=%.1f", time.monotonic() - started)
    check(answer["owner"] == next_owner, f"{PROVIDER} re-registered {MEETING} at {next_owner}")
    check(alice.group_send("Still here after the crash")["group_deliveries"] == 2,
          "the running meeting was not affected by the overlay failure")
    for user in users:
        user.close()

    step(f"STEP 8: the provider {PROVIDER} crashes and its record expires")
    network.crash(PROVIDER)
    started = time.monotonic()
    statuses, order = network.wait_for_ring()
    check(len(order) == 2, "ring repaired itself to two peers")
    while network.lookup(next_owner)["found"]:
        if time.monotonic() - started > 20:
            raise TimeoutError("The dead provider's record never expired")
        time.sleep(1)
    LOG.info("RECORD_GONE seconds=%.1f", time.monotonic() - started)
    LOG.info("CHECK ok: a meeting whose host died stops being discoverable")


def write_transcript(target):
    """Merge every process's log into one file ordered by timestamp."""
    lines = []
    for path in sorted(target.glob("*.console.txt")):
        for line in path.read_text(encoding="utf-8").splitlines():
            if LOG_LINE.match(line):
                lines.append(line)
    # The sort is stable and keys only on the timestamp, so each process keeps its own order.
    lines.sort(key=lambda line: line[:23])
    transcript = target / "demo_transcript.txt"
    transcript.write_text("CECS 327 Milestone 3: merged peer logs (UTC timestamps)\n\n"
                          + "\n".join(lines) + "\n", encoding="utf-8")
    return transcript


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", default=str(ROOT / "evidence" / "p2p_run"))
    args = parser.parse_args()
    target = Path(args.output_dir).resolve()
    if target == ROOT or target == ROOT.parent:
        raise ValueError("Output directory cannot be the project root")
    target.mkdir(parents=True, exist_ok=True)
    # Only remove demo-generated files; do not delete unrelated user files.
    for pattern in ("*.log", "*.console.txt", "demo_transcript.txt"):
        for generated in target.glob(pattern):
            if generated.is_file():
                generated.unlink()
    configure_logging("demo", target)
    network = Network(target)
    try:
        run_scenario(network)
        LOG.info("RESULT: PASS")
        code = 0
    except Exception as exc:  # Any failure must still produce the transcript and a FAIL result.
        LOG.error("RESULT: FAIL %r", exc)
        code = 1
    finally:
        network.stop()
    # The demo's own log joins the merge under the same naming as the peers' console files.
    (target / "demo.console.txt").write_text((target / "demo.log").read_text(encoding="utf-8"), encoding="utf-8")
    print("Evidence:", write_transcript(target))
    sys.exit(code)


if __name__ == "__main__":
    main()
