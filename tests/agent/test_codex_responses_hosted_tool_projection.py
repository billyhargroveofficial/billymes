"""Live-card projection for provider-executed Responses hosted tools."""

from types import SimpleNamespace

import pytest

from agent.codex_responses_adapter import _normalize_codex_response
from agent.codex_runtime import _consume_codex_event_stream


def _agent_and_calls():
    calls = {"progress": [], "starts": [], "completes": []}
    agent = SimpleNamespace(
        session_id="session-test",
        _current_turn_id="turn-test",
        _current_api_request_id="request-test",
        tool_progress_callback=lambda *args, **kwargs: calls["progress"].append((args, kwargs)),
        tool_start_callback=lambda call_id, name, args: calls["starts"].append((call_id, name, args)),
        tool_complete_callback=lambda call_id, name, args, result: calls["completes"].append(
            (call_id, name, args, result)
        ),
    )
    return agent, calls


def test_hosted_batch_emits_one_terminal_observer_hook_per_projected_call(monkeypatch):
    agent, _ = _agent_and_calls()
    observed = []
    monkeypatch.setattr(
        "model_tools._emit_post_tool_call_hook",
        lambda **kwargs: observed.append(kwargs),
    )
    _consume_codex_event_stream(
        [
            {
                "type": "response.output_item.done",
                "item": {
                    "id": "ws_observer",
                    "type": "web_search_call",
                    "status": "completed",
                    "action": {"type": "search", "queries": ["one", "two"]},
                },
            },
            {"type": "response.completed", "response": {"status": "completed"}},
        ],
        model="gpt-test",
        agent=agent,
    )

    assert [entry["function_name"] for entry in observed] == [
        "web_search", "web_search"
    ]
    assert [entry["function_args"] for entry in observed] == [
        {"query": "one"}, {"query": "two"}
    ]
    assert all(entry["session_id"] == "session-test" for entry in observed)
    assert all(entry["turn_id"] == "turn-test" for entry in observed)
    assert all(entry["status"] == "success" for entry in observed)


def test_hosted_web_search_batch_fans_out_without_becoming_dispatchable_tool_calls():
    agent, calls = _agent_and_calls()
    queries = ["one", "two", "three", "four"]
    response = _consume_codex_event_stream(
        [
            {"type": "response.output_item.added", "item": {"id": "ws_1", "type": "web_search_call"}},
            {
                "type": "response.web_search_call.searching",
                "item_id": "ws_1",
                "action": {"type": "search", "queries": queries},
            },
            {
                "type": "response.output_item.done",
                "item": {
                    "id": "ws_1", "type": "web_search_call", "status": "completed",
                    "action": {"type": "search", "queries": queries},
                },
            },
            {
                "type": "response.output_item.done",
                "item": {
                    "id": "msg_1", "type": "message", "status": "completed",
                    "content": [{"type": "output_text", "text": "done"}],
                },
            },
            {"type": "response.completed", "response": {"id": "resp_1", "status": "completed"}},
        ],
        model="gpt-test",
        agent=agent,
    )

    assert [entry[1] for entry in calls["starts"]] == ["web_search"] * 4
    assert [entry[2] for entry in calls["starts"]] == [{"query": query} for query in queries]
    ids = [entry[0] for entry in calls["starts"]]
    assert len(set(ids)) == 4
    assert [entry[0] for entry in calls["completes"]] == ids
    assert len(calls["progress"]) == 8
    assert [entry[0][0] for entry in calls["progress"]] == ["tool.started"] * 4 + ["tool.completed"] * 4

    normalized, finish_reason = _normalize_codex_response(response)
    assert normalized.tool_calls == []
    assert normalized.content == "done"
    assert finish_reason == "stop"


def test_hosted_batch_duration_starts_at_early_item_lifecycle(monkeypatch):
    agent, calls = _agent_and_calls()
    clock = {"now": 100.0}
    monkeypatch.setattr(
        "agent.codex_runtime.time.monotonic", lambda: clock["now"]
    )

    def events():
        # OpenAI normally identifies the hosted item before publishing its
        # action. The four queries arrive only when the item is done.
        yield {
            "type": "response.output_item.added",
            "item": {"id": "ws_timed", "type": "web_search_call"},
        }
        clock["now"] = 104.25
        yield {
            "type": "response.output_item.done",
            "item": {
                "id": "ws_timed",
                "type": "web_search_call",
                "status": "completed",
                "action": {
                    "type": "search",
                    "queries": ["one", "two", "three", "four"],
                },
            },
        }
        yield {"type": "response.completed", "response": {"status": "completed"}}

    _consume_codex_event_stream(events(), model="gpt-test", agent=agent)

    completions = [
        kwargs
        for args, kwargs in calls["progress"]
        if args[0] == "tool.completed"
    ]
    assert len(completions) == 4
    assert all(entry["duration"] == pytest.approx(4.25) for entry in completions)
    assert [entry["tool_call_id"] for entry in completions] == [
        call_id for call_id, _, _ in calls["starts"]
    ]


