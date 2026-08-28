"""Client-safe display projection for persisted Codex commentary items.

``codex_message_items`` is provider replay state, so it must never be sent to
browser clients wholesale.  This module exposes the narrow display projection
needed to restore commentary that was visible live before a page reload.
"""

from __future__ import annotations

import json
from typing import Any, Mapping

from utils import is_truthy_value


# Persisted provider sidecars are untrusted input at the browser boundary.  A
# normal Responses turn is far below these ceilings; the limits keep corrupt
# imports from turning a history read into unbounded JSON/parser work.
_MAX_ENCODED_SIDECAR_CHARS = 8 * 1024 * 1024
_MAX_JSON_NESTING = 128
_MAX_SIDECAR_ITEMS = 4096
_MAX_CONTENT_PARTS = 512
_MAX_COMMENTARY_TEXT_CHARS = 1024 * 1024


def _json_nesting_within_limit(value: str) -> bool:
    """Cheaply reject pathological JSON nesting before ``json.loads``."""
    depth = 0
    in_string = False
    escaped = False
    for char in value:
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char in "[{":
            depth += 1
            if depth > _MAX_JSON_NESTING:
                return False
        elif char in "]}":
            depth -= 1
            if depth < 0:
                return False
    return depth == 0 and not in_string


def interim_assistant_messages_enabled(config: Mapping[str, Any] | None) -> bool:
    """Whether this profile would have shown live Codex commentary.

    Both flags matter.  ``interim_assistant_messages`` controls the transport
    callback; ``show_commentary`` controls whether the Codex adapter emits
    commentary to that callback rather than its reasoning channel.  Defaults
    deliberately match the live path (enabled).
    """
    display = config.get("display") if isinstance(config, Mapping) else None
    if not isinstance(display, Mapping):
        return True
    return is_truthy_value(display.get("interim_assistant_messages", True)) and (
        is_truthy_value(display.get("show_commentary", True))
    )


def project_interim_assistant_messages(
    message: Any, *, enabled: bool = True
) -> list[dict[str, str]]:
    """Extract ordered, client-safe commentary from one persisted row.

    This is intentionally structural rather than text-based: only Responses
    ``message`` items authored by the assistant with ``phase=commentary`` and
    ``output_text`` parts qualify.  The returned ids are the provider item id
    when present, otherwise a deterministic item-position id.  No raw
    Responses sidecar or final-answer content crosses this boundary.
    """
    if not enabled or not isinstance(message, Mapping):
        return []
    # These sidecars are replay metadata on an assistant transcript row only.
    # Never turn a malformed/user/tool row into a visible assistant segment.
    if message.get("role") != "assistant":
        return []
    raw_items = message.get("codex_message_items")
    # SessionDB's paged ``get_messages`` surface intentionally leaves JSON
    # sidecars encoded, while conversation/resume reads decode them.  Accept
    # both persistence shapes at this single display boundary.
    if isinstance(raw_items, str):
        if len(
            raw_items
        ) > _MAX_ENCODED_SIDECAR_CHARS or not _json_nesting_within_limit(raw_items):
            return []
        try:
            raw_items = json.loads(raw_items)
        except (TypeError, ValueError, RecursionError, MemoryError):
            return []
    if not isinstance(raw_items, list) or len(raw_items) > _MAX_SIDECAR_ITEMS:
        return []

    projected: list[dict[str, str]] = []
    emitted_ids: set[str] = set()
    # Match the live Codex interim callback's client-visible security
    # boundary.  Persisted Responses sidecars are provider replay state, not
    # a trusted display payload.
    from agent.agent_runtime_helpers import strip_think_blocks
    from agent.redact import redact_sensitive_text

    for index, item in enumerate(raw_items):
        if not isinstance(item, Mapping):
            continue
        if item.get("type") != "message" or item.get("role") != "assistant":
            continue
        phase = item.get("phase")
        if not isinstance(phase, str) or phase.strip().lower() != "commentary":
            continue
        content = item.get("content")
        if not isinstance(content, list) or len(content) > _MAX_CONTENT_PARTS:
            continue
        text_parts: list[str] = []
        text_chars = 0
        for part in content:
            if (
                not isinstance(part, Mapping)
                or part.get("type") != "output_text"
                or not isinstance(part.get("text"), str)
            ):
                continue
            part_text = part["text"]
            text_chars += len(part_text)
            if text_chars > _MAX_COMMENTARY_TEXT_CHARS:
                text_parts = []
                break
            text_parts.append(part_text)
        if not text_parts:
            continue
        text = "".join(text_parts)
        visible = strip_think_blocks(None, text).strip()
        visible = redact_sensitive_text(visible).strip()
        if not visible or visible == "(empty)":
            continue
        item_id = item.get("id")
        base_id = (
            str(item_id)
            if isinstance(item_id, (str, int)) and str(item_id)
            else f"commentary-{index}"
        )
        stable_id = base_id
        suffix = 0
        while stable_id in emitted_ids:
            suffix += 1
            stable_id = (
                f"{base_id}-{index}" if suffix == 1 else f"{base_id}-{index}-{suffix}"
            )
        emitted_ids.add(stable_id)
        projected.append({"id": stable_id, "text": visible})
    return projected
