"""Presentation-only lifecycle for hermes_tools calls inside execute_code."""

from __future__ import annotations

import json
import threading

from tools.nested_tool_presentation import (
    NestedToolPresentation,
    current_nested_tool_presentation,
    nested_tool_presentation_scope,
    sanitize_nested_tool_args,
)
from tools.thread_context import propagate_context_to_thread


def test_nested_arguments_are_bounded_and_strictly_redacted():
    secret = "sk-" + "testsecret01234567890123456789"
    safe = sanitize_nested_tool_args(
        {
            "query": f"Hermes {secret}",
            "url": "https://user:pass@example.test/x?token=short-secret",
            "token": "short-secret",
            "headers": {"X-Test": secret},
            "content": "private page body",
            "nested": {"items": list(range(20))},
        }
    )

    rendered = json.dumps(safe, ensure_ascii=False)
    assert secret not in rendered
    assert "short-secret" not in rendered
    assert "user:pass" not in rendered
    assert "private page body" not in rendered
    assert safe["token"] == "«redacted»"
    assert safe["headers"] == "«redacted»"
    assert safe["content"] == "«redacted»"
    assert len(safe["nested"]["items"]) == 9


def test_lifecycle_uses_distinct_ids_and_never_exposes_raw_results():
    progress = []
    starts = []
    completes = []

    with nested_tool_presentation_scope(
        parent_tool_call_id="call_outer",
        progress_callback=lambda *args, **kwargs: progress.append((args, kwargs)),
        start_callback=lambda *args: starts.append(args),
        complete_callback=lambda *args: completes.append(args),
    ) as observer:
        first = observer.start("web_search", {"query": "Hermes"})
        second = observer.start(
            "web_extract", {"urls": ["https://example.test/docs"]}
        )
        observer.finish(
            first,
            json.dumps({"results": [{"content": "RAW-PAGE-SECRET"}]}),
        )
        # The second call is deliberately left pending: scope exit must close it.

    assert first != second
    assert first.startswith("sandbox_")
    assert second.startswith("sandbox_")
    assert [event[0][0] for event in progress] == [
        "tool.started",
        "tool.started",
        "tool.completed",
        "tool.completed",
    ]
    assert [event[1] for event in starts] == ["web_search", "web_extract"]
    assert len(completes) == 2
    assert "RAW-PAGE-SECRET" not in json.dumps(completes, ensure_ascii=False)
    assert json.loads(completes[0][3]) == {"status": "completed"}
    assert json.loads(completes[1][3]) == {"status": "unknown"}
    assert progress[2][1]["is_error"] is False
    assert progress[3][1]["is_error"] is True
    assert progress[2][1]["tool_call_id"] == first
    assert progress[3][1]["tool_call_id"] == second
    assert current_nested_tool_presentation() is None


def test_error_detection_idempotence_and_late_start_rejection():
    completes = []
    observer = NestedToolPresentation(
        parent_tool_call_id="call_outer",
        complete_callback=lambda *args: completes.append(args),
    )
    call_id = observer.start("web_search", {"query": "Hermes"})
    observer.finish(call_id, json.dumps({"error": "network failed"}))
    observer.finish(call_id, json.dumps({"ok": True}))
    observer.settle_pending()

    assert len(completes) == 1
    assert json.loads(completes[0][3]) == {"status": "failed"}
    assert observer.start("web_search", {"query": "late"}) is None


def test_callback_failures_do_not_break_nested_dispatch_lifecycle():
    def boom(*_args, **_kwargs):
        raise RuntimeError("display unavailable")

    observer = NestedToolPresentation(
        parent_tool_call_id="call_outer",
        progress_callback=boom,
        start_callback=boom,
        complete_callback=boom,
    )
    call_id = observer.start("web_search", {"query": "Hermes"})
    observer.finish(call_id, json.dumps({"ok": True}))
    observer.settle_pending()


def test_opaque_url_and_header_secrets_are_removed_from_display_args():
    safe = sanitize_nested_tool_args(
        {
            "command": (
                'curl -H "Cookie: session=LEAK_COOKIE" '
                '-H "X-Session-Key: LEAK_SESSION" '
                "https://user:pass@example.test/a?foo=LEAK_QUERY#LEAK_FRAGMENT"
            ),
        },
        tool_name="terminal",
    )

    rendered = json.dumps(safe, ensure_ascii=False)
    assert "LEAK_COOKIE" not in rendered
    assert "LEAK_SESSION" not in rendered
    assert "LEAK_QUERY" not in rendered
    assert "LEAK_FRAGMENT" not in rendered
    assert "user:pass" not in rendered
    assert "example.test/a" in rendered


