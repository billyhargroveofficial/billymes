"""Regression coverage for durable, display-only hosted/nested tool cards."""

from __future__ import annotations

import contextlib
import sqlite3
import threading
from types import SimpleNamespace

from hermes_state import SessionDB
from tui_gateway import server
from tui_gateway.presentation_ledger import MAX_CARDS_PER_SESSION, PresentationLedger


def test_presentation_cards_survive_restart_without_transcript_rows(tmp_path):
    """The sidecar is durable but never creates model-visible state rows."""
    home = tmp_path / "profile"
    home.mkdir()
    state = home / "state.db"
    with sqlite3.connect(state) as connection:
        connection.execute(
            "CREATE TABLE messages (id INTEGER PRIMARY KEY, content TEXT)"
        )
        connection.execute("INSERT INTO messages (content) VALUES ('actual user turn')")

    ledger = PresentationLedger(home)
    ledger.start(
        "session-a",
        "hosted_search-1",
        "web_search",
        {"query": "Python docs"},
        "Python docs",
        turn_id="turn-a",
        turn_index=1,
    )
    ledger.complete(
        "session-a",
        "hosted_search-1",
        "web_search",
        {"query": "Python docs"},
        duration_s=1.25,
        is_error=False,
        turn_id="turn-a",
        turn_index=1,
    )

    # A new object models a fresh gateway process opening the same profile.
    cards, total = PresentationLedger(home).list("session-a")
    assert total == 1
    assert cards == [
        {
            "id": "hosted_search-1",
            "sequence": cards[0]["sequence"],
            "turn_id": "turn-a",
            "turn_index": 1,
            "origin": "hosted",
            "name": "web_search",
            "args": {"query": "Python docs"},
            "preview": "Python docs",
            "status": "done",
            "ok": True,
            "error": None,
            "duration_s": 1.25,
            "started_at": cards[0]["started_at"],
            "completed_at": cards[0]["completed_at"],
        }
    ]
    with sqlite3.connect(state) as connection:
        assert connection.execute("SELECT content FROM messages").fetchall() == [
            ("actual user turn",)
        ]
    assert (home / "presentation.db").exists()


def test_presentation_ledger_redacts_and_bounds_cards(tmp_path):
    ledger = PresentationLedger(tmp_path)
    ledger.start(
        "session-a",
        "hosted_sensitive",
        "web_search",
        {
            "query": "normal",
            "authorization": "Bearer definitely-not-stored",
            "url": "https://user:password@example.test/a?token=leaked#fragment",
            "command": "curl https://user:password@example.test/private?token=leaked#fragment",
            "whitespace_url": "  https://user:password@example.test/space?token=leaked",
            "too_deep": {"a": {"b": {"c": {"d": "omit-me"}}}},
            "many": list(range(12)),
        },
        turn_id="turn-a",
        turn_index=2,
    )
    cards, _ = ledger.list("session-a")
    args = cards[0]["args"]
    assert "authorization" not in args
    assert args["url"] == "https://example.test/a"
    assert args["command"] == "curl https://example.test/private"
    assert args["whitespace_url"] == "https://example.test/space"
    assert args["too_deep"]["a"]["b"]["c"] == "[omitted]"
    assert args["many"] == list(range(8))
    assert "definitely-not-stored" not in repr(cards)
    assert "password" not in repr(cards)
    assert "token=leaked" not in repr(cards)


def test_presentation_ledger_rejects_nonfinite_values_and_zero_turn_index(tmp_path):
    ledger = PresentationLedger(tmp_path)
    ledger.start(
        "session-a",
        "hosted_values",
        "web_search",
        {"nan": float("nan"), "infinity": float("inf")},
        turn_id="turn-a",
        turn_index=0,
    )
    ledger.complete(
        "session-a",
        "hosted_values",
        "web_search",
        {},
        duration_s=float("inf"),
        is_error=False,
        turn_id="turn-a",
        turn_index=0,
    )
    cards, _ = ledger.list("session-a")
    assert cards[0]["turn_index"] is None
    assert cards[0]["args"] == {}
    assert cards[0]["duration_s"] is None

    for index in range(MAX_CARDS_PER_SESSION + 3):
        ledger.start(
            "session-b",
            f"hosted_{index}",
            "web_search",
            {"query": str(index)},
            turn_id="turn-b",
            turn_index=1,
        )
    bounded, total = ledger.list("session-b", limit=MAX_CARDS_PER_SESSION)
    assert total == MAX_CARDS_PER_SESSION
    assert len(bounded) == MAX_CARDS_PER_SESSION
    assert bounded[0]["id"] == "hosted_3"


