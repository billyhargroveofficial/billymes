"""Tests for commands_enabled config flag in TelegramAdapter."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import MessageEvent, MessageType


def _make_test_adapter(extra=None):
    """Build a TelegramAdapter without running __init__."""
    from plugins.platforms.telegram.adapter import TelegramAdapter

    adapter = object.__new__(TelegramAdapter)
    adapter.platform = Platform.TELEGRAM
    adapter.config = PlatformConfig(
        enabled=True, token="***", extra=extra or {}
    )
    adapter._bot = MagicMock()
    adapter._bot.set_my_commands = AsyncMock()
    adapter._bot.delete_my_commands = AsyncMock()
    adapter._forum_command_registered = set()
    adapter._forum_lock = asyncio.Lock()
    # Stub attributes referenced by _run_post_connect_housekeeping
    adapter._post_connect_task = None
    adapter._set_status_indicator = AsyncMock()
    adapter._setup_dm_topics = AsyncMock()
    return adapter


# ---------------------------------------------------------------------------
# 0. Constructor wiring — real __init__, not object.__new__
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    ("extra", "expected"),
    [
        ({"commands_enabled": "false"}, False),
        ({}, True),
    ],
)
def test_commands_enabled_coerced_in_constructor(extra, expected):
    """Real __init__ coerces extra.commands_enabled into _commands_enabled.

    The tests below bypass __init__ via object.__new__; this one proves the
    wiring that actually sets the flag. __init__ spawns no background
    resources (only attributes; asyncio.Lock/Event are lazy-bound), so no
    cleanup is needed — same as sibling tests that construct TelegramAdapter
    directly (e.g. test_telegram_status_indicator.py).
    """
    from plugins.platforms.telegram.adapter import TelegramAdapter

    adapter = TelegramAdapter(PlatformConfig(enabled=True, token="***", extra=extra))
    assert adapter._commands_enabled is expected


# ---------------------------------------------------------------------------
# 1. Default true — normal registration
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_commands_enabled_default_true_housekeeping():
    """commands_enabled defaults to True — set_my_commands is called for all scopes."""
    adapter = _make_test_adapter()
    adapter._commands_enabled = True

    with patch("telegram.BotCommand") as MockBotCommand:
        MockBotCommand.side_effect = lambda name, desc: SimpleNamespace(
            name=name, description=desc
        )
        with patch("hermes_cli.commands.telegram_menu_commands") as mock_menu:
            mock_menu.return_value = ([("new", "Start new session")], 0)
            with patch("hermes_cli.commands.telegram_menu_max_commands", return_value=60):
                await adapter._run_post_connect_housekeeping()

    assert adapter._bot.set_my_commands.await_count == 3  # Default, AllPrivateChats, AllGroupChats
    adapter._bot.delete_my_commands.assert_not_awaited()


# ---------------------------------------------------------------------------
# 2. Quoted "false" — delete_my_commands on all three scopes
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_commands_enabled_quoted_false_housekeeping():
    """quoted 'false' via extra → delete_my_commands for Default, AllPrivateChats, AllGroupChats.

    Best-effort per scope: the first scope's delete raises, but the call must
    not propagate — the remaining scopes still run and all three calls happen.
    """
    adapter = _make_test_adapter(extra={"commands_enabled": "false"})
    adapter._commands_enabled = False
    adapter._bot.delete_my_commands = AsyncMock(
        side_effect=[RuntimeError("scope failure"), None, None]
    )

    await adapter._run_post_connect_housekeeping()

    adapter._bot.set_my_commands.assert_not_awaited()
    assert adapter._bot.delete_my_commands.await_count == 3


# ---------------------------------------------------------------------------
# 3. Command drop in _handle_command
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_handle_command_drops_when_disabled():
    """_handle_command silently returns before gateway dispatch when disabled."""
    adapter = _make_test_adapter(extra={"commands_enabled": "false"})
    adapter._commands_enabled = False
    adapter._is_user_authorized_from_message = MagicMock(return_value=True)
    adapter._should_process_message = MagicMock(return_value=True)
    adapter._ensure_forum_commands = AsyncMock()
    adapter.handle_message = AsyncMock()

    msg = SimpleNamespace(text="/new", chat=SimpleNamespace(id=123))
    update = SimpleNamespace(message=msg, effective_message=msg, update_id=1)

    await adapter._handle_command(update, None)

    adapter.handle_message.assert_not_awaited()
    adapter._ensure_forum_commands.assert_not_awaited()


# ---------------------------------------------------------------------------
# 4. Cleaned-text bypass drop (@bot /model via text path)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_text_path_drops_mention_command_when_disabled():
    """@bot /model is routed through text path; after _clean_bot_trigger_text
    it's recognized as a slash command and silently dropped."""
    adapter = _make_test_adapter(extra={"commands_enabled": "false"})
    adapter._commands_enabled = False
    adapter._is_user_authorized_from_message = MagicMock(return_value=True)
    adapter._should_process_message = MagicMock(return_value=True)
    adapter._should_observe_unmentioned_group_message = MagicMock(return_value=False)
    adapter._ensure_forum_commands = AsyncMock()
    adapter._cache_replied_media = AsyncMock()
    adapter._apply_telegram_group_observe_attribution = MagicMock(
        side_effect=lambda e: e
    )
    adapter._enqueue_text_event = MagicMock()
    # _clean_bot_trigger_text strips @bot_username prefix — simulate
    # @test_bot /model → /model after cleaning.
    adapter._current_bot_username = MagicMock(return_value="test_bot")

    # Return a MessageEvent whose text after _clean_bot_trigger_text
    # will be "/model", which get_command() recognises.
    adapter._build_message_event = MagicMock(return_value=MessageEvent(
        text="@test_bot /model",
        message_type=MessageType.TEXT,
    ))

    msg = SimpleNamespace(text="@test_bot /model", chat=SimpleNamespace(id=123))
    update = SimpleNamespace(message=msg, effective_message=msg, update_id=1)

    await adapter._handle_text_message(update, None)

    adapter._enqueue_text_event.assert_not_called()


