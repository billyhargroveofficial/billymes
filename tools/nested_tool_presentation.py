"""Live, presentation-only lifecycle for tools called inside ``execute_code``.

Programmatic Tool Calling keeps nested ``hermes_tools`` calls inside the
sandbox RPC loop.  That is deliberately faster than returning every call to
the model, but it also means the normal agent executor never sees those calls
and cannot render them.  This module bridges only the presentation lifecycle:
it never dispatches a tool, writes conversation history, or exposes a nested
tool result.

The observer is stored in a ContextVar.  ``execute_code`` already propagates
the parent context into its local and remote RPC worker threads, so both
transports can report the real dispatch without changing the sandbox protocol.
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
import hashlib
from itertools import islice
import json
import logging
import re
import threading
import time
from typing import Any, Callable, Iterator
import unicodedata
import uuid

from agent.display import _detect_tool_failure, build_tool_preview
from agent.redact import redact_sensitive_text

logger = logging.getLogger(__name__)

_REDACTED = "«redacted»"
_MAX_DEPTH = 3
_MAX_DICT_ITEMS = 12
_MAX_LIST_ITEMS = 8
_MAX_STRING_CHARS = 500

_OPAQUE_KEYS = frozenset(
    {
        "base64",
        "blob",
        "body",
        "bytes",
        "content",
        "data",
        "headers",
        "html",
        "image",
        "output",
        "payload",
        "response",
        "result",
    }
)
_SECRET_KEY_FRAGMENTS = (
    "access_key",
    "api_key",
    "apikey",
    "auth",
    "authorization",
    "cookie",
    "credential",
    "id_token",
    "password",
    "private_key",
    "refresh_token",
    "secret",
    "session_key",
    "token",
)
_ALLOWED_ARGUMENT_KEYS = {
    "web_search": frozenset({"query", "limit"}),
    "web_extract": frozenset({"urls", "char_limit"}),
    "read_file": frozenset({"path", "offset", "limit"}),
    "write_file": frozenset({"path", "cross_profile"}),
    "search_files": frozenset(
        {
            "pattern",
            "target",
            "path",
            "file_glob",
            "limit",
            "offset",
            "output_mode",
            "context",
        }
    ),
    "patch": frozenset(
        {"path", "replace_all", "mode", "cross_profile"}
    ),
    "terminal": frozenset({"command", "timeout", "workdir"}),
}

# Extra hardening for this UI/log egress boundary.  The shared redactor masks
# known provider token formats; nested args also need to cover opaque session
# cookies and generic authorization material that has no recognizable prefix.
_AUTH_SCHEME_RE = re.compile(
    r"\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}",
    re.IGNORECASE,
)
_HEADER_SECRET_RE = re.compile(
    r"\b(Authorization|Proxy-Authorization|Cookie|Set-Cookie|"
    r"X-[A-Za-z0-9-]*(?:Auth|Token|Key|Secret))\s*:\s*([^\"'\r\n]+)",
    re.IGNORECASE,
)
_CLI_SECRET_OPTION_RE = re.compile(
    r"(?P<prefix>(?:^|\s)(?:"
    r"--(?:[a-z0-9-]*(?:cookie|credential|password|secret|token)|"
    r"(?:api|access|client|private|session)-key|key|oauth2-bearer|"
    r"proxy-user|user)|-[bUu])(?:=|\s+))"
    r"(?P<value>\"[^\"]*\"|'[^']*'|\S+)",
    re.IGNORECASE,
)
_LABELED_SECRET_RE = re.compile(
    r"\b(session(?:[_ -]?(?:cookie|key))?|cookie|credential|"
    r"access[_ -]?key|api[_ -]?key|token|password|secret)"
    r"\s*[:=]\s*([^\s,;\"']+)",
    re.IGNORECASE,
)
_HTTP_URL_RE = re.compile(r"https?://[^\s\"'<>]+", re.IGNORECASE)


def _sensitive_key(key: Any) -> bool:
    normalized = str(key).strip().lower().replace("-", "_")
    if normalized in _OPAQUE_KEYS:
        return True
    return any(fragment in normalized for fragment in _SECRET_KEY_FRAGMENTS)


def _safe_string(value: Any) -> str:
    text = redact_sensitive_text(
        str(value),
        force=True,
        redact_url_credentials=True,
    )
    # Presentation values do not need control/format characters. Treat them
    # as separators (rather than deleting them) so ``--token\tVALUE`` cannot
    # be collapsed into the regex-bypassing ``--tokenVALUE``. This also makes
    # zero-width label splitting such as ``token\u200b: X`` visible to the
    # generic credential-label expressions below.
    text = "".join(
        " " if unicodedata.category(char) in {"Cc", "Cf"} else char
        for char in text
    )
    if text.lower().startswith("data:"):
        return _REDACTED
    # Tool cards do not need URL query strings or fragments.  Removing them
    # wholesale is safer than guessing which arbitrary parameter names carry
    # credentials, signed URLs, session ids, or private search inputs.
    def _strip_url_tail(match: re.Match[str]) -> str:
        url = match.group(0)
        head = url.split("#", 1)[0].split("?", 1)[0]
        # Drop userinfo while preserving the host/path display value.
        scheme, separator, rest = head.partition("://")
        if separator and "@" in rest.split("/", 1)[0]:
            authority, slash, path = rest.partition("/")
            authority = authority.rsplit("@", 1)[-1]
            head = f"{scheme}://{authority}{slash}{path}"
        return head

    text = _HTTP_URL_RE.sub(_strip_url_tail, text)
    text = _AUTH_SCHEME_RE.sub(lambda match: f"{match.group(1)} {_REDACTED}", text)
    text = _HEADER_SECRET_RE.sub(
        lambda match: f"{match.group(1)}: {_REDACTED}",
        text,
    )
    text = _CLI_SECRET_OPTION_RE.sub(
        lambda match: f"{match.group('prefix')}{_REDACTED}",
        text,
    )
    text = _LABELED_SECRET_RE.sub(
        lambda match: f"{match.group(1)}={_REDACTED}",
        text,
    )
    if len(text) > _MAX_STRING_CHARS:
        return text[:_MAX_STRING_CHARS] + "…"
    return text


def sanitize_nested_tool_value(value: Any, *, _depth: int = 0) -> Any:
    """Return a small JSON-compatible value safe for transient UI events."""
    if _depth >= _MAX_DEPTH:
        return "«truncated»"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return _safe_string(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return _REDACTED
    if isinstance(value, dict):
        safe: dict[str, Any] = {}
        for index, (raw_key, raw_value) in enumerate(value.items()):
            if index >= _MAX_DICT_ITEMS:
                break
            key = _safe_string(raw_key)[:120]
            safe[key] = (
                _REDACTED
                if _sensitive_key(raw_key)
                else sanitize_nested_tool_value(raw_value, _depth=_depth + 1)
            )
        if len(value) > _MAX_DICT_ITEMS:
            safe["_truncated"] = len(value) - _MAX_DICT_ITEMS
        return safe
    if isinstance(value, (list, tuple, set, frozenset)):
        safe_values = [
            sanitize_nested_tool_value(item, _depth=_depth + 1)
            for item in islice(value, _MAX_LIST_ITEMS)
        ]
        if len(value) > _MAX_LIST_ITEMS:
            safe_values.append(f"… {len(value) - _MAX_LIST_ITEMS} more")
        return safe_values
    return _safe_string(value)


def sanitize_nested_tool_args(
    args: Any,
    *,
    tool_name: str | None = None,
) -> dict[str, Any]:
    if isinstance(args, dict) and tool_name is not None:
        allowed = _ALLOWED_ARGUMENT_KEYS.get(tool_name, frozenset())
        args = {key: args[key] for key in sorted(allowed) if key in args}
    safe = sanitize_nested_tool_value(args)
    if isinstance(safe, dict):
        return safe
    return {"arguments": safe}


class NestedToolPresentation:
    """Thread-safe, fail-open lifecycle projector for sandbox RPC calls."""

    def __init__(
        self,
        *,
        parent_tool_call_id: str,
        progress_callback: Callable[..., Any] | None = None,
        start_callback: Callable[..., Any] | None = None,
        complete_callback: Callable[..., Any] | None = None,
    ) -> None:
        parent = str(parent_tool_call_id or "").strip()
        self._identity = parent or f"execute_code:{uuid.uuid4().hex}"
        self._progress_callback = progress_callback
        self._start_callback = start_callback
        self._complete_callback = complete_callback
        self._lock = threading.Lock()
        # Serialize external callback emission.  Without this lock, scope
        # settlement on the outer thread can race an RPC worker between state
        # publication and its start callbacks, producing complete-before-start.
        self._emit_lock = threading.Lock()
        self._counter = 0
        self._closed = False
        self._states: dict[str, dict[str, Any]] = {}

    def _call_id(self, index: int) -> str:
        digest = hashlib.sha256(
            f"sandbox-tool:{self._identity}:{index}".encode("utf-8")
        ).hexdigest()[:24]
        return f"sandbox_{digest}"

    @staticmethod
    def _preview(name: str, args: dict[str, Any]) -> str | None:
        try:
            preview = build_tool_preview(name, args)
        except Exception:
            try:
                preview = json.dumps(args, ensure_ascii=False)
            except (TypeError, ValueError):
                preview = None
        if not preview:
            return None
        return _safe_string(preview)[:160]

    def start(self, name: Any, args: Any) -> str | None:
        """Project one real, already-authorized nested dispatch as started."""
        tool_name = _safe_string(name or "unknown")[:120] or "unknown"
        safe_args = sanitize_nested_tool_args(args, tool_name=tool_name)
        preview = self._preview(tool_name, safe_args)
        with self._emit_lock:
            with self._lock:
                if self._closed:
                    return None
                self._counter += 1
                call_id = self._call_id(self._counter)
                self._states[call_id] = {
                    "name": tool_name,
                    "args": safe_args,
                    "started": time.monotonic(),
                    "done": False,
                }

            if callable(self._progress_callback):
                try:
                    self._progress_callback(
                        "tool.started", tool_name, preview, safe_args
                    )
                except Exception:
                    logger.debug(
                        "nested tool progress start callback failed",
                        exc_info=True,
                    )
            if callable(self._start_callback):
                try:
                    self._start_callback(call_id, tool_name, safe_args)
                except Exception:
                    logger.debug("nested tool start callback failed", exc_info=True)
        return call_id

    def _claim_completion(
        self,
        call_id: str,
        *,
        raw_result: Any = None,
        force_error: bool = False,
    ) -> tuple[dict[str, Any], bool, float] | None:
        with self._lock:
            state = self._states.get(call_id)
            if state is None or state["done"]:
                return None
            state["done"] = True
            duration = max(0.0, time.monotonic() - state["started"])
        is_error = bool(force_error)
        if not is_error:
            try:
                is_error, _ = _detect_tool_failure(state["name"], raw_result)
            except Exception:
                logger.debug("nested tool failure detection failed", exc_info=True)
        return state, bool(is_error), duration

    def _emit_completion(
        self,
        call_id: str,
        state: dict[str, Any],
        is_error: bool,
        duration: float,
        status: str | None = None,
    ) -> None:
        # Never forward the real nested result through a presentation event.
        # It may contain fetched pages, file contents, credentials, or images.
        result = json.dumps(
            {"status": status or ("failed" if is_error else "completed")},
            ensure_ascii=False,
        )
        if callable(self._progress_callback):
            try:
                self._progress_callback(
                    "tool.completed",
                    state["name"],
                    None,
                    None,
                    duration=duration,
                    is_error=is_error,
                    result=result,
                    tool_call_id=call_id,
                )
            except Exception:
                logger.debug(
                    "nested tool progress completion callback failed",
                    exc_info=True,
                )
        if callable(self._complete_callback):
            try:
                self._complete_callback(
                    call_id,
                    state["name"],
                    state["args"],
                    result,
                )
            except Exception:
                logger.debug(
                    "nested tool completion callback failed",
                    exc_info=True,
                )

    def finish(
        self,
        call_id: str | None,
        raw_result: Any = None,
        *,
        force_error: bool = False,
    ) -> None:
        if not call_id:
            return
        with self._emit_lock:
            claimed = self._claim_completion(
                call_id,
                raw_result=raw_result,
                force_error=force_error,
            )
            if claimed is not None:
                state, is_error, duration = claimed
                self._emit_completion(call_id, state, is_error, duration)

    def settle_pending(self, *, status: str = "unknown") -> None:
        """Close unfinished cards when the outer execute_code scope exits."""
        with self._emit_lock:
            with self._lock:
                self._closed = True
                pending = [
                    (call_id, state)
                    for call_id, state in self._states.items()
                    if not state["done"]
                ]
                now = time.monotonic()
                for _, state in pending:
                    state["done"] = True
            for call_id, state in pending:
                self._emit_completion(
                    call_id,
                    state,
                    True,
                    max(0.0, now - state["started"]),
                    status=status,
                )


_CURRENT_NESTED_TOOL_PRESENTATION: ContextVar[
    NestedToolPresentation | None
] = ContextVar("hermes_nested_tool_presentation", default=None)


def current_nested_tool_presentation() -> NestedToolPresentation | None:
    return _CURRENT_NESTED_TOOL_PRESENTATION.get()


@contextmanager
def nested_tool_presentation_scope(
    *,
    parent_tool_call_id: str,
    progress_callback: Callable[..., Any] | None = None,
    start_callback: Callable[..., Any] | None = None,
    complete_callback: Callable[..., Any] | None = None,
) -> Iterator[NestedToolPresentation | None]:
    """Bind an observer for exactly one outer ``execute_code`` dispatch."""
    if not any(
        callable(callback)
        for callback in (progress_callback, start_callback, complete_callback)
    ):
        yield None
        return

    observer = NestedToolPresentation(
        parent_tool_call_id=parent_tool_call_id,
        progress_callback=progress_callback,
        start_callback=start_callback,
        complete_callback=complete_callback,
    )
    token = _CURRENT_NESTED_TOOL_PRESENTATION.set(observer)
    try:
        yield observer
    except BaseException:
        observer.settle_pending(status="interrupted")
        raise
    else:
        observer.settle_pending(status="unknown")
    finally:
        _CURRENT_NESTED_TOOL_PRESENTATION.reset(token)