def test_hosted_done_only_duration_uses_request_start_fallback(monkeypatch):
    agent, calls = _agent_and_calls()
    monkeypatch.setattr("agent.codex_runtime.time.monotonic", lambda: 23.5)

    _consume_codex_event_stream(
        [
            {
                "type": "response.output_item.done",
                "item": {
                    "id": "ws_done_only",
                    "type": "web_search_call",
                    "status": "completed",
                    "action": {"type": "search", "queries": ["only"]},
                },
            },
            {"type": "response.completed", "response": {"status": "completed"}},
        ],
        model="gpt-test",
        agent=agent,
        hosted_fallback_started_at=20.0,
    )

    completed = next(
        kwargs
        for args, kwargs in calls["progress"]
        if args[0] == "tool.completed"
    )
    assert completed["duration"] == pytest.approx(3.5)


@pytest.mark.parametrize(
    ("item_type", "action", "expected"),
    [
        ("web_search_call", {"type": "open_page", "url": "https://example.test/a"}, [("web_extract", {"urls": ["https://example.test/a"]})]),
        ("web_search_call", {"type": "find_in_page", "url": "https://example.test/a", "pattern": "needle"}, [("web_extract", {"urls": ["https://example.test/a"], "find_pattern": "needle"})]),
        ("file_search_call", {"queries": [{"query": "alpha"}, {"query": "beta"}]}, [("search_files", {"pattern": "alpha"}), ("search_files", {"pattern": "beta"})]),
        ("shell_call", {"commands": [{"command": "pwd"}, {"command": "id"}]}, [("terminal", {"command": "pwd"}), ("terminal", {"command": "id"})]),
        ("code_interpreter_call", {"code": "print('ok')", "outputs": ["never show"]}, [("execute_code", {"code": "print('ok')"})]),
        ("image_generation_call", {}, [("image_generate", {})]),
        ("computer_call", {"type": "click"}, [("computer_use", {"action": "click"})]),
        ("local_shell_call", {"command": ["sh", "-lc", "echo hi"]}, [("terminal", {"command": "sh -lc echo hi"})]),
        ("mcp_call", {"server_label": "local", "name": "read", "arguments": '{"path":"a.txt","output":"never","token":"secret"}'}, [("mcp.local.read", {"path": "a.txt"})]),
    ],
)
def test_hosted_variants_project_once_and_done_without_added_is_safe(item_type, action, expected):
    agent, calls = _agent_and_calls()
    # Deliberately omit output_item.added: providers may collapse fast calls
    # into one done frame. The projector must synthesize a matched lifecycle.
    _consume_codex_event_stream(
        [
            {
                "type": "response.output_item.done",
                "item": {"id": f"item_{item_type}", "type": item_type, "status": "completed", "action": action},
            },
            {"type": "response.completed", "response": {"status": "completed"}},
        ],
        model="gpt-test",
        agent=agent,
    )
    assert [(name, args) for _, name, args in calls["starts"]] == expected
    assert [(name, args) for _, name, args, _ in calls["completes"]] == expected
    assert [call_id for call_id, _, _ in calls["starts"]] == [call_id for call_id, _, _, _ in calls["completes"]]


def test_hosted_added_and_done_frames_are_idempotent_and_terminal_failure_settles_pending():
    agent, calls = _agent_and_calls()
    _consume_codex_event_stream(
        [
            {"type": "response.output_item.added", "item": {"id": "fs_1", "type": "file_search_call", "action": {"queries": ["x"]}}},
            {"type": "response.output_item.added", "item": {"id": "fs_1", "type": "file_search_call", "action": {"queries": ["x"]}}},
            {"type": "response.incomplete", "response": {"status": "incomplete"}},
        ],
        model="gpt-test",
        agent=agent,
    )
    assert len(calls["starts"]) == len(calls["completes"]) == 1
    assert calls["progress"][-1][1]["is_error"] is True


