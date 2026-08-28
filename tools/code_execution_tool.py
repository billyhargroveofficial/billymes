#!/usr/bin/env python3
"""
Code Execution Tool -- Programmatic Tool Calling (PTC)

Lets the LLM write a Python script that calls Hermes tools via RPC,
collapsing multi-step tool chains into a single inference turn.

Architecture (two transports):

  **Local backend (UDS):**
  1. Parent generates a `hermes_tools.py` stub module with UDS RPC functions
  2. Parent opens a Unix domain socket and starts an RPC listener thread
  3. Parent spawns a child process that runs the LLM's script
  4. Tool calls travel over the UDS back to the parent for dispatch

  **Remote backends (file-based RPC):**
  1. Parent generates `hermes_tools.py` with file-based RPC stubs
  2. Parent ships both files to the remote environment
  3. Script runs inside the terminal backend (Docker/SSH/Modal/Daytona/etc.)
  4. Tool calls are written as request files; a polling thread on the parent
     reads them via env.execute(), dispatches, and writes response files
  5. The script polls for response files and continues

In both cases, only the script's stdout is returned to the LLM; intermediate
tool results never enter the context window.

Platform: Linux / macOS use Unix domain sockets; Windows uses loopback TCP.
Remote execution additionally requires Python 3 in the terminal backend.
"""

import base64
import json
import logging
import os
import platform
import re
import secrets
import shlex
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid

_IS_WINDOWS = platform.system() == "Windows"
from typing import Any, Dict, List, Optional, Tuple

from tools.thread_context import propagate_context_to_thread
from agent.thread_scoped_output import thread_scoped_silence

# Availability gate.  On Windows we fall back to loopback TCP for the
# sandbox RPC transport (AF_UNIX is unreliable on Windows Python) — see
# ``_use_tcp_rpc`` in ``_execute_local`` below.  That makes execute_code
# available on every platform Hermes itself runs on.
logger = logging.getLogger(__name__)

SANDBOX_AVAILABLE = True

# The 7 tools allowed inside the sandbox. The intersection of this list
# and the session's enabled tools determines which stubs are generated.
SANDBOX_ALLOWED_TOOLS = frozenset([
    "web_search",
    "web_extract",
    "read_file",
    "write_file",
    "search_files",
    "patch",
    "terminal",
])

# Resource limit defaults (overridable via config.yaml → code_execution.*)
DEFAULT_TIMEOUT = 300        # 5 minutes
DEFAULT_MAX_TOOL_CALLS = 50
DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10
MAX_PARALLEL_TOOL_CALLS = 32
MAX_STDOUT_BYTES = 50_000    # 50 KB
MAX_STDERR_BYTES = 10_000    # 10 KB


def _assemble_stdout_result(
    head: bytes,
    tail: bytes = b"",
    *,
    total_bytes: Optional[int] = None,
) -> Tuple[str, Dict[str, Any]]:
    """Build display stdout plus explicit truncation metadata.

    The agent receives execute_code results as JSON. A textual truncation
    marker can be missed or later re-truncated by a client layer, so keep the
    marker for humans and also expose byte counts for deterministic handling.
    """
    captured = head + tail
    total = len(captured) if total_bytes is None else max(total_bytes, len(captured))
    truncated = total > len(captured)
    omitted = max(0, total - len(captured))

    if truncated:
        stdout_text = (
            head.decode("utf-8", errors="replace")
            + f"\n\n... [OUTPUT TRUNCATED - {omitted:,} bytes omitted "
            f"out of {total:,} total] ...\n\n"
            + tail.decode("utf-8", errors="replace")
        )
    else:
        stdout_text = captured.decode("utf-8", errors="replace")

    metadata: Dict[str, Any] = {
        "stdout_truncated": truncated,
        "stdout_bytes_captured": len(captured),
        "stdout_bytes_total": total,
        "stdout_bytes_omitted": omitted,
    }
    if truncated:
        metadata["warning"] = (
            "execute_code stdout was truncated; the script did run, but only "
            "the captured head/tail output is included. Re-run only with "
            "narrower output if the omitted data is required."
        )
    return stdout_text, metadata


def _truncate_stdout_text(stdout_text: str) -> Tuple[str, Dict[str, Any]]:
    """Cap a complete stdout string by bytes using the same head/tail policy.

    When the full text is in hand (this function's callers, unlike the
    streaming per-call reader), the omitted middle is not discarded: the
    complete output is spilled to cache/exec and the result carries the
    path — the same recover-don't-rerun pattern as web_extract's
    cache/web full-text store.
    """
    stdout_bytes = stdout_text.encode("utf-8", errors="replace")
    if len(stdout_bytes) <= MAX_STDOUT_BYTES:
        return _assemble_stdout_result(stdout_bytes)

    head_bytes = int(MAX_STDOUT_BYTES * 0.4)
    tail_bytes = MAX_STDOUT_BYTES - head_bytes
    text, metadata = _assemble_stdout_result(
        stdout_bytes[:head_bytes],
        stdout_bytes[-tail_bytes:],
        total_bytes=len(stdout_bytes),
    )
    spill_path = _spill_full_stdout(stdout_text)
    if spill_path:
        metadata["stdout_spill_path"] = spill_path
        metadata["warning"] = (
            "execute_code stdout was truncated (head/tail shown); the "
            f"script did run. FULL output saved to {spill_path} — page it "
            f'with read_file(path="{spill_path}", offset=...) instead of '
            "re-running."
        )
    return text, metadata


# Hard ceiling on the spilled file, mirroring web_tools' MAX_STORED_TEXT_CHARS
# rationale: a runaway print loop must not write unbounded bytes to disk.
MAX_SPILLED_STDOUT_BYTES = 5_000_000


def _spill_full_stdout(stdout_text: str) -> Optional[str]:
    """Write full stdout to cache/exec; return its path (None on failure).

    Best-effort by design — truncated inline output is still returned when
    storage fails. Files are keyed by content digest so identical reruns
    coalesce; the directory rides the same remote bind-mount list as
    cache/web (credential_files._CACHE_DIRS) if present there.
    """
    try:
        import hashlib
        from hermes_constants import get_hermes_dir

        if len(stdout_text) > MAX_SPILLED_STDOUT_BYTES:
            stdout_text = (
                stdout_text[:MAX_SPILLED_STDOUT_BYTES]
                + f"\n\n[... spill capped at {MAX_SPILLED_STDOUT_BYTES:,} bytes ...]"
            )
        cache_dir = get_hermes_dir("cache/exec", "exec_spill")
        cache_dir.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256(
            stdout_text.encode("utf-8", errors="replace")
        ).hexdigest()[:12]
        path = cache_dir / f"stdout-{digest}.txt"
        from tools.spill_safety import write_text_exclusive

        write_text_exclusive(path, stdout_text, private=False, overwrite=True)
        return str(path)
    except Exception as exc:  # noqa: BLE001
        logger.debug("Failed to spill execute_code stdout: %s", exc)
        return None

# Environment variable scrubbing rules (shared between the local + remote
# backends).  Secret-substring block is applied first; anything left must
# match a safe prefix, the operational HERMES_ allowlist, or (on Windows) an
# OS-essential name.  Delegate-task child context is also an exact-name
# operational marker: without it, a sandbox script that spawns/imports Hermes
# code can lose the DB-layer Kanban mutation guard while still inheriting
# HERMES_HOME.
#
# NB: the broad "HERMES_" prefix was deliberately removed (#27303) — it leaked
# HERMES_*-named config that lacks a secret substring (e.g. HERMES_BASE_URL,
# HERMES_KANBAN_DB, HERMES_*_WEBHOOK).  The child only needs the few
# location/profile vars in _HERMES_CHILD_ALLOWED below; HERMES_RPC_SOCKET /
# HERMES_RPC_DIR / TZ / HOME are injected explicitly after scrubbing.
_SAFE_ENV_PREFIXES = ("PATH", "HOME", "USER", "LANG", "LC_", "TERM",
                      "TMPDIR", "TMP", "TEMP", "SHELL", "LOGNAME",
                      "XDG_", "PYTHONPATH", "VIRTUAL_ENV", "CONDA")
_SECRET_SUBSTRINGS = ("KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL",
                      "PASSWD", "AUTH", "DSN", "WEBHOOK",
                      # Abbreviations that appear in real-world credential
                      # variable names but were previously undetected:
                      # CREDS (CREDENTIALS abbreviated), BEARER
                      # (Authorization: Bearer tokens), APIKEY (written
                      # without an underscore). "PASS" is intentionally NOT
                      # added — it false-positives on legitimate non-secret
                      # vars (BYPASS_CACHE, COMPASS_DIR, PASSENGER_HOST) while
                      # PASSWORD/PASSWD already cover the credential cases.
                      "CREDS", "BEARER", "APIKEY")

# Operational HERMES_* vars the child legitimately needs by exact name — these
# are non-secret runtime-location flags (the same set hermes_cli treats as the
# runtime location) that repo-root modules a sandbox script imports may read at
# import time.  None match _SECRET_SUBSTRINGS.
_HERMES_CHILD_ALLOWED = frozenset({
    "HERMES_HOME",
    "HERMES_PROFILE",
    "HERMES_CONFIG",
    "HERMES_ENV",
    "HERMES_DELEGATED_CHILD_CONTEXT",
})

# Windows-only: a handful of variables are required by the OS/CRT itself.
# Without them, even stdlib calls like ``socket.socket()`` fail with
# WinError 10106 (Winsock can't locate mswsock.dll) and ``subprocess``
# can't resolve cmd.exe.  These are well-known OS paths, not secrets, so
# we allow them through by exact name.  The _SECRET_SUBSTRINGS block
# still runs as a safety net (none of these names match those substrings).
_WINDOWS_ESSENTIAL_ENV_VARS = frozenset({
    "SYSTEMROOT",       # %SYSTEMROOT%\System32 — Winsock needs this
    "SYSTEMDRIVE",      # C: (or wherever Windows lives)
    "WINDIR",           # usually same as SYSTEMROOT
    "COMSPEC",          # cmd.exe path — subprocess shell=True needs it
    "PATHEXT",          # .COM;.EXE;.BAT;... — shell lookup
    "OS",               # "Windows_NT" — some tools gate on this
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
    "PUBLIC",           # C:\Users\Public
    "ALLUSERSPROFILE",  # C:\ProgramData — some stdlib paths use it
    "PROGRAMDATA",      # C:\ProgramData
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "APPDATA",          # %USERPROFILE%\AppData\Roaming — Python uses it
    "LOCALAPPDATA",     # %USERPROFILE%\AppData\Local
    "USERPROFILE",      # C:\Users\<name> — Python's expanduser uses it
    "USERDOMAIN",
    "USERNAME",
    "HOMEDRIVE",        # C:
    "HOMEPATH",         # \Users\<name>
    "COMPUTERNAME",
})


def _scrub_child_env(source_env, is_passthrough=None, is_windows=None):
    """Produce the scrubbed child-process env for execute_code.

    Rules (order matters):
      1. Passthrough vars (skill- or config-declared) pass through the active
         profile secret scope; an absent scoped value is omitted and an
         unscoped multiplex read fails closed.
      2. Secret-substring names (KEY/TOKEN/DSN/WEBHOOK/etc.) are blocked.
      3. Names matching a safe prefix pass.
      4. Operational HERMES_* vars (_HERMES_CHILD_ALLOWED) pass by exact name.
      5. On Windows, a small OS-essential allowlist passes by exact name
         — without these the child can't even create a socket or spawn a
         subprocess.

    Extracted into a helper so tests can exercise the logic without
    spawning a subprocess.
    """
    resolve_passthrough_value = None
    if is_passthrough is None:
        try:
            from tools.env_passthrough import (
                is_env_passthrough as _ep,
                resolve_passthrough_value,
            )
        except Exception:
            _ep = lambda _: False  # noqa: E731
            resolve_passthrough_value = lambda _name, _fallback: None  # noqa: E731
        is_passthrough = _ep
    else:
        try:
            from tools.env_passthrough import resolve_passthrough_value
        except Exception:
            resolve_passthrough_value = lambda _name, _fallback: None  # noqa: E731
    if is_windows is None:
        is_windows = _IS_WINDOWS

    scrubbed = {}
    # Non-secret HERMES_* vars dropped by the tightened allowlist (#27303). The
    # broad "HERMES_" prefix used to pass these through; now only the
    # operational set does. The drop is intentional (those vars can carry
    # config like HERMES_KANBAN_DB / HERMES_BASE_URL), but a sandbox script
    # that imports a repo module reading one at import time would otherwise see
    # it silently unset. Surface the drop once so the behavior change is
    # diagnosable and points at the env_passthrough opt-in escape hatch.
    _dropped_hermes = []
    for k, v in source_env.items():
        if is_passthrough(k):
            resolved = resolve_passthrough_value(k, v)
            if resolved is not None:
                scrubbed[k] = resolved
            continue
        if any(s in k.upper() for s in _SECRET_SUBSTRINGS):
            continue
        if any(k.startswith(p) for p in _SAFE_ENV_PREFIXES):
            scrubbed[k] = v
            continue
        if k in _HERMES_CHILD_ALLOWED:
            scrubbed[k] = v
            continue
        if is_windows and k.upper() in _WINDOWS_ESSENTIAL_ENV_VARS:
            scrubbed[k] = v
            continue
        if k.startswith("HERMES_"):
            # Non-secret (secrets were already dropped above) and not in any
            # allowlist — a deliberately-dropped HERMES_* var.
            _dropped_hermes.append(k)
    if _dropped_hermes:
        logger.debug(
            "execute_code: dropped %d non-allowlisted HERMES_* var(s) from the "
            "sandbox child env (%s). This is intentional hardening (#27303); if "
            "a sandbox script legitimately needs one, declare it via "
            "env_passthrough in the skill/config so it passes by explicit opt-in.",
            len(_dropped_hermes),
            ", ".join(sorted(_dropped_hermes)),
        )

    # delegate_task children are marked with a ContextVar, not os.environ, while
    # the execute_code sandbox crosses a process boundary. Bridge that context
    # into the child env and strip dispatcher-owned Kanban variables after the
    # normal secret/passthrough scrub so an explicit passthrough cannot re-grant
    # a delegated child the parent's board mutation capability.
    try:
        from agent.delegation_context import (
            is_delegated_child_process_context,
            scrub_kanban_env,
        )

        if is_delegated_child_process_context():
            scrubbed = scrub_kanban_env(scrubbed)
    except Exception:
        pass
    return scrubbed


