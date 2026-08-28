"""Dashboard account-usage endpoint regressions."""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
from datetime import datetime, timezone

from agent.account_usage import AccountUsageSnapshot, AccountUsageWindow


def test_account_usage_endpoint_serializes_available_accounts_in_profile_scope(
    monkeypatch,
):
    """Usage remains scoped to the selected profile and exposes only UI-safe fields."""
    import agent.account_usage as account_usage
    import hermes_cli.web_server as web_server

    scoped_profiles: list[str | None] = []
    fetched: list[str] = []

    @contextmanager
    def profile_scope(profile: str | None):
        scoped_profiles.append(profile)
        yield

    reset_at = datetime(2026, 8, 30, 12, 0, tzinfo=timezone.utc)
    snapshots = {
        "openai-codex": AccountUsageSnapshot(
            provider="openai-codex",
            source="usage_api",
            fetched_at=reset_at,
            title="ChatGPT limits",
            plan="Pro",
            windows=(
                AccountUsageWindow(
                    label="5-hour", used_percent=42.5, reset_at=reset_at,
                    detail="42.5% used",
                ),
            ),
            details=("Credits balance: $12.50",),
        ),
        "anthropic": AccountUsageSnapshot(
            provider="anthropic",
            source="usage_api",
            fetched_at=reset_at,
            title="Claude limits",
            windows=(AccountUsageWindow(label="Weekly", used_percent=10.0),),
        ),
    }

    def fetch(provider_id: str):
        fetched.append(provider_id)
        return snapshots[provider_id]

    monkeypatch.setattr(web_server, "_profile_scope", profile_scope)
    monkeypatch.setattr(account_usage, "fetch_account_usage", fetch)

    payload = asyncio.run(web_server.providers_account_usage(profile="profile-a"))

    assert set(fetched) == {"openai-codex", "anthropic"}
    assert scoped_profiles == ["profile-a", "profile-a"]
    assert payload == {
        "accounts": [
            {
                "provider": "openai-codex",
                "plan": "Pro",
                "title": "ChatGPT limits",
                "windows": [{
                    "label": "5-hour",
                    "used_percent": 42.5,
                    "reset_at": "2026-08-30T12:00:00+00:00",
                    "detail": "42.5% used",
                }],
                "details": ["Credits balance: $12.50"],
            },
            {
                "provider": "anthropic",
                "plan": None,
                "title": "Claude limits",
                "windows": [{
                    "label": "Weekly",
                    "used_percent": 10.0,
                    "reset_at": None,
                    "detail": None,
                }],
                "details": [],
            },
        ],
    }


def test_account_usage_endpoint_omits_failed_and_unavailable_providers(monkeypatch):
    """A provider outage must not fail the dashboard endpoint or leak a placeholder."""
    import agent.account_usage as account_usage
    import hermes_cli.web_server as web_server

    unavailable = AccountUsageSnapshot(
        provider="anthropic",
        source="usage_api",
        fetched_at=datetime.now(timezone.utc),
        details=("Login required",),
        unavailable_reason="not_authenticated",
    )

    def fetch(provider_id: str):
        if provider_id == "openai-codex":
            raise RuntimeError("usage API unavailable")
        return unavailable

    monkeypatch.setattr(account_usage, "fetch_account_usage", fetch)

    assert asyncio.run(web_server.providers_account_usage()) == {"accounts": []}
