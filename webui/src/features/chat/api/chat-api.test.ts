import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiPayloadError } from '@/shared/api'
import { chatApi } from './chat-api'

const displayKey = `display:v1:${'a'.repeat(64)}`

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('chatApi session messages', () => {
  it('accepts Hermes multimodal content blocks while validating their container', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              session_id: 'session-1',
              messages: [
                {
                  id: 55,
                  session_id: 'session-1',
                  role: 'tool',
                  content: [
                    { type: 'text', text: 'safe fixture' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } },
                  ],
                  tool_call_id: 'call-1',
                  tool_calls: null,
                  tool_name: 'browser',
                  timestamp: null,
                  finish_reason: null,
                  reasoning: null,
                  reasoning_content: null,
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    )

    await expect(chatApi.messages('session-1')).resolves.toMatchObject({
      messages: [
        {
          content: [{ type: 'text', text: 'safe fixture' }, { type: 'image_url' }],
        },
      ],
      pagination: { user_turn_offset: 0 },
    })
  })

  it('requests the newest bounded page and advances server offset for older history', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            session_id: 'session-1',
            data: [],
            pagination: { limit: 500, offset: 500, returned: 12, user_turn_offset: 37 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    )
    vi.stubGlobal('fetch', fetch)

    await expect(
      chatApi.messages('session-1', 'work', { limit: 500, offset: 500 }),
    ).resolves.toMatchObject({
      pagination: { limit: 500, offset: 500, returned: 12, user_turn_offset: 37 },
    })

    expect(fetch).toHaveBeenCalledWith(
      '/api/sessions/session-1/messages?include_compacted=true&order=latest&limit=500&offset=500&profile=work',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('uses the server-bounded display-key prefix for an active turn beyond the normal 500-row page', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            session_id: 'session-1',
            messages: [],
            pagination: {
              limit: 500,
              offset: 0,
              returned: 500,
              through_display_key_found: true,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    )
    vi.stubGlobal('fetch', fetch)

    await expect(
      chatApi.messages('session-1', 'work', {
        limit: 500,
        offset: 0,
        throughDisplayKey: displayKey,
      }),
    ).resolves.toMatchObject({ pagination: { through_display_key_found: true } })

    expect(fetch).toHaveBeenCalledWith(
      `/api/sessions/session-1/messages?include_compacted=true&order=latest&limit=500&offset=0&through_display_key=${encodeURIComponent(displayKey)}&profile=work`,
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('keeps the same display-key boundary when requesting the next older page', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            session_id: 'session-1',
            messages: [],
            pagination: {
              limit: 500,
              offset: 500,
              returned: 500,
              through_display_key_found: true,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    )
    vi.stubGlobal('fetch', fetch)

    await chatApi.messages('session-1', 'work', {
      limit: 500,
      offset: 500,
      throughDisplayKey: displayKey,
    })

    expect(fetch).toHaveBeenCalledWith(
      `/api/sessions/session-1/messages?include_compacted=true&order=latest&limit=500&offset=500&through_display_key=${encodeURIComponent(displayKey)}&profile=work`,
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('preserves an absent or false display-key marker for compatibility fallback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              session_id: 'session-1',
              messages: [],
              pagination: { through_display_key_found: false },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    )

    await expect(
      chatApi.messages('session-1', undefined, {
        throughDisplayKey: `display:v1:${'b'.repeat(64)}`,
      }),
    ).resolves.toMatchObject({ pagination: { through_display_key_found: false } })
  })

  it('accepts only the client-safe durable commentary projection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              session_id: 'session-1',
              messages: [
                {
                  id: 55,
                  session_id: 'session-1',
                  role: 'assistant',
                  content: 'final',
                  tool_call_id: null,
                  tool_calls: null,
                  tool_name: null,
                  timestamp: null,
                  finish_reason: 'stop',
                  reasoning: null,
                  reasoning_content: null,
                  interim_messages: [{ id: 'commentary-1', text: 'checking sources' }],
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    )

    await expect(chatApi.messages('session-1')).resolves.toMatchObject({
      messages: [{ interim_messages: [{ id: 'commentary-1', text: 'checking sources' }] }],
    })
  })

  it('rejects malformed durable commentary instead of guessing from provider sidecars', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              session_id: 'session-1',
              messages: [
                {
                  id: 55,
                  session_id: 'session-1',
                  role: 'assistant',
                  content: 'final',
                  tool_call_id: null,
                  tool_calls: null,
                  tool_name: null,
                  timestamp: null,
                  finish_reason: 'stop',
                  reasoning: null,
                  reasoning_content: null,
                  interim_messages: [{ id: 'commentary-1', text: 42 }],
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    )

    await expect(chatApi.messages('session-1')).rejects.toBeInstanceOf(ApiPayloadError)
  })

  it('lists at least 100 sessions in recent-first order', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ sessions: [], total: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    vi.stubGlobal('fetch', fetch)

    await chatApi.sessions()

    expect(fetch).toHaveBeenCalledWith(
      '/api/sessions?order=recent&limit=100',
      expect.objectContaining({ credentials: 'include' }),
    )
  })
})
