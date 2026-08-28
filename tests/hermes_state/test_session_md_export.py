import time

import hermes_state
from agent.context_compressor import HISTORICAL_TASK_HEADING, SUMMARY_PREFIX, _SUMMARY_END_MARKER
from hermes_state import SessionDB


def test_export_candidates_via_prune_filters_ended_old_sessions(tmp_path, monkeypatch):
    db = SessionDB(db_path=tmp_path / "state.db")
    monkeypatch.setattr(hermes_state.time, "time", lambda: 2_000_000.0)
    try:
        db.create_session("old_cli", source="cli")
        db.end_session("old_cli", "done")
        db._conn.execute("UPDATE sessions SET started_at=?, ended_at=? WHERE id=?", (1_000_000.0, 1_000_010.0, "old_cli"))

        db.create_session("new_cli", source="cli")
        db.end_session("new_cli", "done")
        db._conn.execute("UPDATE sessions SET started_at=?, ended_at=? WHERE id=?", (1_990_000.0, 1_990_010.0, "new_cli"))

        db.create_session("old_active", source="cli")
        db._conn.execute("UPDATE sessions SET started_at=? WHERE id=?", (1_000_000.0, "old_active"))
        db._conn.commit()

        # Export uses the shared prune/archive candidate selection.
        candidates = db.list_prune_candidates(
            started_before=2_000_000.0 - 5 * 86400, archived=None
        )
        assert [c["id"] for c in candidates] == ["old_cli"]
    finally:
        db.close()




