#!/usr/bin/env python3
"""

Tests for the code execution sandbox (programmatic tool calling).

These tests monkeypatch handle_function_call so they don't require API keys
or a running terminal backend. They verify the core sandbox mechanics:
UDS socket lifecycle, hermes_tools generation, timeout enforcement,
output capping, tool call counting, and error propagation.

Run with:  python -m pytest tests/test_code_execution.py -v
   or:     python tests/test_code_execution.py
"""

import pytest
# pytestmark removed — tests run fine (61 pass, ~99s)

import base64
import json
import os
import socket
import time

os.environ["TERMINAL_ENV"] = "local"


@pytest.fixture(autouse=True)
def _force_local_terminal(monkeypatch):
    """Re-set TERMINAL_ENV=local before every test.

    The module-level assignment above covers import time, but under xdist
    another worker can overwrite os.environ between tests.  monkeypatch
    ensures each test starts (and ends) with the correct value.
    """
    monkeypatch.setenv("TERMINAL_ENV", "local")


@pytest.fixture(autouse=True)
def _fresh_kernel_registry():
    """Session kernels are always on: dispose them per-test so a lingering
    kernel child can't outlive the run (hangs pytest at exit) or leak one
    test's interpreter state into the next."""
    from tools.code_kernel import shutdown_all_kernels

    shutdown_all_kernels()
    yield
    shutdown_all_kernels()
import sys
import threading
import unittest
from unittest.mock import patch, MagicMock

from tools.code_execution_tool import (
    SANDBOX_ALLOWED_TOOLS,
    execute_code,
    generate_hermes_tools_module,
    check_sandbox_requirements,
    build_execute_code_schema,
    EXECUTE_CODE_SCHEMA,
    _TOOL_DOC_LINES,
    _execute_remote,
    _format_interrupted_output,
)
from tools.registry import registry


def _mock_handle_function_call(function_name, function_args, task_id=None, user_task=None):
    """Mock dispatcher that returns canned responses for each tool."""
    if function_name == "terminal":
        cmd = function_args.get("command", "")
        return json.dumps({"output": f"mock output for: {cmd}", "exit_code": 0})
    if function_name == "web_search":
        return json.dumps({"results": [{"url": "https://example.com", "title": "Example", "description": "A test result"}]})
    if function_name == "read_file":
        return json.dumps({"content": "line 1\nline 2\nline 3\n", "total_lines": 3})
    if function_name == "write_file":
        return json.dumps({"status": "ok", "path": function_args.get("path", "")})
    if function_name == "search_files":
        return json.dumps({"matches": [{"file": "test.py", "line": 1, "text": "match"}]})
    if function_name == "patch":
        return json.dumps({"status": "ok", "replacements": 1})
    if function_name == "web_extract":
        return json.dumps("# Extracted content\nSome text from the page.")
    return json.dumps({"error": f"Unknown tool in mock: {function_name}"})


class TestSandboxRequirements(unittest.TestCase):
    def test_available_on_posix(self):
        if sys.platform != "win32":
            self.assertTrue(check_sandbox_requirements())

    def test_schema_is_valid(self):
        self.assertEqual(EXECUTE_CODE_SCHEMA["name"], "execute_code")
        self.assertIn("code", EXECUTE_CODE_SCHEMA["parameters"]["properties"])
        self.assertIn("code", EXECUTE_CODE_SCHEMA["parameters"]["required"])


class TestInterruptedOutput(unittest.TestCase):
    def tearDown(self):
        from tools.interrupt import set_interrupt

        set_interrupt(False)

    def test_uses_recorded_interrupt_source(self):
        from tools.interrupt import set_interrupt

        set_interrupt(True, reason="superseded by a new live turn")

        self.assertEqual(
            _format_interrupted_output("partial output"),
            "partial output\n[execution interrupted — superseded by a new live turn]",
        )

    def test_unknown_interrupt_source_is_neutral(self):
        from tools.interrupt import set_interrupt

        set_interrupt(True)

        self.assertEqual(
            _format_interrupted_output(""),
            "[execution interrupted]",
        )


class TestHermesToolsGeneration(unittest.TestCase):
    def test_generates_all_allowed_tools(self):
        src = generate_hermes_tools_module(list(SANDBOX_ALLOWED_TOOLS))
        for tool in SANDBOX_ALLOWED_TOOLS:
            self.assertIn(f"def {tool}(", src)


    def test_empty_list_generates_nothing(self):
        src = generate_hermes_tools_module([])
        self.assertNotIn("def terminal(", src)
        self.assertIn("def _call(", src)  # infrastructure still present


    def test_file_transport_uses_tempfile_fallback_for_rpc_dir(self):
        src = generate_hermes_tools_module(["terminal"], transport="file")
        self.assertIn("import json, os, shlex, tempfile, threading, time", src)
        self.assertIn("os.path.join(tempfile.gettempdir(), \"hermes_rpc\")", src)
        self.assertNotIn('os.environ.get("HERMES_RPC_DIR", "/tmp/hermes_rpc")', src)

    def test_file_transport_serializes_seq_allocation(self):
        """Regression: file transport _call() must allocate `_seq` under a
        lock, otherwise concurrent threads can pick the same seq and clobber
        each other's request files."""
        src = generate_hermes_tools_module(["terminal"], transport="file")
        self.assertIn("_seq_lock = threading.Lock()", src)
        self.assertIn("with _seq_lock:", src)


class TestRpcDispatchState(unittest.TestCase):
    def test_tool_call_limit_is_reserved_atomically(self):
        from tools.code_execution_tool import _RpcDispatchState

        counter = [0]
        state = _RpcDispatchState(
            tool_call_counter=counter,
            tool_call_log=[],
            max_tool_calls=1,
            max_parallel_tool_calls=10,
            stop_event=threading.Event(),
        )
        rendezvous = threading.Barrier(10)
        results = []
        results_lock = threading.Lock()

        def reserve_once():
            rendezvous.wait(timeout=10)
            result = state.reserve()
            with results_lock:
                results.append(result)

        threads = [threading.Thread(target=reserve_once) for _ in range(10)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)

        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertEqual(sum(result is None for result in results), 1)
        self.assertEqual(counter, [1])
        self.assertTrue(all(
            result is None or "limit reached" in result.lower()
            for result in results
        ))


