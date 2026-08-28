from __future__ import annotations

import json
import threading
import time
from types import SimpleNamespace

import httpx
import pytest
from openai import OpenAI

from agent import codex_websocket as wire


class _FakeSocket:
    def __init__(self, responses, *, handshake_headers=None):
        self.responses = list(responses)
        self.sent = []
        self.closed = False
        self.recv_timeouts = []
        self.response = SimpleNamespace(headers=handshake_headers or {})

    def send(self, payload):
        self.sent.append(json.loads(payload))

    def recv(self, timeout=None):
        self.recv_timeouts.append(timeout)
        if not self.responses:
            raise AssertionError("fake websocket exhausted")
        item = self.responses.pop(0)
        if isinstance(item, BaseException):
            raise item
        return json.dumps(item)

    def close(self, *args, **kwargs):
        self.closed = True


def _agent():
    return SimpleNamespace(
        base_url="https://chatgpt.com/backend-api/codex",
        api_key="oauth-test-token",
        model="gpt-5.6-luna",
        session_id="session-123",
        _current_turn_id="turn-1",
        _client_kwargs={
            "api_key": "oauth-test-token",
            "default_headers": {
                "originator": "hermes-agent",
                "User-Agent": "HermesAgent/test",
            },
        },
    )


@pytest.fixture(autouse=True)
def _enable_fake_websocket_client(monkeypatch):
    # Production auto-enables for the real ``openai.OpenAI`` type. Tests use a
    # tiny stand-in and opt in explicitly so unrelated mocks never dial out.
    monkeypatch.setenv("HERMES_CODEX_WEBSOCKET", "1")


def _client():
    return SimpleNamespace(
        api_key="oauth-test-token",
        base_url="https://chatgpt.com/backend-api/codex/",
    )


def _kwargs(*, tools=None):
    result = {
        "model": "gpt-5.6-luna",
        "instructions": "Be useful.",
        "input": [{"role": "user", "content": "hello"}],
        "store": False,
        "stream": True,
        "reasoning": {"effort": "max", "summary": "auto"},
        "include": ["reasoning.encrypted_content"],
        "prompt_cache_key": "pck_static",
        "extra_headers": {
            "session_id": "session-123",
            "x-client-request-id": "wrong-cache-identity",
        },
    }
    if tools is not None:
        result["tools"] = tools
        result["parallel_tool_calls"] = True
        result["tool_choice"] = "auto"
    return result


def test_prepare_classic_request_uses_native_identity_headers(monkeypatch):
    monkeypatch.setenv("HERMES_CODEX_RESPONSES_LITE", "0")

    prepared = wire.prepare_codex_direct_request(_agent(), _kwargs(), _client())

    assert prepared is not None
    assert prepared.use_lite is False
    assert prepared.websocket_headers["OpenAI-Beta"] == (
        "responses_websockets=2026-02-06"
    )
    assert prepared.websocket_headers["session-id"] == "session-123"
    assert prepared.websocket_headers["thread-id"] == "session-123"
    assert prepared.websocket_headers["x-client-request-id"] == "session-123"
    assert prepared.websocket_headers["x-codex-routing-hint"] == ("model=gpt-5.6-luna")
    assert "OpenAI-Beta" not in prepared.http_kwargs["extra_headers"]
    assert prepared.websocket_body["client_metadata"]["session_id"] == ("session-123")
    assert prepared.http_kwargs["extra_body"]["input"][0]["content"] == "hello"
    assert prepared.idle_timeout_seconds == 300


def test_cold_catalog_fetch_enables_lite_before_first_headless_turn(monkeypatch):
    from agent import model_metadata

    monkeypatch.delenv("HERMES_CODEX_RESPONSES_LITE", raising=False)
    calls = []

    def fake_metadata(model, *, access_token, allow_fetch, **_kwargs):
        calls.append((model, bool(access_token), allow_fetch))
        if not allow_fetch:
            return None
        return {"slug": model, "use_responses_lite": True}

    monkeypatch.setattr(
        model_metadata,
        "get_codex_oauth_model_metadata",
        fake_metadata,
    )

    prepared = wire.prepare_codex_direct_request(_agent(), _kwargs(), _client())

    assert prepared is not None and prepared.use_lite is True
    assert calls == [
        ("gpt-5.6-luna", True, False),
        ("gpt-5.6-luna", True, True),
    ]


