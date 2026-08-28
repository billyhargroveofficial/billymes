"""Round-trip tests for the structured Codex/reasoning columns.

get_messages() returns reasoning_details / codex_reasoning_items /
codex_message_items / codex_output_items as the raw TEXT stored in their
columns (it only hydrates content and tool_calls). Callers that feed those
rows straight back into a write — the POST /api/sessions/{id}/fork handler
pipes get_messages() into replace_messages() — must not re-encode that
TEXT, or the forked session replays with structured fields decoding to
strings and every isinstance(..., list) consumer silently drops them.
"""
import json
import sqlite3

import pytest

from hermes_state import SCHEMA_VERSION, SessionDB


REASONING_DETAILS = [
    {"type": "reasoning.text", "text": "compare both branches first", "format": "unknown"}
]
CODEX_REASONING_ITEMS = [
    {"id": "rs_1", "type": "reasoning", "encrypted_content": "opaque-blob"}
]
CODEX_MESSAGE_ITEMS = [
    {
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "content": [{"type": "output_text", "text": "done"}],
    }
]
CODEX_OUTPUT_ITEMS = [
    {
        "id": "rs_1",
        "type": "reasoning",
        "encrypted_content": "opaque-blob",
        "summary": [{"type": "summary_text", "text": "searched first"}],
        "_issuer_kind": "codex_responses",
    },
    {
        "id": "ws_1",
        "type": "web_search_call",
        "status": "completed",
        "action": {"type": "search", "query": "current docs"},
    },
    {
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "status": "completed",
        "content": [
            {
                "type": "output_text",
                "text": "done",
                "annotations": [
                    {
                        "type": "url_citation",
                        "url": "https://example.test/docs",
                        "title": "Docs",
                    }
                ],
            }
        ],
    },
]


@pytest.fixture
def db(tmp_path):
    return SessionDB(tmp_path / "state.db")


def _seed(db, sid="src"):
    """Session with one assistant message carrying all three reasoning fields."""
    db.create_session(sid, source="cli")
    db.append_message(sid, role="user", content="hi")
    db.append_message(
        sid,
        role="assistant",
        content="done",
        reasoning_details=REASONING_DETAILS,
        codex_reasoning_items=CODEX_REASONING_ITEMS,
        codex_message_items=CODEX_MESSAGE_ITEMS,
        codex_output_items=CODEX_OUTPUT_ITEMS,
    )


def _fork(db, src, dst):
    """The fork handler's copy step: raw get_messages rows into replace_messages."""
    db.create_session(dst, source="cli")
    db.replace_messages(dst, db.get_messages(src))


def _assistant(conversation):
    return next(m for m in conversation if m["role"] == "assistant")


class TestDirectWrite:
    """Live-runtime path: structured values in, structured values back."""

    def test_reasoning_fields_hydrate_as_structures(self, db):
        _seed(db)
        msg = _assistant(db.get_messages_as_conversation("src"))
        assert msg["reasoning_details"] == REASONING_DETAILS
        assert msg["codex_reasoning_items"] == CODEX_REASONING_ITEMS
        assert msg["codex_message_items"] == CODEX_MESSAGE_ITEMS
        assert msg["codex_output_items"] == CODEX_OUTPUT_ITEMS


class TestForkRoundTrip:
    """get_messages -> replace_messages must keep the stored TEXT intact."""

    def test_reasoning_details_survive_fork(self, db):
        _seed(db)
        _fork(db, "src", "fork")
        msg = _assistant(db.get_messages_as_conversation("fork"))
        assert msg["reasoning_details"] == REASONING_DETAILS

    def test_codex_reasoning_items_survive_fork(self, db):
        _seed(db)
        _fork(db, "src", "fork")
        msg = _assistant(db.get_messages_as_conversation("fork"))
        assert msg["codex_reasoning_items"] == CODEX_REASONING_ITEMS

    def test_codex_message_items_survive_fork(self, db):
        _seed(db)
        _fork(db, "src", "fork")
        msg = _assistant(db.get_messages_as_conversation("fork"))
        assert msg["codex_message_items"] == CODEX_MESSAGE_ITEMS

    def test_codex_output_items_survive_fork(self, db):
        _seed(db)
        _fork(db, "src", "fork")
        msg = _assistant(db.get_messages_as_conversation("fork"))
        assert msg["codex_output_items"] == CODEX_OUTPUT_ITEMS

    def test_fork_of_fork_stays_stable(self, db):
        # Each extra round-trip used to add another encoding layer.
        _seed(db)
        _fork(db, "src", "fork1")
        _fork(db, "fork1", "fork2")
        msg = _assistant(db.get_messages_as_conversation("fork2"))
        assert msg["reasoning_details"] == REASONING_DETAILS
        assert msg["codex_reasoning_items"] == CODEX_REASONING_ITEMS
        assert msg["codex_message_items"] == CODEX_MESSAGE_ITEMS
        assert msg["codex_output_items"] == CODEX_OUTPUT_ITEMS


