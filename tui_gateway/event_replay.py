"""Per-session event sequencing + durable-aware replay for WS reconnects.

Every gateway event frame that flows through :func:`server.write_json` (and
therefore ``_emit``) is stamped with a per-session monotonic ``seq`` and
appended to a replay buffer keyed by session id. A reconnecting client
calls the ``session.events.since`` RPC with its last observed seq; the server
replays everything newer from the buffer, then live events resume seamlessly.

Design constraints honored:
- stdio TUI path unaffected: frames gain a ``seq`` field only on event frames;
  Ink ignores unknown params keys.
- Thread safety: a single module lock guards counters + buffers; write_json
  already serializes per-transport writes, so stamping under the lock cannot
  reorder frames relative to each other.
- Memory bound: replay history safe to discard after authoritative hydration
  is capped at _REPLAY_BUFFER_MAX events and _REPLAY_SESSIONS_MAX sessions are
  retained FIFO.  The current active tail is deliberately retained in full,
  so a reconnect never loses a long in-flight response to truncation.
"""

from __future__ import annotations

import threading
import uuid
from collections import OrderedDict, deque

# Process identity for the replay contract. Seq counters live in-process, so
# a gateway restart silently resets them to 1 while clients still hold high
# watermarks — events_since(sid, 97) then returns [] with truncated=False and
# the client believes it missed nothing (and its stale watermark makes every
# future replay empty too). The epoch lets clients detect the restart and
# reset their watermarks.
_REPLAY_EPOCH = uuid.uuid4().hex

# Retained replay history per session.  This is not a hard total deque length:
# the still-current tail (seq > replay_base_seq) is intentionally exempt until
# a later transition makes it safe to discard.
_REPLAY_BUFFER_MAX = 512
# Distinct sessions remembered. Desktop users rarely exceed a dozen live chats.
_REPLAY_SESSIONS_MAX = 64

_replay_lock = threading.Lock()
# sid -> deque of (seq, event_object) where event_object is the frame's
# ``params`` dict (bare event: type/session_id/seq/payload) — the exact shape
# the client's dispatch path consumes.
_replay_buffers: "OrderedDict[str, deque]" = OrderedDict()
_replay_next_seq: dict[str, int] = {}
# Highest sequence at which this session emitted a successful terminal turn.
# Unlike ``latest_seq`` this deliberately does not advance for an error or an
# interrupted/cancelled turn.  It reports persistence progress; reconnecting
# clients use the broader replay-base cursor below for discard decisions.
_replay_durable_seq: dict[str, int] = {}
# Highest prefix an authoritatively hydrated client may omit.  It can advance
# beyond durable_seq only when a new turn starts, explicitly superseding a
# prior error/interrupted/warning terminal that was never persisted.
_replay_base_seq: dict[str, int] = {}


def replay_epoch() -> str:
    """Opaque token identifying this server process's seq numbering."""
    return _REPLAY_EPOCH


def _prune_replay_history(buf: deque, replay_base_seq: int) -> None:
    """Keep the current tail intact while bounding discardable replay history.

    Must run under ``_replay_lock``.  A long streaming response can exceed
    the ordinary replay capacity; its frames remain available until a normal
    ``message.complete`` makes them durable or a new ``message.start``
    supersedes a previous failed terminal.  At either transition the buffer
    can again shrink to its capacity without dropping the current turn.
    """
    while len(buf) > _REPLAY_BUFFER_MAX and buf[0][0] <= replay_base_seq:
        buf.popleft()


def _stamp_event(obj: dict) -> None:
    """Stamp one outgoing event frame (mutates obj in place) and record it."""
    if obj.get("method") != "event":
        return
    params = obj.get("params")
    if not isinstance(params, dict):
        return
    sid = params.get("session_id") or ""
    if not sid:
        # Session-less global events (skin.changed etc.) are re-fetchable via
        # their own RPCs; no replay contract for them.
        return
    with _replay_lock:
        seq = _replay_next_seq.get(sid, 0) + 1
        _replay_next_seq[sid] = seq
        params["seq"] = seq
        buf = _replay_buffers.get(sid)
        if buf is None:
            # Do not use deque(maxlen=...): it silently drops the oldest
            # active delta before replay_base_seq can move past it.
            buf = deque()
            _replay_buffers[sid] = buf
            while len(_replay_buffers) > _REPLAY_SESSIONS_MAX:
                _oldest_sid, _oldest_buf = _replay_buffers.popitem(last=False)
                _replay_next_seq.pop(_oldest_sid, None)
                _replay_durable_seq.pop(_oldest_sid, None)
                _replay_base_seq.pop(_oldest_sid, None)
        buf.append((seq, params))
        # Only a normally completed, persisted assistant turn is a durable
        # baseline.  In particular, ``message.complete`` also represents
        # error/interrupted endings and a history-version mismatch reports a
        # successful-looking response with ``warning`` because it was not
        # saved.  All of those must remain replayable rather than being
        # skipped by a client that hydrates saved history first.
        if (
            params.get("type") == "message.complete"
            and isinstance(params.get("payload"), dict)
            and params["payload"].get("status") == "complete"
            and not params["payload"].get("warning")
        ):
            _replay_durable_seq[sid] = seq
            _replay_base_seq[sid] = seq
        elif params.get("type") == "message.start":
            # A new turn makes the previous non-durable terminal obsolete:
            # it has either been shown already or is superseded by the new
            # authoritative request.  Keep this start itself replayable.
            _replay_base_seq[sid] = max(_replay_base_seq.get(sid, 0), seq - 1)
        _prune_replay_history(buf, _replay_base_seq.get(sid, 0))