def test_hosted_tool_skips_cold_catalog_lite_lookup(monkeypatch):
    from agent import model_metadata

    monkeypatch.delenv("HERMES_CODEX_RESPONSES_LITE", raising=False)

    def unexpected_lookup(*_args, **_kwargs):
        raise AssertionError("hosted tools must short-circuit before /models")

    monkeypatch.setattr(
        model_metadata,
        "get_codex_oauth_model_metadata",
        unexpected_lookup,
    )
    tools = [{"type": "web_search", "search_context_size": "medium"}]

    prepared = wire.prepare_codex_direct_request(
        _agent(), _kwargs(tools=tools), _client()
    )

    assert prepared is not None and prepared.use_lite is False
    assert prepared.websocket_body["tools"] == tools


def test_websocket_read_timeout_follows_explicit_http_read_timeout(monkeypatch):
    monkeypatch.setenv("HERMES_CODEX_RESPONSES_LITE", "0")
    socket = _FakeSocket(_events("resp_1", _message()))
    monkeypatch.setattr(wire, "_connect", lambda prepared: socket)
    api_kwargs = _kwargs()
    api_kwargs["timeout"] = SimpleNamespace(read=91.0)
    agent = _agent()

    prepared = wire.prepare_codex_direct_request(agent, api_kwargs, _client())

    assert prepared is not None
    assert prepared.idle_timeout_seconds == 91.0
    list(wire.open_codex_websocket_stream(agent, prepared))
    assert socket.recv_timeouts == [91.0, 91.0, 91.0]


def test_native_http_fallback_sends_same_body_when_websocket_disabled(monkeypatch):
    monkeypatch.setenv("HERMES_CODEX_WEBSOCKET", "0")
    monkeypatch.setenv("HERMES_CODEX_RESPONSES_LITE", "0")
    observed = {}

    def handler(request: httpx.Request) -> httpx.Response:
        observed["headers"] = dict(request.headers)
        observed["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=(
                b'data: {"type":"response.completed","response":'
                b'{"id":"resp_http","status":"completed","output":[],"usage":null}}\n\n'
                b"data: [DONE]\n\n"
            ),
        )

    http_client = httpx.Client(transport=httpx.MockTransport(handler))
    client = OpenAI(
        api_key="oauth-test-token",
        base_url="https://chatgpt.com/backend-api/codex/",
        http_client=http_client,
    )
    try:
        prepared = wire.prepare_codex_direct_request(_agent(), _kwargs(), client)
        assert prepared is not None
        assert prepared.websocket_allowed is False
        stream = client.responses.create(**prepared.http_kwargs)
        list(stream)
    finally:
        client.close()

    expected = prepared.websocket_body
    assert observed["body"] == expected
    assert observed["headers"]["session-id"] == "session-123"
    assert observed["headers"]["thread-id"] == "session-123"
    assert observed["headers"]["x-client-request-id"] == "session-123"
    assert "openai-beta" not in observed["headers"]


def test_prepare_lite_moves_instructions_and_tools_into_input(monkeypatch):
    monkeypatch.setenv("HERMES_CODEX_RESPONSES_LITE", "1")
    tools = [
        {
            "type": "function",
            "name": "read_file",
            "description": "Read a file",
            "parameters": {"type": "object", "properties": {}},
            "strict": False,
        }
    ]

    prepared = wire.prepare_codex_direct_request(
        _agent(), _kwargs(tools=tools), _client()
    )

    assert prepared is not None and prepared.use_lite is True
    body = prepared.websocket_body
    assert "instructions" not in body
    assert "tools" not in body
    assert body["parallel_tool_calls"] is False
    assert body["input"][0]["type"] == "additional_tools"
    namespace = body["input"][0]["tools"][0]
    assert namespace["type"] == "namespace"
    assert namespace["name"] == "functions"
    assert namespace["tools"][0]["name"] == "read_file"
    assert body["input"][1]["role"] == "developer"
    assert body["input"][2] == {"role": "user", "content": "hello"}
    assert body["reasoning"]["context"] == "all_turns"
    assert (
        prepared.websocket_headers["x-openai-internal-codex-responses-lite"] == "true"
    )
    assert (
        body["client_metadata"][
            "ws_request_header_x_openai_internal_codex_responses_lite"
        ]
        == "true"
    )