def test_hosted_early_start_is_completed_successfully_by_completed_terminal_without_done():
    agent, calls = _agent_and_calls()
    _consume_codex_event_stream(
        [
            {
                "type": "response.web_search_call.searching",
                "item_id": "ws_terminal_only",
                "action": {"type": "search", "queries": ["early"]},
            },
            {"type": "response.completed", "response": {"status": "completed"}},
        ],
        model="gpt-test",
        agent=agent,
    )
    assert len(calls["starts"]) == len(calls["completes"]) == 1
    assert calls["starts"][0][0] == calls["completes"][0][0]
    assert calls["progress"][-1][0][0] == "tool.completed"
    assert calls["progress"][-1][1]["is_error"] is False


def test_hosted_terminal_output_only_is_projected_without_changing_reconstructed_output():
    agent, calls = _agent_and_calls()
    response = _consume_codex_event_stream(
        [
            {
                "type": "response.completed",
                "response": {
                    "status": "completed",
                    "output": [{
                        "id": "terminal_web", "type": "web_search_call", "status": "completed",
                        "action": {"type": "search", "queries": ["only terminal"]},
                    }],
                },
            },
        ],
        model="gpt-test",
        agent=agent,
    )
    assert response.output == []
    assert [(name, args) for _, name, args in calls["starts"]] == [
        ("web_search", {"query": "only terminal"})
    ]
    assert len(calls["completes"]) == 1


def test_hosted_mcp_waits_for_metadata_and_never_exposes_secret_arguments():
    agent, calls = _agent_and_calls()
    _consume_codex_event_stream(
        [
            {"type": "response.output_item.added", "item": {"id": "mcp_1", "type": "mcp_call"}},
            {
                "type": "response.mcp_call.in_progress", "item_id": "mcp_1",
                "server_label": "files", "name": "read",
                "arguments": '{"path":"safe.txt","authorization":"Bearer leak","api_key":"leak","cookie":"leak","credential":"leak","access key":"leak","private_key":"leak","headers":{"X-Auth":"Bearer leak"}}',
            },
            {
                "type": "response.output_item.done",
                "item": {
                    "id": "mcp_1", "type": "mcp_call", "status": "completed",
                    "server_label": "files", "name": "read",
                    "arguments": '{"path":"safe.txt","authorization":"Bearer leak"}',
                },
            },
            {"type": "response.completed", "response": {"status": "completed"}},
        ],
        model="gpt-test",
        agent=agent,
    )
    assert len(calls["starts"]) == len(calls["completes"]) == 1
    assert calls["starts"][0][1:] == ("mcp.files.read", {"path": "safe.txt"})
    rendered = repr(calls)
    for secret in ("Bearer leak", "api_key", "cookie", "credential", "access key", "private_key", "X-Auth"):
        assert secret not in rendered


def test_hosted_mcp_waits_for_complete_identity_before_starting_one_card():
    agent, calls = _agent_and_calls()
    _consume_codex_event_stream(
        [
            {
                "type": "response.mcp_call.in_progress",
                "item_id": "mcp_partial",
                "server_label": "files",
            },
            {
                "type": "response.output_item.done",
                "item": {
                    "id": "mcp_partial",
                    "type": "mcp_call",
                    "status": "completed",
                    "server_label": "files",
                    "name": "read",
                    "arguments": '{"path":"safe.txt"}',
                },
            },
            {"type": "response.completed", "response": {"status": "completed"}},
        ],
        model="gpt-test",
        agent=agent,
    )
    assert len(calls["starts"]) == len(calls["completes"]) == 1
    assert calls["starts"][0][1:] == ("mcp.files.read", {"path": "safe.txt"})


def test_hosted_shell_stream_command_indexes_are_distinct_and_redacted():
    agent, calls = _agent_and_calls()
    _consume_codex_event_stream(
        [
            {"type": "response.shell_call.command_added", "item_id": "shell_1", "command_index": 0, "command": "pwd"},
            {"type": "response.shell_call.command_added", "item_id": "shell_1", "command_index": 1, "command": "curl --private-key=top-secret -H 'Authorization: Bearer top-secret' https://example.test"},
            {"type": "response.shell_call.command_done", "item_id": "shell_1", "command_index": 0, "command": "pwd"},
            {"type": "response.shell_call.command_done", "item_id": "shell_1", "command_index": 1, "command": "curl --private-key=top-secret -H 'Authorization: Bearer top-secret' https://example.test"},
            {"type": "response.completed", "response": {"status": "completed"}},
        ],
        model="gpt-test",
        agent=agent,
    )
    assert len(calls["starts"]) == len(calls["completes"]) == 2
    assert len({call_id for call_id, _, _ in calls["starts"]}) == 2
    assert calls["starts"][1][2] == {"command": "[redacted command]"}
    assert "top-secret" not in repr(calls)


