import { afterEach, describe, expect, it, vi } from 'vitest'
import { voiceApi } from './voice-api'

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('voiceApi profile ownership', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('includes the default profile instead of inheriting the dashboard process home', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ transcript: 'готово' }))
    vi.stubGlobal('fetch', fetch)

    await voiceApi.transcribe('data:audio/webm;base64,AA==', 'audio/webm', 'default')

    expect(fetch.mock.calls[0]?.[0]).toBe('/api/audio/transcribe?profile=default')
  })
})
