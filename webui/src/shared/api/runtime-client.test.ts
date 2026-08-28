import { describe, expect, it } from 'vitest'
import {
  appendRuntimeClient,
  isRuntimeClientId,
  RUNTIME_CLIENT_HEADER,
  RUNTIME_CLIENT_QUERY,
  runtimeClientHeaders,
  runtimeClientId,
} from './runtime-client'

describe('per-tab runtime client identity', () => {
  it('is stable in one JavaScript realm without browser persistence', () => {
    expect(runtimeClientId()).toBe(runtimeClientId())
    expect(runtimeClientId().length).toBeGreaterThanOrEqual(16)
  })

  it('adds the identity to same-origin request headers without dropping callers headers', () => {
    const headers = runtimeClientHeaders({ Accept: 'application/json' }, 'runtime-fixture-1')
    expect(headers.get('Accept')).toBe('application/json')
    expect(headers.get(RUNTIME_CLIENT_HEADER)).toBe('runtime-fixture-1')
  })

  it('adds the identity to relative and absolute WebSocket URLs', () => {
    expect(appendRuntimeClient('/api/ws?ticket=safe', 'runtime-fixture-1')).toBe(
      `/api/ws?ticket=safe&${RUNTIME_CLIENT_QUERY}=runtime-fixture-1`,
    )
    expect(
      new URL(
        appendRuntimeClient('wss://dashboard.test/api/ws', 'runtime-fixture-1'),
      ).searchParams.get(RUNTIME_CLIENT_QUERY),
    ).toBe('runtime-fixture-1')
  })

  it('accepts opaque high-entropy-shaped IDs and rejects unsafe or short values', () => {
    expect(isRuntimeClientId('runtime-fixture-1')).toBe(true)
    expect(isRuntimeClientId('a'.repeat(16))).toBe(false)
    expect(isRuntimeClientId('too-short')).toBe(false)
    expect(isRuntimeClientId('runtime id with spaces')).toBe(false)
    expect(isRuntimeClientId('x'.repeat(129))).toBe(false)
  })
})
