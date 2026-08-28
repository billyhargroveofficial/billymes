import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { errorMessage } from '@/shared/lib/error-message'
import { attachmentsApi } from '../api/attachments-api'
import { attachmentMarker, isImagePath, type AttachmentKind } from './attachments'
import { createAsyncScopeGuard } from './async-scope'

export type PendingAttachment = {
  id: string
  kind: AttachmentKind
  name: string
  size: number
  status: 'uploading' | 'ready' | 'error'
  /** Browser-side object URL for instant image previews. */
  previewUrl: string | null
  remotePath: string | null
  error: string | null
}

type QueuedAttachment = PendingAttachment & {
  /** Prevent an old profile's queue from reappearing after A → B → A. */
  scopeGeneration: number
}

function attachmentKindOf(file: File): AttachmentKind {
  if (file.type.startsWith('image/')) return 'image'
  return isImagePath(file.name) ? 'image' : 'file'
}

function safeFileName(name: string) {
  const trimmed = name.trim().replace(/[^\p{L}\p{N}._-]+/gu, '_')
  return trimmed.replace(/^[._-]+/u, '').slice(0, 96) || 'file'
}

function readAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('файл не прочитался'))
    reader.readAsDataURL(file)
  })
}

/**
 * Composer attachment queue. Files upload to the gateway as soon as they are
 * added — images through the chat image endpoint, everything else into
 * the selected profile's `uploads/` via the managed-files API — and the send
 * path turns the ready ones into `[… attached at: path]` marker lines.
 */
export function useAttachments(profile: string) {
  const [items, setItems] = useState<QueuedAttachment[]>([])
  const [scope, setScope] = useState({ profile, generation: 0 })
  if (scope.profile !== profile) {
    // This is derived state for the UI identity, not an effect-driven reset:
    // React immediately re-renders with a new generation before exposing the
    // new profile. Keeping old queue rows internally lets cleanup revoke their
    // previews without ever showing them again after A → B → A.
    setScope({ profile, generation: scope.generation + 1 })
  }
  const itemsRef = useRef(items)
  const counter = useRef(0)
  const uploadsRef = useRef(new Map<string, AbortController>())
  const scopeGuardRef = useRef(createAsyncScopeGuard({ profile, scopeKey: profile }))

  const visibleItems = useMemo<PendingAttachment[]>(
    () => items.filter((item) => item.scopeGeneration === scope.generation),
    [items, scope.generation],
  )

  useEffect(() => {
    itemsRef.current = items
  }, [items])

  useEffect(
    () => () => {
      for (const controller of uploadsRef.current.values()) controller.abort()
      uploadsRef.current.clear()
      for (const item of itemsRef.current) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
      }
    },
    [],
  )

  useLayoutEffect(() => {
    // Commit the asynchronous scope before the browser can dispatch an event
    // into the new profile. Older FileReader/fetch completions are rejected by
    // this guard, while the render generation above prevents visual revival.
    scopeGuardRef.current.setScope({ profile, scopeKey: profile })
    // A prompt marker is meaningful only in the profile that owns the upload.
    // Abort in-flight fetches where possible; the generation guard also covers
    // FileReader and servers that finish despite an abort. The old queue is
    // hidden by its generation rather than reset from an effect.
    for (const controller of uploadsRef.current.values()) controller.abort()
    uploadsRef.current.clear()
  }, [profile])

  const patch = useCallback((id: string, update: Partial<PendingAttachment>) => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...update } : item)))
  }, [])

  const addFiles = useCallback(
    (files: Iterable<File>) => {
      for (const file of files) {
        const scope = scopeGuardRef.current.capture()
        const controller = new AbortController()
        counter.current += 1
        const id = `att-${counter.current}-${file.name}`
        uploadsRef.current.set(id, controller)
        const kind = attachmentKindOf(file)
        const previewUrl = kind === 'image' ? URL.createObjectURL(file) : null
        setItems((current) => [
          ...current,
          {
            id,
            kind,
            name: file.name || 'файл',
            size: file.size,
            status: 'uploading',
            previewUrl,
            remotePath: null,
            error: null,
            scopeGeneration: scope.generation,
          },
        ])
        void (async () => {
          try {
            const dataUrl = await readAsDataUrl(file)
            if (
              !scopeGuardRef.current.isCurrent(scope) ||
              uploadsRef.current.get(id) !== controller
            ) {
              return
            }
            const uploaded =
              kind === 'image'
                ? await attachmentsApi.uploadImage(dataUrl, file.name, profile, controller.signal)
                : await attachmentsApi.uploadFile(
                    `uploads/${new Date()
                      .toISOString()
                      .replace(/[:.]/gu, '-')}_${safeFileName(file.name)}`,
                    dataUrl,
                    profile,
                    controller.signal,
                  )
            if (
              !scopeGuardRef.current.isCurrent(scope) ||
              uploadsRef.current.get(id) !== controller
            ) {
              return
            }
            patch(id, { status: 'ready', remotePath: uploaded.path })
          } catch (error) {
            if (
              !scopeGuardRef.current.isCurrent(scope) ||
              uploadsRef.current.get(id) !== controller
            ) {
              return
            }
            patch(id, { status: 'error', error: errorMessage(error, 'не удалось загрузить') })
          } finally {
            if (uploadsRef.current.get(id) === controller) uploadsRef.current.delete(id)
          }
        })()
      }
    },
    [patch, profile, scope.generation],
  )

  const remove = useCallback((id: string) => {
    uploadsRef.current.get(id)?.abort()
    uploadsRef.current.delete(id)
    setItems((current) => {
      const target = current.find((item) => item.id === id)
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
      return current.filter((item) => item.id !== id)
    })
  }, [])

  const clear = useCallback(() => {
    for (const item of itemsRef.current) {
      if (item.scopeGeneration !== scope.generation) continue
      uploadsRef.current.get(item.id)?.abort()
      uploadsRef.current.delete(item.id)
    }
    setItems((current) => {
      for (const item of current) {
        if (item.scopeGeneration !== scope.generation) continue
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
      }
      return current.filter((item) => item.scopeGeneration !== scope.generation)
    })
  }, [scope.generation])

  const markers = useCallback(
    () =>
      itemsRef.current
        .filter(
          (item) =>
            item.scopeGeneration === scope.generation && item.status === 'ready' && item.remotePath,
        )
        .map((item) => attachmentMarker(item.kind, item.remotePath as string)),
    [scope.generation],
  )

  return { items: visibleItems, addFiles, remove, clear, markers }
}