def test_v1_migration_keeps_same_card_id_in_two_turns(tmp_path):
    """Old sidecars had UNIQUE(session_id, card_id); migrate before upsert."""
    path = tmp_path / "presentation.db"
    with sqlite3.connect(path) as connection:
        connection.execute(
            """
            CREATE TABLE presentation_cards (
                ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL, card_id TEXT NOT NULL, origin TEXT NOT NULL,
                name TEXT NOT NULL, args_json TEXT NOT NULL, preview TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'running', ok INTEGER, error TEXT,
                duration_s REAL, started_at REAL NOT NULL, completed_at REAL,
                updated_at REAL NOT NULL, UNIQUE(session_id, card_id)
            )
            """
        )
        connection.execute(
            """
            INSERT INTO presentation_cards
              (session_id, card_id, origin, name, args_json, started_at, updated_at)
            VALUES ('session-a', 'hosted_reused', 'hosted', 'web_search', '{}', 1, 1)
            """
        )
    ledger = PresentationLedger(tmp_path)
    ledger.start(
        "session-a",
        "hosted_reused",
        "web_search",
        {"query": "next"},
        turn_id="turn-b",
        turn_index=2,
    )
    cards, total = PresentationLedger(tmp_path).list("session-a")
    assert total == 2
    assert [(card["turn_id"], card["id"]) for card in cards] == [
        (None, "hosted_reused"),
        ("turn-b", "hosted_reused"),
    ]


def test_cold_list_preserves_two_turn_groups_and_card_order(tmp_path):
    ledger = PresentationLedger(tmp_path)
    for turn_id, turn_index, card_id in (
        ("turn-one", 1, "hosted_first"),
        ("turn-one", 1, "sandbox_second"),
        ("turn-two", 2, "hosted_third"),
    ):
        ledger.start(
            "session-a",
            card_id,
            "web_search",
            {"query": card_id},
            turn_id=turn_id,
            turn_index=turn_index,
        )
    # Simulate a gateway restart/cold reload, not an in-memory replay.
    cards, total = PresentationLedger(tmp_path).list("session-a")
    assert total == 3
    assert [(card["turn_id"], card["turn_index"], card["id"]) for card in cards] == [
        ("turn-one", 1, "hosted_first"),
        ("turn-one", 1, "sandbox_second"),
        ("turn-two", 2, "hosted_third"),
    ]


def test_presentation_rpc_keeps_same_session_key_isolated_by_profile(
    monkeypatch, tmp_path
):
    homes = {"alpha": tmp_path / "alpha", "beta": tmp_path / "beta"}
    for profile, home in homes.items():
        PresentationLedger(home).start(
            "same-session-key",
            f"hosted_{profile}",
            "web_search",
            {"query": profile},
            turn_id=f"turn-{profile}",
            turn_index=1,
        )

    @contextlib.contextmanager
    def no_state_db(_params):
        yield None

    monkeypatch.setattr(server, "_profile_home", lambda profile: homes.get(profile))
    monkeypatch.setattr(server, "_profile_db", no_state_db)

    alpha = server._methods["session.presentation.list"](
        "rpc-alpha", {"session_id": "same-session-key", "profile": "alpha"}
    )
    beta = server._methods["session.presentation.list"](
        "rpc-beta", {"session_id": "same-session-key", "profile": "beta"}
    )
    assert [card["id"] for card in alpha["result"]["cards"]] == ["hosted_alpha"]
    assert [card["id"] for card in beta["result"]["cards"]] == ["hosted_beta"]


def test_presentation_rpc_replays_compression_lineage_per_profile(monkeypatch, tmp_path):
    """A sidebar compression tip must retain cards from every old segment."""
    homes = {"alpha": tmp_path / "alpha", "beta": tmp_path / "beta"}
    tips = {}
    for profile, home in homes.items():
        db = SessionDB(home / "state.db")
        try:
            root = db.create_session("root", "dashboard")
            db.append_message(root, "user", f"{profile} before compression")
            db.end_session(root, "compression")
            tip = db.create_session("tip", "dashboard", parent_session_id=root)
            db.append_message(tip, "user", f"{profile} after compression")
            tips[profile] = tip
        finally:
            db.close()
        ledger = PresentationLedger(home)
        ledger.start(
            root,
            f"hosted_{profile}_root",
            "web_search",
            {"query": f"{profile} root"},
            turn_index=1,
        )
        ledger.start(
            tip,
            f"hosted_{profile}_tip",
            "web_search",
            {"query": f"{profile} tip"},
            turn_index=2,
        )

    @contextlib.contextmanager
    def profile_db(params):
        db = SessionDB(homes[params["profile"]] / "state.db")
        try:
            yield db
        finally:
            db.close()

    monkeypatch.setattr(server, "_profile_home", lambda profile: homes.get(profile))
    monkeypatch.setattr(server, "_profile_db", profile_db)

    alpha = server._methods["session.presentation.list"](
        "rpc-alpha", {"session_id": tips["alpha"], "profile": "alpha", "limit": 256}
    )
    beta = server._methods["session.presentation.list"](
        "rpc-beta", {"session_id": tips["beta"], "profile": "beta", "limit": 256}
    )

    assert alpha["result"]["session_id"] == tips["alpha"]
    assert alpha["result"]["total"] == 2
    assert [card["id"] for card in alpha["result"]["cards"]] == [
        "hosted_alpha_root",
        "hosted_alpha_tip",
    ]
    assert [card["id"] for card in beta["result"]["cards"]] == [
        "hosted_beta_root",
        "hosted_beta_tip",
    ]


