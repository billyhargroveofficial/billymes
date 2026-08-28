"""Durable, display-only cards for provider and sandbox tool lifecycles.

The normal session transcript is model input.  Provider-hosted Responses calls
and Programmatic Tool Calling children must *not* be written there: they are
not Hermes function calls and replaying them as such changes both execution
semantics and prompt-cache behaviour.  This small sidecar is deliberately a
separate SQLite database per Hermes profile.  It stores only the redacted card
identity/state needed to redraw a Dashboard after a reconnect or restart.
"""

from __future__ import annotations

import json
import math
import re
import sqlite3
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit


DB_NAME = "presentation.db"
MAX_CARDS_PER_SESSION = 256
MAX_CARDS_TOTAL = 10_000
MAX_LIST_LIMIT = 256
_MAX_TEXT = 320
_MAX_ERROR = 180
_SECRET_KEY = re.compile(
    r"(?:api[_-]?key|authorization|cookie|credential|password|secret|token|"
    r"session|private[_-]?key)",
    re.IGNORECASE,
)
_URL_IN_TEXT = re.compile(r"https?://[^\s<>'\"`]+", re.IGNORECASE)


def _is_valid_turn_index(value: object) -> bool:
    """The UI turn index is one-based; zero means "not attached"."""
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _clip(value: object, limit: int = _MAX_TEXT, *, sanitize_urls: bool = True) -> str:
    text = str(value or "").strip()
    if sanitize_urls:
        # A hosted command/preview can contain an URL rather than consist only
        # of one.  It is still an egress boundary, so keep the useful host/path
        # and remove credentials, query strings, and fragments there too.
        text = _URL_IN_TEXT.sub(lambda match: _safe_url(match.group(0)), text)
    if len(text) > limit:
        text = f"{text[:limit]}…"
    try:
        from agent.redact import redact_sensitive_text

        text = redact_sensitive_text(text, force=True, redact_url_credentials=True)
    except Exception:
        pass
    return text


def _safe_url(value: str) -> str:
    value = value.strip()
    try:
        parsed = urlsplit(value)
    except ValueError:
        return _clip(value)
    if not parsed.scheme or not parsed.netloc:
        return _clip(value)
    # Query strings often carry signed URLs/tokens.  Card previews only need
    # the origin and path, never credentials, query, or fragment.
    try:
        host = parsed.hostname or ""
        if parsed.port:
            host = f"{host}:{parsed.port}"
    except ValueError:
        return _clip(value)
    return _clip(
        urlunsplit((parsed.scheme, host, parsed.path, "", "")), sanitize_urls=False
    )


def redact_presentation_value(value: Any, *, depth: int = 0) -> Any:
    """Return a small JSON-compatible safe projection of tool arguments."""
    if depth >= 4:
        return "[omitted]"
    if isinstance(value, dict):
        cleaned: dict[str, Any] = {}
        for raw_key, raw_value in list(value.items())[:16]:
            key = _clip(raw_key, 64)
            if not key or _SECRET_KEY.search(key):
                continue
            cleaned[key] = redact_presentation_value(raw_value, depth=depth + 1)
        return cleaned
    if isinstance(value, (list, tuple)):
        return [redact_presentation_value(item, depth=depth + 1) for item in value[:8]]
    if isinstance(value, str):
        return (
            _safe_url(value)
            if value.strip().startswith(("http://", "https://"))
            else _clip(value)
        )
    if isinstance(value, float) and not math.isfinite(value):
        return "[omitted]"
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return _clip(value)


def _encode_args(args: Any) -> str:
    try:
        return json.dumps(
            redact_presentation_value(args), ensure_ascii=False, separators=(",", ":")
        )
    except (TypeError, ValueError):
        return "{}"


def _decode_args(raw: object) -> dict[str, Any]:
    try:
        value = json.loads(str(raw or "{}"))
    except (TypeError, ValueError):
        value = {}
    return value if isinstance(value, dict) else {}