def test_common_cli_credential_forms_are_removed_from_terminal_card():
    safe = sanitize_nested_tool_args(
        {
            "command": (
                "curl --cookie LEAK_COOKIE -u alice:LEAK_PASSWORD "
                '-H "X-Custom-Auth: LEAK_AUTH" https://example.test'
            ),
        },
        tool_name="terminal",
    )

    rendered = json.dumps(safe, ensure_ascii=False)
    assert "LEAK_COOKIE" not in rendered
    assert "LEAK_PASSWORD" not in rendered
    assert "LEAK_AUTH" not in rendered
    assert "curl" in rendered


def test_composite_cli_secret_flags_are_removed_from_terminal_card():
    safe = sanitize_nested_tool_args(
        {
            "command": (
                "cmd --client-secret LEAK_CLIENT --session-key LEAK_SESSION "
                "--private-key LEAK_PRIVATE --refresh-token LEAK_REFRESH"
            ),
        },
        tool_name="terminal",
    )

    rendered = json.dumps(safe, ensure_ascii=False)
    assert "LEAK_CLIENT" not in rendered
    assert "LEAK_SESSION" not in rendered
    assert "LEAK_PRIVATE" not in rendered
    assert "LEAK_REFRESH" not in rendered


def test_zero_width_secret_label_cannot_bypass_redaction():
    safe = sanitize_nested_tool_args(
        {"query": "token\u200b: ABCDEFGHIJKLMNOPQRSTUVWXYZ"},
        tool_name="web_search",
    )

    rendered = json.dumps(safe, ensure_ascii=False)
    assert "ABCDEFGHIJKLMNOPQRSTUVWXYZ" not in rendered
    assert "\u200b" not in rendered


def test_control_separated_cli_secret_flag_cannot_bypass_redaction():
    for separator in ("\t", "\n", "\u200b", "\x00"):
        safe = sanitize_nested_tool_args(
            {"command": f"cmd --session-key{separator}LEAK_SESSION"},
            tool_name="terminal",
        )
        assert "LEAK_SESSION" not in json.dumps(safe, ensure_ascii=False)


def test_tool_allowlist_hides_unknown_and_content_arguments():
    safe_write = sanitize_nested_tool_args(
        {
            "path": "note.txt",
            "content": "PRIVATE-CONTENT",
            "unexpected": "PRIVATE-EXTRA",
        },
        tool_name="write_file",
    )
    safe_unknown = sanitize_nested_tool_args(
        {"query": "PRIVATE-UNKNOWN"},
        tool_name="future_tool",
    )

    assert safe_write == {"path": "note.txt"}
    assert safe_unknown == {}


def test_scope_settlement_cannot_emit_completion_before_start():
    events = []
    start_entered = threading.Event()
    release_start = threading.Event()

    def slow_start(*_args):
        events.append("started")
        start_entered.set()
        release_start.wait(timeout=2)

    observer = NestedToolPresentation(
        parent_tool_call_id="call_outer",
        start_callback=slow_start,
        complete_callback=lambda *_args: events.append("completed"),
    )
    worker = threading.Thread(
        target=lambda: observer.start("web_search", {"query": "Hermes"}),
        daemon=True,
    )
    worker.start()
    assert start_entered.wait(timeout=2)

    settlement = threading.Thread(target=observer.settle_pending, daemon=True)
    settlement.start()
    release_start.set()
    worker.join(timeout=2)
    settlement.join(timeout=2)

    assert not worker.is_alive()
    assert not settlement.is_alive()
    assert events == ["started", "completed"]


def test_context_observer_propagates_to_rpc_style_worker_thread():
    starts = []
    seen = []

    with nested_tool_presentation_scope(
        parent_tool_call_id="call_outer",
        start_callback=lambda *args: starts.append(args),
    ) as observer:
        def worker():
            current = current_nested_tool_presentation()
            seen.append(current)
            call_id = current.start("web_search", {"query": "Hermes"})
            current.finish(call_id, json.dumps({"ok": True}))

        thread = threading.Thread(
            target=propagate_context_to_thread(worker),
            daemon=True,
        )
        thread.start()
        thread.join(timeout=2)

    assert not thread.is_alive()
    assert seen == [observer]
    assert len(starts) == 1