def test_presentation_lineage_list_keeps_latest_256_cards_in_global_order(tmp_path):
    ledger = PresentationLedger(tmp_path)
    for index in range(MAX_CARDS_PER_SESSION):
        ledger.start("root", f"hosted_root_{index}", "web_search", {"query": index})
    for index in range(4):
        ledger.start("tip", f"hosted_tip_{index}", "web_search", {"query": index})

    cards, total = ledger.list_many(("root", "tip"), limit=MAX_CARDS_PER_SESSION)

    assert total == MAX_CARDS_PER_SESSION + 4
    assert len(cards) == MAX_CARDS_PER_SESSION
    assert cards[0]["id"] == "hosted_root_4"
    assert cards[-1]["id"] == "hosted_tip_3"


def test_concurrent_first_writes_preserve_every_hosted_batch_card(tmp_path):
    """A four-query hosted batch may settle on concurrent gateway callbacks."""
    ledger = PresentationLedger(tmp_path)
    ready = threading.Barrier(4)
    errors = []

    def persist(index: int) -> None:
        try:
            ready.wait(timeout=2)
            ledger.start(
                "session-a",
                f"hosted_batch-{index}",
                "web_search",
                {"query": f"query {index}"},
                turn_id="turn-a",
                turn_index=1,
            )
            ledger.complete(
                "session-a",
                f"hosted_batch-{index}",
                "web_search",
                {"query": f"query {index}"},
                duration_s=0.5 + index,
                is_error=False,
                turn_id="turn-a",
                turn_index=1,
            )
        except Exception as error:  # pragma: no cover - test diagnosis only
            errors.append(error)

    threads = [threading.Thread(target=persist, args=(index,)) for index in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=5)

    assert not errors
    assert not any(thread.is_alive() for thread in threads)
    cards, total = PresentationLedger(tmp_path).list("session-a")
    assert total == 4
    assert {(card["id"], card["status"], card["duration_s"]) for card in cards} == {
        (f"hosted_batch-{index}", "done", 0.5 + index) for index in range(4)
    }


def test_hosted_and_nested_errors_persist_and_emit_non_success(monkeypatch, tmp_path):
    events = []
    sid = "gateway-live"
    agent = SimpleNamespace(_current_turn_id="turn-2", _user_turn_count=2)
    monkeypatch.setattr(
        server,
        "_emit",
        lambda event, session, payload: events.append((event, session, payload)),
    )
    monkeypatch.setitem(
        server._sessions,
        sid,
        {
            "session_key": "stored-session",
            "profile_home": tmp_path,
            "agent": agent,
            "tool_progress_mode": "all",
        },
    )

    for call_id in ("hosted_failed", "sandbox_failed"):
        server._on_tool_start(sid, call_id, "web_search", {"query": call_id})
        # Completion must retain the turn at start, not attach the card to a
        # later turn if the agent advances while provider settlement arrives.
        agent._current_turn_id = "later-turn"
        agent._user_turn_count = 99
        # No duration is intentional: status must not depend on it.
        server._on_tool_progress(
            sid,
            "tool.completed",
            "web_search",
            tool_call_id=call_id,
            is_error=True,
            result="provider denied request",
        )
        server._on_tool_complete(
            sid, call_id, "web_search", {"query": call_id}, "provider denied request"
        )

    complete = [payload for event, _, payload in events if event == "tool.complete"]
    assert [payload["status"] for payload in complete] == ["error", "error"]
    assert all(payload["ok"] is False for payload in complete)
    assert all(payload["error"] == "provider denied request" for payload in complete)
    cards, total = PresentationLedger(tmp_path).list("stored-session")
    assert total == 2
    assert [
        (
            card["origin"],
            card["status"],
            card["ok"],
            card["turn_id"],
            card["turn_index"],
        )
        for card in cards
    ] == [
        ("hosted", "error", False, "turn-2", 2),
        ("nested", "error", False, "later-turn", 99),
    ]

    reply = server._methods["session.presentation.list"](
        "rpc-1", {"session_id": sid, "limit": 10}
    )
    assert reply["result"]["session_id"] == "stored-session"
    assert [card["id"] for card in reply["result"]["cards"]] == [
        "hosted_failed",
        "sandbox_failed",
    ]