class TestExecuteCodeRemoteTempDir(unittest.TestCase):
    def test_execute_remote_uses_backend_temp_dir_for_sandbox(self):
        class FakeEnv:
            def __init__(self):
                self.commands = []

            def get_temp_dir(self):
                return "/data/data/com.termux/files/usr/tmp"

            def execute(self, command, cwd=None, timeout=None):
                self.commands.append((command, cwd, timeout))
                if "command -v python3" in command:
                    return {"output": "OK\n"}
                if "python3 script.py" in command:
                    return {"output": "hello\n", "returncode": 0}
                return {"output": ""}

        env = FakeEnv()
        fake_thread = MagicMock()

        with patch("tools.code_execution_tool._load_config", return_value={"timeout": 30, "max_tool_calls": 5}), \
             patch("tools.code_execution_tool._get_or_create_env", return_value=(env, "ssh")), \
             patch("tools.code_execution_tool._ship_file_to_remote"), \
             patch("tools.code_execution_tool.threading.Thread", return_value=fake_thread):
            result = json.loads(_execute_remote("print('hello')", "task-1", ["terminal"]))

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["exit_code"], 0)
        self.assertFalse(result["stdout_truncated"])
        self.assertEqual(result["stdout_bytes_total"], len("hello\n".encode("utf-8")))
        # The session-kernel path runs first and fails open on this fake env
        # (no PID from nohup), so search for the per-call sandbox commands
        # rather than pinning positions.
        mkdir_cmd = next(cmd for cmd, _, _ in env.commands
                         if "mkdir -p" in cmd and "hermes_exec_" in cmd)
        run_cmd = next(cmd for cmd, _, _ in env.commands if "python3 script.py" in cmd)
        cleanup_cmd = next(cmd for cmd, _, _ in env.commands
                           if "rm -rf" in cmd and "hermes_exec_" in cmd)
        self.assertIn("mkdir -p /data/data/com.termux/files/usr/tmp/hermes_exec_", mkdir_cmd)
        self.assertIn("HERMES_RPC_DIR=/data/data/com.termux/files/usr/tmp/hermes_exec_", run_cmd)
        self.assertIn("rm -rf /data/data/com.termux/files/usr/tmp/hermes_exec_", cleanup_cmd)
        self.assertNotIn("mkdir -p /tmp/hermes_exec_", mkdir_cmd)

    def test_timezone_shell_quoted_in_remote_execution(self):
        """HERMES_TIMEZONE must be shell-quoted in remote env_prefix to prevent injection."""
        class FakeEnv:
            def __init__(self):
                self.commands = []

            def get_temp_dir(self):
                return "/tmp"

            def execute(self, command, cwd=None, timeout=None):
                self.commands.append((command, cwd, timeout))
                if "command -v python3" in command:
                    return {"output": "OK\n"}
                if "python3 script.py" in command:
                    return {"output": "hello\n", "returncode": 0}
                return {"output": ""}

        env = FakeEnv()
        fake_thread = MagicMock()

        malicious_tz = "US/Eastern; echo PWNED"

        with patch("tools.code_execution_tool._load_config",
                   return_value={"timeout": 30, "max_tool_calls": 5}), \
             patch("tools.code_execution_tool._get_or_create_env",
                   return_value=(env, "ssh")), \
             patch("tools.code_execution_tool._ship_file_to_remote"), \
             patch("tools.code_execution_tool.threading.Thread",
                   return_value=fake_thread), \
             patch.dict(os.environ, {"HERMES_TIMEZONE": malicious_tz}):
            result = json.loads(_execute_remote("print('hello')", "task-1", ["terminal"]))

        self.assertEqual(result["status"], "success")
        run_cmd = next(cmd for cmd, _, _ in env.commands if "python3 script.py" in cmd)
        # The TZ value must be shell-quoted — it should NOT contain unescaped semicolons
        self.assertNotIn("TZ=US/Eastern; echo PWNED", run_cmd,
                         "TZ value with shell metacharacters must not appear unquoted")
        # shlex.quote wraps values containing special characters in single quotes
        self.assertIn("TZ='US/Eastern; echo PWNED'", run_cmd,
                      "TZ value must be wrapped in single quotes by shlex.quote()")


