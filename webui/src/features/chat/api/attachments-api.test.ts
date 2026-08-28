import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachmentsApi } from './attachments-api'

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('attachmentsApi profile ownership', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('includes even the default profile on image and managed-file uploads', async () => {
    const fetch = vi.fn()
    fetch.mockResolvedValueOnce(jsonResponse({ path: '/profiles/default/images/a.png' }))
    fetch.mockResolvedValueOnce(jsonResponse({ path: '/profiles/default/uploads/a.txt' }))
    vi.stubGlobal('fetch', fetch)

    await attachmentsApi.uploadImage('data:image/png;base64,AA==', 'a.png', 'default')
    await attachmentsApi.uploadFile('uploads/a.txt', 'data:text/plain;base64,AA==', 'default')

    expect(fetch.mock.calls[0]?.[0]).toBe('/api/chat/image-upload?profile=default')
    expect(fetch.mock.calls[1]?.[0]).toBe('/api/files/upload?profile=default')
  })

  it('keys media reads to the requested profile without losing the path query', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data_url: 'data:image/png;base64,AA==' }))
    vi.stubGlobal('fetch', fetch)

    await attachmentsApi.media('/profiles/worker/images/a.png', 'worker')

    expect(fetch.mock.calls[0]?.[0]).toBe(
      '/api/media?path=%2Fprofiles%2Fworker%2Fimages%2Fa.png&profile=worker',
    )
  })
})
