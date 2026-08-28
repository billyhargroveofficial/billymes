"""Direct Responses manual-history replay for provider-hosted output items.

Hermes uses ``store=false`` for Codex OAuth.  The provider therefore retains
no response state for the next HTTP/manual-history request: every item from
``response.output`` must survive normalization and be replayed by value, even
when the provider (rather than Hermes) executed the tool.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

from agent.codex_responses_adapter import (
    _chat_messages_to_responses_input,
    _normalize_codex_response,
    _preflight_codex_input_items,
)
from agent.transports.codex import ResponsesApiTransport


class _MessageBuilderAgent:
    stream_delta_callback = None
    _stream_callback = None
    reasoning_callback = None
    verbose_logging = False

    @staticmethod
    def _extract_reasoning(message):
        return getattr(message, "reasoning", None)

    @staticmethod
    def _strip_think_blocks(text):
        return text

    @staticmethod
    def _needs_thinking_reasoning_pad():
        return False


def _hosted_output_items():
    return [
        {
            "id": "rs_reasoning_1",
            "type": "reasoning",
            "encrypted_content": "opaque-reasoning",
            "summary": [{"type": "summary_text", "text": "checking sources"}],
            "content": [{"type": "reasoning_text", "text": "private summary"}],
        },
        {
            "id": "ws_search_1",
            "type": "web_search_call",
            "status": "completed",
            "action": {
                "type": "search",
                "query": "codex oauth",
                "sources": [
                    {
                        "type": "url",
                        "url": "https://developers.openai.com/api/docs/guides/tools-web-search",
                        "title": "Web search",
                    },
                ],
            },
        },
        {
            "id": "fs_search_1",
            "type": "file_search_call",
            "status": "completed",
            "queries": ["OAuth adapter"],
            "results": [{"file_id": "file_1", "filename": "notes.md", "score": 0.98}],
        },
        {
            "id": "ci_code_1",
            "type": "code_interpreter_call",
            "status": "completed",
            "container_id": "cntr_1",
            "code": "print('ok')",
            "outputs": [{"type": "logs", "logs": "ok\n"}],
        },
        {
            "id": "ig_image_1",
            "type": "image_generation_call",
            "status": "in_progress",
            "revised_prompt": "a protocol diagram",
            "result": "aW1hZ2UtYnl0ZXM=",
        },
        {
            "id": "sh_shell_1",
            "type": "shell_call",
            "call_id": "call_shell_1",
            "status": "completed",
            "action": {"commands": ["pwd"], "timeout_ms": 1000},
        },
        {
            "id": "mcp_call_1",
            "type": "mcp_call",
            "status": "completed",
            "server_label": "docs",
            "name": "search",
            "arguments": "{\"q\":\"oauth\"}",
            "output": [{"type": "text", "text": "result"}],
            "approval_request_id": "approval_1",
        },
        {
            "id": "msg_final_1",
            "type": "message",
            "role": "assistant",
            "status": "completed",
            "phase": "final_answer",
            "content": [
                {
                    "type": "output_text",
                    "text": "OAuth works.",
                    "annotations": [
                        {
                            "type": "url_citation",
                            "url": "https://developers.openai.com/api/docs/guides/tools-web-search",
                            "title": "Web search",
                            "start_index": 0,
                            "end_index": 5,
                        },
                    ],
                },
            ],
        },
    ]


def test_normalization_captures_lossless_json_hosted_output_snapshot():
    raw_output = _hosted_output_items()
    response = {"id": "resp_1", "status": "completed", "output": raw_output}

    message, finish_reason = _normalize_codex_response(
        response,
        issuer_kind="codex_backend",
    )

    assert finish_reason == "stop"
    assert message.content == "OAuth works."
    assert [item["type"] for item in message.codex_output_items] == [
        item["type"] for item in raw_output
    ]
    # Full snapshot keeps provider ids/status and nested hosted payloads.  Only
    # encrypted provider-bound items gain a private provenance stamp.
    assert message.codex_output_items[1] == raw_output[1]
    assert message.codex_output_items[4]["status"] == "in_progress"
    assert message.codex_output_items[0]["id"] == "rs_reasoning_1"
    assert message.codex_output_items[0]["_issuer_kind"] == "codex_backend"
    assert message.codex_output_items[-1]["content"][0]["annotations"][0]["url"].startswith(
        "https://developers.openai.com/"
    )
    # This is a persistence contract, not merely an in-memory SDK object.
    json.dumps(message.codex_output_items, allow_nan=False)


def test_transport_exposes_complete_snapshot_in_provider_data():
    transport = ResponsesApiTransport()
    normalized = transport.normalize_response(
        {"id": "resp_1", "status": "completed", "output": _hosted_output_items()},
        issuer_kind="codex_backend",
    )

    assert normalized.provider_data is not None
    assert normalized.codex_output_items == normalized.provider_data["codex_output_items"]
    assert [item["type"] for item in normalized.codex_output_items] == [
        item["type"] for item in _hosted_output_items()
    ]
    json.dumps(normalized.provider_data, allow_nan=False)


def test_manual_replay_restores_all_hosted_items_in_original_order():
    raw_output = _hosted_output_items()
    # Simulate the provenance stamp added during normalization.
    raw_output[0]["_issuer_kind"] = "codex_backend"
    messages = [
        {"role": "user", "content": "research oauth"},
        {
            "role": "assistant",
            "content": "OAuth works.",
            "codex_output_items": raw_output,
            # Legacy sidecars/tool_calls must not duplicate the authoritative
            # full snapshot when both coexist during migration.
            "codex_reasoning_items": [
                {"type": "reasoning", "encrypted_content": "duplicate"},
            ],
            "codex_message_items": [
                {
                    "type": "message",
                    "role": "assistant",
                    "status": "completed",
                    "content": [{"type": "output_text", "text": "duplicate"}],
                },
            ],
            "tool_calls": [
                {
                    "id": "call_duplicate",
                    "type": "function",
                    "function": {"name": "duplicate", "arguments": "{}"},
                },
            ],
        },
        {"role": "user", "content": "and now?"},
    ]

    replay = _chat_messages_to_responses_input(
        messages,
        current_issuer_kind="codex_backend",
    )
    replay_types = [item.get("type") for item in replay]

    assert replay_types == [
        None,
        "reasoning",
        "web_search_call",
        "file_search_call",
        "code_interpreter_call",
        "image_generation_call",
        "shell_call",
        "mcp_call",
        "message",
        None,
    ]
    assert not any(item.get("name") == "duplicate" for item in replay)

    web_item = next(item for item in replay if item.get("type") == "web_search_call")
    assert web_item["id"] == "ws_search_1"
    assert web_item["action"]["sources"][0]["title"] == "Web search"

    image_item = next(item for item in replay if item.get("type") == "image_generation_call")
    assert image_item["id"] == "ig_image_1"
    assert image_item["status"] == "completed"
    assert image_item["result"] == "aW1hZ2UtYnl0ZXM="

    message_item = next(item for item in replay if item.get("type") == "message")
    assert message_item["id"] == "msg_final_1"
    assert message_item["status"] == "completed"
    assert message_item["phase"] == "final_answer"
    assert message_item["content"][0]["annotations"][0]["title"] == "Web search"

    # The second request runs the normal preflight too; hosted items must not
    # be rejected there and nested source/citation data must survive it.
    wire = _preflight_codex_input_items(replay)
    assert [item.get("type") for item in wire] == replay_types
    wire_web = next(item for item in wire if item.get("type") == "web_search_call")
    wire_message = next(item for item in wire if item.get("type") == "message")
    assert wire_web["action"]["sources"] == web_item["action"]["sources"]
    assert wire_message["content"][0]["annotations"] == message_item["content"][0]["annotations"]


def test_sdk_objects_and_non_json_scalars_become_serializable():
    action = SimpleNamespace(type="search", query="oauth", raw=b"source")
    action.self_reference = action
    response = SimpleNamespace(
        status="completed",
        output=[
            SimpleNamespace(
                id="ws_1",
                type="web_search_call",
                status="completed",
                action=action,
            ),
            SimpleNamespace(
                id="msg_1",
                type="message",
                role="assistant",
                status="completed",
                phase="final_answer",
                content=[SimpleNamespace(type="output_text", text="done")],
            ),
        ],
    )

    message, _ = _normalize_codex_response(response)
    encoded = json.dumps(message.codex_output_items, allow_nan=False)

    assert '"raw": "c291cmNl"' in encoded
    assert message.codex_output_items[0]["action"]["self_reference"] is None


def test_foreign_encrypted_item_is_dropped_but_hosted_history_survives():
    raw_output = _hosted_output_items()
    raw_output[0]["_issuer_kind"] = "xai_responses"
    replay = _chat_messages_to_responses_input(
        [{"role": "assistant", "content": "OAuth works.", "codex_output_items": raw_output}],
        current_issuer_kind="codex_backend",
    )

    assert not any(item.get("type") == "reasoning" for item in replay)
    assert any(item.get("type") == "web_search_call" for item in replay)
    assert any(item.get("type") == "message" for item in replay)


def test_invalid_encrypted_recovery_strips_only_encrypted_full_output():
    from run_agent import AIAgent

    agent = SimpleNamespace(_codex_reasoning_replay_enabled=True)
    messages = [
        {
            "role": "assistant",
            "content": "done",
            "codex_output_items": [
                {"type": "reasoning", "encrypted_content": "bad"},
                {"type": "compaction", "encrypted_content": "bad-checkpoint"},
                {"type": "web_search_call", "id": "ws_keep"},
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "done"}],
                },
            ],
            "codex_reasoning_items": [
                {"type": "reasoning", "encrypted_content": "bad"}
            ],
        }
    ]

    stats = AIAgent._disable_codex_reasoning_replay(agent, messages)

    assert stats == {"messages": 1, "items": 3}
    assert agent._codex_reasoning_replay_enabled is False
    assert "codex_reasoning_items" not in messages[0]
    assert [item["type"] for item in messages[0]["codex_output_items"]] == [
        "web_search_call",
        "message",
    ]


def test_invalid_encrypted_recovery_is_durable_across_restart(tmp_path):
    """Rejected blobs must not return from `_db_persisted` resume rows."""
    from hermes_state import SessionDB
    from run_agent import AIAgent

    db_path = tmp_path / "state.db"
    seeded = SessionDB(db_path)
    try:
        seeded.create_session("oauth", source="cli")
        seeded.append_message(
            "oauth",
            role="assistant",
            content="done",
            codex_reasoning_items=[
                {"type": "reasoning", "encrypted_content": "bad-legacy"}
            ],
            codex_output_items=[
                {"type": "reasoning", "encrypted_content": "bad"},
                {"type": "compaction", "encrypted_content": "bad-checkpoint"},
                {"type": "web_search_call", "id": "ws_keep"},
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "done"}],
                },
            ],
        )
    finally:
        seeded.close()

    resumed = SessionDB(db_path)
    try:
        messages = resumed.get_messages_as_conversation("oauth")
        assert messages[0]["_db_persisted"] is True
        agent = SimpleNamespace(
            _codex_reasoning_replay_enabled=True,
            _session_db=resumed,
            session_id="oauth",
            _active_compression_lock_holder=None,
            _active_session_turn_lease_holder=None,
            _active_session_turn_lease_ttl_seconds=300.0,
        )

        stats = AIAgent._disable_codex_reasoning_replay(agent, messages)

        assert stats == {"messages": 1, "items": 3}
        assert "codex_reasoning_items" not in messages[0]
    finally:
        resumed.close()

    restarted = SessionDB(db_path)
    try:
        persisted = restarted.get_messages_as_conversation("oauth")[0]
    finally:
        restarted.close()

    assert "codex_reasoning_items" not in persisted
    assert [item["type"] for item in persisted["codex_output_items"]] == [
        "web_search_call",
        "message",
    ]


def test_invalid_encrypted_recovery_does_not_persist_from_isolated_child():
    """No-persist review agents must not rewrite their shared parent session."""
    from run_agent import AIAgent

    durable_calls = []
    session_db = SimpleNamespace(
        strip_codex_encrypted_replay=lambda *args, **kwargs: durable_calls.append(
            (args, kwargs)
        )
    )
    agent = SimpleNamespace(
        _codex_reasoning_replay_enabled=True,
        _persist_disabled=True,
        _session_db=session_db,
        session_id="shared-parent",
    )
    messages = [
        {
            "role": "assistant",
            "content": "done",
            "codex_reasoning_items": [
                {"type": "reasoning", "encrypted_content": "bad"}
            ],
        }
    ]

    stats = AIAgent._disable_codex_reasoning_replay(agent, messages)

    assert stats == {"messages": 1, "items": 1}
    assert durable_calls == []
    assert "codex_reasoning_items" not in messages[0]


def test_direct_oauth_output_history_survives_process_resume_e2e(tmp_path):
    """Normalize -> message bridge -> SQLite -> reopen -> next request.

    This guards against a same-process-only implementation: the second
    request is built exclusively from the hydrated state.db conversation.
    """
    from agent.chat_completion_helpers import build_assistant_message
    from hermes_state import SessionDB

    transport = ResponsesApiTransport()
    normalized = transport.normalize_response(
        {"id": "resp_1", "status": "completed", "output": _hosted_output_items()},
        issuer_kind="codex_backend",
    )
    stored_message = build_assistant_message(
        _MessageBuilderAgent(),
        normalized,
        normalized.finish_reason,
    )
    assert stored_message["codex_output_items"] == normalized.codex_output_items

    db_path = tmp_path / "state.db"
    db = SessionDB(db_path)
    try:
        db.create_session("oauth", source="cli")
        db.append_message("oauth", role="user", content="research oauth")
        db.append_message(
            "oauth",
            role="assistant",
            content=stored_message["content"],
            finish_reason=stored_message["finish_reason"],
            codex_output_items=stored_message["codex_output_items"],
        )
        db.append_message("oauth", role="user", content="continue")
    finally:
        db.close()

    resumed = SessionDB(db_path)
    try:
        history = resumed.get_messages_as_conversation("oauth")
    finally:
        resumed.close()

    hydrated = next(
        message for message in history if message.get("role") == "assistant"
    )
    assert hydrated["codex_output_items"] == stored_message["codex_output_items"]

    replay = _chat_messages_to_responses_input(
        history,
        current_issuer_kind="codex_backend",
    )
    replay_types = [item.get("type") for item in replay]
    assert replay_types[1:-1] == [
        item["type"] for item in _hosted_output_items()
    ]
    web_item = next(item for item in replay if item.get("type") == "web_search_call")
    final_item = next(item for item in replay if item.get("type") == "message")
    assert web_item["id"] == "ws_search_1"
    assert web_item["action"]["sources"][0]["title"] == "Web search"
    assert final_item["id"] == "msg_final_1"
    assert final_item["phase"] == "final_answer"
    assert final_item["content"][0]["annotations"][0]["title"] == "Web search"
