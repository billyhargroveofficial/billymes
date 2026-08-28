import { expectRecord, requestJson } from '@/shared/api'

function voiceProfile(url: string, profile?: string) {
  // Voice configuration is profile-owned just like an attachment.  Carry
  // `default` explicitly rather than treating it as the dashboard process's
  // implicit home: a shared dashboard can itself be hosted from another
  // profile.
  if (!profile || url.includes('profile=')) return url
  return `${url}${url.includes('?') ? '&' : '?'}profile=${encodeURIComponent(profile)}`
}

export const voiceApi = {
  /**
   * Sends a recorded clip to the gateway's STT provider. Resolves to the
   * transcript; an empty string means the recording contained no speech.
   */
  transcribe: async (
    dataUrl: string,
    mimeType: string,
    profile?: string,
    signal?: AbortSignal,
  ): Promise<string> => {
    const payload = expectRecord(
      await requestJson(voiceProfile('/api/audio/transcribe', profile), {
        method: 'POST',
        body: JSON.stringify({ data_url: dataUrl, mime_type: mimeType }),
        ...(signal ? { signal } : {}),
      }),
      'transcription',
    )
    return typeof payload.transcript === 'string' ? payload.transcript.trim() : ''
  },
}
