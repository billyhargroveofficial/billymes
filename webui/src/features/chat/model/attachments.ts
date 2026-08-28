export type AttachmentKind = 'image' | 'file'

export type MessageAttachment = {
  kind: AttachmentKind
  path: string
  name: string
}

/** Mirrors the agent's `_IMAGE_EXTS` allowlist in `agent/image_routing.py`. */
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic)$/iu

export function isImagePath(path: string) {
  return IMAGE_EXT_RE.test(path)
}

export function baseName(path: string) {
  const clean = path.replace(/[/\\]+$/u, '')
  const index = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'))
  return index >= 0 ? clean.slice(index + 1) : clean
}

/**
 * The prompt-side convention shared with the messaging platforms: the marker
 * puts a gateway-local path into the turn text, and the agent attaches the
 * pixels (images) or reads the file from disk (everything else).
 */
export function attachmentMarker(kind: AttachmentKind, path: string) {
  return kind === 'image' ? `[Image attached at: ${path}]` : `[File attached at: ${path}]`
}

const MARKER_RE = /\[(Image|File) attached at:\s*([^\]\n]+)\]/gu

/**
 * Pulls attachment markers out of a message body for display: the marker
 * lines disappear from the text and come back as structured attachments.
 */
export function splitAttachments(text: string): {
  text: string
  attachments: MessageAttachment[]
} {
  if (!text || !text.includes('attached at:')) return { text, attachments: [] }
  const attachments: MessageAttachment[] = []
  const seen = new Set<string>()
  const remainder = text.replace(MARKER_RE, (_match, kind: string, rawPath: string) => {
    const path = rawPath.trim()
    if (path && !seen.has(path)) {
      seen.add(path)
      attachments.push({
        kind: kind === 'Image' || isImagePath(path) ? 'image' : 'file',
        path,
        name: baseName(path),
      })
    }
    return ''
  })
  const cleaned = remainder
    .replace(/[^\S\n]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
  return { text: cleaned, attachments }
}

/**
 * Bare gateway-local image paths mentioned in agent prose (the agent often
 * answers with «сохранил в /home/…/shot.png»). Fenced and inline code spans
 * are skipped so path examples in snippets do not become previews.
 */
const LOCAL_IMAGE_PATH_RE =
  /(?<![/:\w.])(?:~\/|\/)(?:[\w.-]+\/)*[\w.-]+\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic)\b/giu

export function findImagePaths(text: string): string[] {
  if (!text) return []
  const spans: Array<[number, number]> = []
  for (const match of text.matchAll(/```[^\n]*\n[\s\S]*?```/gu)) {
    spans.push([match.index, match.index + match[0].length])
  }
  for (const match of text.matchAll(/`[^`\n]+`/gu)) {
    spans.push([match.index, match.index + match[0].length])
  }
  const inCode = (at: number) => spans.some(([start, end]) => at >= start && at < end)
  const out: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(LOCAL_IMAGE_PATH_RE)) {
    if (inCode(match.index)) continue
    const path = match[0]
    if (seen.has(path)) continue
    seen.add(path)
    out.push(path)
  }
  return out
}