def check_sandbox_requirements() -> bool:
    """Code execution sandbox requires a POSIX OS for Unix domain sockets."""
    if not SANDBOX_AVAILABLE:
        return False

    try:
        from tools.terminal_tool import (
            _check_vercel_sandbox_requirements,
            _get_env_config,
        )

        config = _get_env_config()
    except Exception:
        logger.debug("Could not resolve terminal config for execute_code availability", exc_info=True)
        return False

    if config.get("env_type") == "vercel_sandbox":
        return _check_vercel_sandbox_requirements(config)

    return True


# ---------------------------------------------------------------------------
# hermes_tools.py code generator
# ---------------------------------------------------------------------------

# Per-tool stub templates: (function_name, signature, docstring, args_dict_expr)
# The args_dict_expr builds the JSON payload sent over the RPC socket.
_TOOL_STUBS = {
    "web_search": (
        "web_search",
        "query: str, limit: int = 5",
        '"""Search the web. Returns dict with data.web list of {url, title, description}."""',
        '{"query": query, "limit": limit}',
    ),
    "web_extract": (
        "web_extract",
        "urls: list, char_limit: int = None",
        '"""Extract content from URLs (no LLM summarization). Returns dict with results list of {url, title, content, error}. Pages over char_limit (default 15000) are head+tail truncated with the full text stored on disk; the content footer gives the path. content is markdown."""',
        '{"urls": urls, "char_limit": char_limit}',
    ),
    "read_file": (
        "read_file",
        "path: str, offset: int = 1, limit: int = 2000",
        '"""Read a file (1-indexed lines). Returns dict with "content" and "total_lines"."""',
        '{"path": path, "offset": offset, "limit": limit}',
    ),
    "write_file": (
        "write_file",
        "path: str, content: str, cross_profile: bool = False",
        '"""Write content to a file (always overwrites). Returns dict with status."""',
        '{"path": path, "content": content, "cross_profile": cross_profile}',
    ),
    "search_files": (
        "search_files",
        'pattern: str, target: str = "content", path: str = ".", file_glob: str = None, limit: int = 50, offset: int = 0, output_mode: str = "content", context: int = 0',
        '"""Search file contents (target="content") or find files by name (target="files"). Returns dict with "matches"."""',
        '{"pattern": pattern, "target": target, "path": path, "file_glob": file_glob, "limit": limit, "offset": offset, "output_mode": output_mode, "context": context}',
    ),
    "patch": (
        "patch",
        'path: str = None, old_string: str = None, new_string: str = None, replace_all: bool = False, mode: str = "replace", patch: str = None, cross_profile: bool = False',
        '"""Targeted find-and-replace (mode="replace") or V4A multi-file patches (mode="patch"). Returns dict with status."""',
        '{"path": path, "old_string": old_string, "new_string": new_string, "replace_all": replace_all, "mode": mode, "patch": patch, "cross_profile": cross_profile}',
    ),
    "terminal": (
        "terminal",
        "command: str, timeout: int = None, workdir: str = None",
        '"""Run a shell command (foreground only). Returns dict with "output" and "exit_code"."""',
        '{"command": command, "timeout": timeout, "workdir": workdir}',
    ),
}


def _sandbox_failure_hint(stderr_text: str, enabled_tools=None) -> Optional[str]:
    """Map well-known sandbox script failures to one actionable recovery hint.

    Production mining (state.db): the top execute_code failure classes are
    hermes_tools import misuse (importing tools that aren't in the sandbox,
    23x in one window), calling the built-in helpers via import, treating
    tool results as strings instead of dicts, and importing third-party
    packages that don't exist in the sandbox interpreter. Bounded scan,
    first match wins, never raises.
    """
    if not stderr_text:
        return None
    window = stderr_text[:4000]
    try:
        m = re.search(
            r"cannot import name '(\w+)' from 'hermes_tools'", window
        )
        if m:
            missing = m.group(1)
            available = sorted(SANDBOX_ALLOWED_TOOLS & set(enabled_tools or SANDBOX_ALLOWED_TOOLS))
            builtin = {"json_parse", "shell_quote", "retry"}
            if missing in builtin:
                return (
                    f"{missing} is a BUILT-IN helper in the sandbox — no import "
                    f"needed. Remove it from the import line and call {missing}(...) directly."
                )
            return (
                f"'{missing}' is not available inside the execute_code sandbox. "
                f"Importable tools here: {', '.join(available)}. For anything "
                "else, use the normal tool call instead of execute_code."
            )
        m = re.search(r"NameError: name '(json_parse|shell_quote|retry)' is not defined", window)
        if m:
            return (
                f"{m.group(1)} is built into the generated sandbox module — "
                "call it directly at module scope without importing it."
            )
        m = re.search(r"ModuleNotFoundError: No module named '([\w.]+)'", window)
        if m:
            return (
                f"'{m.group(1)}' is not installed in the sandbox interpreter. "
                "Use Python stdlib inside execute_code, or run the code via "
                "terminal() with the project venv's python instead."
            )
        if re.search(r"TypeError: string indices must be integers|AttributeError: 'str' object has no attribute 'get'", window):
            return (
                "Tool functions in the sandbox return DICTS (already parsed) — "
                "do not json.loads() them or index them like strings. "
                "Example: read_file(path)['content']."
            )
    except Exception:
        return None
    return None


def generate_hermes_tools_module(enabled_tools: List[str],
                                 transport: str = "uds") -> str:
    """
    Build the source code for the hermes_tools.py stub module.

    Only tools in both SANDBOX_ALLOWED_TOOLS and enabled_tools get stubs.

    Args:
        enabled_tools: Tool names enabled in the current session.
        transport: ``"uds"`` for Unix domain socket (local backend) or
                   ``"file"`` for file-based RPC (remote backends).
    """
    tools_to_generate = sorted(SANDBOX_ALLOWED_TOOLS & set(enabled_tools))

    stub_functions = []
    export_names = []
    for tool_name in tools_to_generate:
        if tool_name not in _TOOL_STUBS:
            continue
        func_name, sig, doc, args_expr = _TOOL_STUBS[tool_name]
        stub_functions.append(
            f"def {func_name}({sig}):\n"
            f"    {doc}\n"
            f"    return _call({func_name!r}, {args_expr})\n"
        )
        export_names.append(func_name)

    if transport == "file":
        header = _FILE_TRANSPORT_HEADER
    else:
        header = _UDS_TRANSPORT_HEADER

    return header + "\n".join(stub_functions)


# ---- Shared helpers section (embedded in both transport headers) ----------

_COMMON_HELPERS = '''\

# ---------------------------------------------------------------------------
# Convenience helpers (avoid common scripting pitfalls)
# ---------------------------------------------------------------------------

def json_parse(text: str):
    """Parse JSON tolerant of control characters and UTF-8 BOM (strict=False).
    Use this instead of json.loads() when parsing output from terminal()
    or web_extract() that may contain raw tabs/newlines in strings,
    or from tools/files that prepend a UTF-8 BOM (salvage #57870, credit @woxinwuhen713-bit)."""
    if isinstance(text, str) and text.startswith("﻿"):
        text = text[1:]
    return json.loads(text, strict=False)


def shell_quote(s: str) -> str:
    """Shell-escape a string for safe interpolation into commands.
    Use this when inserting dynamic content into terminal() commands:
        terminal(f"echo {shell_quote(user_input)}")
    """
    return shlex.quote(s)


def retry(fn, max_attempts=3, delay=2):
    """Retry a function up to max_attempts times with exponential backoff.
    Use for transient failures (network errors, API rate limits):
        result = retry(lambda: terminal("gh issue list ..."))
    """
    last_err = None
    for attempt in range(max_attempts):
        try:
            return fn()
        except Exception as e:
            last_err = e
            if attempt < max_attempts - 1:
                time.sleep(delay * (2 ** attempt))
    raise last_err

'''

# ---- UDS transport (local backend) ---------------------------------------

_UDS_TRANSPORT_HEADER = '''\
"""Auto-generated Hermes tools RPC stubs."""
import json, os, socket, shlex, time
''' + _COMMON_HELPERS + '''\

def _connect():
    """Connect to the parent's RPC server via the transport it picked.

    HERMES_RPC_SOCKET can be either:
      - a filesystem path (POSIX Unix domain socket — the default on
        Linux and macOS)
      - a string of the form ``tcp://127.0.0.1:<port>`` (Windows, where
        AF_UNIX is unreliable — the parent falls back to loopback TCP)
    """
    # One connection per call is the correlation primitive.  It lets calls
    # from ThreadPoolExecutor overlap without a shared recv race or a custom
    # request-id multiplexer, and the connect overhead is negligible beside
    # an actual tool/network call.
    endpoint = os.environ["HERMES_RPC_SOCKET"]
    if endpoint.startswith("tcp://"):
        # tcp://host:port  (host is always 127.0.0.1 in practice — we
        # only bind loopback server-side)
        _host_port = endpoint[len("tcp://"):]
        _host, _, _port = _host_port.rpartition(":")
        conn = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        conn.settimeout(300)
        conn.connect((_host or "127.0.0.1", int(_port)))
    else:
        conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        conn.settimeout(300)
        conn.connect(endpoint)
    return conn

def _call(tool_name, args):
    """Send a tool call to the parent process and return the parsed result."""
    request = json.dumps({
        "tool": tool_name,
        "args": args,
        "token": os.environ.get("HERMES_RPC_TOKEN", ""),
    }) + "\\n"
    # One connection per call is the correlation primitive: read-only calls
    # can overlap without a shared recv race or a request-id multiplexer.
    # Session kernels can legitimately be between accepts after a long idle;
    # retry one fresh connection in that persistent-kernel case.
    _attempts = 2 if os.environ.get("HERMES_RPC_PERSISTENT") == "1" else 1
    for _attempt in range(_attempts):
        try:
            conn = _connect()
            try:
                conn.sendall(request.encode())
                buf = b""
                while True:
                    chunk = conn.recv(65536)
                    if not chunk:
                        raise RuntimeError("Agent process disconnected")
                    buf += chunk
                    if buf.endswith(b"\\n"):
                        break
            finally:
                conn.close()
            break
        except (OSError, RuntimeError):
            if _attempt + 1 >= _attempts:
                raise
    raw = buf.decode().strip()
    result = json.loads(raw)
    if isinstance(result, str):
        try:
            return json.loads(result)
        except (json.JSONDecodeError, TypeError):
            return result
    return result

'''

# ---- File-based transport (remote backends) -------------------------------

_FILE_TRANSPORT_HEADER = '''\
"""Auto-generated Hermes tools RPC stubs (file-based transport)."""
import json, os, shlex, tempfile, threading, time

_RPC_DIR = os.environ.get("HERMES_RPC_DIR") or os.path.join(tempfile.gettempdir(), "hermes_rpc")
_seq = 0
# `_seq += 1` is not atomic (read-modify-write), so concurrent _call()
# invocations from multiple threads could allocate the same sequence number
# and clobber each other's request files. Guard seq allocation with a lock.
_seq_lock = threading.Lock()
''' + _COMMON_HELPERS + '''\

def _call(tool_name, args):
    """Send a tool call request via file-based RPC and wait for response."""
    global _seq
    with _seq_lock:
        _seq += 1
        seq = _seq
    seq_str = f"{seq:06d}"
    req_file = os.path.join(_RPC_DIR, f"req_{seq_str}")
    res_file = os.path.join(_RPC_DIR, f"res_{seq_str}")

    # Write request atomically (write to .tmp, then rename).
    # encoding="utf-8" is critical: on Windows-hosted remote backends
    # (or any non-UTF-8 locale) the default open() mode would mangle
    # non-ASCII chars in tool args when encoding them as JSON.
    tmp = req_file + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({
            "tool": tool_name,
            "args": args,
            "seq": seq,
            "token": os.environ.get("HERMES_RPC_TOKEN", ""),
        }, f)
    os.rename(tmp, req_file)

    # Wait for response with adaptive polling
    deadline = time.monotonic() + 300  # 5-minute timeout per tool call
    poll_interval = 0.05  # Start at 50ms
    while not os.path.exists(res_file):
        if time.monotonic() > deadline:
            raise RuntimeError(f"RPC timeout: no response for {tool_name} after 300s")
        time.sleep(poll_interval)
        poll_interval = min(poll_interval * 1.2, 0.25)  # Back off to 250ms

    with open(res_file, encoding="utf-8") as f:
        raw = f.read()

    # Clean up response file
    try:
        os.unlink(res_file)
    except OSError:
        pass

    result = json.loads(raw)
    if isinstance(result, str):
        try:
            return json.loads(result)
        except (json.JSONDecodeError, TypeError):
            return result
    return result

'''


