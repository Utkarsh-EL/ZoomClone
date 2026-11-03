"""Peer node of a Chord-style ring overlay that discovers meetings through its peers."""

import argparse
import hashlib
import logging
import os
import socket
import socketserver
import threading
import time

from protocol import configure_logging, message, receive, send
from server import IDENTIFIER_RE, MeetingServer

ID_BITS = 16
RING_SIZE = 1 << ID_BITS
SUCCESSOR_LIST_SIZE = 3
MAX_HOPS = 32
RPC_TIMEOUT = 1.0
STABILIZE_INTERVAL = 0.5
RECORD_TTL = 9.0
MAX_RECORD_TTL = 3600.0


class RemoteError(Exception):
    """A live peer answered a request with an error."""


def ring_id(text):
    """Map a peer or resource name to its position on the ring."""
    return int.from_bytes(hashlib.sha1(text.encode("utf-8")).digest(), "big") % RING_SIZE


def in_open(x, a, b):
    """Return whether x lies in the ring interval (a, b); a == b is every ID except a."""
    if a == b:
        return x != a
    return a < x < b if a < b else x > a or x < b


def in_half_open(x, a, b):
    """Return whether x lies in the ring interval (a, b]; a == b is the whole ring."""
    return x == b or in_open(x, a, b)


def parse_address(text):
    host, _, port = text.rpartition(":")
    if not host or not port.isdigit() or not 0 < int(port) < 65536:
        raise ValueError(f"Expected HOST:PORT, got {text!r}")
    return host, int(port)


def check_ref(ref):
    """Validate a peer reference received from the network."""
    valid = (isinstance(ref, dict)
             and isinstance(ref.get("id"), int) and 0 <= ref["id"] < RING_SIZE
             and isinstance(ref.get("name"), str) and IDENTIFIER_RE.fullmatch(ref["name"])
             and isinstance(ref.get("host"), str)
             and isinstance(ref.get("port"), int) and 0 < ref["port"] < 65536)
    if not valid:
        raise ValueError("Invalid peer reference")
    return ref


def check_name(name):
    if not isinstance(name, str) or not IDENTIFIER_RE.fullmatch(name):
        raise ValueError("Invalid name (1-32: letters, digits, . _ -)")
    return name


def exchange(address, packet, timeout=RPC_TIMEOUT):
    """Send one packet over a short-lived TCP connection and return the reply body."""
    with socket.create_connection(address, timeout=timeout) as sock:
        sock.settimeout(timeout)
        send(sock, packet)
        with sock.makefile("rb") as reader:
            try:
                answer = receive(reader)
            except ValueError as exc:
                raise ConnectionError(f"Malformed reply from {address}") from exc
    if answer is None or answer.get("request_id") != packet["id"]:
        raise ConnectionError(f"No matching reply from {address}")
    if answer["type"] == "error":
        raise RemoteError(answer.get("body", {}).get("error", "Unknown error"))
    return answer.get("body", {})


def rpc(address, kind, body=None, timeout=RPC_TIMEOUT, quiet=False):
    """Call a peer from outside the overlay."""
    return exchange(address, message(kind, quiet=quiet, body=body or {}), timeout)


def discover(meeting, via):
    """Ask any peer where a meeting is hosted; return its (host, port)."""
    answer = rpc(via, "lookup", {"name": meeting}, timeout=RPC_TIMEOUT * MAX_HOPS)
    if not answer["found"]:
        raise LookupError(f"No peer knows meeting {meeting!r}")
    try:
        return answer["value"]["host"], answer["value"]["port"]
    except (KeyError, TypeError) as exc:
        raise LookupError(f"Record for {meeting!r} holds no address") from exc


class PeerHandler(socketserver.StreamRequestHandler):
    timeout = RPC_TIMEOUT

    def handle(self):
        try:
            try:
                packet = receive(self.rfile)
            except ValueError as exc:
                send(self.connection, message("error", body={"error": str(exc)}))
                return
            if packet is not None:
                send(self.connection, self.server.peer.serve(packet))
        except (OSError, ValueError) as exc:
            self.server.peer.log.warning("RPC_FAILED remote=%s error=%s", self.client_address, exc)


