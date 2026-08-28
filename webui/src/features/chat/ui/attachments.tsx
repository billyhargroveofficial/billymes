import { useQuery } from '@tanstack/react-query'
import {
  Check,
  Copy,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileText,
  FileVideo,
  ImageOff,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useProfileScope } from '@/features/profiles'
import { cn } from '@/shared/lib/cn'
import { Spinner } from '@/shared/ui/spinner'
import { attachmentsApi } from '../api/attachments-api'
import type { MessageAttachment } from '../model/attachments'
import type { PendingAttachment } from '../model/use-attachments'

function fileGlyph(name: string, className: string) {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  const Icon = /^(pdf|docx?|rtf|txt|md|log)$/u.test(ext)
    ? FileText
    : /^(zip|tar|gz|tgz|bz2|xz|7z|rar)$/u.test(ext)
      ? FileArchive
      : /^(mp3|wav|ogg|oga|flac|m4a)$/u.test(ext)
        ? FileAudio
        : /^(mp4|mov|mkv|webm|avi)$/u.test(ext)
          ? FileVideo
          : /^(js|ts|tsx|jsx|py|rs|go|json|yaml|yml|toml|sh|css|html)$/u.test(ext)
            ? FileCode
            : File
  return <Icon className={className} aria-hidden="true" />
}

function fmtBytes(size: number) {
  if (!size) return ''
  if (size >= 1_048_576) return `${(size / 1_048_576).toFixed(1)} МБ`
  if (size >= 1_024) return `${Math.round(size / 1_024)} КБ`
  return `${size} Б`
}

function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div
      role="dialog"
      aria-label={alt}
      className="fixed inset-0 z-[70] grid place-items-center bg-black/75 p-6 backdrop-blur-sm"
    >
      <button
        type="button"
        aria-label="закрыть просмотр"
        onClick={onClose}
        className="absolute right-4 top-4 grid size-9 place-items-center rounded-full border border-line bg-panel/90 text-paper hover:bg-raised"
      >
        <X className="size-4" />
      </button>
      <button type="button" aria-label="закрыть просмотр" className="contents" onClick={onClose}>
        <img
          src={src}
          alt={alt}
          className="max-h-[calc(100vh-3rem)] max-w-full rounded-2xl object-contain shadow-desk"
          draggable={false}
        />
      </button>
    </div>
  )
}

/** Gateway-local image rendered through `/api/media` with a hover-to-zoom. */
function MediaThumb({ path, name }: { path: string; name: string }) {
  const [zoomed, setZoomed] = useState(false)
  const { profile } = useProfileScope()
  const media = useQuery({
    queryKey: ['media', profile, path],
    queryFn: ({ signal }) => attachmentsApi.media(path, profile, signal),
    staleTime: Infinity,
    retry: 1,
  })
  if (media.isPending) {
    return (
      <div className="skeleton grid h-28 w-36 shrink-0 place-items-center rounded-xl border border-line/60" />
    )
  }
  if (media.error || !media.data) {
    return (
      <div
        title={path}
        className="flex h-28 w-36 shrink-0 flex-col items-center justify-center gap-1.5 rounded-xl border border-line/60 bg-raised/40 px-2 text-center"
      >
        <ImageOff className="size-4 text-mute" aria-hidden="true" />
        <span className="w-full truncate text-[10px] text-mute">{name}</span>
      </div>
    )
  }
  return (
    <>
      <button
        type="button"
        title={path}
        aria-label={`открыть ${name}`}
        onClick={() => setZoomed(true)}
        className="card-interactive h-28 shrink-0 overflow-hidden rounded-xl border border-line/60 bg-ink/40"
      >
        <img
          src={media.data.dataUrl}
          alt={name}
          className="h-full w-auto max-w-[16rem] object-cover"
          draggable={false}
        />
      </button>
      {zoomed && <Lightbox src={media.data.dataUrl} alt={name} onClose={() => setZoomed(false)} />}
    </>
  )
}