# ---------------------------------------------------------------------------
# RPC server (runs in a thread inside the parent process)
# ---------------------------------------------------------------------------

# Terminal parameters that must not be used from ephemeral sandbox scripts
_TERMINAL_BLOCKED_PARAMS = {"background", "pty", "notify", "notify_on_complete", "watch_patterns"}

# Read-only/network tools may overlap. Mutating or stateful tools use an
# exclusive lane and gate against readers, so PTC concurrency cannot race a
# shared terminal environment or observe a write/patch half-applied.
_PARALLEL_RPC_TOOLS = frozenset({
    "web_search",
    "web_extract",
    "read_file",
    "search_files",
})
_RPC_FIRST_REQUEST_TIMEOUT = 2.0
_MAX_RPC_REQUEST_BYTES = 1_000_000


def _resolve_max_parallel_tool_calls(config: dict, max_tool_calls: int) -> int:
    """Return the bounded per-execution RPC worker count."""
    raw = config.get("max_parallel_tool_calls", DEFAULT_MAX_PARALLEL_TOOL_CALLS)
    try:
        value = int(raw)
    except (TypeError, ValueError):
        value = DEFAULT_MAX_PARALLEL_TOOL_CALLS
    return max(1, min(value, max(1, int(max_tool_calls)), MAX_PARALLEL_TOOL_CALLS))


class _RpcDispatchState:
    """Execution-local, lock-protected admission budget and metrics."""

    def __init__(
        self,
        *,
        tool_call_counter: list,
        tool_call_log: list,
        max_tool_calls: int,
        max_parallel_tool_calls: int,
        stop_event: threading.Event,
    ) -> None:
        self._counter = tool_call_counter
        self._log = tool_call_log
        self._max_tool_calls = max_tool_calls
        self._stop_event = stop_event
        self._lock = threading.Lock()
        self._slots = threading.BoundedSemaphore(max_parallel_tool_calls)
        self._active_worker_tids: set[int] = set()

    def acquire_slot(self) -> bool:
        """Wait cooperatively for one execution-wide concurrency slot."""
        while not self._stop_event.is_set():
            if self._slots.acquire(timeout=0.1):
                return True
        return False

    def release_slot(self) -> None:
        self._slots.release()

    def mark_worker_active(self) -> int:
        tid = threading.current_thread().ident
        with self._lock:
            self._active_worker_tids.add(tid)
        return tid

    def mark_worker_done(self, tid: int) -> None:
        with self._lock:
            self._active_worker_tids.discard(tid)
        try:
            from tools.interrupt import set_interrupt

            set_interrupt(False, tid)
        except Exception:
            pass

    def interrupt_active_workers(self) -> None:
        """Signal cooperative tool handlers when the outer script stops."""
        with self._lock:
            tids = list(self._active_worker_tids)
        try:
            from tools.interrupt import set_interrupt

            for tid in tids:
                set_interrupt(True, tid)
        except Exception:
            logger.debug("Could not interrupt sandbox RPC workers", exc_info=True)

    def reserve(self) -> Optional[str]:
        """Atomically admit one real dispatch, or return a tool error."""
        with self._lock:
            if self._stop_event.is_set():
                return tool_error("Execution interrupted")
            if self._counter[0] >= self._max_tool_calls:
                return tool_error(
                    f"Tool call limit reached ({self._max_tool_calls}). "
                    "No more tool calls allowed in this execution."
                )
            # Reserve before dispatch.  Incrementing after completion lets a
            # concurrent burst overshoot the budget before any worker returns.
            self._counter[0] += 1
        return None

    def record(self, tool_name: str, duration: float) -> None:
        # Arguments are intentionally not persisted here.  They can contain
        # credentials in terminal commands/URLs and this log is not needed for
        # result delivery or the live presentation bridge.
        with self._lock:
            self._log.append({
                "tool": tool_name,
                "duration": round(duration, 2),
            })


class _RpcReadWriteGate:
    """Exclude stateful RPC calls from read-only calls without serializing reads.

    Sandboxed code can issue RPCs concurrently.  A terminal command, patch, or
    write_file call must have a coherent view of the same workspace as a
    concurrent read_file call: neither may run while the other is active.
    Read-only calls remain concurrent with each other.  Once a writer has
    arrived, later readers wait behind it so a stream of reads cannot starve a
    pending mutation (and, importantly, cannot observe its half-applied state).
    """

    def __init__(self, stop_event: threading.Event) -> None:
        self._stop_event = stop_event
        self._condition = threading.Condition()
        self._active_readers = 0
        self._writer_active = False
        self._waiting_writers = 0

    def acquire(self, *, read_only: bool) -> bool:
        """Acquire the shared-read or exclusive-write side cooperatively."""
        with self._condition:
            if read_only:
                while (
                    (self._writer_active or self._waiting_writers)
                    and not self._stop_event.is_set()
                ):
                    self._condition.wait(timeout=0.05)
                if self._stop_event.is_set():
                    return False
                self._active_readers += 1
                return True

            self._waiting_writers += 1
            try:
                while (
                    (self._writer_active or self._active_readers)
                    and not self._stop_event.is_set()
                ):
                    self._condition.wait(timeout=0.05)
                if self._stop_event.is_set():
                    return False
                self._writer_active = True
                return True
            finally:
                self._waiting_writers -= 1

    def release(self, *, read_only: bool) -> None:
        with self._condition:
            if read_only:
                self._active_readers -= 1
            else:
                self._writer_active = False
            self._condition.notify_all()

    def wake_all(self) -> None:
        """Wake waiting workers promptly when their enclosing cell stops."""
        with self._condition:
            self._condition.notify_all()


def _validate_rpc_request(
    request: Any,
    *,
    rpc_token: str,
    allowed_tools: frozenset,
) -> Tuple[Optional[str], Any, Optional[str]]:
    """Authenticate and normalize one sandbox RPC request."""
    if not isinstance(request, dict):
        return None, None, tool_error("Invalid RPC request: expected an object")
    if not rpc_token or not secrets.compare_digest(
        # Compare bytes: compare_digest rejects a non-ASCII str, while the
        # request is untrusted sandbox JSON.
        str(request.get("token") or "").encode(), rpc_token.encode()
    ):
        return None, None, tool_error("Unauthorized RPC request")

    tool_name = request.get("tool", "")
    tool_args = request.get("args", {})
    if tool_name not in allowed_tools:
        available = ", ".join(sorted(allowed_tools))
        return None, None, tool_error(
            f"Tool '{tool_name}' is not available in execute_code. "
            f"Available: {available}"
        )
    if tool_name == "terminal" and isinstance(tool_args, dict):
        tool_args = dict(tool_args)
        for param in _TERMINAL_BLOCKED_PARAMS:
            tool_args.pop(param, None)
    return tool_name, tool_args, None


def _dispatch_rpc_request(
    tool_name: str,
    tool_args: Any,
    *,
    task_id: str,
    state: _RpcDispatchState,
    remote: bool = False,
    dispatch=None,
    read_write_gate: Optional[_RpcReadWriteGate] = None,
) -> str:
    """Run one admitted sandbox tool call on an RPC worker."""
    read_only = tool_name in _PARALLEL_RPC_TOOLS
    if read_write_gate is not None and not read_write_gate.acquire(
        read_only=read_only
    ):
        return tool_error("Execution interrupted")
    if not state.acquire_slot():
        if read_write_gate is not None:
            read_write_gate.release(read_only=read_only)
        return tool_error("Execution interrupted")
    worker_tid = state.mark_worker_active()
    try:
        admission_error = state.reserve()
        if admission_error is not None:
            return admission_error

        from tools.nested_tool_presentation import current_nested_tool_presentation

        call_start = time.monotonic()
        # Persistent kernels re-enter the current cell's authority inside
        # `dispatch`.  That authority owns the presentation ContextVar too,
        # so it emits the lifecycle itself to avoid entering one Context from
        # multiple workers. Per-call and remote transports already inherited
        # the calling context and present here.
        presentation = current_nested_tool_presentation() if dispatch is None else None
        presentation_call_id = (
            presentation.start(tool_name, tool_args)
            if presentation is not None
            else None
        )
        dispatch_failed = False
        result = None
        try:
            with thread_scoped_silence():
                if dispatch is None:
                    from model_tools import handle_function_call

                    result = handle_function_call(tool_name, tool_args, task_id=task_id)
                else:
                    result = dispatch(tool_name, tool_args)
        except Exception as exc:
            dispatch_failed = True
            location = "remote sandbox" if remote else "sandbox"
            logger.error("Tool call failed in %s: %s", location, exc, exc_info=True)
            result = tool_error(str(exc))
        finally:
            if presentation is not None:
                presentation.finish(
                    presentation_call_id,
                    result,
                    force_error=dispatch_failed,
                )
            state.record(tool_name, time.monotonic() - call_start)
        return result
    finally:
        state.mark_worker_done(worker_tid)
        state.release_slot()
        if read_write_gate is not None:
            read_write_gate.release(read_only=read_only)


def _recv_local_rpc_request(conn: socket.socket) -> Tuple[Optional[dict], Optional[str]]:
    """Read exactly one bounded newline-delimited request from *conn*."""
    conn.settimeout(_RPC_FIRST_REQUEST_TIMEOUT)
    buf = b""
    while b"\n" not in buf:
        try:
            chunk = conn.recv(65536)
        except socket.timeout:
            return None, tool_error("RPC request timed out")
        if not chunk:
            return None, tool_error("Invalid RPC request: connection closed")
        buf += chunk
        if len(buf) > _MAX_RPC_REQUEST_BYTES:
            return None, tool_error("Invalid RPC request: payload too large")
    line, _remainder = buf.split(b"\n", 1)
    try:
        request = json.loads(line.decode())
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        return None, tool_error(f"Invalid RPC request: {exc}")
    return request, None


def _send_local_rpc_response(conn: socket.socket, result: str) -> None:
    """Best-effort response send; connection close is the frame boundary."""
    try:
        conn.settimeout(300)
        conn.sendall((result + "\n").encode())
    except OSError:
        logger.debug("Sandbox RPC client disconnected before response", exc_info=True)
    finally:
        try:
            conn.close()
        except OSError:
            pass


def _serve_local_rpc_connection(
    conn: socket.socket,
    tool_name: str,
    tool_args: Any,
    *,
    task_id: str,
    state: _RpcDispatchState,
    dispatch=None,
    read_write_gate: Optional[_RpcReadWriteGate] = None,
) -> None:
    result = _dispatch_rpc_request(
        tool_name,
        tool_args,
        task_id=task_id,
        state=state,
        dispatch=dispatch,
        read_write_gate=read_write_gate,
    )
    _send_local_rpc_response(conn, result)


def _rpc_server_loop(
    server_sock: socket.socket,
    task_id: str,
    tool_call_log: list,
    tool_call_counter: list,   # mutable [int] so the thread can increment
    max_tool_calls: int,
    allowed_tools: frozenset,
    stop_event: threading.Event,
    rpc_token: str,
    max_parallel_tool_calls: int = DEFAULT_MAX_PARALLEL_TOOL_CALLS,
    dispatch=None,
):
    """Accept per-call connections and dispatch them on bounded workers.

    ``dispatch`` is supplied only by a persistent session kernel. It rebinds
    a request to the current cell's authority; this listener deliberately
    never captures a cell context for its whole lifetime.
    """
    from tools.daemon_pool import DaemonThreadPoolExecutor

    parallel_workers = max(
        1,
        min(max_parallel_tool_calls, max_tool_calls, MAX_PARALLEL_TOOL_CALLS),
    )
    parallel_executor = DaemonThreadPoolExecutor(
        max_workers=parallel_workers,
        thread_name_prefix="hermes-rpc-read",
    )
    serial_executor = DaemonThreadPoolExecutor(
        max_workers=1,
        thread_name_prefix="hermes-rpc-write",
    )
    state = _RpcDispatchState(
        tool_call_counter=tool_call_counter,
        tool_call_log=tool_call_log,
        max_tool_calls=max_tool_calls,
        max_parallel_tool_calls=parallel_workers,
        stop_event=stop_event,
    )
    read_write_gate = _RpcReadWriteGate(stop_event)
    active_lock = threading.Lock()
    active_connections: set[socket.socket] = set()
    active_futures = set()

    def _forget(future, conn):
        with active_lock:
            active_futures.discard(future)
            active_connections.discard(conn)
    try:
        server_sock.settimeout(0.05)
        while not stop_event.is_set():
            try:
                conn, _ = server_sock.accept()
            except socket.timeout:
                continue
            except OSError as exc:
                if not stop_event.is_set():
                    logger.debug("RPC listener socket error: %s", exc, exc_info=True)
                break

            with active_lock:
                active_connections.add(conn)
            request, read_error = _recv_local_rpc_request(conn)
            if read_error is not None:
                _send_local_rpc_response(conn, read_error)
                with active_lock:
                    active_connections.discard(conn)
                continue

            tool_name, tool_args, validation_error = _validate_rpc_request(
                request,
                rpc_token=rpc_token,
                allowed_tools=allowed_tools,
            )
            if validation_error is not None:
                _send_local_rpc_response(conn, validation_error)
                with active_lock:
                    active_connections.discard(conn)
                continue

            executor = (
                parallel_executor
                if tool_name in _PARALLEL_RPC_TOOLS
                else serial_executor
            )
            try:
                future = executor.submit(
                    # Capture a fresh Context for every worker. Each worker
                    # gets its own wrapper; a Context cannot be entered by
                    # two threads at once. Persistent kernels rebind their
                    # own CellAuthority inside `dispatch`.
                    propagate_context_to_thread(_serve_local_rpc_connection),
                    conn,
                    tool_name,
                    tool_args,
                    task_id=task_id,
                    state=state,
                    dispatch=dispatch,
                    read_write_gate=read_write_gate,
                )
            except RuntimeError as exc:
                _send_local_rpc_response(conn, tool_error(str(exc)))
                with active_lock:
                    active_connections.discard(conn)
                continue
            with active_lock:
                active_futures.add(future)
            future.add_done_callback(lambda done, c=conn: _forget(done, c))
    finally:
        stop_event.set()
        read_write_gate.wake_all()
        state.interrupt_active_workers()
        with active_lock:
            connections = list(active_connections)
            futures = list(active_futures)
        for future in futures:
            future.cancel()
        for conn in connections:
            try:
                conn.close()
            except OSError:
                pass
        parallel_executor.shutdown(wait=False, cancel_futures=True)
        serial_executor.shutdown(wait=False, cancel_futures=True)