def test_lite_tool_grouping_matches_native_namespace_order():
    tools = wire._lite_tools([
        {"type": "tool_search", "execution": "client"},
        {"type": "function", "name": "lookup", "parameters": {}},
        {
            "type": "namespace",
            "name": "editor",
            "description": "Editing",
            "tools": [],
        },
        {
            "type": "namespace",
            "name": "functions",
            "description": "Default tools",
            "tools": [{"type": "function", "name": "existing", "parameters": {}}],
        },
    ])

    assert [tool.get("name") or tool["type"] for tool in tools] == [
        "tool_search",
        "functions",
        "editor",
    ]
    assert tools[1]["description"] == "Default tools"
    assert [tool["name"] for tool in tools[1]["tools"]] == [
        "lookup",
        "existing",
    ]


def test_hosted_tool_forces_classic_even_with_lite_override(monkeypatch):
    monkeypatch.setenv("HERMES_CODEX_RESPONSES_LITE", "1")
    tools = [{"type": "web_search", "search_context_size": "medium"}]

    prepared = wire.prepare_codex_direct_request(
        _agent(), _kwargs(tools=tools), _client()
    )

    assert prepared is not None and prepared.use_lite is False
    assert prepared.websocket_body["tools"] == tools
    assert "x-openai-internal-codex-responses-lite" not in (prepared.websocket_headers)


def _message(item_id="msg_1", text="first answer"):
    return {
        "type": "message",
        "id": item_id,
        "role": "assistant",
        "status": "completed",
        "phase": "final_answer",
        "content": [
            {
                "type": "output_text",
                "text": text,
                "annotations": [{"type": "url_citation", "url": "https://x.test"}],
            }
        ],
    }


def _events(response_id, item):
    return [
        {"type": "response.created", "response": {"id": response_id}},
        {
            "type": "response.output_item.done",
            "output_index": 0,
            "item": item,
        },
        {
            "type": "response.completed",
            "response": {"id": response_id, "status": "completed", "usage": {}},
        },
    ]


def test_second_websocket_create_uses_strict_delta_and_previous_response(monkeypatch):
    monkeypatch.setenv("HERMES_CODEX_RESPONSES_LITE", "0")
    first_item = _message()
    socket = _FakeSocket(
        _events("resp_1", first_item) + _events("resp_2", _message("msg_2", "done"))
    )
    monkeypatch.setattr(wire, "_connect", lambda prepared: socket)
    agent = _agent()

    first = wire.prepare_codex_direct_request(agent, _kwargs(), _client())
    assert first is not None
    assert list(wire.open_codex_websocket_stream(agent, first))[-1]["type"] == (
        "response.completed"
    )

    second_kwargs = _kwargs()
    second_kwargs["input"] = [
        {"role": "user", "content": "hello"},
        # The replay keeps the provider output identity exactly. Only a strict
        # prefix may use the connection-local continuation id.
        {
            "type": "message",
            "id": "msg_1",
            "role": "assistant",
            "status": "completed",
            "phase": "final_answer",
            "content": [
                {
                    "type": "output_text",
                    "text": "first answer",
                    "annotations": [{"type": "url_citation", "url": "https://x.test"}],
                }
            ],
        },
        {"role": "user", "content": "follow up"},
    ]
    agent._current_turn_id = "turn-2"
    second = wire.prepare_codex_direct_request(agent, second_kwargs, _client())
    assert second is not None
    list(wire.open_codex_websocket_stream(agent, second))

    assert len(socket.sent) == 2
    assert "previous_response_id" not in socket.sent[0]
    assert socket.sent[1]["previous_response_id"] == "resp_1"
    assert socket.sent[1]["input"] == [{"role": "user", "content": "follow up"}]
    assert wire.get_codex_websocket_debug_stats(agent) == [
        {
            "connected": True,
            "busy": False,
            "full_context_requests": 1,
            "delta_requests": 1,
            "fallback_count": 0,
            "last_sent_input_items": 1,
            "last_used_previous_response_id": "resp_1",
            "has_turn_state": False,
            "handshake_failures": 0,
            "circuit_open": False,
            "circuit_cooldown_remaining_seconds": 0.0,
        }
    ]