@unittest.skipIf(sys.platform == "win32", "UDS not available on Windows")
class TestExecuteCode(unittest.TestCase):
    """Integration tests using the mock dispatcher."""

    def _run(self, code, enabled_tools=None):
        """Helper: run code with mocked handle_function_call."""
        with patch("tools.code_execution_tool._rpc_server_loop") as mock_rpc:
            # Use real execution but mock the tool dispatcher
            pass
        # Actually run with full integration, mocking at the model_tools level
        with patch("model_tools.handle_function_call", side_effect=_mock_handle_function_call):
            result = execute_code(
                code=code,
                task_id="test-task",
                enabled_tools=enabled_tools or list(SANDBOX_ALLOWED_TOOLS),
            )
        return json.loads(result)

    def test_basic_print(self):
        """Script that just prints -- no tool calls."""
        result = self._run('print("hello world")')
        self.assertEqual(result["status"], "success")
        self.assertIn("hello world", result["output"])
        self.assertEqual(result["tool_calls_made"], 0)

    def test_no_tool_call_script_does_not_wait_for_rpc_accept_timeout(self):
        """A no-tool script should not wait seconds for the idle RPC accept thread."""
        start = time.monotonic()
        result = self._run('print("fast")')
        elapsed = time.monotonic() - start

        self.assertEqual(result["status"], "success")
        self.assertIn("fast", result["output"])
        self.assertLess(elapsed, 2.0, f"execute_code took {elapsed:.3f}s")

    def test_repo_root_modules_are_importable(self):
        """Sandboxed scripts can import modules that live at the repo root."""
        result = self._run('import hermes_constants; print(hermes_constants.__file__)')
        self.assertEqual(result["status"], "success")
        self.assertIn("hermes_constants.py", result["output"])

    def test_single_tool_call(self):
        """Script calls terminal and prints the result."""
        code = """
from hermes_tools import terminal
result = terminal("echo hello")
print(result.get("output", ""))
"""
        result = self._run(code)
        self.assertEqual(result["status"], "success")
        self.assertIn("mock output for: echo hello", result["output"])
        self.assertEqual(result["tool_calls_made"], 1)


    def test_concurrent_tool_calls_match_responses(self):
        """Regression for the UDS RPC race: multiple threads inside the
        sandbox calling terminal() concurrently must each receive their own
        response, not another thread's.

        Before the fix, `_sock` and the recv-loop were shared without a
        lock, so responses (written FIFO by the single-threaded server)
        got delivered to whichever client thread happened to win the
        recv() race. That surfaced as each thread seeing another thread's
        output.

        The mock dispatcher sleeps briefly to guarantee the requests
        overlap on the socket.
        """
        code = '''
import threading
from concurrent.futures import ThreadPoolExecutor
from hermes_tools import terminal

N = 10

def call(i):
    r = terminal(f"echo TAG-{i}")
    return i, r.get("output", "")

with ThreadPoolExecutor(max_workers=N) as ex:
    results = list(ex.map(call, range(N)))

mismatches = [(i, out) for i, out in results if f"TAG-{i}" not in out]
if mismatches:
    print(f"MISMATCH {len(mismatches)}/{N}: {mismatches[:3]}")
else:
    print(f"OK {N}/{N}")
'''

        def slow_mock(function_name, function_args, task_id=None, user_task=None):
            import time as _t
            if function_name == "terminal":
                _t.sleep(0.05)  # ensure requests overlap on the socket
                cmd = function_args.get("command", "")
                # Echo semantics: strip leading "echo " and return the rest
                out = cmd[5:] if cmd.startswith("echo ") else f"mock: {cmd}"
                return json.dumps({"output": out, "exit_code": 0})
            return _mock_handle_function_call(
                function_name, function_args, task_id=task_id, user_task=user_task
            )

        with patch("model_tools.handle_function_call", side_effect=slow_mock):
            raw = execute_code(
                code=code,
                task_id="test-concurrent",
                enabled_tools=list(SANDBOX_ALLOWED_TOOLS),
            )
        result = json.loads(raw)
        self.assertEqual(result["status"], "success", msg=result)
        self.assertIn("OK 10/10", result["output"],
                      msg=f"Concurrent tool calls mismatched: {result['output']!r}")

    def test_parallel_safe_nested_calls_are_simultaneously_in_flight(self):
        """Ten web calls must reach the dispatcher together, not merely return
        correctly after hidden RPC serialization."""
        code = '''
from concurrent.futures import ThreadPoolExecutor
from hermes_tools import web_search

tags = [f"query-{index}" for index in range(10)]
with ThreadPoolExecutor(max_workers=10) as pool:
    results = list(pool.map(lambda tag: web_search(tag), tags))
print("OK", len(results), [item.get("tag") for item in results])
'''
        rendezvous = threading.Barrier(10)

        def overlapping_mock(function_name, function_args, task_id=None, user_task=None):
            if function_name == "web_search":
                rendezvous.wait(timeout=10)
                return json.dumps({"tag": function_args["query"]})
            return _mock_handle_function_call(
                function_name,
                function_args,
                task_id=task_id,
                user_task=user_task,
            )

        from tools.nested_tool_presentation import nested_tool_presentation_scope

        starts = []
        completes = []
        with (
            patch(
                "tools.code_execution_tool._load_config",
                return_value={
                    "timeout": 30,
                    "max_tool_calls": 50,
                    "max_parallel_tool_calls": 10,
                },
            ),
            patch(
                "model_tools.handle_function_call",
                side_effect=overlapping_mock,
            ),
            nested_tool_presentation_scope(
                parent_tool_call_id="call_parallel_outer",
                start_callback=lambda *args: starts.append(args),
                complete_callback=lambda *args: completes.append(args),
            ),
        ):
            result = json.loads(
                execute_code(
                    code=code,
                    task_id="test-real-parallel",
                    enabled_tools=list(SANDBOX_ALLOWED_TOOLS),
                )
            )

        self.assertEqual(result["status"], "success", msg=result)
        self.assertEqual(result["tool_calls_made"], 10)
        self.assertIn("OK 10", result["output"])
        self.assertIn("query-0", result["output"])
        self.assertIn("query-9", result["output"])
        self.assertEqual(len(starts), 10)
        self.assertEqual(len(completes), 10)
        start_ids = [event[0] for event in starts]
        complete_ids = [event[0] for event in completes]
        self.assertEqual(len(set(start_ids)), 10)
        self.assertEqual(set(start_ids), set(complete_ids))
        self.assertEqual(len(complete_ids), len(set(complete_ids)))


    def test_stderr_on_error(self):
        """Traceback from stderr is included in the response."""
        code = """
import sys
print("before error")
raise RuntimeError("deliberate crash")
"""
        result = self._run(code)
        self.assertEqual(result["status"], "error")
        self.assertIn("before error", result["output"])
        self.assertIn("RuntimeError", result.get("error", "") + result.get("output", ""))


    def test_shell_quote_helper(self):
        """shell_quote properly escapes dangerous characters."""
        code = """
from hermes_tools import shell_quote
# String with backticks, quotes, and special chars
dangerous = '`rm -rf /` && $(whoami) "hello"'
escaped = shell_quote(dangerous)
print(escaped)
# Verify it's wrapped in single quotes with proper escaping
assert "rm -rf" in escaped
assert escaped.startswith("'")
"""
        result = self._run(code)
        self.assertEqual(result["status"], "success")


    def test_json_parse_helper_bom(self):
        """json_parse strips a leading UTF-8 BOM and tolerates control chars (#57870)."""
        code = """
from hermes_tools import json_parse
# A leading UTF-8 BOM (e.g. from Windows CLI output) must also parse (#57870)
bom_text = "\\ufeff" + '{"body": "bom-ok"}'
bom_result = json_parse(bom_text)
assert bom_result == {"body": "bom-ok"}, bom_result
print("bom:" + bom_result["body"])
"""
        result = self._run(code)
        self.assertEqual(result["status"], "success")
        self.assertIn("bom:bom-ok", result["output"])


    def test_retry_helper_all_fail(self):
        """retry raises the last error when all attempts fail."""
        code = """
from hermes_tools import retry
def always_fail():
    raise ValueError("nope")
try:
    retry(always_fail, max_attempts=2, delay=0.01)
    print("should not reach here")
except ValueError as e:
    print(f"caught: {e}")
"""
        result = self._run(code)
        self.assertEqual(result["status"], "success")
        self.assertIn("caught: nope", result["output"])


