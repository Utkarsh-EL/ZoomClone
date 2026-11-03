import itertools
import logging
import socket
import time
import unittest

from client import Participant
from peer import (
    MAX_HOPS, Peer, RemoteError, discover, in_half_open, in_open, parse_address, ring_id, rpc,
)
from protocol import MAX_MESSAGE_BYTES

logging.getLogger("p2p-test").addHandler(logging.NullHandler())
NAMES = ("alpha", "sierra", "ora", "xray")
MEETING = "demo-room"


class RingMathTests(unittest.TestCase):
    def test_open_interval_wraps_around_zero(self):
        self.assertTrue(in_open(5, 1, 9))
        self.assertFalse(in_open(1, 1, 9))
        self.assertFalse(in_open(9, 1, 9))
        self.assertTrue(in_open(65000, 60000, 10))
        self.assertTrue(in_open(3, 60000, 10))
        self.assertFalse(in_open(30000, 60000, 10))

    def test_half_open_interval_includes_its_right_end_only(self):
        self.assertTrue(in_half_open(9, 1, 9))
        self.assertFalse(in_half_open(1, 1, 9))
        self.assertTrue(in_half_open(10, 60000, 10))
        self.assertFalse(in_half_open(60000, 60000, 10))

    def test_equal_ends_span_the_whole_ring(self):
        self.assertTrue(in_half_open(7, 7, 7))
        self.assertTrue(in_half_open(8, 7, 7))
        self.assertFalse(in_open(7, 7, 7))
        self.assertTrue(in_open(8, 7, 7))

    def test_ring_id_is_stable_and_in_range(self):
        self.assertEqual(ring_id(MEETING), ring_id(MEETING))
        self.assertTrue(0 <= ring_id(MEETING) < 2 ** 16)

    def test_parse_address(self):
        self.assertEqual(parse_address("127.0.0.1:7001"), ("127.0.0.1", 7001))
        for bad in ("nohost", ":7001", "host:", "host:port", "host:70000"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                parse_address(bad)


class OverlayCase(unittest.TestCase):
    def setUp(self):
        self.peers = {}

    def tearDown(self):
        for peer in self.peers.values():
            crash(peer)

    def peer(self, name, bootstrap=None, record_ttl=60.0):
        peer = Peer(name, logger=logging.getLogger("p2p-test"), interval=0.03, record_ttl=record_ttl)
        peer.start(self.peers[bootstrap].address if bootstrap else None)
        self.peers[name] = peer
        return peer

    def ring(self, names=NAMES, record_ttl=60.0):
        self.peer(names[0], record_ttl=record_ttl)
        for name in names[1:]:
            self.peer(name, names[0], record_ttl=record_ttl)
        return self.wait_for_ring()

    def order(self):
        return sorted(self.peers, key=lambda name: self.peers[name].me["id"])

    def wait_for_ring(self):
        """Wait until the live peers' pointers form one ring ordered by ID."""
        deadline = time.monotonic() + 15
        while True:
            order = self.order()
            if all(self.peers[name].successors[0]["name"] == order[(i + 1) % len(order)]
                   and (self.peers[name].predecessor or {}).get("name") == order[i - 1]
                   for i, name in enumerate(order)):
                return order
            if time.monotonic() >= deadline:
                self.fail(f"Ring did not stabilize; expected order {order}")
            time.sleep(0.01)

    def wait_for(self, predicate, what, seconds=15):
        deadline = time.monotonic() + seconds
        while not predicate():
            if time.monotonic() >= deadline:
                self.fail(f"Timed out waiting for {what}")
            time.sleep(0.02)

    def owner_of(self, name):
        key = ring_id(name)
        order = self.order()
        return next((peer for peer in order if self.peers[peer].me["id"] >= key), order[0])

    def name_capturing(self, key):
        """Return a peer name whose ID takes over a key from the current ring."""
        owner = self.peers[self.owner_of(MEETING)].me["id"]
        return next(name for name in (f"candidate{i}" for i in itertools.count())
                    if in_open(ring_id(name), key - 1, owner))


def crash(peer):
    """Stop a peer with no handoff or notice, as a killed process would."""
    if not peer.stopped.is_set():
        peer.stopping.set()
        peer._stop_meetings()
        peer.server.shutdown()
        peer.server.server_close()
        peer.stopped.set()


class OverlayTests(OverlayCase):
    def test_lone_peer_owns_everything(self):
        peer = self.peer("alpha")
        answer = peer.lookup("nothing-here")
        self.assertEqual((answer["owner"], answer["found"], answer["path"]), ("alpha", False, ["alpha"]))
        peer.publish("thing", {"where": "here"})
        self.assertEqual(peer.lookup("thing")["value"], {"where": "here"})

    def test_four_peers_form_one_ordered_ring(self):
        order = self.ring()
        self.assertEqual(len(order), 4)
        ids = [self.peers[name].me["id"] for name in order]
        self.assertEqual(ids, sorted(ids))
        for index, name in enumerate(order):
            expected = [order[(index + step) % 4] for step in (1, 2, 3)]
            self.wait_for(lambda: [ref["name"] for ref in self.peers[name].successors] == expected,
                          f"{name}'s successor list")

    def test_lookup_is_routed_hop_by_hop_to_the_owner(self):
        order = self.ring()
        self.peers[order[0]].publish(MEETING, {"host": "h", "port": 1})
        owner = self.owner_of(MEETING)
        origin = order[(order.index(owner) + 1) % 4]
        answer = self.peers[origin].lookup(MEETING)
        walk = [order[(order.index(origin) + step) % 4] for step in range(4)]
        self.assertEqual(answer["path"], walk)
        self.assertEqual(answer["owner"], owner)
        self.assertTrue(answer["found"])

    def test_every_peer_resolves_a_meeting_and_clients_can_use_it(self):
        order = self.ring()
        provider = self.peers[order[0]]
        hosted = provider.host_meeting(MEETING)
        users = []
        for index, name in enumerate(order):
            self.assertEqual(discover(MEETING, self.peers[name].address), (hosted["host"], hosted["port"]))
            user = Participant(f"user{index}", MEETING, hosted["host"], hosted["port"])
            user.connect()
            self.addCleanup(user.close)
            users.append(user)
        self.assertEqual(users[0].request("meeting_info")["participant_count"], 4)
        self.assertEqual(users[0].group_send("found through the ring")["group_deliveries"], 4)
        with self.assertRaises(LookupError):
            discover("no-such-meeting", provider.address)

    def test_second_host_for_a_meeting_is_refused(self):
        order = self.ring()
        self.peers[order[0]].host_meeting(MEETING)
        with self.assertRaisesRegex(ValueError, "already hosted"):
            self.peers[order[1]].host_meeting(MEETING)

    def test_joining_peer_receives_the_keys_it_now_owns(self):
        order = self.ring()
        previous_owner = self.owner_of(MEETING)
        self.peers[order[0]].publish(MEETING, {"host": "h", "port": 1})
        name = self.name_capturing(ring_id(MEETING))
        joiner = self.peer(name, order[0])
        self.wait_for_ring()
        self.assertEqual(self.owner_of(MEETING), name)
        self.wait_for(lambda: MEETING in joiner.records, "the key to move to the joining peer")
        self.assertNotIn(MEETING, self.peers[previous_owner].records)
        self.assertEqual(self.peers[order[0]].lookup(MEETING)["owner"], name)

    def test_graceful_leave_hands_off_keys_and_relinks_neighbors(self):
        order = self.ring()
        owner = self.owner_of(MEETING)
        provider = next(name for name in order if name != owner)
        # The record TTL is far above the test's run time, so only the handoff can move the key.
        self.peers[provider].publish(MEETING, {"host": "h", "port": 1})
        heir = order[(order.index(owner) + 1) % 4]
        before = order[order.index(owner) - 1]
        leaver = self.peers.pop(owner)
        leaver.leave()
        self.assertTrue(leaver.stopped.is_set())
        self.assertIn(MEETING, self.peers[heir].records)
        self.assertEqual(self.peers[before].successors[0]["name"], heir)
        self.assertEqual(self.peers[heir].predecessor["name"], before)
        self.wait_for_ring()
        answer = self.peers[provider].lookup(MEETING)
        self.assertEqual((answer["owner"], answer["found"]), (heir, True))
        leaver.leave()  # A second call is harmless.

    def test_provider_leaving_removes_its_record(self):
        order = self.ring()
        owner = self.owner_of(MEETING)
        provider = next(name for name in order if name != owner)
        self.peers[provider].host_meeting(MEETING)
        self.peers.pop(provider).leave()
        self.wait_for_ring()
        self.assertFalse(self.peers[owner].lookup(MEETING)["found"])

    def test_last_two_peers_can_part(self):
        self.ring(("alpha", "sierra"))
        self.peers.pop("alpha").leave()
        survivor = self.peers["sierra"]
        self.assertEqual(survivor.successors[0]["name"], "sierra")
        self.assertIsNone(survivor.predecessor)

    def test_crashed_owner_is_routed_around_and_provider_reregisters(self):
        order = self.ring(record_ttl=0.6)
        owner = self.owner_of(MEETING)
        heir = order[(order.index(owner) + 1) % 4]
        provider = next(name for name in order if name not in (owner, heir))
        self.peers[provider].publish(MEETING, {"host": "h", "port": 1})
        self.wait_for(lambda: MEETING in self.peers[owner].records, "the key to reach its owner")
        crash(self.peers.pop(owner))
        self.wait_for_ring()
        self.wait_for(lambda: MEETING in self.peers[heir].records, "the provider to re-register")
        answer = self.peers[provider].lookup(MEETING)
        self.assertEqual((answer["owner"], answer["found"]), (heir, True))

    def test_ring_survives_two_consecutive_crashes(self):
        order = self.ring((*NAMES, "echo"))
        first, second = order[1], order[2]
        crash(self.peers.pop(first))
        crash(self.peers.pop(second))
        self.assertEqual(self.wait_for_ring(), [order[0], *order[3:]])

    def test_lookup_routes_around_a_dead_successor_before_repair(self):
        order = self.ring()
        peer = self.peers[order[0]]
        dead = order[1]
        peer.stopping.set()  # This peer's repair loop stays out of the way.
        crash(self.peers.pop(dead))
        owner = self.owner_of(MEETING)
        self.assertEqual(peer.find_owner(ring_id(MEETING))["owner"]["name"], owner)
        self.assertEqual(peer.successors[0]["name"], order[2])

    def test_lookup_routes_around_a_frozen_successor(self):
        order = self.ring()
        peer = self.peers[order[0]]
        peer.stopping.set()
        # A socket that listens but never answers behaves like a hung process.
        with socket.socket() as frozen:
            frozen.bind(("127.0.0.1", 0))
            frozen.listen()
            ref = {"id": (peer.me["id"] + 1) % 2 ** 16, "name": "frozen", "host": "127.0.0.1",
                   "port": frozen.getsockname()[1]}
            with peer.lock:
                peer.successors = [ref, *peer.successors]
            started = time.monotonic()
            answer = peer.find_owner(ring_id(MEETING))
        self.assertEqual(answer["owner"]["name"], self.owner_of(MEETING))
        self.assertNotIn("frozen", answer["path"])
        self.assertLess(time.monotonic() - started, 5)

    def test_crashed_peer_can_rejoin_on_its_old_address(self):
        order = self.ring()
        name = order[1]
        port = self.peers[name].me["port"]
        crash(self.peers.pop(name))
        # The rejoin starts at once, while the ring still lists the old instance.
        peer = Peer(name, port=port, logger=logging.getLogger("p2p-test"), interval=0.03)
        started = time.monotonic()
        peer.start(self.peers[order[0]].address)
        self.peers[name] = peer
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(self.wait_for_ring(), order)

    def test_crashed_provider_record_expires(self):
        order = self.ring(record_ttl=0.3)
        owner = self.owner_of(MEETING)
        provider = next(name for name in order if name != owner)
        self.peers[provider].publish(MEETING, {"host": "h", "port": 1})
        self.assertTrue(self.peers[owner].lookup(MEETING)["found"])
        crash(self.peers.pop(provider))
        self.wait_for(lambda: not self.peers[owner].lookup(MEETING)["found"], "the record to expire")
        self.wait_for(lambda: MEETING not in self.peers[owner].records, "the expiry sweep")


class ValidationTests(OverlayCase):
    def test_taken_ring_id_is_refused(self):
        self.peer("alpha")
        with self.assertRaisesRegex(ValueError, "already taken"):
            self.peer("alpha", "alpha")

    def test_join_through_an_unreachable_peer_fails(self):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            address = probe.getsockname()
        peer = Peer("alpha", logger=logging.getLogger("p2p-test"))
        with self.assertRaises(OSError):
            peer.start(address)

    def test_bad_requests_get_errors_and_the_peer_keeps_serving(self):
        peer = self.peer("alpha")
        bad_requests = (
            ("no_such_kind", {}),
            ("lookup", {"name": "bad name!"}),
            ("lookup", {}),
            ("notify", {"peer": {"id": "x"}}),
            ("store", {"records": "nope"}),
            ("store", {"records": [{"name": "a", "value": 1, "ttl": -1}]}),
            ("find_owner", {"key": 2 ** 16, "path": [], "ttl": 1}),
            ("find_owner", {"key": 1, "path": ["x"] * (MAX_HOPS + 1), "ttl": 1}),
        )
        for kind, body in bad_requests:
            with self.subTest(kind=kind, body=body), self.assertRaises(RemoteError):
                rpc(peer.address, kind, body)
        for raw in (b"{not json}\n", b"x" * (MAX_MESSAGE_BYTES + 10) + b"\n"):
            with socket.create_connection(peer.address, timeout=2) as sock:
                sock.sendall(raw)
                self.assertIn(b'"error"', sock.makefile("rb").readline())
        self.assertEqual(rpc(peer.address, "ping")["status"], "ok")

    def test_routing_stops_at_the_hop_limit(self):
        order = self.ring()
        origin = self.peers[order[0]]
        key = self.peers[order[2]].me["id"]
        with self.assertRaisesRegex(RemoteError, "Hop limit"):
            rpc(origin.address, "find_owner", {"key": key, "path": [], "ttl": 0})


if __name__ == "__main__":
    unittest.main()