def test_continuation_uses_replay_clamped_long_message_id(monkeypatch):
    from agent.codex_responses_adapter import (
        _sanitize_responses_output_items_for_replay,
    )

    monkeypatch.setenv("HERMES_CODEX_RESPONSES_LITE", "0")
    raw_item = _message("opaque_" + "x" * 400)
    replay_item = _sanitize_responses_output_items_for_replay([raw_item])[0]
    assert replay_item["id"] != raw_item["id"]
    socket = _FakeSocket(
        _events("resp_1", raw_item) + _events("resp_2", _message("msg_2", "done"))
    )
    monkeypatch.setattr(wire, "_connect", lambda prepared: socket)
    agent = _agent()

    first = wire.prepare_codex_direct_request(agent, _kwargs(), _client())
    assert first is not None
    list(wire.open_codex_websocket_stream(agent, first))

    second_kwargs = _kwargs()
    second_kwargs["input"] = [
        {"role": "user", "content": "hello"},
        replay_item,
        {"role": "user", "content": "follow up"},
    ]
    agent._current_turn_id = "turn-2"
    second = wire.prepare_codex_direct_request(agent, second_kwargs, _client())
    assert second is not None
    list(wire.open_codex_websocket_stream(agent, second))

    assert socket.sent[1]["previous_response_id"] == "resp_1"
    assert socket.sent[1]["input"] == [{"role": "user", "content": "follow up"}]


def test_continuation_uses_replay_normalized_image_status(monkeypatch):
    from agent.codex_responses_adapter import (
        _sanitize_responses_output_items_for_replay,
    )

    monkeypatch.setenv("HERMES_CODEX_RESPONSES_LITE", "0")
    raw_item = {
        "type": "image_generation_call",
        "id": "ig_1",
        "status": "in_progress",
        "result": "aW1hZ2U=",
    }
    replay_item = _sanitize_responses_output_items_for_replay([raw_item])[0]
    assert replay_item["status"] == "completed"
    socket = _FakeSocket(
        _events("resp_1", raw_item) + _events("resp_2", _message("msg_2", "done"))
    )
    monkeypatch.setattr(wire, "_connect", lambda prepared: socket)
    agent = _agent()

    first = wire.prepare_codex_direct_request(agent, _kwargs(), _client())
    assert first is not None
    list(wire.open_codex_websocket_stream(agent, first))

    second_kwargs = _kwargs()
    second_kwargs["input"] = [
        {"role": "user", "content": "hello"},
        replay_item,
        {"role": "user", "content": "follow up"},
    ]
    agent._current_turn_id = "turn-2"
    second = wire.prepare_codex_direct_request(agent, second_kwargs, _client())
    assert second is not None
    list(wire.open_codex_websocket_stream(agent, second))

    assert socket.sent[1]["previous_response_id"] == "resp_1"
    assert socket.sent[1]["input"] == [{"role": "user", "content": "follow up"}]


def test_abandoned_stream_closes_socket_before_next_request(monkeypatch):
    monkeypatch.setenv("HERMES_CODEX_RESPONSES_LITE", "0")
    stale_socket = _FakeSocket(_events("resp_stale", _message()))
    fresh_socket = _FakeSocket(_events("resp_fresh", _message("msg_fresh", "fresh")))
    sockets = iter((stale_socket, fresh_socket))
    monkeypatch.setattr(wire, "_connect", lambda prepared: next(sockets))
    agent = _agent()

    first = wire.prepare_codex_direct_request(agent, _kwargs(), _client())
    assert first is not None
    first_stream = wire.open_codex_websocket_stream(agent, first)
    assert first_stream is not None
    assert next(first_stream)["type"] == "response.created"
    first_stream.close()

    assert stale_socket.closed is True
    assert wire.get_codex_websocket_debug_stats(agent)[0]["connected"] is False

    agent._current_turn_id = "turn-2"
    second = wire.prepare_codex_direct_request(agent, _kwargs(), _client())
    assert second is not None
    second_events = list(wire.open_codex_websocket_stream(agent, second))

    assert second_events[0]["type"] == "response.created"
    assert second_events[0]["response"]["id"] == "resp_fresh"
    assert len(stale_socket.responses) == 2
    assert len(stale_socket.sent) == 1
    assert len(fresh_socket.sent) == 1