class TestStubSchemaDrift(unittest.TestCase):
    """Verify that _TOOL_STUBS in code_execution_tool.py stay in sync with
    the real tool schemas registered in tools/registry.py.

    If a tool gains a new parameter but the sandbox stub isn't updated,
    the LLM will try to use the parameter (it sees it in the system prompt)
    and get a TypeError.  This test catches that drift.
    """

    # Parameters that are internal (injected by the handler, not user-facing)
    _INTERNAL_PARAMS = {"task_id", "user_task"}
    # Parameters intentionally blocked in the sandbox
    _BLOCKED_TERMINAL_PARAMS = {"background", "pty", "notify", "notify_on_complete", "watch_patterns"}

    def test_stubs_cover_all_schema_params(self):
        """Every user-facing parameter in the real schema must appear in the
        corresponding _TOOL_STUBS entry."""
        import re
        from tools.code_execution_tool import _TOOL_STUBS

        # Import the registry and trigger tool registration
        from tools.registry import registry
        import tools.file_tools  # noqa: F401 - registers read_file, write_file, patch, search_files
        import tools.web_tools  # noqa: F401 - registers web_search, web_extract

        for tool_name, (func_name, sig, doc, args_expr) in _TOOL_STUBS.items():
            entry = registry._tools.get(tool_name)
            if not entry:
                # Tool might not be registered yet (e.g., terminal uses a
                # different registration path).  Skip gracefully.
                continue

            schema_props = entry.schema.get("parameters", {}).get("properties", {})
            schema_params = set(schema_props.keys()) - self._INTERNAL_PARAMS
            if tool_name == "terminal":
                schema_params -= self._BLOCKED_TERMINAL_PARAMS

            # Extract parameter names from the stub signature string
            # Match word before colon: "pattern: str, target: str = ..."
            stub_params = set(re.findall(r'(\w+)\s*:', sig))

            missing = schema_params - stub_params
            self.assertEqual(
                missing, set(),
                f"Stub for '{tool_name}' is missing parameters that exist in "
                f"the real schema: {missing}. Update _TOOL_STUBS in "
                f"code_execution_tool.py to include them."
            )


    def test_generated_module_accepts_all_params(self):
        """The generated hermes_tools.py module should accept all current params
        without TypeError when called with keyword arguments."""
        src = generate_hermes_tools_module(list(SANDBOX_ALLOWED_TOOLS))

        # Compile the generated module to check for syntax errors
        compile(src, "hermes_tools.py", "exec")

        # Verify specific parameter signatures are in the source
        # search_files must accept context, offset, output_mode
        self.assertIn("context", src)
        self.assertIn("offset", src)
        self.assertIn("output_mode", src)

        # patch must accept mode and patch params
        self.assertIn("mode", src)


# ---------------------------------------------------------------------------
# build_execute_code_schema
# ---------------------------------------------------------------------------

class TestBuildExecuteCodeSchema(unittest.TestCase):
    """Tests for build_execute_code_schema — the dynamic schema generator."""

    def test_default_includes_all_tools(self):
        schema = build_execute_code_schema()
        desc = schema["description"]
        for name, _ in _TOOL_DOC_LINES:
            self.assertIn(name, desc, f"Default schema should mention '{name}'")

    def test_schema_structure(self):
        schema = build_execute_code_schema()
        self.assertEqual(schema["name"], "execute_code")
        self.assertIn("parameters", schema)
        self.assertIn("code", schema["parameters"]["properties"])
        self.assertEqual(schema["parameters"]["required"], ["code"])

    def test_subset_only_lists_enabled_tools(self):
        enabled = {"terminal", "read_file"}
        schema = build_execute_code_schema(enabled)
        desc = schema["description"]
        self.assertIn("terminal(", desc)
        self.assertIn("read_file(", desc)
        self.assertNotIn("web_search(", desc)
        self.assertNotIn("web_extract(", desc)
        self.assertNotIn("write_file(", desc)


    def test_none_defaults_to_all_tools(self):
        schema_none = build_execute_code_schema(None)
        schema_all = build_execute_code_schema(SANDBOX_ALLOWED_TOOLS)
        self.assertEqual(schema_none["description"], schema_all["description"])


# ---------------------------------------------------------------------------
# Environment variable filtering (security critical)
# ---------------------------------------------------------------------------