class PresentationLedger:
    """A bounded per-profile sidecar; it never opens or mutates ``state.db``."""

    def __init__(self, profile_home: str | Path):
        self.path = Path(profile_home) / DB_NAME

    def _connect(self, *, write: bool) -> sqlite3.Connection | None:
        if not write and not self.path.exists():
            return None
        if write:
            self.path.parent.mkdir(parents=True, exist_ok=True)
        # A tool lifecycle must not block the model turn for a long database
        # wait.  Individual writes below retry short SQLITE_BUSY windows, which
        # covers concurrent gateway threads and a first-use schema migration.
        connection = sqlite3.connect(self.path, timeout=1.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout=1000")
        if write:
            with connection:
                connection.execute("PRAGMA journal_mode=WAL")
                connection.execute("PRAGMA synchronous=NORMAL")
                connection.execute(
                    """
                CREATE TABLE IF NOT EXISTS presentation_cards (
                    ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    turn_id TEXT NOT NULL DEFAULT '',
                    turn_index INTEGER,
                    card_id TEXT NOT NULL,
                    origin TEXT NOT NULL,
                    name TEXT NOT NULL,
                    args_json TEXT NOT NULL,
                    preview TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'running',
                    ok INTEGER,
                    error TEXT,
                    duration_s REAL,
                    started_at REAL NOT NULL,
                    completed_at REAL,
                    updated_at REAL NOT NULL,
                    UNIQUE(session_id, turn_id, card_id)
                )
                """
                )
                connection.execute(
                    "CREATE INDEX IF NOT EXISTS idx_presentation_cards_session "
                    "ON presentation_cards(session_id, ordinal)"
                )
                # v1 shipped without turn ownership.  First add the two fields
                # in-place so existing data stays readable throughout migration.
                # Then rebuild only this sidecar table when its v1 unique key
                # would otherwise collapse an identical provider item id in two
                # different turns.  ``state.db`` is never opened or changed.
                columns = {
                    str(row["name"])
                    for row in connection.execute(
                        "PRAGMA table_info(presentation_cards)"
                    )
                }
                if "turn_id" not in columns:
                    connection.execute(
                        "ALTER TABLE presentation_cards ADD COLUMN turn_id TEXT NOT NULL DEFAULT ''"
                    )
                if "turn_index" not in columns:
                    connection.execute(
                        "ALTER TABLE presentation_cards ADD COLUMN turn_index INTEGER"
                    )
                unique_keys = []
                for index in connection.execute(
                    "PRAGMA index_list(presentation_cards)"
                ):
                    if not index["unique"]:
                        continue
                    index_name = str(index["name"])
                    unique_keys.append(
                        tuple(
                            str(column["name"])
                            for column in connection.execute(
                                f"PRAGMA index_info({index_name!r})"
                            )
                        )
                    )
                if ("session_id", "turn_id", "card_id") not in unique_keys:
                    connection.execute(
                        "ALTER TABLE presentation_cards RENAME TO presentation_cards_v1"
                    )
                    connection.execute(
                        """
                        CREATE TABLE presentation_cards (
                            ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
                            session_id TEXT NOT NULL,
                            turn_id TEXT NOT NULL DEFAULT '',
                            turn_index INTEGER,
                            card_id TEXT NOT NULL,
                            origin TEXT NOT NULL,
                            name TEXT NOT NULL,
                            args_json TEXT NOT NULL,
                            preview TEXT NOT NULL DEFAULT '',
                            status TEXT NOT NULL DEFAULT 'running',
                            ok INTEGER,
                            error TEXT,
                            duration_s REAL,
                            started_at REAL NOT NULL,
                            completed_at REAL,
                            updated_at REAL NOT NULL,
                            UNIQUE(session_id, turn_id, card_id)
                        )
                        """
                    )
                    connection.execute(
                        """
                        INSERT INTO presentation_cards
                            (ordinal, session_id, turn_id, turn_index, card_id, origin, name,
                             args_json, preview, status, ok, error, duration_s, started_at,
                             completed_at, updated_at)
                        SELECT ordinal, session_id, COALESCE(turn_id, ''), turn_index, card_id,
                               origin, name, args_json, preview, status, ok, error, duration_s,
                               started_at, completed_at, updated_at
                        FROM presentation_cards_v1
                        """
                    )
                    connection.execute("DROP TABLE presentation_cards_v1")
                # The rebuild above drops indexes attached to the old sidecar
                # table, so install both lookup indexes after migration.
                connection.execute(
                    "CREATE INDEX IF NOT EXISTS idx_presentation_cards_session "
                    "ON presentation_cards(session_id, ordinal)"
                )
                connection.execute(
                    "CREATE INDEX IF NOT EXISTS idx_presentation_cards_turn "
                    "ON presentation_cards(session_id, turn_index, ordinal)"
                )
        return connection

    @staticmethod
    def _is_busy(error: sqlite3.Error) -> bool:
        text = str(error).lower()
        return "locked" in text or "busy" in text

    def _write(self, operation) -> bool:
        """Run a short sidecar transaction, tolerating transient SQLite locks."""
        for attempt in range(3):
            connection: sqlite3.Connection | None = None
            try:
                connection = self._connect(write=True)
                assert connection is not None
                with connection:
                    operation(connection)
                return True
            except sqlite3.Error as error:
                if not self._is_busy(error) or attempt == 2:
                    return False
                # Another gateway thread can be creating/migrating this tiny
                # sidecar.  A bounded retry is preferable to losing a card.
                time.sleep(0.025 * (2**attempt))
            finally:
                if connection is not None:
                    connection.close()
        return False

    @staticmethod
    def _origin(card_id: str) -> str | None:
        if card_id.startswith("hosted_"):
            return "hosted"
        if card_id.startswith("sandbox_"):
            return "nested"
        return None

    def start(
        self,
        session_id: str,
        card_id: str,
        name: str,
        args: Any,
        preview: str = "",
        *,
        turn_id: str | None = None,
        turn_index: int | None = None,
    ) -> None:
        origin = self._origin(str(card_id))
        if not session_id or not origin:
            return
        now = time.time()

        def write(connection: sqlite3.Connection) -> None:
            connection.execute(
                """
                    INSERT INTO presentation_cards
                        (session_id, turn_id, turn_index, card_id, origin, name, args_json, preview, status, started_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
                    ON CONFLICT(session_id, turn_id, card_id) DO UPDATE SET
                        turn_index=excluded.turn_index,
                        name=excluded.name,
                        args_json=excluded.args_json,
                        preview=CASE WHEN excluded.preview <> '' THEN excluded.preview ELSE presentation_cards.preview END,
                        updated_at=excluded.updated_at
                    """,
                (
                    session_id,
                    str(turn_id or ""),
                    turn_index if _is_valid_turn_index(turn_index) else None,
                    card_id,
                    origin,
                    _clip(name, 120) or "tool",
                    _encode_args(args),
                    _clip(preview, 160),
                    now,
                    now,
                ),
            )
            self._trim(connection, session_id)

        # Presentation persistence is optional; an exhausted lock/failure must
        # never affect the actual model turn.
        self._write(write)

    def complete(
        self,
        session_id: str,
        card_id: str,
        name: str,
        args: Any,
        *,
        duration_s: float | None,
        is_error: bool,
        error: object = "",
        turn_id: str | None = None,
        turn_index: int | None = None,
    ) -> None:
        origin = self._origin(str(card_id))
        if not session_id or not origin:
            return
        now = time.time()
        safe_duration = (
            max(0.0, float(duration_s))
            if isinstance(duration_s, (int, float))
            and not isinstance(duration_s, bool)
            and math.isfinite(float(duration_s))
            else None
        )
        status = "error" if is_error else "done"

        def write(connection: sqlite3.Connection) -> None:
            connection.execute(
                """
                    INSERT INTO presentation_cards
                        (session_id, turn_id, turn_index, card_id, origin, name, args_json, status, ok, error,
                         duration_s, started_at, completed_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(session_id, turn_id, card_id) DO UPDATE SET
                        turn_index=excluded.turn_index,
                        name=excluded.name,
                        args_json=excluded.args_json,
                        -- A duplicate terminal callback after a provider
                        -- failure must not repaint the durable card as a
                        -- success merely because its error metadata was
                        -- omitted by the duplicate frame.
                        status=CASE WHEN presentation_cards.status = 'error'
                            THEN presentation_cards.status ELSE excluded.status END,
                        ok=CASE WHEN presentation_cards.status = 'error'
                            THEN presentation_cards.ok ELSE excluded.ok END,
                        error=CASE WHEN presentation_cards.status = 'error'
                            THEN presentation_cards.error ELSE excluded.error END,
                        duration_s=COALESCE(excluded.duration_s, presentation_cards.duration_s),
                        completed_at=excluded.completed_at,
                        updated_at=excluded.updated_at
                    """,
                (
                    session_id,
                    str(turn_id or ""),
                    turn_index if _is_valid_turn_index(turn_index) else None,
                    card_id,
                    origin,
                    _clip(name, 120) or "tool",
                    _encode_args(args),
                    status,
                    0 if is_error else 1,
                    _clip(error, _MAX_ERROR) if is_error else None,
                    safe_duration,
                    now,
                    now,
                    now,
                ),
            )
            self._trim(connection, session_id)

        self._write(write)

    def list(
        self, session_id: str, *, limit: int = MAX_LIST_LIMIT
    ) -> tuple[list[dict[str, Any]], int]:
        """Return one session's cards in durable insertion order."""
        return self.list_many((session_id,), limit=limit)

    def list_many(
        self, session_ids: Any, *, limit: int = MAX_LIST_LIMIT
    ) -> tuple[list[dict[str, Any]], int]:
        """Return one bounded, chronological card stream across session ids.

        Context compression rotates a durable conversation onto a child
        ``session_id``.  The display ledger deliberately does not participate
        in that state transition, so callers pass the *compression-only*
        root-to-tip lineage here.  ``ordinal`` is global to this sidecar and
        therefore provides a stable cross-segment order without synthesising
        transcript rows.  A repeated id in ``session_ids`` is ignored, but
        distinct cards with the same provider id remain separate rows when
        their session/turn identity differs.
        """
        ids = list(
            dict.fromkeys(
                str(item).strip() for item in session_ids if str(item).strip()
            )
        )
        if not ids:
            return [], 0
        safe_limit = max(1, min(int(limit), MAX_LIST_LIMIT))
        try:
            connection = self._connect(write=False)
        except sqlite3.Error:
            return [], 0
        if connection is None:
            return [], 0
        try:
            placeholders = ",".join("?" for _ in ids)
            total_row = connection.execute(
                "SELECT COUNT(*) AS count FROM presentation_cards "
                f"WHERE session_id IN ({placeholders})",
                ids,
            ).fetchone()
            total = int(total_row["count"] if total_row else 0)
            rows = connection.execute(
                f"""
                SELECT ordinal, turn_id, turn_index, card_id, origin, name, args_json, preview, status, ok, error,
                       duration_s, started_at, completed_at
                FROM presentation_cards
                WHERE session_id IN ({placeholders})
                ORDER BY ordinal DESC
                LIMIT ?
                """,
                [*ids, safe_limit],
            ).fetchall()
            cards = [
                {
                    "id": row["card_id"],
                    "sequence": int(row["ordinal"]),
                    "turn_id": row["turn_id"] or None,
                    "turn_index": row["turn_index"],
                    "origin": row["origin"],
                    "name": row["name"],
                    "args": _decode_args(row["args_json"]),
                    "preview": row["preview"] or "",
                    "status": row["status"],
                    "ok": None if row["ok"] is None else bool(row["ok"]),
                    "error": row["error"],
                    "duration_s": row["duration_s"],
                    "started_at": row["started_at"],
                    "completed_at": row["completed_at"],
                }
                for row in reversed(rows)
            ]
            return cards, total
        except sqlite3.Error:
            return [], 0
        finally:
            connection.close()

    def count(self, session_id: str) -> int:
        """Return one session's display-only card count without transcript I/O."""
        return self.count_many((session_id,)).get(session_id, 0)

    def count_many(self, session_ids: Any) -> dict[str, int]:
        """Count cards for a page of sessions in one sidecar SELECT.

        This is intentionally independent from ``tool_call_count`` in
        ``state.db``: provider-hosted and sandbox cards are presentation only,
        not model transcript tool calls.
        """
        ids = list(
            dict.fromkeys(
                str(item).strip() for item in session_ids if str(item).strip()
            )
        )
        if not ids:
            return {}
        try:
            connection = self._connect(write=False)
        except sqlite3.Error:
            return {}
        if connection is None:
            return {}
        try:
            placeholders = ",".join("?" for _ in ids)
            rows = connection.execute(
                "SELECT session_id, COUNT(*) AS count FROM presentation_cards "
                f"WHERE session_id IN ({placeholders}) GROUP BY session_id",
                ids,
            ).fetchall()
            return {str(row["session_id"]): int(row["count"]) for row in rows}
        except sqlite3.Error:
            return {}
        finally:
            connection.close()

    @staticmethod
    def _trim(connection: sqlite3.Connection, session_id: str) -> None:
        connection.execute(
            """
            DELETE FROM presentation_cards
            WHERE session_id = ? AND ordinal NOT IN (
                SELECT ordinal FROM presentation_cards
                WHERE session_id = ? ORDER BY ordinal DESC LIMIT ?
            )
            """,
            (session_id, session_id, MAX_CARDS_PER_SESSION),
        )
        connection.execute(
            """
            DELETE FROM presentation_cards
            WHERE ordinal NOT IN (
                SELECT ordinal FROM presentation_cards ORDER BY ordinal DESC LIMIT ?
            )
            """,
            (MAX_CARDS_TOTAL,),
        )


__all__ = [
    "DB_NAME",
    "MAX_CARDS_PER_SESSION",
    "MAX_LIST_LIMIT",
    "PresentationLedger",
    "redact_presentation_value",
]