# ---------------------------------------------------------------------------
# Remote execution support (file-based RPC via terminal backend)
# ---------------------------------------------------------------------------

def _get_or_create_env(task_id: str):
    """Get or create the terminal environment for *task_id*.

    Reuses the same environment (container/sandbox/SSH session) that the
    terminal and file tools use, creating one if it doesn't exist yet.
    Returns ``(env, env_type)`` tuple.
    """
    from tools.terminal_tool import (
        _active_environments, _env_lock, _create_environment,
        _get_env_config, _last_activity, _start_cleanup_thread,
        _creation_locks, _creation_locks_lock, _task_env_overrides,
        _resolve_container_task_id, _resolve_task_host_cwd,
    )

    effective_task_id = _resolve_container_task_id(task_id)

    # Fast path: environment already exists
    with _env_lock:
        if effective_task_id in _active_environments:
            _last_activity[effective_task_id] = time.time()
            return _active_environments[effective_task_id], _get_env_config()["env_type"]

    # Slow path: create environment (same pattern as file_tools._get_file_ops)
    with _creation_locks_lock:
        if effective_task_id not in _creation_locks:
            _creation_locks[effective_task_id] = threading.Lock()
        task_lock = _creation_locks[effective_task_id]

    with task_lock:
        with _env_lock:
            if effective_task_id in _active_environments:
                _last_activity[effective_task_id] = time.time()
                return _active_environments[effective_task_id], _get_env_config()["env_type"]

        config = _get_env_config()
        env_type = config["env_type"]
        overrides = _task_env_overrides.get(effective_task_id, {})

        if env_type == "docker":
            image = overrides.get("docker_image") or config["docker_image"]
        elif env_type == "singularity":
            image = overrides.get("singularity_image") or config["singularity_image"]
        elif env_type == "modal":
            image = overrides.get("modal_image") or config["modal_image"]
        elif env_type == "daytona":
            image = overrides.get("daytona_image") or config["daytona_image"]
        else:
            image = ""

        cwd = overrides.get("cwd") or config["cwd"]

        container_config = None
        from tools.terminal_tool import _is_container_backend as _is_container

        if _is_container(env_type):
            container_config = {
                "container_cpu": config.get("container_cpu", 1),
                "container_memory": config.get("container_memory", 5120),
                "container_disk": config.get("container_disk", 51200),
                "container_persistent": config.get("container_persistent", True),
                "vercel_runtime": config.get("vercel_runtime", ""),
                "docker_volumes": config.get("docker_volumes", []),
                "docker_run_as_host_user": config.get("docker_run_as_host_user", False),
                "docker_network": config.get("docker_network", True),
            }

        ssh_config = None
        if env_type == "ssh":
            ssh_config = {
                "host": config.get("ssh_host", ""),
                "user": config.get("ssh_user", ""),
                "port": config.get("ssh_port", 22),
                "key": config.get("ssh_key", ""),
                "persistent": config.get("ssh_persistent", False),
            }

        local_config = None
        if env_type == "local":
            local_config = {
                "persistent": config.get("local_persistent", False),
            }

        logger.info("Creating new %s environment for execute_code task %s...",
                     env_type, effective_task_id[:8])
        env = _create_environment(
            env_type=env_type,
            image=image,
            cwd=cwd,
            timeout=config["timeout"],
            ssh_config=ssh_config,
            container_config=container_config,
            local_config=local_config,
            task_id=effective_task_id,
            host_cwd=_resolve_task_host_cwd(config, task_id),
        )

        with _env_lock:
            _active_environments[effective_task_id] = env
            _last_activity[effective_task_id] = time.time()

        _start_cleanup_thread()
        logger.info("%s environment ready for execute_code task %s",
                     env_type, effective_task_id[:8])
        return env, env_type


def _ship_file_to_remote(env, remote_path: str, content: str) -> None:
    """Write *content* to *remote_path* on the remote environment.

    Uses ``echo … | base64 -d`` rather than stdin piping because some
    backends (Modal) don't reliably deliver stdin_data to chained
    commands.  Base64 output is shell-safe ([A-Za-z0-9+/=]) so single
    quotes are fine.
    """
    encoded = base64.b64encode(content.encode("utf-8")).decode("ascii")
    quoted_remote_path = shlex.quote(remote_path)
    env.execute(
        f"echo '{encoded}' | base64 -d > {quoted_remote_path}",
        cwd="/",
        timeout=30,
    )


def _env_temp_dir(env: Any) -> str:
    """Return a writable temp dir for env-backed execute_code sandboxes."""
    get_temp_dir = getattr(env, "get_temp_dir", None)
    if callable(get_temp_dir):
        try:
            temp_dir = get_temp_dir()
            if isinstance(temp_dir, str) and temp_dir.startswith("/"):
                return temp_dir.rstrip("/") or "/"
        except Exception as exc:
            logger.debug("Could not resolve execute_code env temp dir: %s", exc)
    candidate = tempfile.gettempdir()
    if isinstance(candidate, str) and candidate.startswith("/"):
        return candidate.rstrip("/") or "/"
    return "/tmp"


def _rpc_poll_loop(
    env,
    rpc_dir: str,
    task_id: str,
    tool_call_log: list,
    tool_call_counter: list,
    max_tool_calls: int,
    allowed_tools: frozenset,
    stop_event: threading.Event,
    rpc_token: str,
    max_parallel_tool_calls: int = DEFAULT_MAX_PARALLEL_TOOL_CALLS,
):
    """Poll remote request files while dispatching tool work concurrently.

    Only ``handle_function_call`` runs on the new worker pool.  RPC request /
    response file operations remain serialized on this poller thread; the
    foreground remote script already runs through the backend's established
    concurrent command path.
    """
    from tools.daemon_pool import DaemonThreadPoolExecutor

    parallel_workers = max(
        1,
        min(max_parallel_tool_calls, max_tool_calls, MAX_PARALLEL_TOOL_CALLS),
    )
    parallel_executor = DaemonThreadPoolExecutor(
        max_workers=parallel_workers,
        thread_name_prefix="hermes-remote-rpc-read",
    )
    serial_executor = DaemonThreadPoolExecutor(
        max_workers=1,
        thread_name_prefix="hermes-remote-rpc-write",
    )
    state = _RpcDispatchState(
        tool_call_counter=tool_call_counter,
        tool_call_log=tool_call_log,
        max_tool_calls=max_tool_calls,
        max_parallel_tool_calls=parallel_workers,
        stop_event=stop_event,
    )
    read_write_gate = _RpcReadWriteGate(stop_event)
    poll_interval = 0.1  # 100 ms
    quoted_rpc_dir = shlex.quote(rpc_dir)
    # future -> (request path, quoted request path, quoted response path)
    pending: dict = {}
    # request path -> (quoted request path, quoted response path, result,
    #                  response already atomically committed)
    ready: dict = {}
    tracked_req_files: set[str] = set()
    settled_req_files: set[str] = set()

    def _queue_response(req_file, quoted_req_file, quoted_res_file, result):
        ready[req_file] = (quoted_req_file, quoted_res_file, result, False)
        tracked_req_files.add(req_file)

    def _remote_command_failed(result: Any) -> bool:
        if not isinstance(result, dict):
            return False
        returncode = result.get("returncode")
        if returncode is None:
            return False
        try:
            return int(returncode) != 0
        except (TypeError, ValueError):
            return True

    def _drain_completed() -> bool:
        did_work = False
        # Move completed dispatches onto the single-threaded response writer.
        for future, metadata in list(pending.items()):
            if not future.done():
                continue
            pending.pop(future, None)
            req_file, quoted_req_file, quoted_res_file = metadata
            try:
                tool_result = future.result()
            except Exception as exc:
                logger.error(
                    "Remote sandbox RPC worker failed: %s", exc, exc_info=True
                )
                tool_result = tool_error(str(exc))
            _queue_response(
                req_file,
                quoted_req_file,
                quoted_res_file,
                tool_result,
            )
            did_work = True
        return did_work

    def _flush_ready() -> bool:
        did_work = False
        # A write failure keeps the result in `ready`, so the original tool is
        # never dispatched twice merely because remote I/O failed transiently.
        for req_file, response in list(ready.items()):
            (
                quoted_req_file,
                quoted_res_file,
                tool_result,
                response_committed,
            ) = response
            try:
                if not response_committed:
                    encoded_result = base64.b64encode(
                        tool_result.encode("utf-8")
                    ).decode("ascii")
                    write_result = env.execute(
                        f"echo '{encoded_result}' | base64 -d > {quoted_res_file}.tmp"
                        f" && mv {quoted_res_file}.tmp {quoted_res_file}",
                        cwd="/",
                        timeout=60,
                    )
                    if _remote_command_failed(write_result):
                        raise RuntimeError("remote response write returned non-zero")
                    response_committed = True
                    ready[req_file] = (
                        quoted_req_file,
                        quoted_res_file,
                        tool_result,
                        True,
                    )
                remove_result = env.execute(
                    f"rm -f {quoted_req_file}", cwd="/", timeout=5
                )
                if _remote_command_failed(remove_result):
                    raise RuntimeError("remote request cleanup returned non-zero")
            except Exception as exc:
                if not stop_event.is_set():
                    logger.debug(
                        "Remote RPC response write failed for %s: %s",
                        req_file,
                        exc,
                        exc_info=True,
                    )
                continue
            ready.pop(req_file, None)
            tracked_req_files.discard(req_file)
            settled_req_files.add(req_file)
            did_work = True
        return did_work

    def _discover_requests() -> bool:
        did_work = False
        ls_result = env.execute(
            f"ls -1 {quoted_rpc_dir}/req_* 2>/dev/null || true",
            cwd="/",
            timeout=10,
        )
        output = ls_result.get("output", "").strip()
        req_files = sorted([
            value.strip()
            for value in output.split("\n")
            if value.strip()
            and not value.strip().endswith(".tmp")
            and "/req_" in value.strip()
            and value.strip() not in tracked_req_files
            and value.strip() not in settled_req_files
        ])

        for req_file in req_files:
            if stop_event.is_set():
                break
            quoted_req_file = shlex.quote(req_file)
            read_result = env.execute(
                f"cat {quoted_req_file}", cwd="/", timeout=10
            )
            if _remote_command_failed(read_result):
                raise RuntimeError(f"remote request read failed for {req_file}")
            try:
                request = json.loads(read_result.get("output", ""))
                seq = int(request.get("seq", 0))
                if seq <= 0:
                    raise ValueError("sequence must be positive")
                expected_req_file = f"{rpc_dir}/req_{seq:06d}"
                if req_file != expected_req_file:
                    raise ValueError("sequence does not match request filename")
            except (json.JSONDecodeError, TypeError, ValueError):
                logger.debug("Malformed RPC request in %s", req_file)
                env.execute(f"rm -f {quoted_req_file}", cwd="/", timeout=5)
                continue

            seq_str = f"{seq:06d}"
            quoted_res_file = shlex.quote(f"{rpc_dir}/res_{seq_str}")
            tool_name, tool_args, validation_error = _validate_rpc_request(
                request,
                rpc_token=rpc_token,
                allowed_tools=allowed_tools,
            )
            if validation_error is not None:
                _queue_response(
                    req_file,
                    quoted_req_file,
                    quoted_res_file,
                    validation_error,
                )
                did_work = True
                continue

            executor = (
                parallel_executor
                if tool_name in _PARALLEL_RPC_TOOLS
                else serial_executor
            )
            try:
                future = executor.submit(
                    propagate_context_to_thread(_dispatch_rpc_request),
                    tool_name,
                    tool_args,
                    task_id=task_id,
                    state=state,
                    remote=True,
                    read_write_gate=read_write_gate,
                )
            except RuntimeError as exc:
                _queue_response(
                    req_file,
                    quoted_req_file,
                    quoted_res_file,
                    tool_error(str(exc)),
                )
                continue
            pending[future] = (
                req_file,
                quoted_req_file,
                quoted_res_file,
            )
            tracked_req_files.add(req_file)
            did_work = True
        return did_work

    try:
        while not stop_event.is_set():
            did_work = False
            try:
                did_work |= _drain_completed()
                did_work |= _flush_ready()
                did_work |= _discover_requests()
            except Exception as exc:
                if not stop_event.is_set():
                    logger.debug("RPC poll error: %s", exc, exc_info=True)
            if not did_work and not stop_event.is_set():
                stop_event.wait(poll_interval)
    finally:
        read_write_gate.wake_all()
        state.interrupt_active_workers()
        for future in pending:
            future.cancel()
        parallel_executor.shutdown(wait=False, cancel_futures=True)
        serial_executor.shutdown(wait=False, cancel_futures=True)