@unittest.skipIf(sys.platform == "win32", "UDS not available on Windows")
class TestEnvVarFiltering(unittest.TestCase):
    """Verify that execute_code filters environment variables correctly.

    The child process should NOT receive API keys, tokens, or secrets.
    It should receive safe vars like PATH, HOME, LANG, etc.
    """

    def _get_child_env(self, extra_env=None):
        """Run a script that dumps its environment and return the env dict."""
        code = (
            "import os, json\n"
            "print(json.dumps(dict(os.environ)))\n"
        )
        env_backup = os.environ.copy()
        try:
            if extra_env:
                os.environ.update(extra_env)
            with patch("model_tools.handle_function_call", return_value='{}'), \
                 patch("tools.code_execution_tool._load_config",
                       return_value={"timeout": 10, "max_tool_calls": 50}):
                # reset=True: a session kernel's env is frozen at spawn, so
                # env-building rules are only observable on a FRESH kernel —
                # a reused one would (correctly) show the env from whenever
                # it was first spawned, not this test's os.environ tweaks.
                raw = execute_code(code, task_id="test-env",
                                   enabled_tools=list(SANDBOX_ALLOWED_TOOLS),
                                   reset=True)
        finally:
            os.environ.clear()
            os.environ.update(env_backup)

        result = json.loads(raw)
        self.assertEqual(result["status"], "success", result.get("error", ""))
        return json.loads(result["output"].strip())

    def test_api_keys_excluded(self):
        child_env = self._get_child_env({
            "OPENAI_API_KEY": "sk-secret123",
            "ANTHROPIC_API_KEY": "sk-ant-secret",
            "FIRECRAWL_API_KEY": "fc-secret",
        })
        self.assertNotIn("OPENAI_API_KEY", child_env)
        self.assertNotIn("ANTHROPIC_API_KEY", child_env)
        self.assertNotIn("FIRECRAWL_API_KEY", child_env)

    def test_tokens_excluded(self):
        child_env = self._get_child_env({
            "GITHUB_TOKEN": "ghp_secret",
            "MODAL_TOKEN_ID": "tok-123",
            "MODAL_TOKEN_SECRET": "tok-sec",
        })
        self.assertNotIn("GITHUB_TOKEN", child_env)
        self.assertNotIn("MODAL_TOKEN_ID", child_env)
        self.assertNotIn("MODAL_TOKEN_SECRET", child_env)


    def test_hermes_rpc_socket_injected(self):
        child_env = self._get_child_env()
        self.assertIn("HERMES_RPC_SOCKET", child_env)


    def test_timezone_injected_when_set(self):
        env_backup = os.environ.copy()
        try:
            os.environ["HERMES_TIMEZONE"] = "America/New_York"
            child_env = self._get_child_env()
            self.assertEqual(child_env.get("TZ"), "America/New_York")
        finally:
            os.environ.clear()
            os.environ.update(env_backup)

    def test_timezone_not_set_when_empty(self):
        env_backup = os.environ.copy()
        try:
            os.environ.pop("HERMES_TIMEZONE", None)
            child_env = self._get_child_env()
            if "TZ" in child_env:
                self.assertNotEqual(child_env["TZ"], "")
        finally:
            os.environ.clear()
            os.environ.update(env_backup)


# ---------------------------------------------------------------------------
# execute_code edge cases
# ---------------------------------------------------------------------------

class TestExecuteCodeEdgeCases(unittest.TestCase):

    def test_command_argument_points_to_terminal(self):
        result = json.loads(registry.dispatch(
            "execute_code",
            {"command": "git status"},
            task_id="test",
            enabled_tools=list(SANDBOX_ALLOWED_TOOLS),
        ))
        self.assertIn("error", result)
        self.assertIn("'command' parameter", result["error"])
        self.assertIn("terminal(command=...)", result["error"])
        self.assertIn("execute_code(code=...)", result["error"])

    def test_terminal_code_argument_points_to_execute_code(self):
        """Mirror recovery: terminal(code=...) names the stray argument and
        redirects to execute_code, instead of the opaque
        'Invalid command: expected string, got NoneType'."""
        from tools.terminal_tool import _handle_terminal
        result = json.loads(_handle_terminal({"code": "print(1)"}, task_id="test"))
        self.assertIn("error", result)
        self.assertIn("'code' parameter", result["error"])
        self.assertIn("execute_code(code=...)", result["error"])
        self.assertIn("terminal(command=...)", result["error"])
        self.assertNotIn("NoneType", result["error"])

    def test_empty_code_explains_required_parameter(self):
        for code in ("", None):
            with self.subTest(code=code):
                result = json.loads(registry.dispatch(
                    "execute_code",
                    {"code": code},
                    task_id="test",
                ))
                self.assertIn("error", result)
                self.assertIn("non-empty 'code' parameter", result["error"])
                self.assertIn("Python source", result["error"])
                self.assertIn("terminal(command=...)", result["error"])

    def test_non_string_code_redirects_instead_of_attributeerror(self):
        for code in (123, {"code": "print(1)"}, ["print(1)"]):
            with self.subTest(code=code):
                result = json.loads(registry.dispatch(
                    "execute_code",
                    {"code": code},
                    task_id="test",
                ))
                self.assertIn("error", result)
                self.assertIn(type(code).__name__, result["error"])
                self.assertIn("Python source as a string", result["error"])
                self.assertNotIn("AttributeError", result["error"])

    def test_windows_returns_error(self):
        """When SANDBOX_AVAILABLE is False (e.g. when the backend deems
        the sandbox unusable for this environment), execute_code returns
        an error JSON with a readable message pointing the caller at
        regular tool calls.  Previously this was a Windows-only gate;
        execute_code now works on Windows via loopback TCP, so the
        error is only emitted when SANDBOX_AVAILABLE is explicitly
        flipped off (e.g. for future platform-specific disables)."""
        with patch("tools.code_execution_tool.SANDBOX_AVAILABLE", False):
            result = json.loads(execute_code("print('hi')", task_id="test"))
            self.assertIn("error", result)
            self.assertIn("unavailable", result["error"].lower())


    @unittest.skipIf(sys.platform == "win32", "UDS not available on Windows")
    def test_nonoverlapping_tools_fallback(self):
        """When enabled_tools has no overlap with SANDBOX_ALLOWED_TOOLS,
        should fall back to all allowed tools."""
        code = (
            "from hermes_tools import terminal\n"
            "print('fallback ok')\n"
        )
        with patch("model_tools.handle_function_call",
                    return_value=json.dumps({"ok": True})):
            result = json.loads(execute_code(
                code, task_id="test-nonoverlap",
                enabled_tools=["vision_analyze", "browser_snapshot"],
            ))
        self.assertEqual(result["status"], "success")
        self.assertIn("fallback ok", result["output"])