class PeerServer(socketserver.ThreadingTCPServer):
    daemon_threads = True
    request_queue_size = 64
    # On Windows this option would let a second process bind a port already in use.
    allow_reuse_address = os.name != "nt"

    def __init__(self, address, peer):
        super().__init__(address, PeerHandler)
        self.peer = peer


class Peer:
    def __init__(self, name, host="127.0.0.1", port=0, logger=None,
                 interval=STABILIZE_INTERVAL, record_ttl=RECORD_TTL, verbose=False):
        check_name(name)
        self.log = logger or logging.getLogger(name)
        self.interval = interval
        self.record_ttl = record_ttl
        self.verbose = verbose
        self.server = PeerServer((host, port), self)
        self.me = {"id": ring_id(name), "name": name, "host": host,
                   "port": self.server.server_address[1]}
        self.address = (host, self.me["port"])
        self.lock = threading.RLock()
        self.predecessor = None
        self.successors = [self.me]
        self.records = {}    # resource name -> {"value", "expires"}, for keys this peer owns
        self.published = {}  # resource name -> {"value", "owner"}, for resources this peer provides
        self.meetings = {}   # meeting -> MeetingServer hosted by this peer
        self.stopping = threading.Event()
        self.stopped = threading.Event()

    # ---- lifecycle ----

    def start(self, bootstrap=None):
        """Join through a bootstrap peer, or create a new ring when there is none."""
        owner = None
        try:
            if bootstrap:
                # Routing runs before this peer serves: when it restarts on its old address, the
                # ring's stale entry for it fails the hop check instead of answering for its ID.
                route = rpc(bootstrap, "find_owner", {"key": self.me["id"], "path": [], "ttl": MAX_HOPS},
                            timeout=RPC_TIMEOUT * MAX_HOPS)
                owner = check_ref(route["owner"])
                if owner["id"] == self.me["id"]:
                    raise ValueError(f"Ring ID {self.me['id']} is already taken by {owner['name']}")
                self.successors = [owner]
        except Exception:
            self.server.server_close()
            raise
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05},
                         name=f"{self.me['name']}-server", daemon=True).start()
        self.log.info("PEER_START name=%s id=%d address=%s:%d", self.me["name"], self.me["id"],
                      self.me["host"], self.me["port"])
        if owner:
            self.log.info("JOIN via=%s:%d successor=%s path=%s", *bootstrap, owner["name"],
                          ">".join(route["path"]))
            self.call(owner, "notify", {"peer": self.me})
        else:
            self.log.info("RING_CREATED first peer is %s", self.me["name"])
        threading.Thread(target=self._maintain, name=f"{self.me['name']}-maintain", daemon=True).start()

    def leave(self):
        """Hand off keys, unlink from both neighbors, and stop serving."""
        if self.stopping.is_set():
            return
        self.stopping.set()
        self.log.info("LEAVE_START name=%s", self.me["name"])
        with self.lock:
            published, self.published = list(self.published), {}
        for name in published:
            try:
                self.call(self.find_owner(ring_id(name))["owner"], "delete", {"name": name})
            except (OSError, RemoteError, ValueError) as exc:
                self.log.warning("UNREGISTER_FAILED name=%s error=%s", name, exc)
        self._stop_meetings()
        with self.lock:
            predecessor, successors = self.predecessor, list(self.successors)
            records, self.records = self.records, {}
        successor = successors[0]
        if successor["id"] != self.me["id"]:
            self._send_records(successor, records)
            self._tell_left(successor, {"peer": self.me, "predecessor": predecessor})
            if predecessor and predecessor["id"] != self.me["id"]:
                self._tell_left(predecessor, {"peer": self.me, "successors": successors})
        self.log.info("LEAVE_DONE name=%s successor=%s predecessor=%s", self.me["name"],
                      successor["name"], predecessor["name"] if predecessor else None)
        self.server.shutdown()
        self.server.server_close()
        self.stopped.set()

    def _tell_left(self, peer, body):
        try:
            self.call(peer, "peer_left", body)
        except (OSError, RemoteError) as exc:
            self.log.warning("LEAVE_NOTICE_FAILED peer=%s error=%s", peer["name"], exc)

    def _stop_meetings(self):
        with self.lock:
            meetings, self.meetings = self.meetings, {}
        for meeting, server in meetings.items():
            for session in server.group(meeting):
                session.close_connection()
            server.shutdown()
            server.server_close()

    # ---- messaging ----

    def _note(self, quiet, text, *args):
        if self.verbose or not quiet:
            self.log.info(text, *args)

    def call(self, peer, kind, body=None, timeout=RPC_TIMEOUT, quiet=False):
        """Send one request to a peer; a call addressed to this peer stays in-process."""
        body = body or {}
        if peer["id"] == self.me["id"]:
            return self.dispatch(kind, body)
        packet = message(kind, sender=self.me["name"], quiet=quiet, body=body)
        self._note(quiet, "SEND to=%s type=%s id=%s body=%s", peer["name"], kind, packet["id"], body)
        return exchange((peer["host"], peer["port"]), packet, timeout)

    def serve(self, packet):
        """Answer one request received from the network."""
        kind = packet["type"]
        self._note(packet.get("quiet"), "RECV from=%s type=%s id=%s body=%s",
                   packet.get("sender", "client"), kind, packet.get("id"), packet.get("body"))
        try:
            return message("reply", request_id=packet.get("id"), sender=self.me["name"],
                           body=self.dispatch(kind, packet.get("body", {})))
        except (ValueError, KeyError, TypeError, OSError, RemoteError) as exc:
            self.log.warning("RPC_ERROR type=%s error=%r", kind, exc)
            return message("error", request_id=packet.get("id"), body={"error": str(exc)})

    def dispatch(self, kind, body):
        handler = getattr(self, f"on_{kind}", None)
        if handler is None or not isinstance(body, dict):
            raise ValueError(f"Unknown request {kind!r} or invalid body")
        return handler(body)

    # ---- overlay maintenance ----

    def _maintain(self):
        next_refresh = 0
        while not self.stopping.wait(self.interval):
            try:
                self._check_predecessor()
                self._stabilize()
                self._expire_records()
                if time.monotonic() >= next_refresh:
                    next_refresh = time.monotonic() + self.record_ttl / 3
                    self._refresh_published()
            except Exception as exc:  # A bad reply must not end this peer's repair loop.
                self.log.warning("MAINTENANCE_ERROR %r", exc)

    def _check_predecessor(self):
        with self.lock:
            predecessor = self.predecessor
        if predecessor is None:
            return
        try:
            self.call(predecessor, "ping", quiet=True)
        except OSError as exc:
            with self.lock:
                if self.predecessor is predecessor:
                    self.predecessor = None
            self.log.warning("PREDECESSOR_FAILED peer=%s error=%s", predecessor["name"], exc)

    def _stabilize(self):
        """Confirm the successor, adopt any peer now between us, and announce this peer to it."""
        while True:
            with self.lock:
                successor = self.successors[0]
            try:
                info = self.call(successor, "neighbors", quiet=True)
                break
            except OSError as exc:
                self._drop_successor(successor, exc)
        candidate = info["predecessor"]
        if candidate and in_open(check_ref(candidate)["id"], self.me["id"], successor["id"]):
            try:
                info = self.call(candidate, "neighbors", quiet=True)
                successor = candidate
            except OSError:
                pass  # A stale predecessor pointer; the successor clears it on its own check.
        self._set_successors([successor, *map(check_ref, info["successors"])])
        if successor["id"] != self.me["id"]:
            self.call(successor, "notify", {"peer": self.me}, quiet=True)

    def _set_successors(self, peers):
        fresh, seen = [], set()
        for peer in peers:
            if peer["id"] == self.me["id"]:
                break  # The list has wrapped around the ring.
            if peer["id"] not in seen:
                seen.add(peer["id"])
                fresh.append(peer)
        fresh = fresh[:SUCCESSOR_LIST_SIZE] or [self.me]
        with self.lock:
            previous, self.successors = self.successors[0], fresh
        if previous["id"] != fresh[0]["id"]:
            self.log.info("SUCCESSOR_CHANGED %s -> %s", previous["name"], fresh[0]["name"])

    def _drop_successor(self, peer, reason):
        self.log.warning("SUCCESSOR_FAILED peer=%s error=%s", peer["name"], reason)
        with self.lock:
            remaining = [item for item in self.successors if item["id"] != peer["id"]]
            if self.predecessor and self.predecessor["id"] == peer["id"]:
                self.predecessor = None
        self._set_successors(remaining)

    # ---- soft-state records ----

    def _expire_records(self):
        now = time.monotonic()
        with self.lock:
            expired = [name for name, record in self.records.items() if record["expires"] <= now]
            for name in expired:
                del self.records[name]
        for name in expired:
            self.log.info("RECORD_EXPIRED name=%s", name)

    def _refresh_published(self):
        with self.lock:
            names = list(self.published)
        for name in names:
            try:
                self._register(name, quiet=True)
            except (OSError, RemoteError) as exc:
                self.log.warning("REGISTER_FAILED name=%s error=%s", name, exc)

    def _register(self, name, quiet=False):
        key = ring_id(name)
        route = self.find_owner(key, quiet=quiet)
        owner = route["owner"]
        with self.lock:
            entry = self.published.get(name)
        if entry is None:
            return
        self.call(owner, "store", {"records": [{"name": name, "value": entry["value"],
                                                "ttl": self.record_ttl}]}, quiet=quiet)
        if entry["owner"] != owner["name"]:
            self.log.info("REGISTER name=%s key=%d owner=%s previous_owner=%s path=%s", name, key,
                          owner["name"], entry["owner"], ">".join(route["path"]))
            entry["owner"] = owner["name"]

    def _send_records(self, peer, records):
        """Move records to the peer now responsible; the provider's refresh covers a failure."""
        if not records:
            return
        now = time.monotonic()
        # shortcut: one frame per transfer caps a move at about 400 records, chunk if that grows.
        wire = [{"name": name, "value": record["value"], "ttl": max(record["expires"] - now, 0.001)}
                for name, record in records.items()]
        try:
            self.call(peer, "store", {"records": wire})
            self.log.info("KEYS_TRANSFER to=%s names=%s", peer["name"], sorted(records))
        except (OSError, RemoteError, ValueError) as exc:
            self.log.warning("KEYS_TRANSFER_FAILED to=%s error=%s", peer["name"], exc)

    # ---- routing and discovery ----

    def find_owner(self, key, quiet=False):
        """Route through the ring to the peer responsible for a key."""
        return self.on_find_owner({"key": key, "path": [], "ttl": MAX_HOPS, "quiet": quiet})

    def lookup(self, name):
        """Resolve a resource name through the overlay."""
        check_name(name)
        key = ring_id(name)
        route = self.find_owner(key)
        owner = route["owner"]
        record = self.call(owner, "get", {"name": name})["record"]
        self.log.info("LOOKUP name=%s key=%d owner=%s hops=%d path=%s found=%s", name, key, owner["name"],
                      len(route["path"]) - 1, ">".join(route["path"]), record is not None)
        return {"name": name, "key": key, "found": record is not None,
                "value": record["value"] if record else None, "owner": owner["name"],
                "path": route["path"]}

    def publish(self, name, value):
        """Make a resource discoverable and keep it alive for as long as this peer runs."""
        check_name(name)
        with self.lock:
            self.published[name] = {"value": value, "owner": None}
        self._register(name)

    def host_meeting(self, meeting):
        """Start a meeting coordinator on this peer and advertise it through the overlay."""
        check_name(meeting)
        found = self.lookup(meeting)
        if found["found"]:
            raise ValueError(f"Meeting {meeting!r} is already hosted by {found['value']['peer']}")
        server = MeetingServer((self.me["host"], 0), self.log)
        threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05},
                         name=f"{meeting}-coordinator", daemon=True).start()
        with self.lock:
            self.meetings[meeting] = server
        value = {"host": self.me["host"], "port": server.server_address[1], "peer": self.me["name"]}
        self.log.info("HOST_MEETING meeting=%s address=%s:%d", meeting, value["host"], value["port"])
        self.publish(meeting, value)
        return value

    # ---- request handlers ----

    def on_ping(self, _body):
        return {"status": "ok"}

    def on_neighbors(self, _body):
        with self.lock:
            return {"predecessor": self.predecessor, "successors": list(self.successors)}

    def on_notify(self, body):
        peer = check_ref(body["peer"])
        with self.lock:
            previous = self.predecessor
            if peer["id"] == self.me["id"] or not (
                    previous is None or in_open(peer["id"], previous["id"], self.me["id"])):
                return {"status": "ignored"}
            self.predecessor = peer
            moving = {name: self.records.pop(name) for name in list(self.records)
                      if not in_half_open(ring_id(name), peer["id"], self.me["id"])}
        self.log.info("PREDECESSOR_CHANGED %s -> %s", previous["name"] if previous else None, peer["name"])
        self._send_records(peer, moving)
        return {"status": "accepted"}

    def on_peer_left(self, body):
        peer = check_ref(body["peer"])
        self.log.info("PEER_LEFT name=%s", peer["name"])
        if "predecessor" in body:
            replacement = check_ref(body["predecessor"]) if body["predecessor"] else None
            with self.lock:
                if self.predecessor and self.predecessor["id"] == peer["id"]:
                    self.predecessor = replacement if replacement and replacement["id"] != self.me["id"] else None
                    self.log.info("PREDECESSOR_CHANGED %s -> %s", peer["name"],
                                  self.predecessor["name"] if self.predecessor else None)
        if "successors" in body:
            with self.lock:
                affected = self.successors[0]["id"] == peer["id"]
            if affected:
                self._set_successors([ref for ref in map(check_ref, body["successors"])
                                      if ref["id"] != peer["id"]])
        return {"status": "ok"}

    def on_find_owner(self, body):
        key, ttl = body["key"], body["ttl"]
        if not isinstance(key, int) or not 0 <= key < RING_SIZE or not isinstance(ttl, int):
            raise ValueError("Invalid key or hop limit")
        quiet = bool(body.get("quiet"))
        path = [*body["path"], self.me["name"]]
        if len(path) > MAX_HOPS + 1:
            raise ValueError("Path is longer than the hop limit")
        with self.lock:
            predecessor = self.predecessor
        if body.get("final") or (predecessor and in_half_open(key, predecessor["id"], self.me["id"])):
            return {"owner": self.me, "path": path}
        while True:
            with self.lock:
                successor = self.successors[0]
            if successor["id"] == self.me["id"]:
                return {"owner": self.me, "path": path}
            if ttl <= 0:
                raise ValueError(f"Hop limit reached routing key {key}")
            final = in_half_open(key, self.me["id"], successor["id"])
            self._note(quiet, "FORWARD key=%d next=%s final=%s path=%s", key, successor["name"], final,
                       ">".join(path))
            try:
                # The forwarded call waits for the whole remaining route, so a dead or frozen
                # hop has to be caught here, under the short timeout.
                self.call(successor, "ping", quiet=True)
                forwarded = {"key": key, "path": path, "ttl": ttl - 1, "final": final}
                if quiet:
                    forwarded["quiet"] = True
                return self.call(successor, "find_owner", forwarded,
                                 timeout=RPC_TIMEOUT * max(ttl, 1), quiet=quiet)
            except OSError as exc:
                self._drop_successor(successor, exc)

    def on_store(self, body):
        records = body["records"]
        if not isinstance(records, list):
            raise ValueError("Invalid records")
        for record in records:
            name, ttl = check_name(record["name"]), record["ttl"]
            if isinstance(ttl, bool) or not isinstance(ttl, (int, float)) or not 0 < ttl <= MAX_RECORD_TTL:
                raise ValueError("Invalid record TTL")
            with self.lock:
                known = name in self.records
                self.records[name] = {"value": record["value"], "expires": time.monotonic() + ttl}
            if not known:
                self.log.info("STORE name=%s key=%d ttl=%.1f", name, ring_id(name), ttl)
        return {"status": "stored", "count": len(records)}

    def on_get(self, body):
        name = check_name(body["name"])
        with self.lock:
            record = self.records.get(name)
            if record is None or record["expires"] <= time.monotonic():
                return {"record": None}
            return {"record": {"name": name, "value": record["value"],
                               "ttl": record["expires"] - time.monotonic()}}

    def on_delete(self, body):
        name = check_name(body["name"])
        with self.lock:
            removed = self.records.pop(name, None)
        if removed:
            self.log.info("UNREGISTER name=%s", name)
        return {"status": "deleted" if removed else "absent"}

    def on_lookup(self, body):
        return self.lookup(body["name"])

    def on_host(self, body):
        return self.host_meeting(body["meeting"])

    def on_leave(self, _body):
        # The reply goes out first; leave() ends with this peer's listener closed.
        threading.Thread(target=self.leave, name=f"{self.me['name']}-leave", daemon=True).start()
        return {"status": "leaving"}

    def on_status(self, _body):
        now = time.monotonic()
        with self.lock:
            return {
                "me": self.me,
                "predecessor": self.predecessor,
                "successors": list(self.successors),
                "records": {name: {"key": ring_id(name), "value": record["value"],
                                   "ttl": round(record["expires"] - now, 1)}
                            for name, record in self.records.items()},
                "published": sorted(self.published),
            }


