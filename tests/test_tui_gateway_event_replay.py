"""Tests for tui_gateway.event_replay — per-session event seq + replay buffer."""

import threading

import pytest

from tui_gateway import event_replay
from tui_gateway import server
from tui_gateway.event_replay import (
    latest_seq,
    reset_replay_state,
    events_since,
    replay_stats,
)


@pytest.fixture(autouse=True)
def _clean():
    reset_replay_state()
    yield
    reset_replay_state()


def _frame(sid, etype="message.delta"):
    return {
        "jsonrpc": "2.0",
        "method": "event",
        "params": {"type": etype, "session_id": sid, "payload": {}},
    }


def _complete_frame(sid, status="complete", warning=None):
    frame = _frame(sid, "message.complete")
    frame["params"]["payload"] = {"status": status}
    if warning:
        frame["params"]["payload"]["warning"] = warning
    return frame


def test_stamp_adds_monotonic_seq_per_session():
    f1 = _frame("s1")
    f2 = _frame("s1")
    other = _frame("s2")

    event_replay._stamp_event(f1)
    event_replay._stamp_event(other)
    event_replay._stamp_event(f2)

    assert f1["params"]["seq"] == 1
    assert f2["params"]["seq"] == 2  # per-session counter, unaffected by s2
    assert other["params"]["seq"] == 1


def test_stamp_ignores_non_event_and_sessionless_frames():
    rpc = {"jsonrpc": "2.0", "id": 1, "result": {}}
    no_sid = {"jsonrpc": "2.0", "method": "event", "params": {"type": "skin.changed"}}

    event_replay._stamp_event(rpc)
    event_replay._stamp_event(no_sid)

    assert "seq" not in rpc
    assert "seq" not in no_sid["params"]
    assert replay_stats()["events"] == 0


def test_events_since_returns_only_newer_frames_in_order():
    frames = [_frame("s1") for _ in range(5)]
    for f in frames:
        event_replay._stamp_event(f)

    got = events_since("s1", 3)
    assert [e["seq"] for e in got] == [4, 5]
    assert events_since("s1", 0) == [f["params"] for f in frames]
    assert events_since("s1", 99) == []
    assert latest_seq("s1") == 5


def test_events_since_returns_client_dispatchable_event_objects():
    """Cross-language contract: the client's replay loop dispatches an element
    only when it has a TOP-LEVEL ``type`` (json-rpc-gateway.ts fetchReplay:
    ``if (!event?.type) continue``). Returning full JSON-RPC envelopes here
    makes every replayed event silently droppable — the original #94219 bug.
    """
    event_replay._stamp_event(_frame("s1"))
    (event,) = events_since("s1", 0)

    # Bare event object, not an envelope.
    assert event["type"] == "message.delta"
    assert event["session_id"] == "s1"
    assert event["seq"] == 1
    assert "jsonrpc" not in event
    assert "method" not in event
    assert "params" not in event


def test_unknown_session_returns_empty():
    assert events_since("nope", 0) == []
    assert latest_seq("nope") == 0


def test_reset_clears_durable_cursor_too():
    event_replay._stamp_event(_complete_frame("s1"))
    assert event_replay.replay_snapshot("s1", 0)["durable_seq"] == 1

    reset_replay_state()

    assert event_replay.replay_snapshot("s1", 0) == {
        "events": [],
        "latest_seq": 0,
        "truncated": False,
        "durable_seq": 0,
        "replay_base_seq": 0,
    }


def test_successful_complete_advances_durable_cursor_only():
    event_replay._stamp_event(_frame("s1"))
    event_replay._stamp_event(_complete_frame("s1", "error"))
    event_replay._stamp_event(_complete_frame("s1", "interrupted"))
    event_replay._stamp_event(
        _complete_frame(
            "s1",
            "complete",
            "History changed during this turn — response was not saved.",
        )
    )

    before = event_replay.replay_snapshot("s1", 0)
    assert before["latest_seq"] == 4
    assert before["durable_seq"] == 0
    assert before["replay_base_seq"] == 0
    assert [event["seq"] for event in before["events"]] == [1, 2, 3, 4]

    event_replay._stamp_event(_complete_frame("s1", "complete"))
    event_replay._stamp_event(_frame("s1"))
    event_replay._stamp_event(_frame("s1"))
    after = event_replay.replay_snapshot("s1", 5)
    assert after["latest_seq"] == 7
    assert after["durable_seq"] == 5
    assert after["replay_base_seq"] == 5
    assert [event["seq"] for event in after["events"]] == [6, 7]