# ---------------------------------------------------------------------------
# _load_config
# ---------------------------------------------------------------------------

class TestLoadConfig(unittest.TestCase):
    def test_returns_empty_dict_when_cli_config_unavailable(self):
        from tools.code_execution_tool import _load_config
        with patch.dict("sys.modules", {"cli": None}):
            result = _load_config()
            self.assertIsInstance(result, dict)


    def test_does_not_import_interactive_cli(self):
        from tools.code_execution_tool import _load_config
        mock_cli = MagicMock()
        mock_cli.CLI_CONFIG = {"code_execution": {"timeout": 999}}
        with patch.dict("sys.modules", {"cli": mock_cli}), \
             patch("hermes_cli.config.read_raw_config", return_value={}):
            result = _load_config()
        self.assertEqual(result, {})


# ---------------------------------------------------------------------------
# Interrupt event
# ---------------------------------------------------------------------------

@unittest.skipIf(sys.platform == "win32", "UDS not available on Windows")
class TestInterruptHandling(unittest.TestCase):
    def test_interrupt_event_stops_execution(self):
        """When interrupt is set for the execution thread, execute_code should stop."""
        code = "import time; time.sleep(60); print('should not reach')"
        from tools.interrupt import set_interrupt

        # Capture the main thread ID so we can target the interrupt correctly.
        # execute_code runs in the current thread; set_interrupt needs its ID.
        main_tid = threading.current_thread().ident

        def set_interrupt_after_delay():
            import time as _t
            _t.sleep(1)
            set_interrupt(True, main_tid)

        t = threading.Thread(target=set_interrupt_after_delay, daemon=True)
        t.start()

        try:
            with patch("model_tools.handle_function_call",
                        return_value=json.dumps({"ok": True})), \
                 patch("tools.code_execution_tool._load_config",
                       return_value={"timeout": 30, "max_tool_calls": 50}):
                result = json.loads(execute_code(
                    code, task_id="test-interrupt",
                    enabled_tools=list(SANDBOX_ALLOWED_TOOLS),
                ))
            self.assertEqual(result["status"], "interrupted")
            self.assertIn("interrupted", result["output"])
        finally:
            set_interrupt(False, main_tid)
            t.join(timeout=3)


class TestHeadTailTruncation(unittest.TestCase):
    """Tests for head+tail truncation of large stdout in execute_code."""

    def _run(self, code):
        with patch("model_tools.handle_function_call", side_effect=_mock_handle_function_call):
            result = execute_code(
                code=code,
                task_id="test-task",
                enabled_tools=list(SANDBOX_ALLOWED_TOOLS),
            )
        return json.loads(result)

    def test_short_output_not_truncated(self):
        """Output under MAX_STDOUT_BYTES should not be truncated."""
        result = self._run('print("small output")')
        self.assertEqual(result["status"], "success")
        self.assertIn("small output", result["output"])
        self.assertNotIn("TRUNCATED", result["output"])


    def test_remote_large_output_gets_truncation_metadata(self):
        """Remote backend output capping is explicit in the JSON result."""
        class FakeEnv:
            def __init__(self):
                self.commands = []

            def get_temp_dir(self):
                return "/tmp"

            def execute(self, command, cwd=None, timeout=None):
                self.commands.append((command, cwd, timeout))
                if "command -v python3" in command:
                    return {"output": "OK\n"}
                if "python3 script.py" in command:
                    return {"output": "HEAD\n" + ("x" * 80_000) + "\nTAIL\n", "returncode": 0}
                return {"output": ""}

        fake_thread = MagicMock()

        with patch("tools.code_execution_tool._load_config", return_value={"timeout": 30, "max_tool_calls": 5}), \
             patch("tools.code_execution_tool._get_or_create_env", return_value=(FakeEnv(), "ssh")), \
             patch("tools.code_execution_tool._ship_file_to_remote"), \
             patch("tools.code_execution_tool.threading.Thread", return_value=fake_thread):
            result = json.loads(_execute_remote("print('large')", "task-1", ["terminal"]))

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["exit_code"], 0)
        self.assertTrue(result["stdout_truncated"])
        self.assertIn("HEAD", result["output"])
        self.assertIn("TAIL", result["output"])
        self.assertGreater(result["stdout_bytes_total"], result["stdout_bytes_captured"])
        self.assertGreater(result["stdout_bytes_omitted"], 0)
        # Spillover (#96997-adjacent): the warning now points at the saved
        # full-output file instead of advising a narrower re-run.
        self.assertIn("execute_code stdout was truncated", result["warning"])
        self.assertIn("read_file", result["warning"])
        self.assertIn("stdout_spill_path", result)
        with open(result["stdout_spill_path"], encoding="utf-8") as f:
            body = f.read()
        self.assertIn("HEAD", body)
        self.assertIn("TAIL", body)


