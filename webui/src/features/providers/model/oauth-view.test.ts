import { describe, expect, it } from 'vitest'
import {
  connectedCount,
  connectionSummary,
  expiryLabel,
  expiryMillis,
  flowLabel,
  isTerminalOauthStatus,
  oauthStatusLabel,
  pollIntervalMs,
} from './oauth-view'
import type { OauthProvider, OauthSession } from './types'

function provider(overrides: Partial<OauthProvider> = {}): OauthProvider {
  return {
    id: 'nous',
    name: 'Nous Portal',
    flow: 'device_code',
    cliCommand: 'hermes auth add nous',
    docsUrl: null,
    disconnectHint: null,
    disconnectCommand: null,
    disconnectable: true,
    status: {
      loggedIn: false,
      source: null,
      sourceLabel: null,
      tokenPreview: null,
      expiresAt: null,
      hasRefreshToken: false,
      lastRefresh: null,
    },
    ...overrides,
  }
}

describe('isTerminalOauthStatus', () => {
  it('keeps polling while pending or unknown', () => {
    expect(isTerminalOauthStatus('pending')).toBe(false)
    expect(isTerminalOauthStatus(null)).toBe(false)
    expect(isTerminalOauthStatus(undefined)).toBe(false)
  })

  it('stops on every terminal status the gateway can set', () => {
    for (const status of ['approved', 'error', 'expired', 'cancelled', 'denied']) {
      expect(isTerminalOauthStatus(status)).toBe(true)
    }
  })
})

describe('oauthStatusLabel', () => {
  it('translates the known statuses', () => {
    expect(oauthStatusLabel('pending')).toBe('ждём подтверждения')
    expect(oauthStatusLabel('approved')).toBe('подключено')
    expect(oauthStatusLabel('expired')).toBe('код истёк')
  })

  it('passes an unknown status through unchanged', () => {
    expect(oauthStatusLabel('weird')).toBe('weird')
  })
})

describe('expiryMillis', () => {
  it('parses an ISO timestamp', () => {
    expect(expiryMillis('2026-08-26T06:39:32.207Z')).toBe(Date.parse('2026-08-26T06:39:32.207Z'))
  })

  it('passes epoch milliseconds through', () => {
    expect(expiryMillis(1787779256562)).toBe(1787779256562)
  })

  it('promotes epoch seconds to milliseconds', () => {
    expect(expiryMillis(1787779256)).toBe(1787779256000)
  })

  it('rejects unusable values', () => {
    expect(expiryMillis(null)).toBeNull()
    expect(expiryMillis(0)).toBeNull()
    expect(expiryMillis('never')).toBeNull()
  })
})

describe('expiryLabel', () => {
  const now = Date.parse('2026-08-26T00:00:00.000Z')

  it('reports an expired credential', () => {
    expect(expiryLabel(now - 1000, now)).toBe('срок истёк')
  })

  it('scales the unit with the remaining time', () => {
    expect(expiryLabel(now + 30 * 60_000, now)).toBe('истекает через 30 мин')
    expect(expiryLabel(now + 3 * 3_600_000, now)).toBe('истекает через 3 ч')
    expect(expiryLabel(now + 2 * 86_400_000, now)).toBe('истекает через 2 дн')
  })

  it('returns null when there is nothing to show', () => {
    expect(expiryLabel(null, now)).toBeNull()
  })
})

describe('connectionSummary', () => {
  const now = Date.parse('2026-08-26T00:00:00.000Z')

  it('is empty for a disconnected provider', () => {
    expect(connectionSummary(provider(), now)).toEqual([])
  })

  it('flattens source, preview, expiry and refresh into one line', () => {
    const summary = connectionSummary(
      provider({
        status: {
          loggedIn: true,
          source: 'pool:personal-pro',
          sourceLabel: 'chatgpt',
          tokenPreview: '…HXQWqg',
          expiresAt: now + 3_600_000,
          hasRefreshToken: true,
          lastRefresh: null,
        },
      }),
      now,
    )
    expect(summary).toEqual(['chatgpt', '…HXQWqg', 'истекает через 1 ч', 'есть refresh'])
  })

  it('falls back to the raw source slug when there is no label', () => {
    const summary = connectionSummary(
      provider({
        status: {
          loggedIn: true,
          source: 'claude_code_cli',
          sourceLabel: null,
          tokenPreview: null,
          expiresAt: null,
          hasRefreshToken: false,
          lastRefresh: null,
        },
      }),
      now,
    )
    expect(summary).toEqual(['claude_code_cli'])
  })
})

describe('connectedCount and flowLabel', () => {
  it('counts only logged-in providers', () => {
    expect(
      connectedCount([
        provider(),
        provider({ id: 'a', status: { ...provider().status, loggedIn: true } }),
        provider({ id: 'b', status: { ...provider().status, loggedIn: true } }),
      ]),
    ).toBe(2)
  })

  it('labels each flow', () => {
    expect(flowLabel('pkce')).toBe('pkce')
    expect(flowLabel('device_code')).toBe('код устройства')
    expect(flowLabel('external')).toBe('внешний cli')
  })
})

describe('pollIntervalMs', () => {
  const session: OauthSession = {
    sessionId: 's',
    flow: 'device_code',
    authUrl: null,
    userCode: 'X',
    verificationUrl: null,
    expiresIn: 900,
    pollInterval: 5,
  }

  it('uses the gateway hint in milliseconds', () => {
    expect(pollIntervalMs(session)).toBe(5000)
  })

  it('clamps to a sane window and defaults without a hint', () => {
    expect(pollIntervalMs({ ...session, pollInterval: 0 })).toBe(2000)
    expect(pollIntervalMs({ ...session, pollInterval: 600 })).toBe(15_000)
    expect(pollIntervalMs({ ...session, pollInterval: null })).toBe(2000)
    expect(pollIntervalMs(null)).toBe(2000)
  })
})
