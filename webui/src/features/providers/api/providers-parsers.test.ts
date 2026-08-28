import { describe, expect, it } from 'vitest'
import {
  parseCustomEndpoints,
  parseEnvVars,
  parseOauthPoll,
  parseOauthProviders,
  parseOauthSession,
  parseOauthSubmit,
  parsePool,
  parseProbe,
} from './providers-parsers'

describe('parseOauthProviders', () => {
  it('reads the live provider shape and normalises empty strings to null', () => {
    const parsed = parseOauthProviders({
      providers: [
        {
          id: 'nous',
          name: 'Nous Portal',
          flow: 'device_code',
          cli_command: 'hermes auth add nous',
          docs_url: 'https://portal.nousresearch.com',
          disconnect_hint: null,
          disconnect_command: null,
          disconnectable: true,
          status: {
            logged_in: false,
            source: 'nous_portal',
            source_label: 'Nous Portal',
            token_preview: '',
            expires_at: null,
            has_refresh_token: false,
          },
        },
      ],
    })
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.flow).toBe('device_code')
    expect(parsed[0]?.status.tokenPreview).toBeNull()
    expect(parsed[0]?.status.loggedIn).toBe(false)
  })

  it('tolerates a status object that omits every optional field', () => {
    const parsed = parseOauthProviders({
      providers: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          flow: 'pkce',
          status: { logged_in: false, source: null },
        },
      ],
    })
    expect(parsed[0]?.status).toEqual({
      loggedIn: false,
      source: null,
      sourceLabel: null,
      tokenPreview: null,
      expiresAt: null,
      hasRefreshToken: false,
      lastRefresh: null,
    })
    expect(parsed[0]?.disconnectable).toBe(false)
  })

  it('keeps epoch-millisecond expiry as a number', () => {
    const parsed = parseOauthProviders({
      providers: [
        {
          id: 'claude-code',
          name: 'Claude Code',
          flow: 'external',
          disconnect_command: 'rm -f ~/.claude/.credentials.json',
          disconnectable: false,
          status: { logged_in: true, expires_at: 1787779256562, token_preview: '…8ikwAA' },
        },
      ],
    })
    expect(parsed[0]?.status.expiresAt).toBe(1787779256562)
    expect(parsed[0]?.disconnectCommand).toBe('rm -f ~/.claude/.credentials.json')
  })

  it('rejects an unknown flow rather than guessing', () => {
    expect(() =>
      parseOauthProviders({ providers: [{ id: 'x', flow: 'magic', status: {} }] }),
    ).toThrow(/unknown OAuth flow/)
  })
})

describe('parseOauthSession', () => {
  it('reads a device-code start response', () => {
    expect(
      parseOauthSession({
        session_id: 'abc',
        flow: 'device_code',
        user_code: 'WXYZ-1234',
        verification_url: 'https://portal/activate?code=WXYZ',
        expires_in: 900,
        poll_interval: 5,
      }),
    ).toEqual({
      sessionId: 'abc',
      flow: 'device_code',
      authUrl: null,
      userCode: 'WXYZ-1234',
      verificationUrl: 'https://portal/activate?code=WXYZ',
      expiresIn: 900,
      pollInterval: 5,
    })
  })

  it('reads a pkce start response', () => {
    const parsed = parseOauthSession({
      session_id: 'sid',
      flow: 'pkce',
      auth_url: 'https://claude.ai/oauth/authorize?x=1',
      expires_in: 600,
    })
    expect(parsed.flow).toBe('pkce')
    expect(parsed.authUrl).toBe('https://claude.ai/oauth/authorize?x=1')
    expect(parsed.pollInterval).toBeNull()
  })
})

describe('parseOauthPoll and parseOauthSubmit', () => {
  it('defaults a missing poll status to pending', () => {
    expect(parseOauthPoll({ session_id: 'sid' })).toEqual({
      sessionId: 'sid',
      status: 'pending',
      errorMessage: null,
      expiresAt: null,
    })
  })

  it('reads a failed submit', () => {
    expect(parseOauthSubmit({ ok: false, status: 'error', message: 'No code provided' })).toEqual({
      ok: false,
      status: 'error',
      message: 'No code provided',
    })
  })
})

