"""Tests for the bundled Codex OAuth hosted-search provider."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest


PROVIDER = (
    Path(__file__).resolve().parents[3]
    / "plugins"
    / "web"
    / "codex-native"
    / "provider.py"
)
SPEC = importlib.util.spec_from_file_location("codex_native_test_provider", PROVIDER)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def test_payload_uses_hosted_search_and_no_store():
    payload = MODULE._build_payload(
        "current UEFA final",
        5,
        {
            "model": "gpt-5.6-luna",
            "reasoning": "low",
            "search_context_size": "medium",
        },
    )

    assert payload["tools"] == [
        {"type": "web_search", "search_context_size": "medium"}
    ]
    assert payload["include"] == ["web_search_call.action.sources"]
    assert payload["tool_choice"] == "required"
    assert payload["store"] is False
    assert payload["stream"] is True
    assert payload["reasoning"] == {"effort": "low"}


def test_result_parser_rejects_unsafe_urls_and_deduplicates():
    text = json.dumps(
        {
            "results": [
                {
                    "title": "Good",
                    "url": "https://example.com/a",
                    "description": "A",
                },
                {
                    "title": "Duplicate",
                    "url": "https://example.com/a",
                    "description": "B",
                },
                {
                    "title": "Credentials",
                    "url": "https://user:pass@example.com/private",
                    "description": "C",
                },
                {
                    "title": "Bad",
                    "url": "javascript:alert(1)",
                    "description": "D",
                },
            ]
        }
    )

    rows = MODULE._results_from_text(
        text,
        [
            {"url": "https://example.com/a"},
            {"url": "https://user:pass@example.com/private"},
            {"url": "javascript:alert(1)"},
        ],
        limit=5,
    )

    assert rows == [
        {
            "title": "Good",
            "url": "https://example.com/a",
            "description": "A",
            "position": 1,
        }
    ]


def test_result_parser_rejects_model_url_not_in_authoritative_sources():
    text = json.dumps(
        {
            "results": [
                {
                    "title": "Injected",
                    "url": "https://attacker.invalid/",
                    "description": "Not returned by hosted search",
                },
                {
                    "title": "Model title",
                    "url": "https://real.example/source",
                    "description": "Model description",
                },
            ]
        }
    )

    rows = MODULE._results_from_text(
        text,
        [
            {
                "title": "Authoritative title",
                "url": "https://real.example/source",
                "description": "Authoritative snippet",
            }
        ],
        limit=1,
    )

    assert rows == [
        {
            "title": "Authoritative title",
            "url": "https://real.example/source",
            "description": "Authoritative snippet",
            "position": 1,
        }
    ]


def test_annotation_fallback_is_normalized():
    rows = MODULE._results_from_text(
        "No JSON",
        [
            {
                "title": "Source",
                "url": "https://example.org/x",
                "description": "Snippet",
            }
        ],
        limit=3,
    )

    assert rows[0]["position"] == 1
    assert rows[0]["url"] == "https://example.org/x"


def test_empty_results_payload_is_valid_search_response():
    assert MODULE._decode_json_object('{"results":[]}') == {"results": []}
    assert MODULE._results_from_text('{"results":[]}', [], limit=5) == []


def test_sse_decoder_accepts_event_name_and_bounded_json():
    class Response:
        def iter_lines(self):
            return iter(
                [
                    "event: response.output_text.delta",
                    'data: {"delta":"hello"}',
                    "",
                    "data: [DONE]",
                    "",
                ]
            )

    assert list(MODULE._iter_sse_json(Response())) == [
        {"type": "response.output_text.delta", "delta": "hello"}
    ]


def _hosted_search_done(*, sources=None):
    return {
        "type": "response.output_item.done",
        "item": {
            "type": "web_search_call",
            "status": "completed",
            "action": {
                "type": "search",
                "sources": sources or [],
            },
        },
    }


def _successful_terminal():
    return {
        "type": "response.completed",
        "response": {"id": "resp_1", "status": "completed", "output": []},
    }


def test_stream_results_are_grounded_in_completed_hosted_search_sources():
    text = json.dumps(
        {
            "results": [
                {"title": "Injected", "url": "https://attacker.invalid/"},
                {"title": "Real", "url": "https://real.example/source"},
            ]
        }
    )
    events = [
        _hosted_search_done(
            sources=[
                {
                    "type": "url",
                    "url": "https://real.example/source",
                    "title": "Hosted source",
                }
            ]
        ),
        {"type": "response.output_text.delta", "delta": text},
        _successful_terminal(),
    ]

    assert MODULE._results_from_events(events, limit=1) == [
        {
            "title": "Hosted source",
            "url": "https://real.example/source",
            "description": "",
            "position": 1,
        }
    ]


@pytest.mark.parametrize(
    "terminal_type",
    ["response.failed", "response.incomplete", "error"],
)
def test_stream_terminal_failure_rejects_partial_json(terminal_type):
    events = [
        _hosted_search_done(
            sources=[{"type": "url", "url": "https://real.example/source"}]
        ),
        {
            "type": "response.output_text.delta",
            "delta": '{"results":[{"url":"https://real.example/source"}]}',
        },
        {"type": terminal_type, "error": {"message": "terminal boom"}},
    ]

    with pytest.raises(RuntimeError, match="terminal boom"):
        MODULE._results_from_events(events, limit=5)


def test_stream_requires_successful_completed_terminal():
    events = [
        _hosted_search_done(
            sources=[{"type": "url", "url": "https://real.example/source"}]
        ),
        {
            "type": "response.output_text.delta",
            "delta": '{"results":[{"url":"https://real.example/source"}]}',
        },
        {
            "type": "response.done",
            "response": {"id": "resp_1", "status": "completed", "output": []},
        },
    ]

    with pytest.raises(RuntimeError, match="without response.completed"):
        MODULE._results_from_events(events, limit=5)


def test_stream_requires_completed_hosted_search_call():
    events = [
        {
            "type": "response.output_text.done",
            "text": '{"results":[{"url":"https://real.example/source"}]}',
        },
        _successful_terminal(),
    ]

    with pytest.raises(RuntimeError, match="without executing.*hosted web_search"):
        MODULE._results_from_events(events, limit=5)


def test_completed_hosted_search_may_return_literal_empty_results():
    events = [
        _hosted_search_done(),
        {"type": "response.output_text.done", "text": '{"results":[]}'},
        _successful_terminal(),
    ]

    assert MODULE._results_from_events(events, limit=5) == []


def test_provider_validates_query_and_clamps_limit(monkeypatch):
    provider = MODULE.CodexNativeWebSearchProvider()
    captured = {}

    def fake_execute(query, limit):
        captured.update(query=query, limit=limit)
        return []

    monkeypatch.setattr(MODULE, "_execute_search", fake_execute)

    assert provider.search("  ")["success"] is False
    assert provider.search("query", limit=100) == {
        "success": True,
        "data": {"web": []},
    }
    assert captured == {"query": "query", "limit": 10}


def test_provider_availability_uses_profile_credential_probe(monkeypatch):
    provider = MODULE.CodexNativeWebSearchProvider()

    monkeypatch.setattr(MODULE, "_read_codex_access_token", lambda: None)
    assert provider.is_available() is False
    monkeypatch.setattr(MODULE, "_read_codex_access_token", lambda: "token")
    assert provider.is_available() is True


def test_oauth_credentials_are_pinned_to_official_codex_endpoint(monkeypatch):
    import hermes_cli.auth

    monkeypatch.setattr(
        hermes_cli.auth,
        "resolve_codex_runtime_credentials",
        lambda **kwargs: {
            "api_key": "oauth-secret",
            "base_url": "https://attacker.invalid/backend-api/codex",
        },
    )

    with pytest.raises(RuntimeError, match="non-official endpoint"):
        MODULE._resolve_credentials()

    monkeypatch.setattr(
        hermes_cli.auth,
        "resolve_codex_runtime_credentials",
        lambda **kwargs: {
            "api_key": "oauth-secret",
            "base_url": "https://chatgpt.com/backend-api/codex/",
        },
    )
    assert MODULE._resolve_credentials() == (
        "oauth-secret",
        "https://chatgpt.com/backend-api/codex",
    )
