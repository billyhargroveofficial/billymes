"""Native Responses-over-WebSocket transport for ChatGPT Codex OAuth.

The consumer Codex backend supports a persistent ``response.create`` WebSocket
protocol.  Keeping one socket per Hermes conversation gives the backend a
connection-local continuation chain: when the next logical request is a strict
extension of the previous request and its output, only the delta is sent with
``previous_response_id``.  Any mismatch falls back to a full create request.

This module intentionally owns only the consumer Codex wire.  Public OpenAI and
OpenAI-compatible endpoints continue to use the SDK's HTTP/SSE transport.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, Iterator, Mapping, MutableMapping, Optional
from urllib.parse import urlparse, urlunparse

logger = logging.getLogger(__name__)

_WS_BETA_HEADER = "responses_websockets=2026-02-06"
_LITE_HEADER = "x-openai-internal-codex-responses-lite"
_WS_LITE_METADATA_KEY = "ws_request_header_x_openai_internal_codex_responses_lite"
_HANDSHAKE_FAILURE_CIRCUIT_THRESHOLD = 2
_HANDSHAKE_FAILURE_COOLDOWN_SECONDS = 300.0
_MIN_IDLE_TIMEOUT_SECONDS = 30.0
_MAX_IDLE_TIMEOUT_SECONDS = 1800.0
_DEFAULT_IDLE_TIMEOUT_SECONDS = 300.0
_UNSET = object()
_STATE_REGISTRY_INIT_LOCK = threading.Lock()
_RLOCK_TYPE = type(threading.RLock())
_HOSTED_TOOL_TYPES = frozenset({
    "web_search",
    "web_search_preview",
    "file_search",
    "code_interpreter",
    "image_generation",
    "computer",
    "local_shell",
    "shell",
    "mcp",
})


class CodexWebSocketTransportError(ConnectionError):
    """A retryable failure in the optional Codex WebSocket transport."""

    retryable = True


class CodexWebSocketAbortError(CodexWebSocketTransportError):
    """An external watchdog/teardown abort that must not start another call."""

    retryable = False


def _env_bool(name: str) -> Optional[bool]:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return None
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return None


def _positive_finite_float(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(parsed) or parsed <= 0:
        return None
    return parsed


def _websocket_idle_timeout_seconds(agent: Any, api_kwargs: Mapping[str, Any]) -> float:
    """Resolve the socket read budget from the matching HTTP request timeout."""
    override = _positive_finite_float(
        os.environ.get("HERMES_CODEX_WEBSOCKET_IDLE_TIMEOUT_SECONDS")
    )
    if override is not None:
        return min(_MAX_IDLE_TIMEOUT_SECONDS, max(_MIN_IDLE_TIMEOUT_SECONDS, override))

    timeout = api_kwargs.get("timeout")
    if timeout is None:
        timeout = (getattr(agent, "_client_kwargs", {}) or {}).get("timeout")
    if isinstance(timeout, (int, float)) and not isinstance(timeout, bool):
        read_timeout = _positive_finite_float(timeout)
    else:
        read_timeout = _positive_finite_float(getattr(timeout, "read", None))
    if read_timeout is None:
        read_timeout = _DEFAULT_IDLE_TIMEOUT_SECONDS
    return min(
        _MAX_IDLE_TIMEOUT_SECONDS,
        max(_MIN_IDLE_TIMEOUT_SECONDS, read_timeout),
    )


def _handshake_cooldown_seconds() -> float:
    raw = os.environ.get("HERMES_CODEX_WEBSOCKET_HANDSHAKE_COOLDOWN_SECONDS")
    if raw is None:
        return _HANDSHAKE_FAILURE_COOLDOWN_SECONDS
    try:
        configured = float(raw)
    except (TypeError, ValueError, OverflowError):
        return _HANDSHAKE_FAILURE_COOLDOWN_SECONDS
    if not math.isfinite(configured) or configured < 0:
        return _HANDSHAKE_FAILURE_COOLDOWN_SECONDS
    return min(3600.0, configured)


def _json_clone(value: Any) -> Any:
    """Return a detached plain-JSON value or raise ``TypeError``."""
    return json.loads(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def _official_codex_base_url(value: Any) -> Optional[str]:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        parsed = urlparse(raw)
    except (TypeError, ValueError):
        return None
    if parsed.scheme != "https" or (parsed.hostname or "").lower() != "chatgpt.com":
        return None
    try:
        if parsed.port not in (None, 443):
            return None
    except ValueError:
        return None
    path = parsed.path.rstrip("/")
    if path.endswith("/responses"):
        path = path[: -len("/responses")]
    if path != "/backend-api/codex":
        return None
    return urlunparse(("https", "chatgpt.com", path, "", "", ""))


def _responses_websocket_url(base_url: str) -> str:
    parsed = urlparse(base_url.rstrip("/") + "/responses")
    return urlunparse(("wss", parsed.netloc, parsed.path, "", parsed.query, ""))


def _extract_api_key(agent: Any, client: Any) -> Optional[str]:
    candidates = [
        getattr(client, "api_key", None),
        (getattr(agent, "_client_kwargs", {}) or {}).get("api_key"),
        getattr(agent, "api_key", None),
    ]
    for candidate in candidates:
        if callable(candidate):
            try:
                candidate = candidate()
            except Exception:
                continue
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return None


def _header_map(value: Any) -> Dict[str, str]:
    if not isinstance(value, Mapping):
        return {}
    result: Dict[str, str] = {}
    for key, item in value.items():
        if key and item is not None:
            result[str(key)] = str(item)
    return result


def _header_set(headers: MutableMapping[str, str], name: str, value: Any) -> None:
    """Case-insensitively replace one header in a plain mapping."""
    for existing in list(headers):
        if existing.lower() == name.lower():
            headers.pop(existing, None)
    if value is not None and str(value):
        headers[name] = str(value)


def _session_identity(agent: Any) -> tuple[str, str, str]:
    session_id = str(getattr(agent, "session_id", "") or "").strip()
    if not session_id:
        # Stable for this in-memory agent, without creating host-global state.
        session_id = getattr(agent, "_codex_direct_session_id", "")
        if not session_id:
            session_id = (
                "hermes-"
                + hashlib.sha256(
                    f"{id(agent)}:{time.time_ns()}".encode("utf-8")
                ).hexdigest()[:32]
            )
            setattr(agent, "_codex_direct_session_id", session_id)
    thread_id = session_id
    turn_id = str(getattr(agent, "_current_turn_id", "") or "").strip()
    if not turn_id:
        turn_id = (
            "turn-"
            + hashlib.sha256(
                f"{session_id}:{time.time_ns()}".encode("utf-8")
            ).hexdigest()[:24]
        )
    return session_id, thread_id, turn_id


def _contains_hosted_tool(tools: Any) -> bool:
    if not isinstance(tools, list):
        return False
    for tool in tools:
        if not isinstance(tool, Mapping):
            continue
        tool_type = str(tool.get("type") or "").strip()
        if tool_type in _HOSTED_TOOL_TYPES:
            return True
        if tool_type and tool_type not in {
            "function",
            "custom",
            "namespace",
            "tool_search",
        }:
            return True
    return False


def _catalog_requests_lite(model: str, access_token: str) -> bool:
    """Read the live Codex catalog helper while remaining upgrade-compatible.

    Dashboard startup doesn't necessarily prewarm the authenticated model
    picker. Check the token-scoped in-process snapshot first, then perform the
    one bounded official ``/models`` fetch only on a cache miss. Without this
    second step a cold headless server silently keeps Lite-capable models on
    the classic wire for its entire first session.
    """
    try:
        from agent import model_metadata

        metadata_helper = getattr(
            model_metadata,
            "get_codex_oauth_model_metadata",
            None,
        )
        if callable(metadata_helper):
            metadata = metadata_helper(
                model,
                access_token=access_token,
                allow_fetch=False,
            )
            if metadata is None:
                metadata = metadata_helper(
                    model,
                    access_token=access_token,
                    allow_fetch=True,
                )
            return (
                isinstance(metadata, dict)
                and metadata.get("use_responses_lite") is True
            )

        for name in (
            "should_use_codex_responses_lite",
            "codex_model_uses_responses_lite",
            "codex_model_use_responses_lite",
            "codex_uses_responses_lite",
        ):
            helper = getattr(model_metadata, name, None)
            if callable(helper):
                try:
                    return bool(
                        helper(
                            model,
                            access_token=access_token,
                            allow_fetch=True,
                        )
                    )
                except TypeError:
                    try:
                        return bool(helper(model))
                    except TypeError:
                        continue
    except Exception:
        logger.debug("Codex model catalog Lite lookup failed", exc_info=True)
    return False


def _should_use_lite(model: str, tools: Any, access_token: str) -> bool:
    # Hosted tools cannot be encoded on the Lite wire. Avoid a synchronous
    # authenticated /models probe on a cold cache when its answer cannot alter
    # the request shape.
    if _contains_hosted_tool(tools):
        return False
    override = _env_bool("HERMES_CODEX_RESPONSES_LITE")
    requested = (
        _catalog_requests_lite(model, access_token) if override is None else override
    )
    return bool(requested)


def _strip_image_detail(value: Any) -> Any:
    if isinstance(value, list):
        return [_strip_image_detail(item) for item in value]
    if not isinstance(value, dict):
        return value
    result = {key: _strip_image_detail(item) for key, item in value.items()}
    if result.get("type") in {"input_image", "image_url"}:
        result.pop("detail", None)
    return result


def _lite_tools(tools: Any) -> list[dict[str, Any]]:
    if not isinstance(tools, list):
        tools = []
    grouped: list[dict[str, Any]] = []
    passthrough: list[dict[str, Any]] = []
    functions_index: Optional[int] = None
    functions_description = ""
    for raw in tools:
        if not isinstance(raw, dict):
            continue
        tool = _json_clone(raw)
        if tool.get("type") in {"function", "custom"}:
            if functions_index is None:
                functions_index = len(passthrough)
            grouped.append(tool)
            continue
        if tool.get("type") == "namespace" and tool.get("name") == "functions":
            if functions_index is None:
                functions_index = len(passthrough)
            description = tool.get("description")
            if isinstance(description, str) and description.strip():
                functions_description = description
            nested = tool.get("tools")
            if isinstance(nested, list):
                grouped.extend(item for item in nested if isinstance(item, dict))
            continue
        passthrough.append(tool)
    if grouped and functions_index is not None:
        passthrough.insert(
            functions_index,
            {
                "type": "namespace",
                "name": "functions",
                "description": functions_description,
                "tools": grouped,
            },
        )
    return passthrough


def _apply_lite_body(body: dict[str, Any]) -> dict[str, Any]:
    transformed = _json_clone(body)
    tools = _lite_tools(transformed.pop("tools", None))
    instructions = transformed.pop("instructions", "")
    original_input = transformed.get("input")
    input_items = list(original_input) if isinstance(original_input, list) else []
    prefix: list[dict[str, Any]] = [
        {"type": "additional_tools", "role": "developer", "tools": tools}
    ]
    if isinstance(instructions, str) and instructions:
        prefix.append({
            "type": "message",
            "role": "developer",
            "content": [{"type": "input_text", "text": instructions}],
            "internal_chat_message_metadata_passthrough": {
                "content_item_kinds": ["model.base_instructions"]
            },
        })
    transformed["input"] = _strip_image_detail(prefix + input_items)
    transformed["parallel_tool_calls"] = False
    reasoning = transformed.get("reasoning")
    if isinstance(reasoning, dict):
        reasoning = dict(reasoning)
        reasoning["context"] = "all_turns"
        transformed["reasoning"] = reasoning
    return transformed


def _flatten_sdk_kwargs(kwargs: Mapping[str, Any]) -> dict[str, Any]:
    """Convert OpenAI SDK kwargs into the JSON body sent on the wire."""
    body: dict[str, Any] = {}
    for key, value in kwargs.items():
        if key in {
            "extra_body",
            "extra_headers",
            "extra_query",
            "timeout",
        }:
            continue
        body[key] = value
    extra_body = kwargs.get("extra_body")
    if isinstance(extra_body, Mapping):
        body.update(extra_body)
    body["stream"] = True
    return _json_clone(body)


def _turn_metadata(session_id: str, thread_id: str, turn_id: str) -> str:
    return json.dumps(
        {
            "session_id": session_id,
            "thread_id": thread_id,
            "turn_id": turn_id,
            "request_kind": "turn",
        },
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    )


@dataclass(frozen=True)
class PreparedCodexRequest:
    http_kwargs: dict[str, Any]
    websocket_body: dict[str, Any]
    websocket_headers: dict[str, str]
    base_url: str
    session_id: str
    thread_id: str
    turn_id: str
    use_lite: bool
    credential_fingerprint: str
    websocket_allowed: bool
    idle_timeout_seconds: float


def _is_real_openai_client(client: Any) -> bool:
    """Avoid opening real sockets from lightweight mocked client objects."""
    module = str(getattr(type(client), "__module__", "") or "")
    return module == "openai" or module.startswith("openai.")


def prepare_codex_direct_request(
    agent: Any,
    api_kwargs: Mapping[str, Any],
    client: Any,
) -> Optional[PreparedCodexRequest]:
    """Prepare matching HTTP and WebSocket wire shapes for consumer Codex."""
    if _env_bool("HERMES_CODEX_DIRECT_NATIVE") is False:
        return None
    websocket_override = _env_bool("HERMES_CODEX_WEBSOCKET")
    real_openai_client = _is_real_openai_client(client)
    websocket_allowed = bool(
        websocket_override is True
        or (websocket_override is not False and real_openai_client)
    )
    if not real_openai_client and websocket_override is not True:
        # Unit tests and third-party facades intentionally keep the historical
        # SDK surface. Production's primary client is ``openai.OpenAI``.  An
        # explicit HERMES_CODEX_WEBSOCKET=0 only disables the socket; native
        # identity/Lite preparation and the byte-equivalent HTTP path remain.
        return None
    client_base_url = getattr(client, "base_url", None)
    base_url = _official_codex_base_url(
        getattr(agent, "base_url", None) or client_base_url
    )
    if base_url is None:
        return None
    token = _extract_api_key(agent, client)
    if token is None:
        return None

    session_id, thread_id, turn_id = _session_identity(agent)
    raw_body = _flatten_sdk_kwargs(api_kwargs)
    model = str(raw_body.get("model") or getattr(agent, "model", "") or "")
    use_lite = _should_use_lite(model, raw_body.get("tools"), token)
    body = _apply_lite_body(raw_body) if use_lite else raw_body

    client_metadata = body.get("client_metadata")
    metadata = _header_map(client_metadata)
    metadata.update({
        "session_id": session_id,
        "thread_id": thread_id,
        "turn_id": turn_id,
        "x-codex-turn-metadata": _turn_metadata(session_id, thread_id, turn_id),
    })
    if use_lite:
        metadata[_WS_LITE_METADATA_KEY] = "true"
    body["client_metadata"] = metadata

    headers = _header_map(
        (getattr(agent, "_client_kwargs", {}) or {}).get("default_headers")
    )
    headers.update(_header_map(api_kwargs.get("extra_headers")))
    _header_set(headers, "Authorization", f"Bearer {token}")
    _header_set(headers, "OpenAI-Beta", _WS_BETA_HEADER)
    _header_set(headers, "session-id", session_id)
    _header_set(headers, "thread-id", thread_id)
    _header_set(headers, "x-client-request-id", thread_id)
    tier = body.get("service_tier")
    routing_hint = f"model={model}" + (f";tier={tier}" if tier else "")
    _header_set(headers, "x-codex-routing-hint", routing_hint)
    if use_lite:
        _header_set(headers, _LITE_HEADER, "true")
    else:
        _header_set(headers, _LITE_HEADER, None)

    # The SDK accepts unknown Codex fields through extra_body. Keep the HTTP
    # fallback body byte-equivalent to the WebSocket body (minus its frame
    # ``type``) and preserve SDK-only transport kwargs separately.
    http_kwargs: dict[str, Any] = {}
    for key in ("timeout", "extra_query"):
        if key in api_kwargs:
            http_kwargs[key] = api_kwargs[key]
    http_headers = dict(headers)
    _header_set(http_headers, "OpenAI-Beta", None)
    http_kwargs["extra_headers"] = http_headers
    # Give the SDK the minimal required typed fields; everything else is
    # already plain wire JSON and bypasses its expensive recursive transform.
    if model:
        http_kwargs["model"] = model
    http_kwargs["stream"] = True
    http_kwargs["extra_body"] = body

    return PreparedCodexRequest(
        http_kwargs=http_kwargs,
        websocket_body=body,
        websocket_headers=headers,
        base_url=base_url,
        session_id=session_id,
        thread_id=thread_id,
        turn_id=turn_id,
        use_lite=use_lite,
        credential_fingerprint=hashlib.sha256(token.encode("utf-8")).hexdigest()[:16],
        websocket_allowed=websocket_allowed,
        idle_timeout_seconds=_websocket_idle_timeout_seconds(agent, api_kwargs),
    )


def _comparable_response_item(value: Any) -> Any:
    """Return one logical input item in continuation-comparison form.

    Codex compares request properties exactly and ignores only the internal chat
    metadata attached to a top-level response item.  Hermes additionally strips
    output-only ``id`` / ``status`` fields when replaying client-executed and
    encrypted items, so those two fields are ignored only for those known item
    kinds.  Applying that rule recursively is unsafe: tool schemas routinely
    contain properties named ``id`` and ``status`` and changing either must
    invalidate the continuation chain.
    """
    if not isinstance(value, dict):
        return _json_clone(value)
    result = _json_clone(value)
    result.pop("_issuer_kind", None)
    result.pop("internal_chat_message_metadata_passthrough", None)
    if result.get("type") in {
        "function_call",
        "custom_tool_call",
        "reasoning",
        "compaction",
    }:
        result.pop("id", None)
        result.pop("status", None)
    return result


def _continuation_replay_output_items(output_items: list[Any]) -> Optional[list[Any]]:
    """Canonicalize output exactly as manual history will replay it.

    The connection-local continuation prefix must match the next request's
    by-value history, not the raw provider output. The replay adapter clamps
    oversized message/hosted ids, normalizes image-generation status, and
    strips output-only fields. Storing the raw form makes an otherwise strict
    extension look different and silently degrades every such turn to a full
    context request.

    Sanitization is only an optimization boundary here. If it unexpectedly
    fails, retire the continuation chain instead of risking a false prefix.
    """
    try:
        from agent.codex_responses_adapter import (
            _preflight_codex_input_items,
            _sanitize_responses_output_items_for_replay,
        )

        replay_items = _sanitize_responses_output_items_for_replay(
            output_items,
            current_issuer_kind="codex_backend",
            native_compaction_eligible=False,
        )
        return _preflight_codex_input_items(
            replay_items,
            sanitize_harmony_tokens=True,
        )
    except Exception:
        logger.debug(
            "Could not canonicalize Codex websocket continuation output",
            exc_info=True,
        )
        return None


def _request_options_hash(body: Mapping[str, Any]) -> str:
    options = {
        key: value
        for key, value in body.items()
        if key
        not in {
            "input",
            "previous_response_id",
            "type",
            "client_metadata",
            # Delivery-only: native Codex deliberately excludes this from
            # continuation compatibility.
            "stream_options",
        }
    }
    encoded = json.dumps(
        options,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _strict_prefix_delta(
    current_input: Any,
    previous_input: list[Any],
    previous_output: list[Any],
) -> Optional[list[Any]]:
    if not isinstance(current_input, list):
        return None
    expected = previous_input + previous_output
    if len(current_input) < len(expected):
        return None
    for previous, current in zip(expected, current_input):
        if _comparable_response_item(previous) != _comparable_response_item(current):
            return None
    return _json_clone(current_input[len(expected) :])


@dataclass
class _ConnectionState:
    key: str
    socket: Any = None
    created_at: float = 0.0
    last_inbound_at: float = 0.0
    busy: bool = False
    force_http_once: bool = False
    last_options_hash: Optional[str] = None
    last_full_input: list[Any] = field(default_factory=list)
    last_output: list[Any] = field(default_factory=list)
    last_response_id: Optional[str] = None
    turn_state: Optional[str] = None
    turn_id: Optional[str] = None
    full_context_requests: int = 0
    delta_requests: int = 0
    fallback_count: int = 0
    last_sent_input_items: int = 0
    last_used_previous_response_id: Optional[str] = None
    handshake_failures: int = 0
    disabled_until: float = 0.0
    retired: bool = False
    generation: int = 0
    lease_counter: int = 0
    active_lease: Optional[int] = None
    lock: threading.RLock = field(default_factory=threading.RLock)

    def _reset_chain_locked(self) -> None:
        self.last_options_hash = None
        self.last_full_input = []
        self.last_output = []
        self.last_response_id = None

    def release_lease(self, lease: int) -> None:
        with self.lock:
            if self.active_lease == lease:
                self.active_lease = None
                self.busy = False

    def close(
        self,
        reason: str,
        *,
        expected_socket: Any = _UNSET,
        expected_lease: Optional[int] = None,
        force_http_once: bool = False,
    ) -> bool:
        """Detach under the mutex, then close without holding it.

        ``expected_*`` fences a late failure/abort from closing a replacement
        socket that already belongs to a newer physical attempt.
        """
        with self.lock:
            if expected_socket is not _UNSET and self.socket is not expected_socket:
                return False
            if expected_lease is not None and self.active_lease != expected_lease:
                return False
            socket = self.socket
            was_active = socket is not None or self.busy
            self.socket = None
            if force_http_once:
                self.force_http_once = True
            self._reset_chain_locked()
            self.generation += 1
            self.active_lease = None
            self.busy = False
        if socket is not None:
            try:
                socket.close(code=1000, reason=reason[:120])
            except TypeError:
                try:
                    socket.close()
                except Exception:
                    pass
            except Exception:
                pass
        return was_active


def _close_owned_stream_socket(
    state: _ConnectionState,
    socket: Any,
    lease: int,
    reason: str,
    *,
    force_http_once: bool = False,
) -> None:
    """Close this lease, or report that an external abort won the race."""
    if not state.close(
        reason,
        expected_socket=socket,
        expected_lease=lease,
        force_http_once=force_http_once,
    ):
        raise CodexWebSocketAbortError("Codex websocket request was aborted")


def _state_registry(
    agent: Any,
) -> tuple[dict[str, _ConnectionState], threading.RLock]:
    """Return the per-agent state map and its registry mutex."""
    with _STATE_REGISTRY_INIT_LOCK:
        states = getattr(agent, "_codex_direct_ws_states", None)
        if not isinstance(states, dict):
            states = {}
            setattr(agent, "_codex_direct_ws_states", states)
        registry_lock = getattr(agent, "_codex_direct_ws_states_lock", None)
        if not isinstance(registry_lock, _RLOCK_TYPE):
            registry_lock = threading.RLock()
            setattr(agent, "_codex_direct_ws_states_lock", registry_lock)
    return states, registry_lock


def _state_key(prepared: PreparedCodexRequest) -> str:
    return "|".join((
        prepared.base_url,
        prepared.session_id,
        str(prepared.websocket_body.get("model") or ""),
        "lite" if prepared.use_lite else "classic",
        prepared.credential_fingerprint,
    ))


def _connect(prepared: PreparedCodexRequest) -> Any:
    from websockets.sync.client import connect

    return connect(
        _responses_websocket_url(prepared.base_url),
        additional_headers=prepared.websocket_headers,
        open_timeout=10,
        close_timeout=2,
        ping_interval=20,
        ping_timeout=60,
        # Encrypted reasoning and hosted image results can exceed the
        # websockets package's 1 MiB default. Keep a bounded per-frame ceiling
        # while relying on TCP backpressure instead of a giant frame queue.
        max_size=128 * 1024 * 1024,
        max_queue=64,
    )


def _connection_header(socket: Any, name: str) -> Optional[str]:
    """Read one opening-handshake response header from websockets.sync."""
    response = getattr(socket, "response", None)
    headers = getattr(response, "headers", None)
    if headers is None:
        return None
    try:
        value = headers.get(name)
    except Exception:
        return None
    return str(value) if value is not None and str(value) else None


def _event_turn_state(event: Mapping[str, Any]) -> Optional[str]:
    direct = event.get("turn_state")
    if isinstance(direct, str) and direct:
        return direct
    headers = event.get("headers")
    if isinstance(headers, Mapping):
        for key, value in headers.items():
            if str(key).lower() == "x-codex-turn-state" and isinstance(value, str):
                return value or None
    return None


def _event_response_id(event: Mapping[str, Any]) -> Optional[str]:
    response = event.get("response")
    if isinstance(response, Mapping):
        value = response.get("id")
        if isinstance(value, str) and value:
            return value
    value = event.get("response_id")
    if isinstance(value, str) and value:
        return value
    return None


def _event_error_code(event: Mapping[str, Any]) -> str:
    error = event.get("error")
    if isinstance(error, Mapping):
        code = error.get("code") or error.get("type")
        if isinstance(code, str):
            return code.strip().lower()
    response = event.get("response")
    if isinstance(response, Mapping):
        response_error = response.get("error")
        if isinstance(response_error, Mapping):
            code = response_error.get("code") or response_error.get("type")
            if isinstance(code, str):
                return code.strip().lower()
    code = event.get("code")
    return code.strip().lower() if isinstance(code, str) else ""


class _CodexWebSocketStream(Iterator[dict[str, Any]]):
    def __init__(
        self,
        state: _ConnectionState,
        prepared: PreparedCodexRequest,
        lease: int,
    ) -> None:
        self._state = state
        self._prepared = prepared
        self._lease = lease
        self._iterator = self._iterate()
        self._closed = False

    def __iter__(self) -> "_CodexWebSocketStream":
        return self

    def __next__(self) -> dict[str, Any]:
        return next(self._iterator)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._iterator.close()
        finally:
            self._state.release_lease(self._lease)

    def _iterate(self) -> Iterator[dict[str, Any]]:
        state = self._state
        prepared = self._prepared
        raw_body = _json_clone(prepared.websocket_body)
        full_input = raw_body.get("input")
        if not isinstance(full_input, list):
            full_input = []
        options_hash = _request_options_hash(raw_body)
        output_items: list[Any] = []
        response_id: Optional[str] = None
        completed = False
        try:
            with state.lock:
                if (
                    state.active_lease != self._lease
                    or state.socket is None
                    or state.retired
                ):
                    raise CodexWebSocketAbortError(
                        "Codex websocket request was aborted before send"
                    )
                socket = state.socket
                turn_state = state.turn_state
                previous_response_id = state.last_response_id
                previous_options_hash = state.last_options_hash
                previous_full_input = state.last_full_input
                previous_output = state.last_output

            # Prefix comparison can traverse a very large request. Keep it out
            # of the mutex so a watchdog can detach the lease immediately; the
            # second fenced snapshot below prevents a detached request sending.
            request = {"type": "response.create", **raw_body}
            if turn_state:
                metadata = _header_map(request.get("client_metadata"))
                metadata["x-codex-turn-state"] = turn_state
                request["client_metadata"] = metadata
            if previous_response_id and previous_options_hash == options_hash:
                delta = _strict_prefix_delta(
                    full_input,
                    previous_full_input,
                    previous_output,
                )
                if delta is not None:
                    request["previous_response_id"] = previous_response_id
                    request["input"] = delta

            with state.lock:
                if (
                    state.active_lease != self._lease
                    or state.socket is not socket
                    or state.retired
                ):
                    raise CodexWebSocketAbortError(
                        "Codex websocket request was aborted before send"
                    )
                sent_input = request.get("input")
                state.last_sent_input_items = (
                    len(sent_input) if isinstance(sent_input, list) else 0
                )
                used_previous_response_id = request.get("previous_response_id")
                if isinstance(used_previous_response_id, str):
                    state.delta_requests += 1
                    state.last_used_previous_response_id = used_previous_response_id
                else:
                    state.full_context_requests += 1
                    state.last_used_previous_response_id = None

            # Never hold ``state.lock`` across blocking socket I/O or a
            # generator yield. Cross-thread watchdog/teardown closes the local
            # socket, which unblocks recv; the expected socket + lease fences
            # below prevent that old attempt from touching a replacement.
            try:
                socket.send(
                    json.dumps(
                        request,
                        ensure_ascii=False,
                        separators=(",", ":"),
                    )
                )
            except Exception as exc:
                _close_owned_stream_socket(
                    state,
                    socket,
                    self._lease,
                    "send-failed",
                    force_http_once=True,
                )
                raise CodexWebSocketTransportError(
                    f"Codex websocket send failed: {exc}"
                ) from exc

            while True:
                try:
                    raw = socket.recv(timeout=prepared.idle_timeout_seconds)
                except TimeoutError as exc:
                    _close_owned_stream_socket(
                        state,
                        socket,
                        self._lease,
                        "idle-timeout",
                        force_http_once=True,
                    )
                    raise CodexWebSocketTransportError(
                        "Codex websocket idle timeout"
                    ) from exc
                except Exception as exc:
                    _close_owned_stream_socket(
                        state,
                        socket,
                        self._lease,
                        "receive-failed",
                        force_http_once=True,
                    )
                    raise CodexWebSocketTransportError(
                        f"Codex websocket receive failed: {exc}"
                    ) from exc
                if raw is None:
                    _close_owned_stream_socket(
                        state,
                        socket,
                        self._lease,
                        "closed",
                        force_http_once=True,
                    )
                    raise CodexWebSocketTransportError(
                        "Codex websocket closed before response completion"
                    )
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8", errors="replace")
                try:
                    event = json.loads(raw)
                except (TypeError, ValueError) as exc:
                    _close_owned_stream_socket(
                        state,
                        socket,
                        self._lease,
                        "malformed-frame",
                        force_http_once=True,
                    )
                    raise CodexWebSocketTransportError(
                        "Codex websocket emitted malformed JSON"
                    ) from exc
                if not isinstance(event, dict):
                    continue

                with state.lock:
                    if state.socket is not socket or state.active_lease != self._lease:
                        raise CodexWebSocketAbortError(
                            "Codex websocket request was aborted"
                        )
                    state.last_inbound_at = time.monotonic()
                    new_turn_state = _event_turn_state(event)
                    if new_turn_state:
                        state.turn_state = new_turn_state

                event_type = str(event.get("type") or "")
                error_code = _event_error_code(event)
                if isinstance(used_previous_response_id, str) and error_code in {
                    "previous_response_not_found",
                    "invalid_previous_response_id",
                }:
                    # Native Codex retires a websocket after every stream error.
                    # Reconnect and retry the full input; response ids are
                    # connection-local and the errored socket isn't reusable.
                    _close_owned_stream_socket(
                        state,
                        socket,
                        self._lease,
                        "continuation-expired",
                    )
                    raise CodexWebSocketTransportError(
                        "Codex websocket continuation expired"
                    )
                if error_code == "websocket_connection_limit_reached":
                    _close_owned_stream_socket(
                        state,
                        socket,
                        self._lease,
                        "connection-limit",
                    )
                    raise CodexWebSocketTransportError(
                        "Codex websocket connection lifetime expired"
                    )
                if event_type == "error":
                    # Preserve the provider error frame for the normal error
                    # classifier, but poison the transport before yielding it.
                    _close_owned_stream_socket(
                        state,
                        socket,
                        self._lease,
                        "provider-error",
                    )
                    yield event
                    return
                if event_type == "response.output_item.done":
                    item = event.get("item")
                    if isinstance(item, dict):
                        output_items.append(_json_clone(item))
                observed_id = _event_response_id(event)
                if observed_id:
                    response_id = observed_id
                if event_type in {
                    "response.failed",
                    "response.incomplete",
                    "response.cancelled",
                }:
                    _close_owned_stream_socket(
                        state,
                        socket,
                        self._lease,
                        "non-success-terminal",
                    )
                    yield event
                    return

                if event_type == "response.completed":
                    completed = True
                    response = event.get("response")
                    if not output_items and isinstance(response, Mapping):
                        terminal_output = response.get("output")
                        if isinstance(terminal_output, list):
                            output_items = _json_clone(terminal_output)
                yield event
                if completed:
                    break

            stored_full_input = _json_clone(full_input)
            stored_output = _continuation_replay_output_items(output_items)
            with state.lock:
                if (
                    completed
                    and response_id
                    and stored_output is not None
                    and state.socket is socket
                    and state.active_lease == self._lease
                ):
                    state.last_options_hash = options_hash
                    state.last_full_input = stored_full_input
                    state.last_output = stored_output
                    state.last_response_id = response_id
                elif state.socket is socket and state.active_lease == self._lease:
                    state._reset_chain_locked()
        finally:
            if not completed and "socket" in locals():
                # A consumer can abandon an iterator without a transport error
                # (Relay cancellation/supersession, callback failure, or an
                # explicit close). Any frames still queued on that connection
                # belong to the abandoned response; reusing it would make the
                # next response.create consume those stale frames. Detach and
                # close only the socket owned by this lease. A concurrent
                # watchdog abort may already have won the race, in which case
                # state.close() safely returns False.
                state.close(
                    "stream-abandoned",
                    expected_socket=socket,
                    expected_lease=self._lease,
                )
            else:
                state.release_lease(self._lease)


def open_codex_websocket_stream(
    agent: Any,
    prepared: PreparedCodexRequest,
) -> Optional[Iterable[dict[str, Any]]]:
    """Open or reuse a native Codex WebSocket, else request HTTP fallback."""
    if not prepared.websocket_allowed or _env_bool("HERMES_CODEX_WEBSOCKET") is False:
        return None
    # Native websocket ResponseCreate doesn't yet carry remote-compaction
    # control fields. Keep those uncommon turns on the proven HTTP path.
    if "context_management" in prepared.websocket_body:
        return None

    key = _state_key(prepared)
    states, registry_lock = _state_registry(agent)
    stale_states: list[_ConnectionState] = []
    with registry_lock:
        state = states.get(key)
        if not isinstance(state, _ConnectionState):
            state = _ConnectionState(key=key)
            states[key] = state
        # Bound stale model/credential sessions without touching the active one.
        if len(states) > 4:
            for stale_key in list(states):
                if stale_key == key:
                    continue
                stale = states.get(stale_key)
                if isinstance(stale, _ConnectionState):
                    with stale.lock:
                        if stale.busy:
                            continue
                        stale.retired = True
                    states.pop(stale_key, None)
                    stale_states.append(stale)
                else:
                    states.pop(stale_key, None)
                if len(states) <= 4:
                    break
    for stale in stale_states:
        stale.close("pool-eviction")

    while True:
        expired_socket: Any = None
        expired_lease: Optional[int] = None
        with state.lock:
            if state.retired:
                raise CodexWebSocketAbortError("Codex websocket state was retired")
            # A concurrent call never waits behind the active socket. It gets a
            # full-context HTTP fallback and cannot mutate the active turn's
            # sticky-routing state.
            if state.busy:
                state.fallback_count += 1
                return None

            # Turn identity is explicit in Hermes' main loop and is stable
            # across physical retries and tool follow-ups. This avoids clearing
            # a freshly learned turn-state merely because a first-request retry
            # still ends in a user item.
            if state.turn_id != prepared.turn_id:
                state.turn_id = prepared.turn_id
                state.turn_state = None

            now = time.monotonic()
            if state.disabled_until > now:
                state.fallback_count += 1
                return None
            if state.disabled_until:
                # Half-open probe after cooldown. One failure reopens the
                # breaker; one successful handshake resets it completely.
                state.disabled_until = 0.0
                state.handshake_failures = _HANDSHAKE_FAILURE_CIRCUIT_THRESHOLD - 1
            if state.force_http_once:
                state.force_http_once = False
                state.fallback_count += 1
                return None

            socket = state.socket
            if socket is not None and now - state.created_at > 55 * 60:
                expired_socket = socket
                state.lease_counter += 1
                expired_lease = state.lease_counter
                state.active_lease = expired_lease
                state.busy = True
            else:
                state.lease_counter += 1
                lease = state.lease_counter
                state.active_lease = lease
                state.busy = True
                connect_generation = state.generation
                if socket is not None:
                    return _CodexWebSocketStream(state, prepared, lease)

        if expired_socket is not None:
            if not state.close(
                "connection-age",
                expected_socket=expired_socket,
                expected_lease=expired_lease,
            ):
                raise CodexWebSocketAbortError(
                    "Codex websocket connection refresh was aborted"
                )
            continue

        # Connect outside the state mutex. Teardown/watchdog may cancel the
        # lease while the handshake is in flight; generation + lease checks
        # below then discard the late socket instead of resurrecting it.
        try:
            new_socket = _connect(prepared)
        except Exception as exc:
            counted_failure = False
            failure_count = 0
            circuit_open = False
            with state.lock:
                if (
                    state.active_lease == lease
                    and state.generation == connect_generation
                    and not state.retired
                ):
                    state.handshake_failures += 1
                    counted_failure = True
                    if state.handshake_failures >= _HANDSHAKE_FAILURE_CIRCUIT_THRESHOLD:
                        state.disabled_until = (
                            time.monotonic() + _handshake_cooldown_seconds()
                        )
                    failure_count = state.handshake_failures
                    circuit_open = state.disabled_until > time.monotonic()
                    state._reset_chain_locked()
                    state.active_lease = None
                    state.busy = False
                    state.fallback_count += 1
            if counted_failure:
                logger.warning(
                    "Codex WebSocket unavailable; using HTTP/SSE fallback "
                    "(%s, failure %d/%d%s)",
                    type(exc).__name__,
                    failure_count,
                    _HANDSHAKE_FAILURE_CIRCUIT_THRESHOLD,
                    "; circuit open" if circuit_open else "",
                )
            else:
                raise CodexWebSocketAbortError(
                    "Codex websocket handshake was aborted"
                ) from exc
            return None

        discard_socket = False
        with state.lock:
            if (
                state.active_lease != lease
                or state.generation != connect_generation
                or state.socket is not None
                or state.retired
            ):
                discard_socket = True
            else:
                state.socket = new_socket
                state.created_at = time.monotonic()
                state.last_inbound_at = state.created_at
                state.handshake_failures = 0
                state.disabled_until = 0.0
                handshake_turn_state = _connection_header(
                    new_socket, "x-codex-turn-state"
                )
                if handshake_turn_state:
                    state.turn_state = handshake_turn_state
        if discard_socket:
            try:
                new_socket.close(code=1000, reason="superseded-connect")
            except TypeError:
                try:
                    new_socket.close()
                except Exception:
                    pass
            except Exception:
                pass
            raise CodexWebSocketAbortError("Codex websocket handshake was aborted")
        return _CodexWebSocketStream(state, prepared, lease)


def codex_http_fallback_kwargs(
    agent: Any,
    prepared: PreparedCodexRequest,
) -> dict[str, Any]:
    """Return detached HTTP kwargs with the current turn's sticky token.

    WebSocket carries ``x-codex-turn-state`` in ``client_metadata``; native
    Codex replays the same token as an HTTP header when it falls back mid-turn.
    The caller receives a new top-level/header mapping, so the prepared request
    remains safe to reuse for a later physical attempt.
    """
    result = dict(prepared.http_kwargs)
    headers = _header_map(result.get("extra_headers"))
    state: Optional[_ConnectionState] = None
    states, registry_lock = _state_registry(agent)
    with registry_lock:
        candidate = states.get(_state_key(prepared))
        if isinstance(candidate, _ConnectionState):
            state = candidate
    turn_state: Optional[str] = None
    if state is not None:
        with state.lock:
            if state.turn_id == prepared.turn_id:
                turn_state = state.turn_state
    _header_set(headers, "x-codex-turn-state", turn_state)
    result["extra_headers"] = headers
    return result


def abort_active_codex_websocket(
    agent: Any,
    *,
    reason: str = "request-abort",
) -> bool:
    """Cross-thread abort active native Codex sockets without clearing state."""
    states, registry_lock = _state_registry(agent)
    with registry_lock:
        snapshot = list(states.values())
    aborted = False
    for state in snapshot:
        if not isinstance(state, _ConnectionState):
            continue
        with state.lock:
            lease = state.active_lease
            socket = state.socket
            active = state.busy and lease is not None
        if active and state.close(
            reason,
            expected_socket=socket,
            expected_lease=lease,
        ):
            aborted = True
    return aborted


def close_codex_websockets(agent: Any, *, reason: str = "agent-close") -> None:
    """Close all native Codex sockets owned by an agent."""
    states, registry_lock = _state_registry(agent)
    with registry_lock:
        snapshot = list(states.values())
        for state in snapshot:
            if isinstance(state, _ConnectionState):
                with state.lock:
                    state.retired = True
        states.clear()
    for state in snapshot:
        if isinstance(state, _ConnectionState):
            state.close(reason)


def get_codex_websocket_debug_stats(agent: Any) -> list[dict[str, Any]]:
    """Return secret-free per-connection diagnostics for tests and support."""
    states, registry_lock = _state_registry(agent)
    with registry_lock:
        snapshot = list(states.values())
    result: list[dict[str, Any]] = []
    for state in snapshot:
        if not isinstance(state, _ConnectionState):
            continue
        with state.lock:
            result.append({
                "connected": state.socket is not None,
                "busy": state.busy,
                "full_context_requests": state.full_context_requests,
                "delta_requests": state.delta_requests,
                "fallback_count": state.fallback_count,
                "last_sent_input_items": state.last_sent_input_items,
                "last_used_previous_response_id": (
                    state.last_used_previous_response_id
                ),
                "has_turn_state": bool(state.turn_state),
                "handshake_failures": state.handshake_failures,
                "circuit_open": state.disabled_until > time.monotonic(),
                "circuit_cooldown_remaining_seconds": max(
                    0.0,
                    state.disabled_until - time.monotonic(),
                ),
            })
    return result


__all__ = [
    "abort_active_codex_websocket",
    "codex_http_fallback_kwargs",
    "CodexWebSocketAbortError",
    "CodexWebSocketTransportError",
    "PreparedCodexRequest",
    "close_codex_websockets",
    "get_codex_websocket_debug_stats",
    "open_codex_websocket_stream",
    "prepare_codex_direct_request",
]