describe('parseEnvVars', () => {
  it('turns the key -> descriptor map into a list', () => {
    const parsed = parseEnvVars({
      FIRECRAWL_API_KEY: {
        is_set: true,
        redacted_value: 'fc-l...-key',
        description: 'Firecrawl API key',
        url: 'https://firecrawl.dev/',
        category: 'tool',
        is_password: true,
        tools: ['web_search', 'web_extract'],
        advanced: false,
        channel_managed: false,
        provider: '',
        provider_label: '',
        custom: false,
      },
      NOUS_BASE_URL: {
        is_set: false,
        redacted_value: null,
        description: '',
        url: null,
        category: 'provider',
        is_password: false,
        tools: [],
        advanced: true,
        channel_managed: false,
        provider: '',
        provider_label: '',
        custom: false,
      },
    })
    expect(parsed.map((item) => item.key)).toEqual(['FIRECRAWL_API_KEY', 'NOUS_BASE_URL'])
    expect(parsed[0]?.tools).toEqual(['web_search', 'web_extract'])
    expect(parsed[0]?.redactedValue).toBe('fc-l...-key')
    expect(parsed[1]?.advanced).toBe(true)
    expect(parsed[1]?.redactedValue).toBeNull()
  })

  it('falls back to an "other" category when the gateway omits one', () => {
    expect(parseEnvVars({ SOMETHING: { is_set: false } })[0]?.category).toBe('other')
  })
})

describe('parsePool', () => {
  it('reads pooled entries and keeps the 1-based index', () => {
    const parsed = parsePool({
      providers: [
        {
          provider: 'openai-codex',
          entries: [
            {
              index: 1,
              id: '42383e',
              label: 'personal-pro',
              auth_type: 'oauth',
              source: 'device_code',
              priority: 0,
              last_status: null,
              request_count: 0,
              token_preview: 'eyJh...QWqg',
              has_refresh: true,
            },
          ],
        },
      ],
    })
    expect(parsed[0]?.provider).toBe('openai-codex')
    expect(parsed[0]?.entries[0]?.index).toBe(1)
    expect(parsed[0]?.entries[0]?.hasRefresh).toBe(true)
  })

  it('falls back to the list position when index is missing', () => {
    const parsed = parsePool({
      providers: [{ provider: 'p', entries: [{ id: 'a' }, { id: 'b' }] }],
    })
    expect(parsed[0]?.entries.map((entry) => entry.index)).toEqual([1, 2])
  })
})

describe('parseCustomEndpoints', () => {
  it('reads the empty live payload', () => {
    expect(
      parseCustomEndpoints({
        endpoints: [],
        current: { provider: 'openai-codex', model: 'gpt-5.6-sol', base_url: '' },
      }),
    ).toEqual({
      endpoints: [],
      current: { provider: 'openai-codex', model: 'gpt-5.6-sol', baseUrl: '' },
    })
  })

  it('defaults discover_models to true and drops blank model ids', () => {
    const parsed = parseCustomEndpoints({
      endpoints: [
        {
          id: 'local',
          name: 'Local',
          base_url: 'http://localhost:1234/v1',
          model: 'qwen',
          models: ['qwen', '', 'llama'],
          context_length: null,
          has_api_key: true,
          api_key_preview: '${LOCAL_KEY}',
          is_current: true,
          source: 'providers',
        },
      ],
    })
    expect(parsed.endpoints[0]?.discoverModels).toBe(true)
    expect(parsed.endpoints[0]?.models).toEqual(['qwen', 'llama'])
    expect(parsed.endpoints[0]?.contextLength).toBeNull()
  })
})

describe('parseProbe', () => {
  it('treats a missing reachable flag as reachable', () => {
    expect(parseProbe({ ok: false, message: 'bad key' }, 'probe')).toEqual({
      ok: false,
      reachable: true,
      message: 'bad key',
      models: [],
    })
  })

  it('reads discovered model ids', () => {
    expect(
      parseProbe({ ok: true, reachable: true, message: '', models: ['a', 'b'] }, 'probe').models,
    ).toEqual(['a', 'b'])
  })
})
