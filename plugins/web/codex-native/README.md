# Codex Native Web Search

`codex-native` is a bundled Hermes web-search provider. It reuses the active
profile's `openai-codex` OAuth credential and executes OpenAI's hosted
`web_search` tool through the ChatGPT/Codex Responses endpoint. It does not
need an OpenAI API key, a search API key, a residential proxy, or scraped
search-result pages.

Select it in `config.yaml`:

```yaml
web:
  search_backend: codex-native
  extract_backend: lightpanda-local
  codex_native:
    model: gpt-5.6-luna
    reasoning: low
    search_context_size: medium
    timeout_seconds: 120
```

The bundled backend is discovered automatically; it does not need an entry in
`plugins.enabled`. Authentication remains profile-local. Sign in with
`hermes auth add openai-codex` inside every profile that selects this backend.

The provider sends `store: false`, follows no redirects while carrying the
OAuth token, retries one time after a 401/403 with a forced credential refresh,
and limits response parsing to 1 MiB.
