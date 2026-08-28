"""Regression coverage for durable, client-safe Codex commentary display."""

from agent.interim_display import (
    interim_assistant_messages_enabled,
    project_interim_assistant_messages,
)


def _row(items):
    return {"role": "assistant", "content": "final", "codex_message_items": items}


def test_projects_only_semantic_commentary_output_text_in_provider_order():
    projected = project_interim_assistant_messages(
        _row([
            {
                "type": "message",
                "id": "commentary-1",
                "role": "assistant",
                "phase": "commentary",
                "content": [
                    {"type": "output_text", "text": "PRELUDE "},
                    {"type": "output_text", "text": "one"},
                    {"type": "refusal", "text": "not client text"},
                ],
            },
            {
                "type": "message",
                "id": "final-1",
                "role": "assistant",
                "phase": "final_answer",
                "content": [{"type": "output_text", "text": "FINAL"}],
            },
            {
                "type": "reasoning",
                "id": "reasoning-1",
                "phase": "commentary",
                "content": [{"type": "output_text", "text": "not a message"}],
            },
            {
                "type": "message",
                "role": "assistant",
                "phase": "commentary",
                "content": [{"type": "output_text", "text": "two"}],
            },
        ])
    )

    assert projected == [
        {"id": "commentary-1", "text": "PRELUDE one"},
        {"id": "commentary-3", "text": "two"},
    ]


def test_projection_is_disabled_without_exposing_or_deduping_raw_sidecars():
    row = _row([
        {
            "type": "message",
            "id": "commentary-1",
            "role": "assistant",
            "phase": "commentary",
            "content": [{"type": "output_text", "text": "same text"}],
        },
        {
            "type": "message",
            "id": "commentary-2",
            "role": "assistant",
            "phase": "commentary",
            "content": [{"type": "output_text", "text": "same text"}],
        },
    ])

    assert project_interim_assistant_messages(row, enabled=False) == []
    assert project_interim_assistant_messages(row) == [
        {"id": "commentary-1", "text": "same text"},
        {"id": "commentary-2", "text": "same text"},
    ]


def test_projection_requires_assistant_parent_and_makes_duplicate_ids_unique():
    items = [
        {
            "type": "message",
            "id": "same-id",
            "role": "assistant",
            "phase": "commentary",
            "content": [{"type": "output_text", "text": "one"}],
        },
        {
            "type": "message",
            "id": "same-id",
            "role": "assistant",
            "phase": "commentary",
            "content": [{"type": "output_text", "text": "two"}],
        },
        {
            "type": "message",
            "role": "assistant",
            "phase": "commentary",
            "content": [{"type": "output_text", "text": "three"}],
        },
        {
            "type": "message",
            "id": "commentary-2",
            "role": "assistant",
            "phase": "commentary",
            "content": [{"type": "output_text", "text": "four"}],
        },
    ]

    assert project_interim_assistant_messages(_row(items)) == [
        {"id": "same-id", "text": "one"},
        {"id": "same-id-1", "text": "two"},
        {"id": "commentary-2", "text": "three"},
        {"id": "commentary-2-3", "text": "four"},
    ]
    assert (
        project_interim_assistant_messages({
            "role": "tool",
            "codex_message_items": items,
        })
        == []
    )


def test_gate_requires_both_live_commentary_settings():
    assert interim_assistant_messages_enabled({}) is True
    assert (
        interim_assistant_messages_enabled({
            "display": {"interim_assistant_messages": False, "show_commentary": True}
        })
        is False
    )
    assert (
        interim_assistant_messages_enabled({
            "display": {"interim_assistant_messages": True, "show_commentary": False}
        })
        is False
    )


def test_projection_uses_live_think_and_secret_redaction_boundary(monkeypatch):
    monkeypatch.setattr("agent.redact._REDACT_ENABLED", True)
    opaque_test_value = "demo_value_" + "A" * 24
    projected = project_interim_assistant_messages(
        _row([
            {
                "type": "message",
                "id": "commentary-1",
                "role": "assistant",
                "phase": "commentary",
                "content": [
                    {
                        "type": "output_text",
                        "text": (
                            "<think>internal scratch</think>Visible "
                            f"OPENAI_API_KEY={opaque_test_value}"
                        ),
                    }
                ],
            },
            {
                "type": "message",
                "id": "commentary-2",
                "role": "assistant",
                "phase": "commentary",
                "content": [{"type": "output_text", "text": "(empty)"}],
            },
        ])
    )

    assert len(projected) == 1
    assert projected[0]["id"] == "commentary-1"
    assert "internal scratch" not in projected[0]["text"]
    assert opaque_test_value not in projected[0]["text"]
    assert "Visible OPENAI_API_KEY=" in projected[0]["text"]


def test_projection_fails_closed_for_pathologically_nested_encoded_sidecar():
    nested = "[" * 3000 + "]" * 3000

    assert project_interim_assistant_messages(_row(nested)) == []


def test_projection_fails_closed_for_unbounded_item_and_text_work():
    ordinary_item = {
        "type": "message",
        "role": "assistant",
        "phase": "commentary",
        "content": [{"type": "output_text", "text": "visible"}],
    }
    assert project_interim_assistant_messages(_row([ordinary_item] * 5000)) == []

    oversized_text_item = {
        **ordinary_item,
        "content": [{"type": "output_text", "text": "x" * (1024 * 1024 + 1)}],
    }
    assert project_interim_assistant_messages(_row([oversized_text_item])) == []
