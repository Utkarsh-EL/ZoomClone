"""Reusable TCP meeting participant, with asynchronous event reception."""

import argparse
import queue
import socket
import threading

from peer import RemoteError, discover, parse_address
from protocol import configure_logging, message, receive, send


class Participant:
    def __init__(self, name, meeting="demo-room", host="127.0.0.1", port=5000,
                 logger=None, trace=False):
        self.name, self.meeting, self.host, self.port = name, meeting, host, port
        self.log = logger
        self.trace = trace
        self.sock = None
        self.reader = None
        self.send_lock = threading.Lock()
        self.pending_lock = threading.Lock()
        self.pending = {}
        self.inbox = queue.Queue()
        self.receiver = None
        self.closed = threading.Event()

    def connect(self):
        self.sock = socket.create_connection((self.host, self.port), timeout=5)
        self.sock.settimeout(None)
        self.reader = self.sock.makefile("rb")
        join = message("join", body={"username": self.name, "meeting": self.meeting})
        send(self.sock, join, self.send_lock, self.log, self.trace)
        answer = receive(self.reader, self.log, self.trace)
        if answer is None or answer.get("type") != "reply" or answer.get("request_id") != join["id"]:
            self.close()
            raise ConnectionError(f"Join failed: {answer}")
        self.receiver = threading.Thread(target=self._listen, name=f"{self.name}-receiver", daemon=True)
        self.receiver.start()
        return answer["body"]

    def _listen(self):
        try:
            while not self.closed.is_set():
                packet = receive(self.reader, self.log, self.trace)
                if packet is None:
                    break
                req_id = packet.get("request_id")
                if packet["type"] in ("reply", "error") and req_id:
                    with self.pending_lock:
                        waiter = self.pending.get(req_id)
                    if waiter is not None:
                        waiter.put(packet)
                        continue
                self.inbox.put(packet)
                if self.log and packet["type"] == "participant_left":
                    self.log.info("ANNOUNCEMENT meeting=%s: %s",
                                  packet.get("meeting"), packet["body"]["content"])
                if self.log and packet["type"] in ("event", "group_message"):
                    self.log.info("DELIVERED %s from=%s meeting=%s body=%r",
                                  packet["type"], packet.get("sender"), packet.get("meeting"), packet.get("body"))
        except (OSError, ValueError) as exc:
            if self.log:
                self.log.warning("Receiver disconnected: %s", exc)
        finally:
            self.closed.set()

    def call(self, kind, **body):
        if self.closed.is_set() or self.sock is None:
            raise ConnectionError("Participant is not connected")
        packet = message(kind, body=body)
        waiter = queue.Queue(maxsize=1)
        with self.pending_lock:
            self.pending[packet["id"]] = waiter
        try:
            send(self.sock, packet, self.send_lock, self.log, self.trace)
            try:
                response = waiter.get(timeout=5)
            except queue.Empty as exc:
                raise TimeoutError(f"No reply to {kind}") from exc
            if response["type"] == "error":
                raise ValueError(response.get("body", {}).get("error", "Unknown error"))
            return response.get("body", {})
        finally:
            with self.pending_lock:
                self.pending.pop(packet["id"], None)

    def request(self, operation):
        return self.call("request", operation=operation)

    def subscribe(self, topic):
        return self.call("subscribe", topic=topic)

    def publish(self, topic, content):
        return self.call("publish", topic=topic, content=content)

    def group_send(self, content):
        return self.call("group_send", content=content)

    def wait_for(self, predicate, timeout=7):
        """Wait for an asynchronous event matching a predicate."""
        import time
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Expected event was not received")
            packet = self.inbox.get(timeout=remaining)
            if predicate(packet):
                return packet

    def close(self):
        self.closed.set()
        if self.sock:
            try:
                self.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self.sock.close()
        if self.reader:
            self.reader.close()


def main():
    parser = argparse.ArgumentParser(description="Interactive meeting participant")
    parser.add_argument("--name", required=True)
    parser.add_argument("--meeting", default="demo-room")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5000)
    parser.add_argument("--via", type=parse_address,
                        help="HOST:PORT of any P2P peer; finds the meeting through the overlay "
                             "and replaces --host and --port")
    parser.add_argument("--log-dir", default="logs")
    parser.add_argument("--trace-marshalling", action="store_true")
    args = parser.parse_args()
    log = configure_logging(args.name, args.log_dir, args.trace_marshalling)
    if args.via:
        try:
            args.host, args.port = discover(args.meeting, args.via)
        except (LookupError, OSError, RemoteError) as exc:
            raise SystemExit(f"Could not discover {args.meeting}: {exc}")
        log.info("DISCOVERED meeting=%s via=%s:%d coordinator=%s:%d", args.meeting, *args.via,
                 args.host, args.port)
    user = Participant(args.name, args.meeting, args.host, args.port, log, args.trace_marshalling)
    try:
        print("Joined:", user.connect())
        print("Commands: members | info | subscribe TOPIC | publish TOPIC TEXT | say TEXT | quit")
        while True:
            command = input(f"{args.name}> ").strip()
            if command == "quit":
                break
            if command == "members":
                print(user.request("list_participants"))
            elif command == "info":
                print(user.request("meeting_info"))
            elif command.startswith("subscribe "):
                print(user.subscribe(command.split(maxsplit=1)[1]))
            elif command.startswith("publish "):
                parts = command.split(maxsplit=2)
                print(user.publish(parts[1], parts[2]) if len(parts) == 3 else "Usage: publish TOPIC TEXT")
            elif command.startswith("say "):
                print(user.group_send(command.split(maxsplit=1)[1]))
            elif command:
                print("Unknown command; use members, info, subscribe, publish, say, quit")
    except (KeyboardInterrupt, EOFError):
        pass
    finally:
        user.close()


if __name__ == "__main__":
    main()