class TestRpcTokenAuthorization(unittest.TestCase):
    """The per-session RPC token must gate socket dispatch (fail-closed).

    Regression coverage for the execute_code tool-socket hardening: a
    request without the matching HERMES_RPC_TOKEN must be rejected before
    the tool is dispatched, while a request carrying the correct token
    round-trips normally.
    """

    def _drive_server(self, rpc_token, requests):
        """Run _rpc_server_loop against a real AF_UNIX socketpair.

        Sends each dict in *requests* as a newline-delimited JSON message
        and returns the list of decoded JSON responses.
        """
        from tools.code_execution_tool import _rpc_server_loop

        # One socketpair per request mirrors the generated per-call client.
        # The listener shim presents each server end through accept().
        pairs = [
            socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
            for _ in requests
        ]
        server_ends = [pair[0] for pair in pairs]
        clients = [pair[1] for pair in pairs]

        class _OneShotListener:
            """Minimal object exposing the .accept()/.settimeout() the loop uses."""

            def __init__(self, connections):
                self._connections = list(connections)

            def settimeout(self, _t):
                pass

            def accept(self):
                if not self._connections:
                    raise socket.timeout()
                return self._connections.pop(0), ("peer", 0)

        listener = _OneShotListener(server_ends)
        stop_event = threading.Event()
        tool_call_log = []
        tool_call_counter = [0]

        def _run():
            with patch(
                "model_tools.handle_function_call",
                side_effect=_mock_handle_function_call,
            ):
                _rpc_server_loop(
                    listener,
                    "test-task",
                    tool_call_log,
                    tool_call_counter,
                    max_tool_calls=10,
                    allowed_tools=frozenset({"terminal"}),
                    stop_event=stop_event,
                    rpc_token=rpc_token,
                )

        from tools.thread_context import propagate_context_to_thread

        t = threading.Thread(
            target=propagate_context_to_thread(_run),
            daemon=True,
        )
        t.start()

        responses = []
        try:
            for client, req in zip(clients, requests):
                client.sendall((json.dumps(req) + "\n").encode())
            for client in clients:
                client.settimeout(5)
                buf = b""
                while True:
                    chunk = client.recv(65536)
                    if not chunk:
                        break
                    buf += chunk
                if buf.strip():
                    responses.append(json.loads(buf.decode().strip()))
        finally:
            stop_event.set()
            for client in clients:
                client.close()
            for server_end in server_ends:
                server_end.close()
            t.join(timeout=5)
        return responses

    def test_missing_token_rejected(self):
        """A request with no token is rejected as Unauthorized."""
        resp = self._drive_server(
            "secret-token", [{"tool": "terminal", "args": {"command": "echo hi"}}]
        )
        self.assertEqual(len(resp), 1)
        self.assertIn("Unauthorized", resp[0].get("error", ""))

    def test_authorized_rpc_projects_each_real_nested_dispatch(self):
        from tools.nested_tool_presentation import nested_tool_presentation_scope

        progress = []
        starts = []
        completes = []
        requests = [
            {
                "tool": "terminal",
                "args": {"command": "printf one"},
                "token": "secret-token",
            },
            {
                "tool": "terminal",
                "args": {"command": "printf two"},
                "token": "secret-token",
            },
        ]
        with nested_tool_presentation_scope(
            parent_tool_call_id="call_outer",
            progress_callback=lambda *a, **kw: progress.append((a, kw)),
            start_callback=lambda *a: starts.append(a),
            complete_callback=lambda *a: completes.append(a),
        ):
            responses = self._drive_server("secret-token", requests)

        self.assertEqual(len(responses), 2)
        self.assertEqual([event[1] for event in starts], ["terminal", "terminal"])
        self.assertEqual(len({event[0] for event in starts}), 2)
        self.assertEqual([event[0][0] for event in progress], [
            "tool.started",
            "tool.completed",
            "tool.started",
            "tool.completed",
        ])
        self.assertEqual(len(completes), 2)
        self.assertTrue(all(
            json.loads(event[3]) == {"status": "completed"}
            for event in completes
        ))

    def test_rejected_rpc_request_has_no_nested_lifecycle(self):
        from tools.nested_tool_presentation import nested_tool_presentation_scope

        starts = []
        with nested_tool_presentation_scope(
            parent_tool_call_id="call_outer",
            start_callback=lambda *a: starts.append(a),
        ):
            responses = self._drive_server(
                "secret-token",
                [{"tool": "terminal", "args": {"command": "id"}}],
            )

        self.assertIn("Unauthorized", responses[0].get("error", ""))
        self.assertEqual(starts, [])

    def test_remote_rpc_projects_the_same_single_dispatch_lifecycle(self):
        from tools.code_execution_tool import _rpc_poll_loop
        from tools.nested_tool_presentation import nested_tool_presentation_scope

        stop_event = threading.Event()
        request_path = "/rpc/req_000001"
        request = {
            "seq": 1,
            "tool": "terminal",
            "args": {"command": "printf remote"},
            "token": "secret-token",
        }

        class FakeEnv:
            def __init__(self):
                self.response_commands = []

            def execute(self, command, cwd=None, timeout=None):
                del cwd, timeout
                if command.startswith("ls -1 "):
                    return {"output": request_path}
                if command == f"cat {request_path}":
                    return {"output": json.dumps(request)}
                if "base64 -d" in command and "/rpc/res_000001" in command:
                    self.response_commands.append(command)
                    stop_event.set()
                    return {"output": ""}
                if command.startswith("rm -f "):
                    return {"output": ""}
                raise AssertionError(f"unexpected remote command: {command}")

        starts = []
        completes = []
        env = FakeEnv()
        with (
            nested_tool_presentation_scope(
                parent_tool_call_id="call_outer",
                start_callback=lambda *a: starts.append(a),
                complete_callback=lambda *a: completes.append(a),
            ),
            patch(
                "model_tools.handle_function_call",
                return_value=json.dumps({"output": "remote ok", "exit_code": 0}),
            ) as dispatch,
        ):
            _rpc_poll_loop(
                env,
                "/rpc",
                "test-task",
                [],
                [0],
                max_tool_calls=10,
                allowed_tools=frozenset({"terminal"}),
                stop_event=stop_event,
                rpc_token="secret-token",
            )

        dispatch.assert_called_once_with(
            "terminal",
            {"command": "printf remote"},
            task_id="test-task",
        )
        self.assertEqual(len(starts), 1)
        self.assertEqual(starts[0][1], "terminal")
        self.assertEqual(len(completes), 1)
        self.assertEqual(json.loads(completes[0][3]), {"status": "completed"})
        self.assertEqual(len(env.response_commands), 1)

    def test_remote_rpc_dispatches_parallel_safe_requests_concurrently(self):
        from tools.code_execution_tool import _rpc_poll_loop
        from tools.nested_tool_presentation import nested_tool_presentation_scope

        stop_event = threading.Event()
        requests = {
            "/rpc/req_000001": {
                "seq": 1,
                "tool": "web_search",
                "args": {"query": "alpha", "limit": 1},
                "token": "secret-token",
            },
            "/rpc/req_000002": {
                "seq": 2,
                "tool": "web_search",
                "args": {"query": "beta", "limit": 1},
                "token": "secret-token",
            },
        }

        class FakeEnv:
            def __init__(self):
                self.removed = set()
                self.response_commands = []
                self.responses = {}

            def execute(self, command, cwd=None, timeout=None):
                del cwd, timeout
                if command.startswith("ls -1 "):
                    pending = [
                        path for path in requests if path not in self.removed
                    ]
                    return {"output": "\n".join(pending)}
                if command.startswith("cat "):
                    path = command[4:]
                    return {"output": json.dumps(requests[path])}
                if "base64 -d" in command and "/rpc/res_" in command:
                    self.response_commands.append(command)
                    encoded = command.split("echo '", 1)[1].split("'", 1)[0]
                    decoded = base64.b64decode(encoded).decode("utf-8")
                    response_path = next(
                        path
                        for path in ("/rpc/res_000001", "/rpc/res_000002")
                        if path in command
                    )
                    self.responses[response_path] = json.loads(decoded)
                    if len(self.response_commands) == len(requests):
                        stop_event.set()
                    return {"output": ""}
                if command.startswith("rm -f "):
                    self.removed.add(command[len("rm -f "):])
                    return {"output": ""}
                raise AssertionError(f"unexpected remote command: {command}")

        rendezvous = threading.Barrier(2)

        def overlapping_dispatch(name, args, task_id=None):
            self.assertEqual(name, "web_search")
            rendezvous.wait(timeout=10)
            return json.dumps({"query": args["query"]})

        starts = []
        completes = []
        env = FakeEnv()
        with (
            nested_tool_presentation_scope(
                parent_tool_call_id="call_outer",
                start_callback=lambda *args: starts.append(args),
                complete_callback=lambda *args: completes.append(args),
            ),
            patch(
                "model_tools.handle_function_call",
                side_effect=overlapping_dispatch,
            ) as dispatch,
        ):
            _rpc_poll_loop(
                env,
                "/rpc",
                "test-task",
                [],
                [0],
                max_tool_calls=10,
                allowed_tools=frozenset({"web_search"}),
                stop_event=stop_event,
                rpc_token="secret-token",
                max_parallel_tool_calls=2,
            )

        self.assertEqual(dispatch.call_count, 2)
        self.assertEqual(len(starts), 2)
        self.assertEqual(len({event[0] for event in starts}), 2)
        self.assertEqual(len(completes), 2)
        self.assertEqual(len(env.response_commands), 2)
        self.assertTrue(any("/rpc/res_000001" in cmd for cmd in env.response_commands))
        self.assertTrue(any("/rpc/res_000002" in cmd for cmd in env.response_commands))
        self.assertEqual(env.responses["/rpc/res_000001"], {"query": "alpha"})
        self.assertEqual(env.responses["/rpc/res_000002"], {"query": "beta"})

    def test_remote_rpc_reader_waits_for_concurrent_terminal_mutation(self):
        """Remote file RPC gives read_file the terminal's committed view."""
        from tools.code_execution_tool import _rpc_poll_loop

        stop_event = threading.Event()
        writer_started = threading.Event()
        release_writer = threading.Event()
        reader_started = threading.Event()
        workspace = {"content": "before"}
        requests = {
            "/rpc/req_000001": {
                "seq": 1,
                "tool": "terminal",
                "args": {"command": "write target"},
                "token": "secret-token",
            },
            "/rpc/req_000002": {
                "seq": 2,
                "tool": "read_file",
                "args": {"path": "target.txt"},
                "token": "secret-token",
            },
        }

        class FakeEnv:
            def __init__(self):
                self.removed = set()
                self.responses = {}

            def execute(self, command, cwd=None, timeout=None):
                del cwd, timeout
                if command.startswith("ls -1 "):
                    pending = [path for path in requests if path not in self.removed]
                    return {"output": "\n".join(pending)}
                if command.startswith("cat "):
                    return {"output": json.dumps(requests[command[4:]])}
                if "base64 -d" in command and "/rpc/res_" in command:
                    encoded = command.split("echo '", 1)[1].split("'", 1)[0]
                    response_path = next(
                        path
                        for path in ("/rpc/res_000001", "/rpc/res_000002")
                        if path in command
                    )
                    self.responses[response_path] = json.loads(
                        base64.b64decode(encoded).decode("utf-8")
                    )
                    if len(self.responses) == 2:
                        stop_event.set()
                    return {"output": ""}
                if command.startswith("rm -f "):
                    self.removed.add(command[len("rm -f "):])
                    return {"output": ""}
                raise AssertionError(f"unexpected remote command: {command}")

        def dispatch(name, _args, task_id=None):
            self.assertEqual(task_id, "test-task")
            if name == "terminal":
                writer_started.set()
                self.assertTrue(release_writer.wait(timeout=5))
                workspace["content"] = "after"
                return json.dumps({"output": "written"})
            if name == "read_file":
                reader_started.set()
                return json.dumps({"content": workspace["content"]})
            self.fail(f"unexpected RPC tool: {name}")

        env = FakeEnv()
        runner = threading.Thread(
            target=_rpc_poll_loop,
            args=(
                env, "/rpc", "test-task", [], [0], 10,
                frozenset({"terminal", "read_file"}), stop_event,
                "secret-token", 2,
            ),
            daemon=True,
        )
        with patch("model_tools.handle_function_call", side_effect=dispatch):
            runner.start()
            self.assertTrue(writer_started.wait(timeout=5))
            self.assertFalse(reader_started.wait(timeout=0.25))
            release_writer.set()
            runner.join(timeout=10)
        self.assertFalse(runner.is_alive())
        self.assertEqual(env.responses["/rpc/res_000002"], {"content": "after"})


    def test_generated_module_sends_token(self):
        """The generated hermes_tools module reads HERMES_RPC_TOKEN and sends it."""
        src = generate_hermes_tools_module(["terminal"], transport="uds")
        self.assertIn("HERMES_RPC_TOKEN", src)
        self.assertIn('"token"', src)


if __name__ == "__main__":
    unittest.main()