def test_hosted_url_redacts_userinfo_and_signed_query_parameters():
    agent, calls = _agent_and_calls()
    _consume_codex_event_stream(
        [
            {
                "type": "response.output_item.done",
                "item": {
                    "id": "signed_url", "type": "web_search_call", "status": "completed",
                    "action": {"type": "open_page", "url": "https://user:password@example.test/a?ok=yes&X-Amz-Signature=leak&token=leak"},
                },
            },
            {"type": "response.completed", "response": {"status": "completed"}},
        ],
        model="gpt-test",
        agent=agent,
    )
    # The hosted open-page action is only *presented* as Hermes web_extract;
    # provider execution remains out-of-band and the sanitized URL is kept.
    assert calls["starts"][0][1:] == (
        "web_extract", {"urls": ["https://example.test/a?ok=yes"]}
    )
    rendered = repr(calls)
    for secret in ("user", "password", "Signature", "token=leak"):
        assert secret not in rendered


def test_hosted_cancelled_terminal_settles_pending_as_error():
    agent, calls = _agent_and_calls()
    response = _consume_codex_event_stream(
        [
            {
                "type": "response.web_search_call.searching", "item_id": "cancelled_search",
                "action": {"type": "search", "queries": ["pending"]},
            },
            {"type": "response.cancelled", "response": {"status": "cancelled"}},
        ],
        model="gpt-test",
        agent=agent,
    )
    assert response.status == "cancelled"
    assert len(calls["starts"]) == len(calls["completes"]) == 1
    assert calls["progress"][-1][1]["is_error"] is True


@pytest.mark.parametrize("event_type", ["response.failed", "response.incomplete", "response.cancelled"])
def test_hosted_terminal_output_on_failure_is_completed_as_error(event_type):
    agent, calls = _agent_and_calls()
    _consume_codex_event_stream(
        [
            {
                "type": event_type,
                "response": {
                    "status": event_type.removeprefix("response."),
                    "output": [{
                        "id": "terminal_failure", "type": "web_search_call", "status": "completed",
                        "action": {"type": "search", "queries": ["should error"]},
                    }],
                },
            },
        ],
        model="gpt-test",
        agent=agent,
    )
    assert len(calls["starts"]) == len(calls["completes"]) == 1
    assert calls["progress"][-1][1]["is_error"] is True


def test_hosted_shell_batch_with_command_index_keeps_distinct_cards():
    agent, calls = _agent_and_calls()
    item = {
        "id": "shell_batch", "type": "shell_call", "status": "completed",
        "action": {"commands": ["pwd", "id"]},
    }
    _consume_codex_event_stream(
        [
            {"type": "response.shell_call.command_added", "item_id": "shell_batch", "command_index": 7, "action": item["action"]},
            {"type": "response.output_item.done", "item": item},
            {"type": "response.completed", "response": {"status": "completed"}},
        ],
        model="gpt-test",
        agent=agent,
    )
    assert len(calls["starts"]) == len(calls["completes"]) == 2
    assert len({call_id for call_id, _, _ in calls["starts"]}) == 2


def test_hosted_idless_duplicate_early_action_is_deduplicated():
    agent, calls = _agent_and_calls()
    early = {
        "type": "response.web_search_call.searching",
        "action": {"type": "search", "queries": ["same action"]},
    }
    _consume_codex_event_stream(
        [early, dict(early), {"type": "response.completed", "response": {"status": "completed"}}],
        model="gpt-test",
        agent=agent,
    )
    assert len(calls["starts"]) == len(calls["completes"]) == 1


@pytest.mark.parametrize("failure_source", ["watchdog", "iterator"])
def test_hosted_stream_control_failures_settle_started_cards(failure_source):
    agent, calls = _agent_and_calls()
    first = {
        "type": "response.web_search_call.searching",
        "item_id": "ws_control_failure",
        "action": {"type": "search", "queries": ["started"]},
    }

    if failure_source == "watchdog":
        events = [first, {"type": "response.created"}]
        seen = 0

        def on_event(_event):
            nonlocal seen
            seen += 1
            if seen == 2:
                raise TimeoutError("watchdog")
    else:
        def failing_events():
            yield first
            raise ConnectionError("stream failed")

        events = failing_events()
        on_event = None

    with pytest.raises((TimeoutError, ConnectionError)):
        _consume_codex_event_stream(
            events,
            model="gpt-test",
            agent=agent,
            on_event=on_event,
        )

    assert len(calls["starts"]) == len(calls["completes"]) == 1
    assert calls["progress"][-1][1]["is_error"] is True
