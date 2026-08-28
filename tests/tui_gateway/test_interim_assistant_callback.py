"""Tests for the interim_assistant_callback config gating in tui_gateway.

These tests exercise the real _agent_cbs() wiring rather than a local
imitation, so a break in the production callback registration is caught.
"""

from __future__ import annotations

from unittest.mock import patch


def test_load_interim_assistant_messages_defaults_true():
    from tui_gateway.server import _load_interim_assistant_messages

    with patch("tui_gateway.server._load_cfg", return_value={}):
        assert _load_interim_assistant_messages() is True


def test_history_restore_projects_durable_commentary_before_final():
    """Cold session.resume uses the same semantic sidecar projection as REST."""
    from tui_gateway import server

    history = [
        {
            "role": "assistant",
            "content": "FINAL",
            "codex_message_items": [
                {
                    "type": "message",
                    "id": "commentary-1",
                    "role": "assistant",
                    "phase": "commentary",
                    "content": [{"type": "output_text", "text": "PRELUDE"}],
                },
                {
                    "type": "message",
                    "id": "final-1",
                    "role": "assistant",
                    "phase": "final_answer",
                    "content": [{"type": "output_text", "text": "FINAL"}],
                },
            ],
        }
    ]

    with patch("tui_gateway.server._load_cfg", return_value={}):
        assert server._history_to_messages(history) == [
            {
                "role": "assistant",
                "text": "PRELUDE",
                "display_kind": "interim_assistant",
                "display_metadata": {"interim_id": "commentary-1"},
            },
            {"role": "assistant", "text": "FINAL"},
        ]

    with patch(
        "tui_gateway.server._load_cfg",
        return_value={"display": {"show_commentary": False}},
    ):
        assert server._history_to_messages(history) == [
            {"role": "assistant", "text": "FINAL"}
        ]


def test_history_restore_keeps_commentary_on_empty_tool_call_carrier():
    """A commentary-only hosted tool carrier must not be dropped before its tool."""
    from tui_gateway import server

    history = [
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "call-1",
                    "function": {"name": "web_search", "arguments": '{"q":"Hermes"}'},
                },
                {
                    "id": "call-2",
                    "function": {"name": "web_fetch", "arguments": '{"url":"https://example.com"}'},
                },
            ],
            "codex_message_items": [
                {
                    "type": "message",
                    "id": "commentary-1",
                    "role": "assistant",
                    "phase": "commentary",
                    "content": [{"type": "output_text", "text": "PRELUDE"}],
                }
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "call-1",
            "content": "search results",
        },
        {
            "role": "tool",
            "tool_call_id": "call-2",
            "content": "fetched page",
        },
        {"role": "assistant", "content": "FINAL"},
    ]

    with patch("tui_gateway.server._load_cfg", return_value={}):
        restored = server._history_to_messages(history)

    assert restored[0] == {
        "role": "assistant",
        "text": "PRELUDE",
        "display_kind": "interim_assistant",
        "display_metadata": {"interim_id": "commentary-1"},
    }
    assert restored[1]["role"] == "tool"
    assert restored[1]["name"] == "web_search"
    assert restored[1]["args"] == {"q": "Hermes"}
    assert restored[2]["role"] == "tool"
    assert restored[2]["name"] == "web_fetch"
    assert restored[2]["args"] == {"url": "https://example.com"}
    assert restored[3] == {"role": "assistant", "text": "FINAL"}


def test_history_restore_drops_raw_codex_carriers_without_blank_assistant_row():
    """Provider replay sidecars neither cross the client boundary nor render."""
    from tui_gateway import server

    history = [
        {
            "role": "assistant",
            "content": "",
            "reasoning_details": [
                {"type": "reasoning.encrypted", "data": "private-signature"}
            ],
            "codex_reasoning_items": [
                {"type": "reasoning", "encrypted_content": "private-blob"}
            ],
            "codex_output_items": [
                {"type": "web_search_call", "id": "private-provider-item"}
            ],
            "codex_message_items": [
                {
                    "type": "message",
                    "id": "commentary-1",
                    "role": "assistant",
                    "phase": "commentary",
                    "content": [{"type": "output_text", "text": "PRELUDE"}],
                }
            ],
        }
    ]

    with patch("tui_gateway.server._load_cfg", return_value={}):
        restored = server._history_to_messages(history)

    assert restored == [
        {
            "role": "assistant",
            "text": "PRELUDE",
            "display_kind": "interim_assistant",
            "display_metadata": {"interim_id": "commentary-1"},
        }
    ]


def test_history_restore_keeps_visible_reasoning_without_provider_sidecars():
    from tui_gateway import server

    history = [
        {
            "role": "assistant",
            "content": "FINAL",
            "reasoning": "safe summary",
            "reasoning_details": [{"data": "private-signature"}],
            "codex_output_items": [{"encrypted_content": "private-blob"}],
        }
    ]

    with patch("tui_gateway.server._load_cfg", return_value={}):
        restored = server._history_to_messages(history)

    assert restored == [
        {"role": "assistant", "text": "FINAL", "reasoning": "safe summary"}
    ]


def test_agent_cbs_includes_interim_callback_when_enabled():
    """_agent_cbs() includes interim_assistant_callback when the config is on.

    Exercises the real _agent_cbs() wiring: the callback must be present in
    the returned dict and, when invoked, must emit a message.interim event
    with the text and already_streamed flag passed through.
    """
    from tui_gateway.server import _agent_cbs

    emitted: list[tuple] = []

    def fake_emit(event_type, sid, payload=None):
        emitted.append((event_type, sid, payload))

    with patch("tui_gateway.server._load_cfg", return_value={}), \
         patch("tui_gateway.server._emit", side_effect=fake_emit):
        cbs = _agent_cbs("test-session")

        assert "interim_assistant_callback" in cbs
        cb = cbs["interim_assistant_callback"]
        assert callable(cb)

        # Invoke the real callback inside the patch context — the lambda
        # resolves _emit by name at call time, so it must be called while
        # the patch is active.
        cb("hello world", already_streamed=True)

    assert len(emitted) == 1
    assert emitted[0][0] == "message.interim"
    assert emitted[0][1] == "test-session"
    assert emitted[0][2]["text"] == "hello world"
    assert emitted[0][2]["already_streamed"] is True