def test_get_compression_lineage_returns_only_compression_chain(tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session("root", source="cli")
        db.end_session("root", "compression")
        db.create_session("child", source="cli", parent_session_id="root")
        db.end_session("child", "compression")
        db.create_session("tip", source="cli", parent_session_id="child")
        db.create_session("branch", source="cli", parent_session_id="root", model_config={"_branched_from": "root"})
        db.create_session("delegate", source="delegate", parent_session_id="child", model_config={"_delegate_from": "child"})
        db.create_session("tool", source="tool", parent_session_id="child")

        assert db.get_compression_lineage("tip") == ["root", "child", "tip"]
        assert db.get_compression_lineage("branch") == ["branch"]
        assert db.get_compression_lineage("delegate") == ["delegate"]
        assert db.get_compression_lineage("tool") == ["tool"]
    finally:
        db.close()


def test_display_anchor_key_survives_compaction_tail_clone(tmp_path):
    """The stable anchor stays put when compaction resequences a live tail."""
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session("session", source="cli")
        db.append_message("session", role="user", content="old context", timestamp=10.0)
        watermark = db.get_active_message_watermark("session")
        old_tail_id = db.append_message(
            "session",
            role="tool",
            content="protected tool result",
            tool_call_id="call-1",
            tool_calls=[{"id": "call-1", "type": "function", "function": {"name": "x", "arguments": "{}"}}],
            tool_name="x",
            timestamp=11.0,
        )
        before = db.latest_active_display_anchor("session")
        assert before is not None
        assert before["row_id"] == old_tail_id
        assert before["display_key"].startswith("display:v1:")

        db.archive_and_compact(
            "session",
            [{"role": "assistant", "content": "compressed summary", "timestamp": 12.0}],
            watermark=watermark,
        )
        after = db.latest_active_display_anchor("session")

        assert after is not None
        assert after["row_id"] != old_tail_id
        assert after["display_key"] == before["display_key"]
        assert db.latest_active_display_row_id("session") == after["row_id"]
    finally:
        db.close()


def test_display_anchor_key_survives_compression_child_clone(tmp_path):
    """A real ``publish_compression_child`` tail clone keeps its key."""
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session("root", source="cli")
        db.append_message("root", role="user", content="old context", timestamp=41.0)
        watermark = db.get_active_message_watermark("root")
        root_id = db.append_message(
            "root", role="user", content="continue this", timestamp=42.0
        )
        root_anchor = db.latest_active_display_anchor("root")
        assert db.try_acquire_compression_lock("root", "test-lock", ttl_seconds=60)
        db.publish_compression_child(
            parent_session_id="root",
            child_session_id="tip",
            source="cli",
            messages=[{"role": "assistant", "content": "summary", "timestamp": 43.0}],
            compression_lock_holder="test-lock",
            watermark=watermark,
            watermark_ceiling=root_id,
        )
        tip_anchor = db.latest_active_display_anchor("tip")

        assert root_anchor is not None and tip_anchor is not None
        assert root_anchor["row_id"] == root_id
        assert tip_anchor["row_id"] != root_id
        assert root_anchor["display_key"] == tip_anchor["display_key"]
        # The capture query is deliberately exact-session: it does not walk
        # the compression lineage while the gateway holds history_lock.
        assert db.latest_active_display_row_id("root") == root_id
    finally:
        db.close()


def test_display_keys_do_not_merge_distinct_raw_tool_call_json(tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session("raw-tools", source="cli")
        first_id = db.append_message(
            "raw-tools",
            role="tool",
            content="same",
            timestamp=1.0,
            tool_call_id="call-1",
            tool_name="lookup",
            tool_calls=[{"id": "call-1", "function": {"name": "lookup", "arguments": "{}"}}],
        )
        second_id = db.append_message(
            "raw-tools",
            role="tool",
            content="same",
            timestamp=1.0,
            tool_call_id="call-1",
            tool_name="lookup",
            tool_calls=[{"id": "call-1", "function": {"name": "lookup", "arguments": "{}"}}],
        )
        # Stored JSON key order is part of the established display-dedupe
        # tuple.  These rows must remain separately addressable even though
        # they decode to equivalent Python dicts.
        db._conn.execute(
            "UPDATE messages SET tool_calls = ? WHERE id = ?",
            ('[{"function":{"arguments":"{}","name":"lookup"},"id":"call-1"}]', second_id),
        )
        db._conn.commit()

        messages = db.get_messages(
            "raw-tools", include_compacted=True, include_display_keys=True
        )
        assert [message["id"] for message in messages] == [first_id, second_id]
        assert messages[0]["display_key"] != messages[1]["display_key"]
    finally:
        db.close()


def test_display_message_key_normalizes_composite_user_carrier(tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session("carrier", source="cli")
        plain_id = db.append_message(
            "carrier", role="user", content="REAL ASK", timestamp=1.0
        )
        carrier_id = db.append_message(
            "carrier",
            role="user",
            content=(
                f"{SUMMARY_PREFIX}\n{HISTORICAL_TASK_HEADING}\n"
                "User asked: 'earlier task'\n\n"
                f"{_SUMMARY_END_MARKER}\n\nREAL ASK"
            ),
            timestamp=1.0,
        )
        # The persisted summary content uses the same carrier projection as
        # compacted display dedupe, so it normalizes to the visible ask.
        messages = db.get_messages("carrier", include_display_keys=True)
        by_id = {message["id"]: message for message in messages}
        assert by_id[carrier_id]["display_key"] == by_id[plain_id]["display_key"]
    finally:
        db.close()


def test_fork_children_created_before_continuation_do_not_hijack_lineage(tmp_path):
    # Regression: the forward walk used to accept any non-branch child as the
    # compression continuation. A delegate/tool child spawned BEFORE the real
    # continuation row (the common runtime ordering — the subagent exists
    # before compression rotates the session) was picked as the successor,
    # so lineage and session .md export followed the subagent's transcript.
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session("root", source="cli")
        db.append_message("root", role="user", content="root msg")
        db.create_session(
            "delegate",
            source="delegate",
            parent_session_id="root",
            model_config={"_delegate_from": "root"},
        )
        db.append_message("delegate", role="user", content="delegate private msg")
        db.end_session("root", "compression")
        db.create_session("continuation", source="cli", parent_session_id="root")
        db.append_message("continuation", role="user", content="continuation msg")

        db.create_session("root2", source="cli")
        db.create_session("toolchild", source="tool", parent_session_id="root2")
        db.end_session("root2", "compression")
        db.create_session("cont2", source="cli", parent_session_id="root2")

        assert db.get_compression_lineage("root") == ["root", "continuation"]
        assert db.get_compression_lineage("continuation") == ["root", "continuation"]
        assert db.get_compression_lineage("root2") == ["root2", "cont2"]

        exported = db.export_session_lineage("root")
        assert exported is not None
        assert exported["lineage_session_ids"] == ["root", "continuation"]
        contents = [
            m.get("content")
            for seg in exported["segments"]
            for m in (seg.get("messages") or [])
        ]
        assert contents == ["root msg", "continuation msg"]
    finally:
        db.close()


def test_compression_lineage_matches_resume_tip_when_a_stale_sibling_exists(tmp_path):
    """Ledger replay must not follow an older orphan instead of the live tip."""
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session("root", source="cli")
        db.end_session("root", "compression")
        db.create_session("stale", source="cli", parent_session_id="root")
        db.append_message("stale", role="user", content="stale sibling")
        db.end_session("stale", "ws_orphan_reap")
        db.create_session("live", source="cli", parent_session_id="root")
        db.append_message("live", role="user", content="actual continuation")

        assert db.get_compression_tip("root") == "live"
        assert db.get_compression_lineage("root") == ["root", "live"]
        assert db.get_compression_lineage("live") == ["root", "live"]
    finally:
        db.close()