def test_non_prefix_sends_full_create(monkeypatch):
    monkeypatch.setenv("HERMES_CODEX_RESPONSES_LITE", "0")
    socket = _FakeSocket(
        _events("resp_1", _message()) + _events("resp_2", _message("msg_2"))
    )
    monkeypatch.setattr(wire, "_connect", lambda prepared: socket)
    agent = _agent()

    first = wire.prepare_codex_direct_request(agent, _kwargs(), _client())
    assert first is not None
    list(wire.open_codex_websocket_stream(agent, first))

    changed = _kwargs()
    changed["input"] = [{"role": "user", "content": "different branch"}]
    second = wire.prepare_codex_direct_request(agent, changed, _client())
    assert second is not None
    list(wire.open_codex_websocket_stream(agent, second))

    assert "previous_response_id" not in socket.sent[1]
    assert socket.sent[1]["input"] == changed["input"]


def test_midstream_failure_forces_exactly_one_http_fallback(monkeypatch):
    monkeypatch.setenv("HERMES_CODEX_RESPONSES_LITE", "0")
    socket = _FakeSocket([OSError("connection reset")])
    monkeypatch.setattr(wire, "_connect", lambda prepared: socket)
    agent = _agent()
    prepared = wire.prepare_codex_direct_request(agent, _kwargs(), _client())
    assert prepared is not None

    stream = wire.open_codex_websocket_stream(agent, prepared)
    assert stream is not None
    with pytest.raises(wire.CodexWebSocketTransportError):
        list(stream)

    # The outer physical-attempt retry gets HTTP; a later logical request may
    # probe a fresh socket again rather than permanently disabling WS.
    assert wire.open_codex_websocket_stream(agent, prepared) is None


def test_handshake_turn_state_is_sent_then_cleared_for_new_user_turn(monkeypatch):
    monkeypatch.setenv("HERMES_CODEX_RESPONSES_LITE", "0")
    socket = _FakeSocket(
        _events("resp_1", _message()),
        handshake_headers={"x-codex-turn-state": "sticky-first-turn"},
    )
    monkeypatch.setattr(wire, "_connect", lambda prepared: socket)
    agent = _agent()
    prepared = wire.prepare_codex_direct_request(agent, _kwargs(), _client())
    assert prepared is not None

    list(wire.open_codex_websocket_stream(agent, prepared))

    assert socket.sent[0]["client_metadata"]["x-codex-turn-state"] == (
        "sticky-first-turn"
    )
    # The next user turn starts without the previous turn's sticky token.
    state = next(iter(agent._codex_direct_ws_states.values()))
    state.turn_state = "sticky-first-turn"
    socket.responses.extend(_events("resp_2", _message("msg_2")))
    changed = _kwargs()
    changed["input"] = [{"role": "user", "content": "new turn"}]
    agent._current_turn_id = "turn-2"
    second = wire.prepare_codex_direct_request(agent, changed, _client())
    assert second is not None
    list(wire.open_codex_websocket_stream(agent, second))
    assert "x-codex-turn-state" not in socket.sent[1]["client_metadata"]


def test_expired_previous_response_reconnects_with_full_context(monkeypatch):
    monkeypatch.setenv("HERMES_CODEX_RESPONSES_LITE", "0")
    first_socket = _FakeSocket(
        _events("resp_1", _message())
        + [
            {
                "type": "error",
                "error": {"code": "previous_response_not_found"},
            }
        ]
    )
    second_socket = _FakeSocket(_events("resp_3", _message("msg_3", "recovered")))
    sockets = iter([first_socket, second_socket])
    monkeypatch.setattr(wire, "_connect", lambda prepared: next(sockets))
    agent = _agent()
    first = wire.prepare_codex_direct_request(agent, _kwargs(), _client())
    assert first is not None
    list(wire.open_codex_websocket_stream(agent, first))

    follow_up = _kwargs()
    follow_up["input"] = [
        {"role": "user", "content": "hello"},
        _message(),
        {"role": "user", "content": "follow up"},
    ]
    agent._current_turn_id = "turn-2"
    prepared = wire.prepare_codex_direct_request(agent, follow_up, _client())
    assert prepared is not None
    with pytest.raises(wire.CodexWebSocketTransportError):
        list(wire.open_codex_websocket_stream(agent, prepared))
    list(wire.open_codex_websocket_stream(agent, prepared))

    assert first_socket.sent[1]["previous_response_id"] == "resp_1"
    assert first_socket.closed is True
    assert "previous_response_id" not in second_socket.sent[0]
    assert second_socket.sent[0]["input"] == follow_up["input"]