class TestAppendMessageRoundTrip:
    """append_message accepts a stored row's already-serialized TEXT too."""

    def test_string_value_not_double_encoded(self, db):
        _seed(db)
        row = next(m for m in db.get_messages("src") if m["role"] == "assistant")
        db.create_session("copy", source="cli")
        db.append_message(
            "copy",
            role="assistant",
            content="done",
            reasoning_details=row["reasoning_details"],
            codex_output_items=row["codex_output_items"],
        )
        msg = _assistant(db.get_messages_as_conversation("copy"))
        assert msg["reasoning_details"] == REASONING_DETAILS
        assert msg["codex_output_items"] == CODEX_OUTPUT_ITEMS


class TestSqlCloneRoundTrip:
    """Pure-SQL concurrent-tail clones must include newly added columns."""

    def test_codex_output_items_survive_compaction_tail_clone(self, db):
        db.create_session("compact", source="cli")
        db.append_message("compact", role="user", content="before")
        watermark = db.get_active_message_watermark("compact")
        db.append_message(
            "compact",
            role="assistant",
            content="concurrent answer",
            codex_output_items=CODEX_OUTPUT_ITEMS,
        )

        inserted = db.archive_and_compact(
            "compact",
            [{"role": "user", "content": "summary"}],
            watermark=watermark,
        )

        assert inserted == 2
        msg = _assistant(db.get_messages_as_conversation("compact"))
        assert msg["codex_output_items"] == CODEX_OUTPUT_ITEMS


class TestExportImportRoundTrip:
    def test_codex_output_items_survive_json_export_import(self, db, tmp_path):
        _seed(db)
        exported = db.export_session("src")
        assert exported is not None
        # Match an actual JSON file boundary rather than passing shared objects.
        payload = json.loads(json.dumps(exported))

        target = SessionDB(tmp_path / "imported.db")
        try:
            result = target.import_sessions([payload])
            assert result["ok"] is True
            msg = _assistant(target.get_messages_as_conversation("src"))
            assert msg["codex_output_items"] == CODEX_OUTPUT_ITEMS
        finally:
            target.close()


def test_v26_schema_reconciles_codex_output_items_column(tmp_path):
    """A pre-v27 store gains the column without losing existing messages."""
    path = tmp_path / "legacy-v26.db"
    legacy = SessionDB(path)
    try:
        legacy.create_session("legacy", source="cli")
        legacy.append_message("legacy", role="user", content="hi")
        legacy.append_message(
            "legacy",
            role="assistant",
            content="old answer",
            codex_reasoning_items=CODEX_REASONING_ITEMS,
            codex_message_items=CODEX_MESSAGE_ITEMS,
        )
    finally:
        legacy.close()

    conn = sqlite3.connect(path)
    try:
        conn.execute("ALTER TABLE messages DROP COLUMN codex_output_items")
        conn.execute("UPDATE schema_version SET version = 26")
        conn.commit()
    finally:
        conn.close()

    reopened = SessionDB(path)
    try:
        columns = {
            row[1]
            for row in reopened._conn.execute("PRAGMA table_info(messages)")
        }
        version = reopened._conn.execute(
            "SELECT version FROM schema_version LIMIT 1"
        ).fetchone()[0]
        assert "codex_output_items" in columns
        assert version == SCHEMA_VERSION == 27

        old = _assistant(reopened.get_messages_as_conversation("legacy"))
        assert old["codex_reasoning_items"] == CODEX_REASONING_ITEMS
        assert old["codex_message_items"] == CODEX_MESSAGE_ITEMS

        reopened.append_message(
            "legacy",
            role="assistant",
            content="new answer",
            codex_output_items=CODEX_OUTPUT_ITEMS,
        )
        new = reopened.get_messages_as_conversation("legacy")[-1]
        assert new["codex_output_items"] == CODEX_OUTPUT_ITEMS
    finally:
        reopened.close()