def replay_snapshot(sid: str, last_seen: int) -> dict:
    """Read a self-consistent replay view under one lock acquisition.

    The event list and both cursors must describe the same instant.
    ``durable_seq`` marks only successfully persisted history.  The broader
    ``replay_base_seq`` also marks failed/warning terminals explicitly
    superseded by a later ``message.start``.  Every event newer than the base
    remains available for the active turn.
    """
    with _replay_lock:
        key = sid or ""
        buf = _replay_buffers.get(key)
        if not buf:
            return {
                "events": [],
                "latest_seq": _replay_next_seq.get(key, 0),
                "truncated": False,
                "durable_seq": _replay_durable_seq.get(key, 0),
                "replay_base_seq": _replay_base_seq.get(key, 0),
            }
        return {
            "events": [event for seq, event in buf if seq > last_seen],
            "latest_seq": _replay_next_seq.get(key, 0),
            "truncated": last_seen + 1 < buf[0][0],
            "durable_seq": _replay_durable_seq.get(key, 0),
            "replay_base_seq": _replay_base_seq.get(key, 0),
        }


def events_since(sid: str, last_seen: int) -> list[dict]:
    """Return recorded EVENT OBJECTS with seq > last_seen for *sid*, in order.

    Shape contract: each element is the frame's ``params`` dict — a bare event
    object with top-level ``type`` / ``session_id`` / ``seq`` — because that is
    exactly what the client's dispatch path consumes. Returning the full
    JSON-RPC envelope here would make every replayed event fail the client's
    ``event.type`` gate and be silently dropped.
    """
    with _replay_lock:
        buf = _replay_buffers.get(sid or "")
        if not buf:
            return []
        return [event for seq, event in buf if seq > last_seen]


def is_truncated(sid: str, last_seen: int) -> bool:
    """True when events between *last_seen* and the buffer's oldest retained
    seq were evicted — the client must refetch history instead of trusting
    the replay to be gap-free."""
    with _replay_lock:
        buf = _replay_buffers.get(sid or "")
        if not buf:
            return False
        return last_seen + 1 < buf[0][0]


def latest_seq(sid: str) -> int:
    """Current highest stamped seq for *sid* (0 when unknown)."""
    with _replay_lock:
        return _replay_next_seq.get(sid or "", 0)


def reset_replay_state() -> None:
    """Test hook."""
    with _replay_lock:
        _replay_buffers.clear()
        _replay_next_seq.clear()
        _replay_durable_seq.clear()
        _replay_base_seq.clear()


def replay_stats() -> dict:
    """Telemetry: buffer occupancy for the ops/debug surface."""
    with _replay_lock:
        durable_events = 0
        superseded_events = 0
        protected_active_events = 0
        for sid, buf in _replay_buffers.items():
            durable_seq = _replay_durable_seq.get(sid, 0)
            replay_base_seq = _replay_base_seq.get(sid, 0)
            for seq, _event in buf:
                if seq <= durable_seq:
                    durable_events += 1
                elif seq <= replay_base_seq:
                    superseded_events += 1
                else:
                    protected_active_events += 1
        return {
            "sessions": len(_replay_buffers),
            "events": sum(len(b) for b in _replay_buffers.values()),
            "durable_events": durable_events,
            "superseded_events": superseded_events,
            "protected_active_events": protected_active_events,
            # Kept for existing debug consumers; it is the replay-history
            # capacity, not a limit on the protected current tail.
            "max_per_session": _REPLAY_BUFFER_MAX,
            "max_replay_history_per_session": _REPLAY_BUFFER_MAX,
        }