def test_duplicate_terminal_event_stays_on_original_turn_and_keeps_duration(
    monkeypatch, tmp_path
):
    sid = "gateway-live"
    agent = SimpleNamespace(_current_turn_id="turn-one", _user_turn_count=1)
    monkeypatch.setitem(
        server._sessions,
        sid,
        {"session_key": "stored-session", "profile_home": tmp_path, "agent": agent},
    )

    server._on_tool_start(sid, "hosted_duplicate", "web_search", {"query": "one"})
    server._on_tool_progress(
        sid,
        "tool.completed",
        "web_search",
        tool_call_id="hosted_duplicate",
        duration=2.4,
    )
    server._on_tool_complete(
        sid, "hosted_duplicate", "web_search", {"query": "one"}, "done"
    )

    # A late duplicate terminal frame must not attach a second card to the
    # next turn or overwrite the provider's explicit duration with a 0.0s one.
    agent._current_turn_id = "turn-two"
    agent._user_turn_count = 2
    server._on_tool_complete(
        sid, "hosted_duplicate", "web_search", {"query": "one"}, "done"
    )

    cards, total = PresentationLedger(tmp_path).list("stored-session")
    assert total == 1
    assert cards[0]["turn_id"] == "turn-one"
    assert cards[0]["turn_index"] == 1
    assert cards[0]["duration_s"] == 2.4


def test_duplicate_success_cannot_overwrite_a_persisted_terminal_error(tmp_path):
    ledger = PresentationLedger(tmp_path)
    ledger.complete(
        "session-a",
        "hosted_failed",
        "web_search",
        {"query": "one"},
        duration_s=1.1,
        is_error=True,
        error="provider denied request",
        turn_id="turn-one",
        turn_index=1,
    )
    # Some compatibility layers send a bare duplicate completion after an
    # error. Preserve the terminal failure rather than turning it green.
    ledger.complete(
        "session-a",
        "hosted_failed",
        "web_search",
        {"query": "one"},
        duration_s=None,
        is_error=False,
        turn_id="turn-one",
        turn_index=1,
    )
    cards, _ = ledger.list("session-a")
    assert cards[0]["status"] == "error"
    assert cards[0]["ok"] is False
    assert cards[0]["error"] == "provider denied request"


def test_terminal_only_card_snapshots_its_turn_for_a_late_duplicate(
    monkeypatch, tmp_path
):
    sid = "terminal-only"
    agent = SimpleNamespace(_current_turn_id="turn-one", _user_turn_count=1)
    monkeypatch.setitem(
        server._sessions,
        sid,
        {"session_key": "stored-session", "profile_home": tmp_path, "agent": agent},
    )
    server._on_tool_complete(
        sid, "hosted_terminal", "web_search", {"query": "one"}, "done"
    )
    agent._current_turn_id = "turn-two"
    agent._user_turn_count = 2
    server._on_tool_complete(
        sid, "hosted_terminal", "web_search", {"query": "one"}, "done"
    )

    cards, total = PresentationLedger(tmp_path).list("stored-session")
    assert total == 1
    assert (cards[0]["turn_id"], cards[0]["turn_index"]) == ("turn-one", 1)


def test_presentation_turn_snapshot_cache_is_bounded(monkeypatch, tmp_path):
    sid = "bounded-snapshots"
    monkeypatch.setitem(
        server._sessions,
        sid,
        {
            "session_key": "stored-session",
            "profile_home": tmp_path,
            "agent": SimpleNamespace(_current_turn_id="turn", _user_turn_count=1),
        },
    )

    for index in range(server._PRESENTATION_TURN_SNAPSHOT_LIMIT + 3):
        server._presentation_turn_for_session(sid, f"hosted_{index}")

    snapshots = server._sessions[sid]["presentation_turns"]
    assert len(snapshots) == server._PRESENTATION_TURN_SNAPSHOT_LIMIT
    assert "hosted_0" not in snapshots
    assert f"hosted_{server._PRESENTATION_TURN_SNAPSHOT_LIMIT + 2}" in snapshots