# ---------------------------------------------------------------------------
# 5. Forum path deletes commands instead of setting them
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_forum_commands_delete_when_disabled():
    """Forum lazy path calls delete_my_commands(BotCommandScopeChat) when disabled."""
    adapter = _make_test_adapter(extra={"commands_enabled": "false"})
    adapter._commands_enabled = False

    msg = SimpleNamespace(
        chat=SimpleNamespace(id=-123, is_forum=True),
    )

    with patch("telegram.BotCommandScopeChat") as MockScope:
        MockScope.side_effect = lambda chat_id: SimpleNamespace(chat_id=chat_id)
        await adapter._ensure_forum_commands(msg)

    assert -123 in adapter._forum_command_registered
    adapter._bot.delete_my_commands.assert_awaited_once()
    adapter._bot.set_my_commands.assert_not_awaited()


# ---------------------------------------------------------------------------
# 6. Forum path idempotence when disabled
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_forum_commands_disabled_race_safety():
    """Two concurrent disabled forum calls must delete only once."""
    adapter = _make_test_adapter(extra={"commands_enabled": "false"})
    adapter._commands_enabled = False

    msg = SimpleNamespace(
        chat=SimpleNamespace(id=-789, is_forum=True),
    )

    with patch("telegram.BotCommandScopeChat"):
        coro1 = adapter._ensure_forum_commands(msg)
        coro2 = adapter._ensure_forum_commands(msg)
        await asyncio.gather(coro1, coro2)

    assert adapter._bot.delete_my_commands.await_count == 1


# ---------------------------------------------------------------------------
# 7. Normal text preserved when commands disabled
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_normal_text_preserved_when_commands_disabled():
    """Regular text (not a command) is still processed normally when disabled."""
    adapter = _make_test_adapter(extra={"commands_enabled": "false"})
    adapter._commands_enabled = False
    adapter._is_user_authorized_from_message = MagicMock(return_value=True)
    adapter._should_process_message = MagicMock(return_value=True)
    adapter._should_observe_unmentioned_group_message = MagicMock(return_value=False)
    adapter._ensure_forum_commands = AsyncMock()
    adapter._cache_replied_media = AsyncMock()
    adapter._apply_telegram_group_observe_attribution = MagicMock(
        side_effect=lambda e: e
    )
    adapter._enqueue_text_event = MagicMock()
    adapter._current_bot_username = MagicMock(return_value="test_bot")

    # "hello world" is not a command — it must pass through.
    adapter._build_message_event = MagicMock(return_value=MessageEvent(
        text="hello world",
        message_type=MessageType.TEXT,
    ))

    msg = SimpleNamespace(text="hello world", chat=SimpleNamespace(id=123))
    update = SimpleNamespace(message=msg, effective_message=msg, update_id=1)

    await adapter._handle_text_message(update, None)

    adapter._enqueue_text_event.assert_called_once()