def _format_interrupted_output(stdout_text: str) -> str:
    """Append an interruption marker without guessing who caused it."""
    from tools.interrupt import get_interrupt_reason

    reason = get_interrupt_reason()
    marker = (
        f"[execution interrupted — {reason}]"
        if reason
        else "[execution interrupted]"
    )
    return f"{stdout_text}\n{marker}" if stdout_text else marker


def _finish_remote_kernel_result(kernel_result: Dict[str, Any], *,
                                 timeout: int, exec_start: float) -> str:
    """Post-process a remote-kernel cell result into the tool's JSON reply.

    Same output pipeline as the per-call paths: truncation, ANSI strip,
    secret redaction; timeout messaging mirrors the local kernel contract
    (kernel killed, state lost, next call fresh).
    """
    from tools.ansi_strip import strip_ansi
    from agent.redact import redact_sensitive_text

    stdout_text = kernel_result.get("stdout", "") or ""
    stderr_text = kernel_result.get("stderr", "") or ""
    traceback_text = kernel_result.get("traceback", "") or ""
    if stderr_text or traceback_text:
        # Same joining shape as the local kernel path (code_kernel result
        # assembly): stderr and traceback ride in the output under one
        # marker so the model always sees the failure inline.
        stdout_text = (
            stdout_text + "\n--- stderr ---\n" + stderr_text + traceback_text
        )

    stdout_text, stdout_metadata = _truncate_stdout_text(stdout_text)
    stdout_text = strip_ansi(stdout_text)
    stdout_text = redact_sensitive_text(stdout_text, code_file=True)

    duration = round(time.monotonic() - exec_start, 2)
    result: Dict[str, Any] = {
        "status": kernel_result.get("status", "error"),
        "output": stdout_text,
        "tool_calls_made": kernel_result.get("tool_calls_made", 0),
        "duration_seconds": duration,
        "kernel": kernel_result.get("kernel", {"remote": True}),
    }
    result.update(stdout_metadata)

    if result["status"] == "timeout":
        timeout_msg = (
            f"Cell timed out after {timeout}s; the remote session kernel was "
            "killed and its state was lost. The next call starts fresh."
        )
        result["error"] = timeout_msg
        result["output"] = (
            (stdout_text + f"\n\n⏰ {timeout_msg}") if stdout_text
            else f"⏰ {timeout_msg}"
        )
    elif result["status"] == "error" and kernel_result.get("error"):
        result["error"] = kernel_result["error"]

    return json.dumps(result, ensure_ascii=False)