/** Non-image attachment: glyph, name, and click-to-copy for the gateway path. */
function FileChip({ path, name, hint }: { path: string; name: string; hint?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current)
    },
    [],
  )
  return (
    <button
      type="button"
      title={`${path} — скопировать путь`}
      onClick={() => {
        void navigator.clipboard?.writeText(path).catch(() => undefined)
        setCopied(true)
        if (timer.current) window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setCopied(false), 1300)
      }}
      className="card-interactive flex h-9 max-w-64 shrink-0 items-center gap-2 rounded-xl border border-line/70 bg-raised/50 px-2.5 text-left"
    >
      {fileGlyph(name, 'size-3.5 shrink-0 text-mercury')}
      <span className="min-w-0 flex-1 truncate text-[11px] text-paper/85">{name}</span>
      {hint && <span className="shrink-0 font-mono text-[9px] text-mute">{hint}</span>}
      {copied ? (
        <Check className="size-3 shrink-0 text-ok" aria-hidden="true" />
      ) : (
        <Copy className="size-3 shrink-0 text-mute/60" aria-hidden="true" />
      )}
    </button>
  )
}

/** Attachment previews under a thread message — images first, then files. */
export function MessageAttachments({ attachments }: { attachments: MessageAttachment[] }) {
  if (!attachments.length) return null
  const images = attachments.filter((item) => item.kind === 'image')
  const files = attachments.filter((item) => item.kind === 'file')
  return (
    <div className="space-y-1.5">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {images.map((item) => (
            <MediaThumb key={item.path} path={item.path} name={item.name} />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {files.map((item) => (
            <FileChip key={item.path} path={item.path} name={item.name} />
          ))}
        </div>
      )}
    </div>
  )
}

/** The composer queue: local previews with upload state and remove controls. */
export function PendingAttachmentStrip({
  items,
  onRemove,
}: {
  items: PendingAttachment[]
  onRemove: (id: string) => void
}) {
  if (!items.length) return null
  return (
    <div className="flex flex-wrap gap-1.5 px-3 pt-3">
      {items.map((item) => (
        <PendingChip key={item.id} item={item} onRemove={onRemove} />
      ))}
    </div>
  )
}

function PendingChip({
  item,
  onRemove,
}: {
  item: PendingAttachment
  onRemove: (id: string) => void
}) {
  const failed = item.status === 'error'
  const uploading = item.status === 'uploading'
  let body: ReactNode
  if (item.kind === 'image' && item.previewUrl) {
    body = (
      <img
        src={item.previewUrl}
        alt={item.name}
        className={cn('h-14 w-auto max-w-32 rounded-lg object-cover', uploading && 'opacity-60')}
        draggable={false}
      />
    )
  } else {
    body = (
      <span className="flex h-9 max-w-56 items-center gap-2 px-2.5">
        {fileGlyph(item.name, 'size-3.5 shrink-0 text-mercury')}
        <span className="min-w-0 flex-1 truncate text-[11px] text-paper/85">{item.name}</span>
        <span className="shrink-0 font-mono text-[9px] text-mute">{fmtBytes(item.size)}</span>
      </span>
    )
  }
  return (
    <div
      title={failed ? (item.error ?? 'не удалось загрузить') : item.name}
      className={cn(
        'group/att relative overflow-hidden rounded-xl border bg-raised/60',
        failed ? 'border-ember/60' : 'border-line/70',
      )}
    >
      {body}
      {uploading && (
        <span className="absolute inset-0 grid place-items-center bg-ink/40">
          <Spinner className="size-4 text-mercury" />
        </span>
      )}
      {failed && (
        <span className="absolute inset-x-0 bottom-0 bg-ember/85 px-1.5 py-0.5 text-center text-[9px] leading-3 text-accent-ink">
          не загрузилось
        </span>
      )}
      <button
        type="button"
        aria-label={`убрать ${item.name}`}
        onClick={() => onRemove(item.id)}
        className="absolute right-1 top-1 grid size-5 place-items-center rounded-full border border-line/60 bg-panel/90 text-mute opacity-0 backdrop-blur transition-opacity duration-150 hover:text-paper focus-visible:opacity-100 group-hover/att:opacity-100 pointer-coarse:opacity-100"
      >
        <X className="size-3" aria-hidden="true" />
      </button>
    </div>
  )
}