def test_nested_tool_schema_id_change_invalidates_continuation(monkeypatch):
    monkeypatch.setenv("HERMES_CODEX_RESPONSES_LITE", "0")
    socket = _FakeSocket(
        _events("resp_1", _message()) + _events("resp_2", _message("msg_2", "done"))
    )
    monkeypatch.setattr(wire, "_connect", lambda prepared: socket)
    agent = _agent()
    first_tools = [
        {
            "type": "function",
            "name": "lookup",
            "parameters": {
                "type": "object",
                "properties": {"id": {"type": "string"}},
            },
        }
    ]
    first = wire.prepare_codex_direct_request(
        agent, _kwargs(tools=first_tools), _client()
    )
    assert first is not None
    list(wire.open_codex_websocket_stream(agent, first))

    changed_tools = json.loads(json.dumps(first_tools))
    changed_tools[0]["parameters"]["properties"]["id"]["type"] = "integer"
    follow_up = _kwargs(tools=changed_tools)
    follow_up["input"] = [
        {"role": "user", "content": "hello"},
        _message(),
        {"role": "user", "content": "follow up"},
    ]
    agent._current_turn_id = "turn-2"
    second = wire.prepare_codex_direct_request(agent, follow_up, _client())
    assert second is not None
    list(wire.open_codex_websocket_stream(agent, second))

    assert "previous_response_id" not in socket.sent[1]
    assert socket.sent[1]["input"] == follow_up["input"]


@pytest.mark.parametrize(
    "changed",
    [
        {"type": "web_search_call", "id": "ws_2", "status": "completed"},
        {"type": "web_search_call", "id": "ws_1", "status": "failed"},
    ],
)
def test_hosted_output_id_and_status_are_strict_prefix_fields(changed):
    previous = {"type": "web_search_call", "id": "ws_1", "status": "completed"}

    assert (
        wire._strict_prefix_delta(
            [{"role": "user", "content": "hello"}, changed],
            [{"role": "user", "content": "hello"}],
            [previous],
        )
        is None
    )


def test_stream_options_do_not_invalidate_continuation_options():
    base = {
        "model": "gpt-5.6-luna",
        "reasoning": {"effort": "max"},
        "stream_options": {"include_usage": True},
    }
    changed = dict(base)
    changed["stream_options"] = {"include_usage": False}

    assert wire._request_options_hash(base) == wire._request_options_hash(changed)


def test_http_fallback_copies_current_turn_state_without_mutating_prepared(
    monkeypatch,
):
    monkeypatch.setenv("HERMES_CODEX_RESPONSES_LITE", "0")
    socket = _FakeSocket([
        {
            "type": "response.created",
            "response": {"id": "resp_1"},
            "headers": {"x-codex-turn-state": "sticky-turn-token"},
        },
        OSError("connection reset"),
    ])
    monkeypatch.setattr(wire, "_connect", lambda prepared: socket)
    agent = _agent()
    prepared = wire.prepare_codex_direct_request(agent, _kwargs(), _client())
    assert prepared is not None

    with pytest.raises(wire.CodexWebSocketTransportError):
        list(wire.open_codex_websocket_stream(agent, prepared))
    fallback = wire.codex_http_fallback_kwargs(agent, prepared)

    assert fallback is not prepared.http_kwargs
    assert fallback["extra_headers"] is not prepared.http_kwargs["extra_headers"]
    assert fallback["extra_headers"]["x-codex-turn-state"] == ("sticky-turn-token")
    assert "x-codex-turn-state" not in prepared.http_kwargs["extra_headers"]


