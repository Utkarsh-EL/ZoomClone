"""Wire protocol shared by every service: newline-delimited UTF-8 JSON over TCP."""

import json
import logging
import time
import uuid
from datetime import datetime, timezone

MAX_MESSAGE_BYTES = 65536


def timestamp():
    """Return a timezone-aware UTC timestamp as an ISO 8601 string."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def message(kind, **fields):
    """Create a protocol message with a unique ID and creation timestamp."""
    return {"type": kind, "id": uuid.uuid4().hex, "timestamp": timestamp(), **fields}


def marshal(packet):
    """Convert a Python dict to bytes. The LF byte frames each TCP message."""
    if not isinstance(packet, dict):
        raise ValueError("Packet must be an object")
    encoded = json.dumps(packet, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) > MAX_MESSAGE_BYTES - 1:
        raise ValueError("Message exceeds size limit")
    return encoded + b"\n"


def unmarshal(raw):
    """Parse a complete line into a dictionary; reject invalid packets."""
    if not raw or len(raw) > MAX_MESSAGE_BYTES or not raw.endswith(b"\n"):
        raise ValueError("Missing newline or invalid message length")
    try:
        packet = json.loads(raw[:-1].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("Invalid UTF-8 JSON") from exc
    if not isinstance(packet, dict) or not isinstance(packet.get("type"), str):
        raise ValueError("JSON must be an object with a string 'type'")
    return packet


def send(sock, packet, lock=None, logger=None, trace=False):
    """Write one complete framed packet, optionally serializing concurrent sends."""
    raw = marshal(packet)
    if trace and logger:
        logger.info("MARSHAL object=%r -> wire_bytes=%r", packet, raw)
    if lock is None:
        sock.sendall(raw)
    else:
        with lock:
            sock.sendall(raw)
    if logger:
        logger.info("SEND type=%s id=%s request_id=%s", packet.get("type"),
                    packet.get("id"), packet.get("request_id"))


def receive(reader, logger=None, trace=False):
    """Read one framed packet. Return None on clean EOF."""
    raw = reader.readline(MAX_MESSAGE_BYTES + 1)
    if not raw:
        return None
    packet = unmarshal(raw)
    if trace and logger:
        logger.info("UNMARSHAL wire_bytes=%r -> object=%r", raw, packet)
    if logger:
        logger.info("RECEIVE type=%s id=%s request_id=%s", packet.get("type"),
                    packet.get("id"), packet.get("request_id"))
    return packet


def configure_logging(role, log_dir, trace=False):
    """Configure UTC timestamp logging to a per-process file and the console."""
    from pathlib import Path
    import sys

    directory = Path(log_dir)
    directory.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger(role)
    logger.setLevel(logging.INFO)
    logger.handlers.clear()
    logger.propagate = False
    formatter = logging.Formatter("%(asctime)sZ %(levelname)s %(name)s %(message)s")
    formatter.converter = time.gmtime
    for handler in (logging.FileHandler(directory / f"{role}.log", encoding="utf-8"),
                    logging.StreamHandler(sys.stdout)):
        handler.setFormatter(formatter)
        logger.addHandler(handler)
    logger.info("Logging started; trace_marshalling=%s", trace)
    return logger