def run_command(peer, line):
    """Execute one interactive command; return False once the terminal should stop reading."""
    command, _, argument = line.strip().partition(" ")
    if command == "status":
        status = peer.on_status({})
        ref = status["predecessor"]
        print(f"me={status['me']['name']} id={status['me']['id']}"
              f" predecessor={ref['name'] if ref else None}"
              f" successors={[item['name'] for item in status['successors']]}")
        print(f"records={status['records']} published={status['published']}")
    elif command == "lookup" and argument:
        print(peer.lookup(argument))
    elif command == "host" and argument:
        print(peer.host_meeting(argument))
    elif command == "leave":
        peer.leave()
        return False
    elif command == "crash":
        os._exit(1)
    elif command:
        print("Commands: status | lookup NAME | host MEETING | leave | crash")
    return True


def read_commands(peer):
    print("Commands: status | lookup NAME | host MEETING | leave | crash", flush=True)
    while True:
        try:
            if not run_command(peer, input()):
                return
        except EOFError:
            return  # No terminal attached: the peer keeps serving until told to leave.
        except (ValueError, OSError, RemoteError) as exc:
            print("Error:", exc)


def main():
    parser = argparse.ArgumentParser(description="Peer node of the ring overlay")
    parser.add_argument("--name", required=True, help="Ring position comes from a hash of this name")
    parser.add_argument("--host", default="127.0.0.1", help="IP to bind and advertise to other peers")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--bootstrap", type=parse_address, help="HOST:PORT of any peer in the ring")
    parser.add_argument("--record-ttl", type=float, default=RECORD_TTL)
    parser.add_argument("--log-dir", default="logs")
    parser.add_argument("--verbose", action="store_true", help="Also log periodic maintenance traffic")
    args = parser.parse_args()
    log = configure_logging(args.name, args.log_dir)
    peer = Peer(args.name, args.host, args.port, log, record_ttl=args.record_ttl, verbose=args.verbose)
    try:
        peer.start(args.bootstrap)
    except (OSError, ValueError, RemoteError) as exc:
        raise SystemExit(f"Could not start {args.name}: {exc}")
    threading.Thread(target=read_commands, args=(peer,), daemon=True).start()
    try:
        while not peer.stopped.wait(0.2):
            pass
    except KeyboardInterrupt:
        peer.leave()
    logging.shutdown()
    # A daemon thread blocked on stdin can abort a normal interpreter exit.
    os._exit(0)


if __name__ == "__main__":
    main()