def test_handshake_failure_circuit_breaker_cools_down_and_half_opens(monkeypatch):
    monkeypatch.setenv("HERMES_CODEX_RESPONSES_LITE", "0")
    attempts = []
    healthy = _FakeSocket(_events("resp_1", _message()))

    def connect(prepared):
        attempts.append(prepared)
        if len(attempts) <= 2:
            raise OSError("handshake failed")
        return healthy

    monkeypatch.setattr(wire, "_connect", connect)
    agent = _agent()
    prepared = wire.prepare_codex_direct_request(agent, _kwargs(), _client())
    assert prepared is not None

    assert wire.open_codex_websocket_stream(agent, prepared) is None
    assert wire.open_codex_websocket_stream(agent, prepared) is None
    assert wire.open_codex_websocket_stream(agent, prepared) is None
    assert len(attempts) == 2
    state = next(iter(agent._codex_direct_ws_states.values()))
    assert state.handshake_failures == 2
    assert state.disabled_until > time.monotonic()
    stats = wire.get_codex_websocket_debug_stats(agent)[0]
    assert stats["circuit_open"] is True
    assert stats["handshake_failures"] == 2
    assert stats["circuit_cooldown_remaining_seconds"] > 0

    state.disabled_until = time.monotonic() - 1
    stream = wire.open_codex_websocket_stream(agent, prepared)
    assert stream is not None
    list(stream)
    assert len(attempts) == 3
    assert state.handshake_failures == 0
    assert state.disabled_until == 0.0
    assert wire.get_codex_websocket_debug_stats(agent)[0]["circuit_open"] is False


class _BlockingSocket(_FakeSocket):
    def __init__(self):
        super().__init__([])
        self.recv_entered = threading.Event()
        self.recv_released = threading.Event()

    def recv(self, timeout=None):
        self.recv_timeouts.append(timeout)
        self.recv_entered.set()
        if not self.recv_released.wait(timeout=2):
            raise AssertionError("cross-thread close did not unblock recv")
        raise OSError("socket closed")

    def close(self, *args, **kwargs):
        super().close(*args, **kwargs)
        self.recv_released.set()


def test_cross_thread_abort_unblocks_recv_and_is_non_retryable(monkeypatch):
    monkeypatch.setenv("HERMES_CODEX_RESPONSES_LITE", "0")
    socket = _BlockingSocket()
    connect_calls = []

    def connect(prepared):
        connect_calls.append(prepared)
        return socket

    monkeypatch.setattr(wire, "_connect", connect)
    agent = _agent()
    prepared = wire.prepare_codex_direct_request(agent, _kwargs(), _client())
    assert prepared is not None
    stream = wire.open_codex_websocket_stream(agent, prepared)
    assert stream is not None
    errors = []

    def consume():
        try:
            list(stream)
        except BaseException as exc:
            errors.append(exc)

    consumer = threading.Thread(target=consume, daemon=True)
    consumer.start()
    assert socket.recv_entered.wait(timeout=1)
    started = time.monotonic()
    assert wire.abort_active_codex_websocket(agent, reason="watchdog") is True
    assert time.monotonic() - started < 0.5
    consumer.join(timeout=1)

    assert not consumer.is_alive()
    assert len(connect_calls) == 1
    assert len(errors) == 1
    assert isinstance(errors[0], wire.CodexWebSocketAbortError)
    assert errors[0].retryable is False
    assert socket.closed is True


def test_abort_before_first_send_is_non_retryable(monkeypatch):
    monkeypatch.setenv("HERMES_CODEX_RESPONSES_LITE", "0")
    socket = _FakeSocket([])
    monkeypatch.setattr(wire, "_connect", lambda prepared: socket)
    agent = _agent()
    prepared = wire.prepare_codex_direct_request(agent, _kwargs(), _client())
    assert prepared is not None
    stream = wire.open_codex_websocket_stream(agent, prepared)
    assert stream is not None

    assert wire.abort_active_codex_websocket(agent, reason="watchdog") is True
    with pytest.raises(wire.CodexWebSocketAbortError) as raised:
        list(stream)

    assert raised.value.retryable is False
    assert socket.sent == []
    assert socket.closed is True