def test_replay_base_supersedes_previous_failed_terminal_on_next_start():
    # A is persisted, so both cursors initially advance together.
    event_replay._stamp_event(_complete_frame("s1"))
    # B fails: its terminal must remain available after an authoritative
    # history hydration of A, because B is not in that history.
    event_replay._stamp_event(_frame("s1", "message.start"))
    event_replay._stamp_event(_complete_frame("s1", "error"))
    failed_b = event_replay.replay_snapshot("s1", 1)
    assert failed_b["durable_seq"] == 1
    assert failed_b["replay_base_seq"] == 1
    assert [event["seq"] for event in failed_b["events"]] == [2, 3]

    # Starting C explicitly supersedes B.  C's start itself stays replayable,
    # while durable history is still only A until C completes successfully.
    event_replay._stamp_event(_frame("s1", "message.start"))
    started_c = event_replay.replay_snapshot("s1", 1)
    assert started_c["durable_seq"] == 1
    assert started_c["replay_base_seq"] == 3
    assert [event["seq"] for event in started_c["events"]] == [2, 3, 4]
    assert [event["seq"] for event in event_replay.replay_snapshot("s1", 3)["events"]] == [4]

    event_replay._stamp_event(_complete_frame("s1"))
    finished_c = event_replay.replay_snapshot("s1", 0)
    assert finished_c["durable_seq"] == 5
    assert finished_c["replay_base_seq"] == 5


def test_many_failed_turns_keep_only_capacity_plus_current_tail():
    for _ in range(event_replay._REPLAY_BUFFER_MAX + 50):
        event_replay._stamp_event(_frame("s1", "message.start"))
        event_replay._stamp_event(_complete_frame("s1", "error"))

    snapshot = event_replay.replay_snapshot("s1", 0)
    stats = replay_stats()
    current_tail = snapshot["latest_seq"] - snapshot["replay_base_seq"]

    assert snapshot["durable_seq"] == 0
    assert current_tail == 2
    assert len(snapshot["events"]) <= event_replay._REPLAY_BUFFER_MAX + current_tail
    assert stats["protected_active_events"] == current_tail
    assert stats["superseded_events"] > 0
    # The newest failure remains replayable until another message.start.
    assert [event["seq"] for event in event_replay.replay_snapshot(
        "s1", snapshot["replay_base_seq"]
    )["events"]] == [snapshot["latest_seq"] - 1, snapshot["latest_seq"]]


def test_replay_snapshot_is_consistent_while_events_are_stamped():
    """A snapshot's events and cursors are captured under the same lock."""
    done = threading.Event()

    def stamp() -> None:
        for _ in range(500):
            event_replay._stamp_event(_frame("s1"))
        done.set()

    worker = threading.Thread(target=stamp)
    worker.start()
    while not done.is_set():
        snapshot = event_replay.replay_snapshot("s1", 0)
        seqs = [event["seq"] for event in snapshot["events"]]
        assert seqs == sorted(seqs)
        if seqs:
            # An unlocked sequence of events_since()+latest_seq() can report
            # a newer cursor than the returned event list.  A snapshot cannot.
            assert seqs[-1] == snapshot["latest_seq"]
        assert snapshot["durable_seq"] <= snapshot["latest_seq"]
    worker.join()

    snapshot = event_replay.replay_snapshot("s1", 0)
    assert snapshot["latest_seq"] == 500
    assert [event["seq"] for event in snapshot["events"]] == list(range(1, 501))


def test_session_events_since_exposes_atomic_snapshot_durable_cursor(monkeypatch):
    seen = {}
    expected = {
        "events": [{"type": "message.delta", "session_id": "s1", "seq": 8}],
        "latest_seq": 8,
        "truncated": False,
        "durable_seq": 7,
        "replay_base_seq": 7,
    }

    def snapshot(sid, last_seen):
        seen.update(sid=sid, last_seen=last_seen)
        return expected

    monkeypatch.setattr(event_replay, "replay_snapshot", snapshot)
    response = server._methods["session.events.since"](
        "request-1", {"session_id": "s1", "last_seen": 7}
    )

    assert seen == {"sid": "s1", "last_seen": 7}
    assert response["result"] == {
        **expected,
        "count": 1,
        "epoch": event_replay.replay_epoch(),
    }


