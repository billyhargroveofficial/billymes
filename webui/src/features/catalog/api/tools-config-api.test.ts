import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseComputerUseStatus,
  parseConfigSchema,
  parseConfigStringList,
  parseMessagingPlatforms,
  parseTerminalBackends,
  parseToolPolicyConfig,
  toolsConfigApi,
} from './tools-config-api'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('agent config payload', () => {
  it('keeps only the tool policy slice and ignores everything else on the document', () => {
    const parsed = parseToolPolicyConfig({
      model: 'anthropic/claude-sonnet-4.6',
      secrets: { provider: 'must-not-survive' },
      platform_toolsets: { cli: ['web', 'hermes-cli'], discord: ['hermes-discord'] },
      known_builtin_toolsets: { cli: ['web', 'browser'] },
      known_plugin_toolsets: { cli: ['workflow'] },
      agent: { disabled_toolsets: ['bfl', 'image_gen'], max_turns: 500 },
      tools: { tool_search: { enabled: 'auto', threshold_pct: 5, nested: { ignored: true } } },
      tool_output: { max_bytes: 50000, max_lines: 2000 },
      terminal: { backend: 'local', docker_image: 'x' },
    })

    expect(parsed.platformToolsets).toEqual({
      cli: ['web', 'hermes-cli'],
      discord: ['hermes-discord'],
    })
    expect(parsed.disabledToolsets).toEqual(['bfl', 'image_gen'])
    expect(parsed.toolSearch).toEqual({ enabled: 'auto', threshold_pct: 5 })
    expect(parsed.toolOutput).toEqual({ max_bytes: 50000, max_lines: 2000 })
    expect(parsed.terminalBackend).toBe('local')
    expect(JSON.stringify(parsed)).not.toContain('must-not-survive')
  })

  it('parses a deny list Hermes stored as a stringified array', () => {
    expect(parseConfigStringList("['memory', 'web']")).toEqual(['memory', 'web'])
    expect(parseConfigStringList('memory, web')).toEqual(['memory', 'web'])
    expect(parseConfigStringList(['memory', 3, ''])).toEqual(['memory'])
    expect(parseConfigStringList(null)).toEqual([])
  })

  it('survives a config with none of the tool keys set', () => {
    const parsed = parseToolPolicyConfig({})
    expect(parsed).toEqual({
      platformToolsets: {},
      knownBuiltinToolsets: {},
      knownPluginToolsets: {},
      disabledToolsets: [],
      toolSearch: {},
      toolOutput: {},
      terminalBackend: null,
    })
  })
})

describe('runtime payloads', () => {
  it('flattens the config schema by dotted path with its options', () => {
    const parsed = parseConfigSchema({
      fields: {
        'terminal.backend': {
          type: 'select',
          description: 'Terminal execution backend',
          options: ['local', 'docker'],
        },
      },
      category_order: ['general'],
    })
    expect(parsed['terminal.backend']).toEqual({
      path: 'terminal.backend',
      type: 'select',
      description: 'Terminal execution backend',
      options: ['local', 'docker'],
    })
  })

  it('reduces the platform catalog to what the assignment rows need', () => {
    const parsed = parseMessagingPlatforms({
      platforms: [
        {
          id: 'telegram',
          name: 'Telegram',
          enabled: true,
          configured: true,
          state: 'connected',
          env_vars: [{ key: 'TELEGRAM_BOT_TOKEN', redacted_value: '8846...Sh70' }],
        },
      ],
    })
    expect(parsed).toEqual([
      { id: 'telegram', name: 'Telegram', enabled: true, configured: true, state: 'connected' },
    ])
    expect(JSON.stringify(parsed)).not.toContain('Sh70')
  })

  it('keeps the terminal backend probe detail and the computer-use checks', () => {
    const backends = parseTerminalBackends({
      active: 'local',
      backends: [
        {
          name: 'local',
          label: 'Local',
          description: 'no isolation',
          active: true,
          status: 'ready',
          detail: '',
        },
        {
          name: 'modal',
          label: 'Modal',
          description: 'cloud sandbox',
          active: false,
          status: 'needs_setup',
          detail: 'Modal credentials not found',
        },
      ],
    })
    expect(backends.active).toBe('local')
    expect(backends.backends[1]).toMatchObject({
      status: 'needs_setup',
      detail: 'Modal credentials not found',
    })

    const status = parseComputerUseStatus({
      platform: 'linux',
      platform_supported: true,
      installed: true,
      version: 'cua-driver 0.21.0',
      ready: true,
      can_grant: false,
      checks: [{ label: 'display server', status: 'warn', message: 'Wayland only' }],
    })
    expect(status).toMatchObject({ ready: true, canGrant: false, version: 'cua-driver 0.21.0' })
    expect(status.checks).toHaveLength(1)
  })
})

describe('tool config mutations', () => {
  it('sends sparse config patches and scoped toolset writes', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await toolsConfigApi.patchConfig({ platform_toolsets: { cli: ['web'] } }, 'worker')
    await toolsConfigApi.saveToolsetEnv('web', { FIRECRAWL_API_KEY: 'secret' }, 'worker')
    await toolsConfigApi.runPostSetup('browser', 'camofox', 'worker')
    await toolsConfigApi.selectTerminalBackend('docker', 'worker')

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/config?profile=worker')
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('PUT')
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      config: { platform_toolsets: { cli: ['web'] } },
      profile: 'worker',
    })
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/tools/toolsets/web/env?profile=worker')
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      env: { FIRECRAWL_API_KEY: 'secret' },
      profile: 'worker',
    })
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      '/api/tools/toolsets/browser/post-setup?profile=worker',
    )
    expect(fetchMock.mock.calls[3]?.[0]).toBe('/api/tools/terminal/backend?profile=worker')
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({
      backend: 'docker',
      profile: 'worker',
    })
  })
})