def test_close_during_handshake_retires_state_and_closes_late_socket(monkeypatch):
    monkeypatch.setenv("HERMES_CODEX_RESPONSES_LITE", "0")
    connect_entered = threading.Event()
    connect_released = threading.Event()
    late_socket = _FakeSocket([])

    def connect(prepared):
        connect_entered.set()
        assert connect_released.wait(timeout=2)
        return late_socket

    monkeypatch.setattr(wire, "_connect", connect)
    agent = _agent()
    prepared = wire.prepare_codex_direct_request(agent, _kwargs(), _client())
    assert prepared is not None
    errors = []

    def open_stream():
        try:
            wire.open_codex_websocket_stream(agent, prepared)
        except BaseException as exc:
            errors.append(exc)

    opener = threading.Thread(target=open_stream, daemon=True)
    opener.start()
    assert connect_entered.wait(timeout=1)

    wire.close_codex_websockets(agent, reason="agent-close")
    assert agent._codex_direct_ws_states == {}
    connect_released.set()
    opener.join(timeout=1)

    assert not opener.is_alive()
    assert late_socket.closed is True
    assert len(errors) == 1
    assert isinstance(errors[0], wire.CodexWebSocketAbortError)
    assert agent._codex_direct_ws_states == {}


def test_provider_error_poisons_socket_and_next_request_reconnects(monkeypatch):
    monkeypatch.setenv("HERMES_CODEX_RESPONSES_LITE", "0")
    poisoned = _FakeSocket([{"type": "error", "error": {"code": "server_error"}}])
    healthy = _FakeSocket(_events("resp_2", _message("msg_2", "recovered")))
    sockets = iter([poisoned, healthy])
    monkeypatch.setattr(wire, "_connect", lambda prepared: next(sockets))
    agent = _agent()
    prepared = wire.prepare_codex_direct_request(agent, _kwargs(), _client())
    assert prepared is not None

    assert list(wire.open_codex_websocket_stream(agent, prepared))[0]["type"] == (
        "error"
    )
    assert poisoned.closed is True
    list(wire.open_codex_websocket_stream(agent, prepared))
    assert "previous_response_id" not in healthy.sent[0]
    assert healthy.sent[0]["input"] == prepared.websocket_body["input"]


@pytest.mark.parametrize(
    "event_type",
    ["response.failed", "response.incomplete", "response.cancelled"],
)
def test_non_success_terminal_poisons_socket_and_reconnects(
    monkeypatch,
    event_type,
):
    monkeypatch.setenv("HERMES_CODEX_RESPONSES_LITE", "0")
    poisoned = _FakeSocket([{"type": event_type, "response": {"id": "resp_bad"}}])
    healthy = _FakeSocket(_events("resp_2", _message("msg_2", "recovered")))
    sockets = iter([poisoned, healthy])
    monkeypatch.setattr(wire, "_connect", lambda prepared: next(sockets))
    agent = _agent()
    prepared = wire.prepare_codex_direct_request(agent, _kwargs(), _client())
    assert prepared is not None

    assert list(wire.open_codex_websocket_stream(agent, prepared))[0]["type"] == (
        event_type
    )
    assert poisoned.closed is True
    list(wire.open_codex_websocket_stream(agent, prepared))
    assert "previous_response_id" not in healthy.sent[0]
    assert healthy.sent[0]["input"] == prepared.websocket_body["input"]


def test_close_clears_owned_socket_and_continuation_state(monkeypatch):
    monkeypatch.setenv("HERMES_CODEX_RESPONSES_LITE", "0")
    socket = _FakeSocket(_events("resp_1", _message()))
    monkeypatch.setattr(wire, "_connect", lambda prepared: socket)
    agent = _agent()
    prepared = wire.prepare_codex_direct_request(agent, _kwargs(), _client())
    assert prepared is not None
    list(wire.open_codex_websocket_stream(agent, prepared))

    wire.close_codex_websockets(agent, reason="test-close")

    assert socket.closed is True
    assert agent._codex_direct_ws_states == {}


def test_agent_cache_eviction_closes_direct_websocket():
    from run_agent import AIAgent

    agent = AIAgent(
        api_key="oauth-test-token",
        base_url="https://chatgpt.com/backend-api/codex",
        model="gpt-5.6-luna",
        quiet_mode=True,
        skip_context_files=True,
        skip_memory=True,
    )
    socket = _FakeSocket([])
    state = wire._ConnectionState(key="test", socket=socket)
    agent._codex_direct_ws_states = {"test": state}

    agent.release_clients()

    assert socket.closed is True
    assert agent._codex_direct_ws_states == {}