def _execute_remote(
    code: str,
    task_id: Optional[str],
    enabled_tools: Optional[List[str]],
    reset: bool = False,
) -> str:
    """Run code on the remote terminal backend.

    Preferred path: the owner's persistent remote session kernel
    (tools/code_kernel_remote.py — detached runner + file cell protocol).
    Fallback path: the original per-call script ship (kept both as the
    fail-open route when a kernel cannot be spawned and as the only route
    for hosts that cannot sustain a background process).
    """

    _cfg = _load_config()
    timeout = _cfg.get("timeout", DEFAULT_TIMEOUT)
    max_tool_calls = _cfg.get("max_tool_calls", DEFAULT_MAX_TOOL_CALLS)
    max_parallel_tool_calls = _resolve_max_parallel_tool_calls(
        _cfg, max_tool_calls
    )

    session_tools = set(enabled_tools) if enabled_tools else set()
    sandbox_tools = frozenset(SANDBOX_ALLOWED_TOOLS & session_tools)
    if not sandbox_tools:
        sandbox_tools = SANDBOX_ALLOWED_TOOLS

    effective_task_id = task_id or "default"
    env, env_type = _get_or_create_env(effective_task_id)

    sandbox_id = uuid.uuid4().hex[:12]
    temp_dir = _env_temp_dir(env)
    sandbox_dir = f"{temp_dir}/hermes_exec_{sandbox_id}"
    quoted_sandbox_dir = shlex.quote(sandbox_dir)
    quoted_rpc_dir = shlex.quote(f"{sandbox_dir}/rpc")

    tool_call_log: list = []
    tool_call_counter = [0]
    exec_start = time.monotonic()
    stop_event = threading.Event()
    rpc_thread = None

    try:
        # Verify Python is available on the remote
        py_check = env.execute(
            "command -v python3 >/dev/null 2>&1 && echo OK",
            cwd="/", timeout=15,
        )
        if "OK" not in py_check.get("output", ""):
            return json.dumps({
                "status": "error",
                "error": (
                    f"Python 3 is not available in the {env_type} terminal "
                    "environment. Install Python to use execute_code with "
                    "remote backends."
                ),
                "tool_calls_made": 0,
                "duration_seconds": 0,
            })

        # --- Session-kernel path (hermes-agent#96873) -------------------
        # Same always-on model as local: one persistent kernel per owner,
        # rebuilt on the run-to-completion transport (detached runner +
        # file cell protocol). Spawn failure falls OPEN to the per-call
        # path below so a degraded remote host never blocks execution.
        try:
            from tools.code_kernel_remote import execute_in_remote_kernel

            kernel_result = execute_in_remote_kernel(
                code,
                env=env,
                env_type=env_type,
                task_env_id=effective_task_id,
                sandbox_tools=frozenset(sandbox_tools),
                timeout=timeout,
                max_tool_calls=max_tool_calls,
                max_parallel_tool_calls=max_parallel_tool_calls,
                reset=bool(reset),
                idle_exit=int(_cfg.get("kernel_idle_timeout", 1800)),
            )
        except Exception:
            logger.warning(
                "remote session-kernel path failed; falling back to per-call",
                exc_info=True,
            )
            kernel_result = None

        if kernel_result is not None:
            return _finish_remote_kernel_result(
                kernel_result, timeout=timeout, exec_start=exec_start,
            )
        logger.info(
            "remote session kernel unavailable on %s; using per-call path",
            env_type,
        )

        # Create sandbox directory on remote
        env.execute(
            f"mkdir -p {quoted_rpc_dir}", cwd="/", timeout=10,
        )

        rpc_token = secrets.token_urlsafe(32)

        # Generate and ship files
        tools_src = generate_hermes_tools_module(
            list(sandbox_tools), transport="file",
        )
        _ship_file_to_remote(env, f"{sandbox_dir}/hermes_tools.py", tools_src)
        _ship_file_to_remote(env, f"{sandbox_dir}/script.py", code)

        # Wrapped so the thread inherits the turn's approval context + callbacks
        # (see tools.thread_context) — else sandbox RPC tool calls lose approval
        # routing (#33057).
        rpc_thread = threading.Thread(
            target=propagate_context_to_thread(_rpc_poll_loop),
            args=(
                env, f"{sandbox_dir}/rpc", effective_task_id,
                tool_call_log, tool_call_counter, max_tool_calls,
                sandbox_tools, stop_event, rpc_token, max_parallel_tool_calls,
            ),
            daemon=True,
        )
        rpc_thread.start()

        # Build environment variable prefix for the script
        env_prefix = (
            f"HERMES_RPC_DIR={shlex.quote(f'{sandbox_dir}/rpc')} "
            f"HERMES_RPC_TOKEN={shlex.quote(rpc_token)} "
            f"PYTHONDONTWRITEBYTECODE=1"
        )
        tz = os.getenv("HERMES_TIMEZONE", "").strip()
        if tz:
            env_prefix += f" TZ={shlex.quote(tz)}"

        # Execute the script on the remote backend
        logger.info("Executing code on %s backend (task %s)...",
                     env_type, effective_task_id[:8])
        script_result = env.execute(
            f"cd {quoted_sandbox_dir} && {env_prefix} python3 script.py",
            timeout=timeout,
        )

        stdout_text = script_result.get("output", "") or ""
        exit_code = script_result.get("returncode", -1)
        status = "success"

        # Check for timeout/interrupt from the backend
        if exit_code == 124:
            status = "timeout"
        elif exit_code == 130:
            status = "interrupted"

    except Exception as exc:
        duration = round(time.monotonic() - exec_start, 2)
        logger.error(
            "execute_code remote failed after %ss with %d tool calls: %s: %s",
            duration, tool_call_counter[0], type(exc).__name__, exc,
            exc_info=True,
        )
        return json.dumps({
            "status": "error",
            "error": str(exc),
            "tool_calls_made": tool_call_counter[0],
            "duration_seconds": duration,
        }, ensure_ascii=False)

    finally:
        # Stop the polling thread
        stop_event.set()
        if rpc_thread is not None:
            rpc_thread.join(timeout=5)

        # Clean up remote sandbox dir
        try:
            env.execute(
                f"rm -rf {quoted_sandbox_dir}", cwd="/", timeout=15,
            )
        except Exception:
            logger.debug("Failed to clean up remote sandbox %s", sandbox_dir)

    duration = round(time.monotonic() - exec_start, 2)

    # --- Post-process output (same as local path) ---

    stdout_text, stdout_metadata = _truncate_stdout_text(stdout_text)

    # Strip ANSI escape sequences
    from tools.ansi_strip import strip_ansi
    stdout_text = strip_ansi(stdout_text)

    # Redact secrets. code_file=True: execute_code output is code-execution
    # output that often echoes source/config — skip false-positive ENV/JSON/
    # f-string-template redaction while still masking real credentials.
    from agent.redact import redact_sensitive_text
    stdout_text = redact_sensitive_text(stdout_text, code_file=True)

    # Build response
    result: Dict[str, Any] = {
        "status": status,
        "output": stdout_text,
        "exit_code": exit_code,
        "tool_calls_made": tool_call_counter[0],
        "duration_seconds": duration,
    }
    result.update(stdout_metadata)

    if status == "timeout":
        timeout_msg = f"Script timed out after {timeout}s and was killed."
        result["error"] = timeout_msg
        # Include timeout message in output so the LLM always surfaces it
        # to the user (see local path comment — same reasoning, #10807).
        if stdout_text:
            result["output"] = stdout_text + f"\n\n⏰ {timeout_msg}"
        else:
            result["output"] = f"⏰ {timeout_msg}"
        logger.warning(
            "execute_code (remote) timed out after %ss (limit %ss) with %d tool calls",
            duration, timeout, tool_call_counter[0],
        )
    elif status == "interrupted":
        result["output"] = _format_interrupted_output(stdout_text)
    elif exit_code != 0:
        result["status"] = "error"
        result["error"] = f"Script exited with code {exit_code}"

    return json.dumps(result, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def _build_child_env(*, rpc_endpoint: str, rpc_token: str, tmpdir: str,
                     child_python: str) -> Dict[str, str]:
    """Build the scrubbed child environment both execution paths share.

    Extracted verbatim from the per-call spawn path so the session-kernel
    path (tools/code_kernel.py) cannot drift from the security rules here:
    secret scrubbing, UTF-8 forcing, TZ handling, subprocess HOME, and the
    PYTHONPATH hygiene for external interpreters.
    """
    from hermes_constants import apply_subprocess_home_env
    child_env = _scrub_child_env(os.environ)
    child_env["HERMES_RPC_SOCKET"] = rpc_endpoint
    child_env["HERMES_RPC_TOKEN"] = rpc_token
    child_env["PYTHONDONTWRITEBYTECODE"] = "1"
    # Force UTF-8 for the child's stdio and default file encoding.
    #
    # Without this, on Windows sys.stdout is bound to the console code
    # page (cp1252 on US-locale installs), and any script that does
    # ``print("café")`` or ``print("→")`` crashes with:
    #
    #   UnicodeEncodeError: 'charmap' codec can't encode character
    #   '\u2192' in position N: character maps to <undefined>
    #
    # PYTHONIOENCODING fixes sys.stdin/stdout/stderr.
    # PYTHONUTF8=1 enables "UTF-8 mode" (PEP 540) which additionally
    # makes ``open()``'s default encoding UTF-8, so user scripts that
    # write files without specifying encoding= also work correctly.
    #
    # On POSIX both values usually match the locale default already,
    # so setting them is harmless belt-and-suspenders for environments
    # with a C/POSIX locale (containers, minimal base images).
    child_env["PYTHONIOENCODING"] = "utf-8"
    child_env["PYTHONUTF8"] = "1"
    # Inject user's configured timezone so datetime.now() in sandboxed
    # code reflects the correct wall-clock time.  Only TZ is set —
    # HERMES_TIMEZONE is an internal Hermes setting and must not leak
    # into child processes.
    _tz_name = os.getenv("HERMES_TIMEZONE", "").strip()
    if _tz_name:
        child_env["TZ"] = _tz_name
    child_env.pop("HERMES_TIMEZONE", None)

    apply_subprocess_home_env(child_env)
    # ``hermes_tools.py`` always lives in the staging directory, so that
    # directory must be importable even when project mode changes CWD.
    # Hermes's own package root is useful too, but only when the child
    # uses the same Python environment. Project mode can select an
    # external venv; exposing Hermes's site-packages to that interpreter
    # can mix incompatible compiled extensions (for example, Python 3.12
    # NumPy with a Python 3.9 project interpreter).
    #
    # Before re-injecting PYTHONPATH, strip Hermes-owned entries that
    # leaked through _scrub_child_env (PYTHONPATH is in _SAFE_ENV_PREFIXES
    # so it passes the scrub).  They are redundant for same-Hermes-
    # environment children and may be incompatible with external
    # interpreters (project mode can select a different venv), so they
    # must not shadow or poison the child's sys.path (#74817).
    from tools.environments.local import _strip_hermes_owned_pythonpath
    _strip_hermes_owned_pythonpath(child_env)
    _hermes_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    _existing_pp = child_env.get("PYTHONPATH", "")
    _pp_parts = [tmpdir]
    if _uses_hermes_python_environment(child_python):
        _pp_parts.append(_hermes_root)
    elif child_python not in _external_env_logged:
        # Import behavior changes silently otherwise — surface it (once
        # per interpreter path) so "import hermes_constants suddenly
        # fails" reports are diagnosable without log spam.
        _external_env_logged.add(child_python)
        logger.info(
            "execute_code: child interpreter %s is outside the Hermes "
            "environment; hermes root omitted from PYTHONPATH",
            child_python,
        )
    if _existing_pp:
        _pp_parts.append(_existing_pp)
    child_env["PYTHONPATH"] = os.pathsep.join(_pp_parts)
    return child_env


def execute_code(
    code: str,
    task_id: Optional[str] = None,
    enabled_tools: Optional[List[str]] = None,
    reset: bool = False,
) -> str:
    """
    Run Python in the session's persistent kernel (local) or a per-call
    child process (remote backends), with RPC access to a subset of
    Hermes tools.

    "Sandbox" in names below refers to the security envelope (env
    scrubbing, tool whitelist + call budget, output redaction) — not an
    isolation jail: in the default `project` mode, code runs in the
    session's cwd with the project venv's interpreter.

    Dispatches to the local (UDS) or remote (file-based RPC) path
    depending on the configured terminal backend.

    Args:
        code:          Python source code to execute.
        task_id:       Session task ID for tool isolation (terminal env, etc.).
        enabled_tools: Tool names enabled in the current session. The sandbox
                       gets the intersection with SANDBOX_ALLOWED_TOOLS.
        reset:         Session-kernel mode only: kill the existing kernel and
                       start fresh before running this code. Ignored in
                       per-call mode, where every call is already fresh.

    Returns:
        JSON string with execution results.
    """
    if not SANDBOX_AVAILABLE:
        return tool_error(
            "execute_code sandbox is unavailable in this environment. "
            "Use normal tool calls (terminal, read_file, write_file, ...) instead."
        )

    if not code or not code.strip():
        return tool_error(
            "No code provided. execute_code requires a non-empty 'code' "
            "parameter containing Python source. To run shell commands, use "
            "terminal(command=...) instead."
        )

    # Hard-block gateway-lifecycle commands, mirroring the terminal_tool
    # guard (#68289): without this, execute_code is a straight bypass — the
    # terminal() path refuses `launchctl bootout ai.hermes.gateway`, but the
    # identical command inside `os.system(...)` / `subprocess.run([...])`
    # here sailed through and SIGTERM'd the gateway mid-task. Gated on
    # PID-file ownership, not the inherited env marker (#92560).
    from tools.process_registry import _is_supervised_gateway_process
    if _is_supervised_gateway_process():
        from cron.lifecycle_guard import contains_gateway_lifecycle_command
        if contains_gateway_lifecycle_command(code):
            return tool_error(
                "Blocked: cannot restart or stop the gateway from inside the "
                "gateway process. The gateway would kill this script before "
                "it could complete (SIGTERM propagates to child processes). "
                "Run the lifecycle command from a shell outside the gateway."
            )

    # Dispatch: remote backends use file-based RPC, local uses UDS
    from tools.terminal_tool import _get_env_config, _docker_has_host_access
    _env_config = _get_env_config()
    env_type = _env_config["env_type"]

    # execute_code runs arbitrary Python (subprocess/os.system/...) that never
    # passes through terminal()/DANGEROUS_PATTERNS, so guard the whole script
    # here before either dispatch path spawns it. Runs synchronously in the
    # caller (tool-executor) thread, which holds the session context (#30882).
    # A Docker sandbox with host bind mounts is no longer isolated, so its
    # script does not get the container fast-path.
    from tools.approval import check_execute_code_guard
    _guard = check_execute_code_guard(
        code, env_type,
        has_host_access=_docker_has_host_access(_env_config),
    )
    if not _guard.get("approved", False):
        return json.dumps({
            "status": "error",
            "error": _guard.get("message") or "execute_code blocked by approval guard.",
            "tool_calls_made": 0,
            "duration_seconds": 0,
        }, ensure_ascii=False)

    # Clean interrupt slate for a user-approved script before EITHER dispatch
    # path spawns it: drop a stale bit that landed on this thread during the
    # blocking approval-wait so it can't kill the just-approved run on the first
    # poll (local _wait_for_process loop, or remote/ssh env.execute which routes
    # through the same poll loop).  A genuine post-clear interrupt re-sets the
    # bit and is still caught downstream.
    if _guard.get("user_approved"):
        from tools.interrupt import clear_current_thread_interrupt
        clear_current_thread_interrupt()

    if env_type != "local":
        return _execute_remote(code, task_id, enabled_tools, reset=bool(reset))

    # --- Local execution path (UDS) --- below this line is unchanged ---

    # Import per-thread interrupt check (cooperative cancellation)
    from tools.interrupt import is_interrupted as _is_interrupted

    # Resolve config
    _cfg = _load_config()
    timeout = _cfg.get("timeout", DEFAULT_TIMEOUT)
    max_tool_calls = _cfg.get("max_tool_calls", DEFAULT_MAX_TOOL_CALLS)
    max_parallel_tool_calls = _resolve_max_parallel_tool_calls(
        _cfg, max_tool_calls
    )

    # Determine which tools the sandbox can call
    session_tools = set(enabled_tools) if enabled_tools else set()
    sandbox_tools = frozenset(SANDBOX_ALLOWED_TOOLS & session_tools)

    if not sandbox_tools:
        sandbox_tools = SANDBOX_ALLOWED_TOOLS

    if _get_kernel_mode() == "session":
        # Session kernels keep one interpreter alive across calls; the guards
        # above already ran for this cell, and the kernel path reuses the
        # same env builder, RPC server, and output redaction as below.
        from tools.code_kernel import execute_in_session_kernel

        _mode = _get_execution_mode()
        return execute_in_session_kernel(
            code,
            task_id=task_id or "",
            mode=_mode,
            child_python=_resolve_child_python(_mode),
            child_cwd=_resolve_child_cwd(_mode, "", task_id=task_id or ""),
            sandbox_tools=frozenset(sandbox_tools),
            timeout=timeout,
            max_tool_calls=max_tool_calls,
            max_parallel_tool_calls=max_parallel_tool_calls,
            reset=bool(reset),
            is_interrupted=_is_interrupted,
        )

    # --- Set up temp directory with hermes_tools.py and script.py ---
    tmpdir = tempfile.mkdtemp(prefix="hermes_sandbox_")
    # Use /tmp on macOS to avoid the long /var/folders/... path that pushes
    # Unix domain socket paths past the 104-byte macOS AF_UNIX limit.
    # On Linux, tempfile.gettempdir() already returns /tmp.
    #
    # Windows: Python 3.9+ added partial AF_UNIX support but the file-backed
    # variant is flaky across Windows builds (requires Windows 10 1803+,
    # still fails under some configurations, and the socket file can't live
    # on the same temp drive as the script).  Fall back to loopback TCP with
    # the same per-call connection framing and bounded worker pool.  The
    # generated client reads the transport selector from HERMES_RPC_SOCKET
    # (path vs. ``tcp://host:port``).
    _sock_tmpdir = "/tmp" if sys.platform == "darwin" else tempfile.gettempdir()
    _use_tcp_rpc = _IS_WINDOWS
    if _use_tcp_rpc:
        sock_path = None  # not used on Windows; TCP endpoint stored below
        rpc_endpoint = None  # set after bind()
    else:
        sock_path = os.path.join(_sock_tmpdir, f"hermes_rpc_{uuid.uuid4().hex}.sock")
        rpc_endpoint = sock_path

    tool_call_log: list = []
    tool_call_counter = [0]  # mutable so the RPC thread can increment
    exec_start = time.monotonic()
    server_sock = None
    stop_event = threading.Event()

    try:
        # Write the auto-generated hermes_tools module.
        # encoding="utf-8" is required on Windows — the stub and user code
        # both contain non-ASCII characters (em-dashes in docstrings, plus
        # whatever the user script carries).  Python's default open() uses
        # the system locale on Windows (cp1252 typically), which corrupts
        # those bytes; the child then fails to import with a SyntaxError
        # ("'utf-8' codec can't decode byte 0x97 in position ...") because
        # Python source files are decoded as UTF-8 by default (PEP 3120).
        # sandbox_tools is already the correct set (intersection with session
        # tools, or SANDBOX_ALLOWED_TOOLS as fallback — see lines above).
        tools_src = generate_hermes_tools_module(list(sandbox_tools))
        with open(os.path.join(tmpdir, "hermes_tools.py"), "w", encoding="utf-8") as f:
            f.write(tools_src)

        # Write the user's script
        with open(os.path.join(tmpdir, "script.py"), "w", encoding="utf-8") as f:
            f.write(code)

        # --- Start RPC server ---
        rpc_token = secrets.token_urlsafe(32)
        # Two transports:
        #   POSIX: AF_UNIX stream socket on sock_path, chmod 0600 for
        #   owner-only access.  Filesystem permissions gate the socket.
        #   Windows: AF_INET stream socket on 127.0.0.1 with an ephemeral
        #   port.  No filesystem permission story, but loopback-only bind
        #   means only the current user's processes (not remote) can
        #   connect.  HERMES_RPC_SOCKET is set to ``tcp://127.0.0.1:<port>``
        #   which the generated client parses to pick AF_INET.
        if _use_tcp_rpc:
            server_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            server_sock.bind(("127.0.0.1", 0))  # ephemeral port
            _host, _port = server_sock.getsockname()[:2]
            rpc_endpoint = f"tcp://{_host}:{_port}"
        else:
            server_sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server_sock.bind(sock_path)
            os.chmod(sock_path, 0o600)
        # A per-call connection is its own response-correlation channel.  Keep
        # enough backlog for one full parallel burst while worker concurrency
        # remains bounded inside _rpc_server_loop.
        server_sock.listen(max_parallel_tool_calls)

        # Wrapped so the thread inherits the turn's approval context + callbacks
        # (see tools.thread_context) — else gateway sandbox tool calls silently
        # auto-approve dangerous commands (#33057, #30882).
        rpc_thread = threading.Thread(
            target=propagate_context_to_thread(_rpc_server_loop),
            args=(
                server_sock, task_id, tool_call_log,
                tool_call_counter, max_tool_calls, sandbox_tools, stop_event,
                rpc_token, max_parallel_tool_calls,
            ),
            daemon=True,
        )
        rpc_thread.start()

        # --- Spawn child process ---
        # Build a minimal environment for the child. We intentionally exclude
        # API keys and tokens to prevent credential exfiltration from LLM-
        # generated scripts. The child accesses tools via RPC, not direct API.
        # Exception: env vars declared by loaded skills (via env_passthrough
        # registry) or explicitly allowed by the user in config.yaml
        # (terminal.env_passthrough) are passed through.  On Windows, a small
        # OS-essential allowlist (SYSTEMROOT, WINDIR, COMSPEC, ...) is also
        # passed through — without those, the child can't create a socket
        # or spawn a subprocess.  See ``_scrub_child_env`` for the rules.

        # Resolve interpreter + CWD based on execute_code mode.
        #   - strict : today's behavior (sys.executable + tmpdir CWD).
        #   - project: user's venv python + session's working directory, so
        #              project deps like pandas and user files resolve.
        # Env scrubbing and tool whitelist apply identically in both modes.
        _mode = _get_execution_mode()
        _child_python = _resolve_child_python(_mode)
        _child_cwd = _resolve_child_cwd(_mode, tmpdir, task_id=task_id or "")
        _script_path = os.path.join(tmpdir, "script.py")

        child_env = _build_child_env(
            rpc_endpoint=rpc_endpoint,
            rpc_token=rpc_token,
            tmpdir=tmpdir,
            child_python=_child_python,
        )

        proc = subprocess.Popen(
            [_child_python, _script_path],
            cwd=_child_cwd,
            env=child_env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
            creationflags=subprocess.CREATE_NO_WINDOW if _IS_WINDOWS else 0,
        )

        # --- Poll loop: watch for exit, timeout, and interrupt ---
        deadline = time.monotonic() + timeout
        stderr_chunks: list = []

        # Background readers to avoid pipe buffer deadlocks.
        # For stdout we use a head+tail strategy: keep the first HEAD_BYTES
        # and a rolling window of the last TAIL_BYTES so the final print()
        # output is never lost.  Stderr keeps head-only (errors appear early).
        _STDOUT_HEAD_BYTES = int(MAX_STDOUT_BYTES * 0.4)   # 40% head
        _STDOUT_TAIL_BYTES = MAX_STDOUT_BYTES - _STDOUT_HEAD_BYTES  # 60% tail

        def _drain(pipe, chunks, max_bytes):
            """Simple head-only drain (used for stderr)."""
            total = 0
            try:
                while True:
                    data = pipe.read(4096)
                    if not data:
                        break
                    if total < max_bytes:
                        keep = max_bytes - total
                        chunks.append(data[:keep])
                    total += len(data)
            except (ValueError, OSError) as e:
                logger.debug("Error reading process output: %s", e, exc_info=True)

        stdout_total_bytes = [0]  # mutable ref for total bytes seen

        def _drain_head_tail(pipe, head_chunks, tail_chunks, head_bytes, tail_bytes, total_ref):
            """Drain stdout keeping both head and tail data."""
            head_collected = 0
            from collections import deque
            tail_buf = deque()
            tail_collected = 0
            try:
                while True:
                    data = pipe.read(4096)
                    if not data:
                        break
                    total_ref[0] += len(data)
                    # Fill head buffer first
                    if head_collected < head_bytes:
                        keep = min(len(data), head_bytes - head_collected)
                        head_chunks.append(data[:keep])
                        head_collected += keep
                        data = data[keep:]  # remaining goes to tail
                        if not data:
                            continue
                    # Everything past head goes into rolling tail buffer
                    tail_buf.append(data)
                    tail_collected += len(data)
                    # Evict old tail data to stay within tail_bytes budget
                    while tail_collected > tail_bytes and tail_buf:
                        oldest = tail_buf.popleft()
                        tail_collected -= len(oldest)
            except (ValueError, OSError):
                pass
            # Transfer final tail to output list
            tail_chunks.extend(tail_buf)

        stdout_head_chunks: list = []
        stdout_tail_chunks: list = []

        stdout_reader = threading.Thread(
            target=_drain_head_tail,
            args=(proc.stdout, stdout_head_chunks, stdout_tail_chunks,
                  _STDOUT_HEAD_BYTES, _STDOUT_TAIL_BYTES, stdout_total_bytes),
            daemon=True
        )
        stderr_reader = threading.Thread(
            target=_drain, args=(proc.stderr, stderr_chunks, MAX_STDERR_BYTES), daemon=True
        )
        stdout_reader.start()
        stderr_reader.start()

        status = "success"
        _activity_state = {
            "last_touch": time.monotonic(),
            "start": exec_start,
        }
        try:
            from tools.environments.base import touch_activity_if_due
        except Exception:
            touch_activity_if_due = None
        poll_interval = 0.005
        while proc.poll() is None:
            if _is_interrupted():
                _kill_process_group(proc)
                status = "interrupted"
                break
            now = time.monotonic()
            if now > deadline:
                _kill_process_group(proc, escalate=True)
                status = "timeout"
                break
            # Periodic activity touch so the gateway's inactivity timeout
            # doesn't kill the agent during long code execution (#10807).
            if touch_activity_if_due is not None:
                try:
                    touch_activity_if_due(_activity_state, "execute_code running")
                except Exception:
                    pass
            try:
                proc.wait(timeout=min(poll_interval, max(0.0, deadline - now)))
            except subprocess.TimeoutExpired:
                pass
            poll_interval = min(0.2, poll_interval * 1.5)

        # Wait for readers to finish draining
        stdout_reader.join(timeout=3)
        stderr_reader.join(timeout=3)

        stderr_text = b"".join(stderr_chunks).decode("utf-8", errors="replace")

        stdout_text, stdout_metadata = _assemble_stdout_result(
            b"".join(stdout_head_chunks),
            b"".join(stdout_tail_chunks),
            total_bytes=stdout_total_bytes[0],
        )

        exit_code = proc.returncode if proc.returncode is not None else -1
        duration = round(time.monotonic() - exec_start, 2)

        # Wait for RPC thread to finish
        stop_event.set()
        server_sock.close()  # break accept() so thread exits promptly
        server_sock = None  # prevent double close in finally
        rpc_thread.join(timeout=3)

        # Strip ANSI escape sequences so the model never sees terminal
        # formatting — prevents it from copying escapes into file writes.
        from tools.ansi_strip import strip_ansi
        stdout_text = strip_ansi(stdout_text)
        stderr_text = strip_ansi(stderr_text)

        # Redact secrets (API keys, tokens, etc.) from sandbox output.
        # The sandbox env-var filter (lines 434-454) blocks os.environ access,
        # but scripts can still read secrets from disk (e.g. open('~/.hermes/.env')).
        # This ensures leaked secrets never enter the model context.
        # code_file=True: this is code-execution output — skip false-positive
        # ENV/JSON/f-string-template redaction; real credentials still masked.
        from agent.redact import redact_sensitive_text
        stdout_text = redact_sensitive_text(stdout_text, code_file=True)
        stderr_text = redact_sensitive_text(stderr_text, code_file=True)

        # Build response
        result: Dict[str, Any] = {
            "status": status,
            "output": stdout_text,
            "exit_code": exit_code,
            "tool_calls_made": tool_call_counter[0],
            "duration_seconds": duration,
        }
        result.update(stdout_metadata)

        if status == "timeout":
            timeout_msg = f"Script timed out after {timeout}s and was killed."
            result["error"] = timeout_msg
            # Include timeout message in output so the LLM always surfaces it
            # to the user.  When output is empty, models often treat the result
            # as "nothing happened" and produce an empty response, which the
            # gateway stream consumer silently drops (#10807).
            if stdout_text:
                result["output"] = stdout_text + f"\n\n⏰ {timeout_msg}"
            else:
                result["output"] = f"⏰ {timeout_msg}"
            logger.warning(
                "execute_code timed out after %ss (limit %ss) with %d tool calls",
                duration, timeout, tool_call_counter[0],
            )
        elif status == "interrupted":
            result["output"] = _format_interrupted_output(stdout_text)
        elif exit_code != 0:
            result["status"] = "error"
            result["error"] = stderr_text or f"Script exited with code {exit_code}"
            # Include stderr in output so the LLM sees the traceback
            if stderr_text:
                result["output"] = stdout_text + "\n--- stderr ---\n" + stderr_text
            # Known-failure-class recovery hint (import misuse, missing
            # module, dict-vs-string result handling) so the model fixes
            # the script on the next attempt instead of re-diagnosing.
            hint = _sandbox_failure_hint(stderr_text, enabled_tools=sandbox_tools)
            if hint:
                result["hint"] = hint

        return json.dumps(result, ensure_ascii=False)

    except Exception as exc:
        duration = round(time.monotonic() - exec_start, 2)
        logger.error(
            "execute_code failed after %ss with %d tool calls: %s: %s",
            duration,
            tool_call_counter[0],
            type(exc).__name__,
            exc,
            exc_info=True,
        )
        return json.dumps({
            "status": "error",
            "error": str(exc),
            "tool_calls_made": tool_call_counter[0],
            "duration_seconds": duration,
        }, ensure_ascii=False)

    finally:
        # Cleanup temp dir and socket
        if server_sock is not None:
            try:
                server_sock.close()
            except OSError as e:
                logger.debug("Server socket close error: %s", e)
        import shutil
        shutil.rmtree(tmpdir, ignore_errors=True)
        try:
            # Only UDS has a filesystem socket to unlink; TCP sockets are
            # freed by server_sock.close() above.
            if sock_path:
                os.unlink(sock_path)
        except OSError:
            pass  # already cleaned up or never created


def _kill_process_group(proc, escalate: bool = False):
    """Kill the child and its entire process tree (cross-platform).

    Delegates to :func:`agent.deadline.kill_process_tree` (#85125 4d):
    SIGTERM to the whole tree first (killpg when the child leads its own
    group — it does, ``start_new_session=True`` — plus a psutil descendant
    sweep for setsid'd grandchildren; ``taskkill /T /F`` on Windows).
    With ``escalate=True`` the child gets 5s to exit after SIGTERM, then the
    surviving tree is SIGKILLed — same escalation the old psutil-local body
    implemented. Never raises; a delegation failure degrades to a plain
    ``proc.kill()`` like the old psutil-failure fallback.
    """
    import signal as _signal

    def _tree_signal(sig) -> None:
        try:
            from agent.deadline import kill_process_tree as _deadline_kill_tree

            _deadline_kill_tree(proc.pid, sig=sig)
        except Exception as e:
            logger.debug("Could not terminate process tree: %s", e, exc_info=True)
            try:
                proc.kill()
            except Exception as e2:
                logger.debug("Could not kill process: %s", e2, exc_info=True)

    # sig is ignored on Windows (taskkill /F is already forceful).
    _tree_signal(getattr(_signal, "SIGTERM", None))

    if escalate:
        # Give the process 5s to exit after SIGTERM, then SIGKILL
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _tree_signal(getattr(_signal, "SIGKILL", None))


def _load_config() -> dict:
    """Load code_execution config without importing the interactive CLI.

    This helper is called while building the module-level execute_code schema
    during tool discovery.  Importing ``cli`` here pulls prompt_toolkit/Rich and
    a large chunk of the classic REPL onto every agent startup path, including
    ``hermes --tui`` where it is never used.  Read the lightweight raw config
    instead; the config layer already caches by (mtime, size), and an absent
    key cleanly falls back to DEFAULT_EXECUTION_MODE.
    """
    try:
        from hermes_cli.config import read_raw_config

        cfg = read_raw_config().get("code_execution", {})
        return cfg if isinstance(cfg, dict) else {}
    except Exception:
        return {}


# ---------------------------------------------------------------------------
# Execution mode resolution (strict vs project)
# ---------------------------------------------------------------------------

# Valid values for code_execution.mode. Kept as a module constant so tests
# and the config layer can reference the canonical set.
EXECUTION_MODES = ("project", "strict")
DEFAULT_EXECUTION_MODE = "project"

# Session kernels are the only local execution model: one persistent kernel
# per conversation (see tools/code_kernel.py). The former
# code_execution.kernel_mode knob ("per-call" | "session") is retired — the
# config key is silently ignored if present, and _get_kernel_mode() remains
# only as a compat symbol for external callers. Remote terminal backends
# still run per-call: their file-based RPC path has no kernel host YET (a
# long-lived remote runner + cell protocol is tracked follow-up work, not a
# design limit).
KERNEL_MODES = ("per-call", "session")  # legacy compat constant
DEFAULT_KERNEL_MODE = "session"


def _get_kernel_mode() -> str:
    """Legacy compat shim — session kernels are always on for local runs."""
    return "session"


def _get_execution_mode() -> str:
    """Return the active execute_code mode — 'project' or 'strict'.

    Reads ``code_execution.mode`` from config.yaml; invalid values fall back
    to ``DEFAULT_EXECUTION_MODE`` ('project') with a log warning.

    Mode semantics:
      - ``project`` (default): scripts run in the session's working directory
        with the active virtual environment's python, so project dependencies
        (pandas, torch, project packages) and files resolve naturally.
      - ``strict``: scripts run in an isolated temp directory with
        ``sys.executable`` (hermes-agent's python). Reproducible and the
        interpreter is guaranteed to work, but project deps and relative paths
        won't resolve.

    Env scrubbing and tool whitelist apply identically in both modes.
    """
    cfg_value = str(_load_config().get("mode", DEFAULT_EXECUTION_MODE)).strip().lower()
    if cfg_value in EXECUTION_MODES:
        return cfg_value
    logger.warning(
        "Ignoring code_execution.mode=%r (expected one of %s), falling back to %r",
        cfg_value, EXECUTION_MODES, DEFAULT_EXECUTION_MODE,
    )
    return DEFAULT_EXECUTION_MODE


# Shared budget for the two interpreter-probe caches below. Success-only
# dict caches (FIFO-evicted at the cap) rather than lru_cache: a transient
# probe failure (fork pressure, 5s timeout on a loaded host) must not stick
# for the process lifetime.
_PROBE_CACHE_MAX = 32
_usable_python_cache: dict = {}
_python_prefix_cache: dict = {}

# Interpreter paths already reported as outside the Hermes environment —
# dedupes the exclusion log to once per path per process.
_external_env_logged: set = set()


def _cache_probe_result(cache: dict, key: str, value):
    """Insert into a bounded probe cache, FIFO-evicting at the cap."""
    if len(cache) >= _PROBE_CACHE_MAX:
        cache.pop(next(iter(cache)))
    cache[key] = value


def _is_usable_python(python_path: str) -> bool:
    """Check whether a candidate Python interpreter is usable for execute_code.

    Requires Python 3.8+ (f-strings and stdlib modules the RPC stubs need).
    Successful probes are cached per interpreter path; failures are retried
    (a sticky False would silently pin project mode to sys.executable).
    """
    cached = _usable_python_cache.get(python_path)
    if cached is not None:
        return cached
    result = _probe_python(
        python_path,
        "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)",
    )
    if result is None:
        return False
    usable = result.returncode == 0
    _cache_probe_result(_usable_python_cache, python_path, usable)
    return usable


def _probe_python(python_path: str, code: str, *, text: bool = False):
    """Run ``python_path -c code`` with the standard interpreter-probe guards.

    Returns the ``CompletedProcess``, or ``None`` when the interpreter is
    missing, can't be spawned, or hangs past the 5s timeout.
    """
    try:
        from agent.delegation_context import delegated_child_subprocess_env

        return subprocess.run(
            [python_path, "-c", code],
            timeout=5,
            capture_output=True,
            text=text,
            creationflags=subprocess.CREATE_NO_WINDOW if _IS_WINDOWS else 0,
            stdin=subprocess.DEVNULL,
            env=delegated_child_subprocess_env(),
        )
    except (OSError, subprocess.TimeoutExpired, subprocess.SubprocessError):
        return None


def _python_environment_prefix(python_path: str) -> str:
    """Return the resolved ``sys.prefix`` reported by *python_path*, if any.

    Successful probes are cached per interpreter path (bounded, FIFO-evicted).
    Failures are NOT cached: a transient probe failure (fork pressure, 5s
    timeout on a loaded host) must not stick for the process lifetime — a
    sticky empty result would silently drop the hermes root from every
    subsequent execute_code call's PYTHONPATH.
    """
    cached = _python_prefix_cache.get(python_path)
    if cached is not None:
        return cached
    result = _probe_python(python_path, "import sys; print(sys.prefix)", text=True)
    if result is not None and result.returncode == 0 and result.stdout.strip():
        prefix = os.path.realpath(result.stdout.strip())
        _cache_probe_result(_python_prefix_cache, python_path, prefix)
        return prefix
    return ""


def _uses_hermes_python_environment(python_path: str) -> bool:
    """Whether *python_path* belongs to Hermes's active Python environment.

    Short-circuits when *python_path* IS the running interpreter (by path or
    realpath) — no subprocess probe on the default strict-mode path, and no
    way for a flaky probe of ``sys.executable`` itself to break the invariant
    that repo-root modules are importable in strict mode.  The realpath leg
    also covers venvs whose bin/python resolves to the same binary (e.g.
    ``uv run`` setting VIRTUAL_ENV without changing sys.prefix).
    """
    if python_path == sys.executable or (
        os.path.realpath(python_path) == os.path.realpath(sys.executable)
    ):
        return True
    return _python_environment_prefix(python_path) == os.path.realpath(sys.prefix)


def _resolve_child_python(mode: str) -> str:
    """Pick the Python interpreter for the execute_code subprocess.

    In ``strict`` mode, always ``sys.executable`` — guaranteed to work and
    keeps behavior fully reproducible across sessions.

    In ``project`` mode, prefer the user's active virtualenv/conda env's
    python so ``import pandas`` etc. work. Falls back to ``sys.executable``
    if no venv is detected, the candidate binary is missing/not executable,
    or it fails a Python 3.8+ version check.
    """
    if mode != "project":
        return sys.executable

    if _IS_WINDOWS:
        exe_names = ("python.exe", "python3.exe")
        subdirs = ("Scripts",)
    else:
        exe_names = ("python", "python3")
        subdirs = ("bin",)

    for var in ("VIRTUAL_ENV", "CONDA_PREFIX"):
        root = os.environ.get(var, "").strip()
        if not root:
            continue
        for subdir in subdirs:
            for exe in exe_names:
                candidate = os.path.join(root, subdir, exe)
                if not (os.path.isfile(candidate) and os.access(candidate, os.X_OK)):
                    continue
                if _is_usable_python(candidate):
                    return candidate
                # Found the interpreter but it failed the version check —
                # log once and fall through to sys.executable.
                logger.info(
                    "execute_code: skipping %s=%s (Python version < 3.8 or broken). "
                    "Using sys.executable instead.", var, candidate,
                )
                return sys.executable

    return sys.executable


def _resolve_child_cwd(mode: str, staging_dir: str, task_id: str = "") -> str:
    """Resolve the working directory for the execute_code subprocess.

    - ``strict``: the staging tmpdir (today's behavior).
    - ``project``: the session's own cwd — its per-session cwd record
      (written after every completed terminal command), then the raw
      per-session cwd override registered via ``session.cwd.set`` /
      ``register_task_env_overrides``, then the session's TERMINAL_CWD
      (same as the terminal tool), or ``os.getcwd()`` if none points at a
      real dir. Falls back to the staging tmpdir as a last resort so we
      never invoke Popen with a nonexistent cwd.

    This mirrors the resolution ladder file tools and the terminal use
    (record → registered override → TERMINAL_CWD), so all file-writing
    paths within a session agree on the working directory. (#56047)
    """
    if mode != "project":
        return staging_dir
    if task_id:
        # 1. The session's cwd record — IS the session's `cd` state.
        try:
            from tools.terminal_tool import get_session_cwd

            recorded = get_session_cwd(task_id)
        except Exception:
            recorded = None
        if recorded and os.path.isdir(recorded):
            return recorded
        # 2. Registered workspace override (session.cwd.set → gateway/TUI/ACP).
        try:
            from tools.file_tools import _registered_task_cwd_override

            session_cwd = _registered_task_cwd_override(task_id)
        except Exception:
            session_cwd = None
        if session_cwd and os.path.isdir(session_cwd):
            return session_cwd
    raw = os.environ.get("TERMINAL_CWD", "").strip()
    if raw:
        expanded = os.path.expanduser(raw)
        if os.path.isdir(expanded):
            return expanded
    here = os.getcwd()
    if os.path.isdir(here):
        return here
    return staging_dir


# ---------------------------------------------------------------------------
# OpenAI Function-Calling Schema
# ---------------------------------------------------------------------------

# Per-tool documentation lines for the execute_code description.
# Ordered to match the canonical display order.
_TOOL_DOC_LINES = [
    ("web_search",
     "  web_search(query: str, limit: int = 5) -> dict\n"
     "    Returns {\"data\": {\"web\": [{\"url\", \"title\", \"description\"}, ...]}}"),
    ("web_extract",
     "  web_extract(urls: list[str], char_limit: int = None) -> dict\n"
     "    Returns {\"results\": [{\"url\", \"title\", \"content\", \"error\"}, ...]} where content is markdown.\n"
     "    No LLM summarization. Pages over char_limit (default 15000) are head+tail truncated; full text stored on disk (path in the content footer)."),
    ("read_file",
     "  read_file(path: str, offset: int = 1, limit: int = 2000) -> dict\n"
     "    Lines are 1-indexed. Returns {\"content\": \"...\", \"total_lines\": N}"),
    ("write_file",
     "  write_file(path: str, content: str) -> dict\n"
     "    Always overwrites the entire file."),
    ("search_files",
     "  search_files(pattern: str, target=\"content\", path=\".\", file_glob=None, limit=50) -> dict\n"
     "    target: \"content\" (search inside files) or \"files\" (find files by name). Returns {\"matches\": [...]}"),
    ("patch",
     "  patch(path: str, old_string: str, new_string: str, replace_all: bool = False) -> dict\n"
     "    Replaces old_string with new_string in the file."),
    ("terminal",
     "  terminal(command: str, timeout=None, workdir=None) -> dict\n"
     "    Foreground only (no background/pty). Returns {\"output\": \"...\", \"exit_code\": N}"),
]


def build_execute_code_schema(enabled_sandbox_tools: set = None,
                              mode: str = None) -> dict:
    """Build the execute_code schema with description listing only enabled tools.

    When tools are disabled via ``hermes tools`` (e.g. web is turned off),
    the schema description should NOT mention web_search / web_extract —
    otherwise the model thinks they are available and keeps trying to use them.

    ``mode`` controls the working-directory sentence in the description:
      - ``'strict'``: scripts run in a temp dir (not the session's CWD)
      - ``'project'`` (default): scripts run in the session's CWD with the
        active venv's python
    If ``mode`` is None, the current ``code_execution.mode`` config is read.
    """
    if enabled_sandbox_tools is None:
        enabled_sandbox_tools = SANDBOX_ALLOWED_TOOLS
    if mode is None:
        mode = _get_execution_mode()

    # Build tool documentation lines for only the enabled tools
    tool_lines = "\n".join(
        doc for name, doc in _TOOL_DOC_LINES if name in enabled_sandbox_tools
    )

    # Build example import list from enabled tools
    import_examples = [n for n in ("web_search", "terminal") if n in enabled_sandbox_tools]
    if not import_examples:
        import_examples = sorted(enabled_sandbox_tools)[:2]
    if import_examples:
        import_str = ", ".join(import_examples) + ", ..."
    else:
        import_str = "..."

    # Mode-specific CWD guidance. Project mode is the default and matches
    # terminal()'s filesystem/interpreter; strict mode retains the isolated
    # temp-dir staging and hermes-agent's own python.
    if mode == "strict":
        cwd_note = (
            "Scripts run in their own temp dir, not the session's CWD — use absolute paths "
            "(os.path.expanduser('~/.hermes/.env')) or terminal()/read_file() for user files."
        )
    else:
        cwd_note = (
            "Scripts run in the session's working directory. Interpreter: "
            "the project's activated venv/conda python when one is active "
            "(VIRTUAL_ENV/CONDA_PREFIX — matches terminal()); otherwise "
            "Hermes's own python (the common case — stdlib plus Hermes's "
            "deps; check `import x` before relying on project packages)."
        )

    # Session kernels are always on (kernel_mode retired in #96787):
    # persistence is part of the tool's one description, not a bolt-on
    # paragraph behind a dead conditional. Remote hosts that cannot sustain
    # a kernel fail open to per-call silently — not worth schema words;
    # the result's `kernel` field tells the truth per call.
    description = (
        "Run Python that calls Hermes tools programmatically. Use when you "
        "need 3+ tool calls with logic between them: filtering/reducing "
        "large outputs before they enter context, branching, or loops "
        "(N pages/files, retry on failure). Use normal tool calls for "
        "single calls, results you must reason over in full, or anything "
        "needing user interaction.\n\n"
        "Calls run in a persistent session kernel: variables, imports, and "
        "loaded data survive across execute_code calls, so build on earlier "
        "work instead of re-loading it. A timed-out or interrupted call "
        "loses that state.\n\n"
        f"Available via `from hermes_tools import ...`:\n\n"
        f"{tool_lines}\n\n"
        "Limits: 5-minute timeout, max 50 tool calls per call. Stdout over "
        "50KB shows head/tail inline; the FULL text is auto-saved to a file "
        "whose path rides in the result. Independent read-only or network "
        "calls may run concurrently; stateful or mutating calls stay ordered. "
        "terminal() is foreground-only (no background or pty).\n\n"
        f"{cwd_note}\n\n"
        "Built-in helpers (no import): json_parse(text) — tolerant "
        "json.loads for terminal() output; shell_quote(s) — shlex.quote for "
        "dynamic shell args; retry(fn, max_attempts=3, delay=2) — "
        "exponential backoff."
    )

    return {
        "name": "execute_code",
        "description": description,
        "parameters": {
            "type": "object",
            "properties": {
                "code": {
                    "type": "string",
                    "description": (
                        "Python code to execute. Import tools with "
                        f"`from hermes_tools import {import_str}` "
                        "and print your final result to stdout."
                    ),
                },
                "reset": {
                    "type": "boolean",
                    "description": (
                        "Discard the kernel's persistent state and start "
                        "fresh before running this code."
                    ),
                },
            },
            "required": ["code"],
        },
    }


# Default schema used at registration time (all sandbox tools listed,
# current configured mode).  model_tools.py rebuilds per-session anyway.
EXECUTE_CODE_SCHEMA = build_execute_code_schema()


# --- Registry ---
from tools.registry import registry, tool_error


def _execute_code_handler(args: dict, **kwargs) -> str:
    """Recover misdirected calls before dispatching to ``execute_code``.

    Models sometimes reuse terminal's ``command`` argument or send a
    non-string ``code`` payload; both get an actionable redirect instead
    of a generic failure.
    """
    # Help models recover when they reuse terminal's ``command`` argument.
    if "code" not in args and "command" in args:
        logger.warning(
            "execute_code received 'command' instead of the required 'code' argument"
        )
        return tool_error(
            "execute_code received a 'command' parameter, but it requires "
            "Python source in 'code'. Use terminal(command=...) for shell "
            "commands; for Python, retry as execute_code(code=...)."
        )

    code = args.get("code", "")
    if code is not None and not isinstance(code, str):
        # A non-string payload (int, dict, list) would otherwise surface as
        # a generic AttributeError from code.strip() — redirect instead.
        return tool_error(
            f"execute_code received a {type(code).__name__} in 'code', but it "
            "requires Python source as a string. Retry as "
            "execute_code(code=\"...\")."
        )

    return execute_code(
        code=code or "",
        task_id=kwargs.get("task_id"),
        enabled_tools=kwargs.get("enabled_tools"),
        reset=bool(args.get("reset", False)),
    )


registry.register(
    name="execute_code",
    toolset="code_execution",
    schema=EXECUTE_CODE_SCHEMA,
    handler=_execute_code_handler,
    check_fn=check_sandbox_requirements,
    emoji="🐍",
    max_result_size_chars=100_000,
)
