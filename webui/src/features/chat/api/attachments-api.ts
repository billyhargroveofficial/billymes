import { expectRecord, expectString, requestJson } from '@/shared/api'

function attachmentProfile(url: string, profile?: string) {
  // Unlike general dashboard settings, attachments must carry even `default`:
  // the backend then resolves the target profile directory instead of falling
  // back to whichever profile hosts this web process.
  if (!profile || url.includes('profile=')) return url
  return `${url}${url.includes('?') ? '&' : '?'}profile=${encodeURIComponent(profile)}`
}

/**
 * Attachments ride the same conventions the Hermes platforms use: an image
 * uploaded through `/api/chat/image-upload` lands in `HERMES_HOME/images/`
 * (inside the `/api/media` serve roots), any other file is written through the
 * managed-files API, and the resulting gateway-local path is referenced from
 * the prompt text — the agent's `extract_image_refs`/file tooling picks local
 * paths up from there.
 */
export const attachmentsApi = {
  uploadImage: async (
    dataUrl: string,
    filename: string,
    profile?: string,
    signal?: AbortSignal,
  ) => {
    const row = expectRecord(
      await requestJson(attachmentProfile('/api/chat/image-upload', profile), {
        method: 'POST',
        body: JSON.stringify({ data_url: dataUrl, filename }),
        ...(signal ? { signal } : {}),
      }),
      'chat image upload',
    )
    return { path: expectString(row.path, 'chat image upload.path') }
  },

  uploadFile: async (path: string, dataUrl: string, profile?: string, signal?: AbortSignal) => {
    const row = expectRecord(
      await requestJson(attachmentProfile('/api/files/upload', profile), {
        method: 'POST',
        body: JSON.stringify({ path, data_url: dataUrl, overwrite: false }),
        ...(signal ? { signal } : {}),
      }),
      'file upload',
    )
    return { path: expectString(row.path, 'file upload.path') }
  },

  /** Base64 data URL for a gateway-local image inside the media serve roots. */
  media: async (path: string, profile?: string, signal?: AbortSignal) => {
    const row = expectRecord(
      await requestJson(
        attachmentProfile(`/api/media?path=${encodeURIComponent(path)}`, profile),
        signal ? { signal } : {},
      ),
      'media',
    )
    return { dataUrl: expectString(row.data_url, 'media.data_url') }
  },
}
