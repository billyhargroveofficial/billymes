"""Codex hosted web search — bundled provider plugin."""

from __future__ import annotations

from .provider import CodexNativeWebSearchProvider


def register(ctx) -> None:
    """Register the subscription-backed Codex search provider."""
    ctx.register_web_search_provider(CodexNativeWebSearchProvider())