def test_long_active_tail_is_not_pruned_or_truncated_from_durable_cursor():
    event_replay._stamp_event(_complete_frame("s1"))
    durable_seq = event_replay.replay_snapshot("s1", 0)["durable_seq"]
    for _ in range(event_replay._REPLAY_BUFFER_MAX + 50):
        event_replay._stamp_event(_frame("s1"))

    stats = replay_stats()
    # Completed history is pruned, but every active delta is protected until
    # its own successful message.complete becomes durable.
    assert stats["events"] == event_replay._REPLAY_BUFFER_MAX + 50
    assert stats["durable_events"] == 0
    assert stats["protected_active_events"] == event_replay._REPLAY_BUFFER_MAX + 50
    assert stats["max_replay_history_per_session"] == event_replay._REPLAY_BUFFER_MAX

    snapshot = event_replay.replay_snapshot("s1", durable_seq)
    assert not snapshot["truncated"]
    assert [event["seq"] for event in snapshot["events"]] == list(
        range(durable_seq + 1, snapshot["latest_seq"] + 1)
    )


def test_successful_complete_prunes_long_active_tail_back_to_capacity():
    event_replay._stamp_event(_complete_frame("s1"))
    for _ in range(event_replay._REPLAY_BUFFER_MAX + 50):
        event_replay._stamp_event(_frame("s1"))

    event_replay._stamp_event(_complete_frame("s1"))
    snapshot = event_replay.replay_snapshot("s1", 0)
    stats = replay_stats()

    assert snapshot["durable_seq"] == snapshot["latest_seq"]
    assert snapshot["replay_base_seq"] == snapshot["latest_seq"]
    assert len(snapshot["events"]) == event_replay._REPLAY_BUFFER_MAX
    assert stats["events"] == event_replay._REPLAY_BUFFER_MAX
    assert stats["durable_events"] == event_replay._REPLAY_BUFFER_MAX
    assert stats["protected_active_events"] == 0
    # A client hydrated through the new durable terminal can always replay a
    # subsequent active tail without a false truncation gap.
    assert not event_replay.replay_snapshot("s1", snapshot["durable_seq"])["truncated"]


def test_session_count_bounded_with_fifo_eviction():
    event_replay._stamp_event(_complete_frame("s0"))
    for i in range(1, event_replay._REPLAY_SESSIONS_MAX + 11):
        event_replay._stamp_event(_frame(f"s{i}"))

    stats = replay_stats()
    assert stats["sessions"] == event_replay._REPLAY_SESSIONS_MAX
    assert events_since("s0", 0) == []  # oldest session fully evicted
    assert event_replay.replay_snapshot("s0", 0)["durable_seq"] == 0
    assert latest_seq(f"s{event_replay._REPLAY_SESSIONS_MAX + 9}") == 1


def test_concurrent_stamping_never_drops_or_duplicates_seq():
    errors = []

    def worker(sid):
        try:
            seen = set()
            for _ in range(200):
                f = _frame(sid)
                event_replay._stamp_event(f)
                seq = f["params"]["seq"]
                assert seq not in seen
                seen.add(seq)
        except AssertionError as exc:  # pragma: no cover
            errors.append(exc)

    threads = [threading.Thread(target=worker, args=(f"t{i}",)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors
    assert replay_stats()["events"] == 8 * 200


def test_truncation_detection_semantics():
    """The RPC handler's truncated flag: gap between last_seen and buffer start."""
    # Overflow completed history so the oldest events are genuinely evicted.
    for _ in range(event_replay._REPLAY_BUFFER_MAX + 10):
        event_replay._stamp_event(_complete_frame("s1"))

    with event_replay._replay_lock:
        oldest = event_replay._replay_buffers["s1"][0][0]

    assert oldest > 1  # eviction happened

    # Client saw everything up to just before the buffer → NOT truncated.
    assert not event_replay.is_truncated("s1", oldest - 1)
    # Client saw seq 5, buffer starts later → truncated.
    assert event_replay.is_truncated("s1", 5)
    # Unknown session: nothing evicted, nothing truncated.
    assert not event_replay.is_truncated("nope", 0)
