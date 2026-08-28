import { describe, expect, it } from 'vitest'
import {
  attachmentMarker,
  baseName,
  findImagePaths,
  isImagePath,
  splitAttachments,
} from './attachments'

describe('attachmentMarker', () => {
  it('formats the platform marker convention', () => {
    expect(attachmentMarker('image', '/home/u/.hermes/images/a.png')).toBe(
      '[Image attached at: /home/u/.hermes/images/a.png]',
    )
    expect(attachmentMarker('file', '/home/u/.hermes/uploads/report.pdf')).toBe(
      '[File attached at: /home/u/.hermes/uploads/report.pdf]',
    )
  })
})

describe('splitAttachments', () => {
  it('lifts markers out of the text and keeps the rest', () => {
    const input =
      'скок стоит\n\n[Image attached at: /workspace/user/.hermes/cache/images/img_1.jpg]\n[screenshot]'
    const { text, attachments } = splitAttachments(input)
    expect(attachments).toEqual([
      { kind: 'image', path: '/workspace/user/.hermes/cache/images/img_1.jpg', name: 'img_1.jpg' },
    ])
    expect(text).toBe('скок стоит\n\n[screenshot]')
  })

  it('classifies non-image markers as files and dedupes repeats', () => {
    const input =
      '[File attached at: /home/u/.hermes/uploads/data.csv]\n' +
      '[File attached at: /home/u/.hermes/uploads/data.csv]\nвот файл'
    const { text, attachments } = splitAttachments(input)
    expect(attachments).toEqual([
      { kind: 'file', path: '/home/u/.hermes/uploads/data.csv', name: 'data.csv' },
    ])
    expect(text).toBe('вот файл')
  })

  it('returns the input untouched when there are no markers', () => {
    const { text, attachments } = splitAttachments('обычное сообщение')
    expect(text).toBe('обычное сообщение')
    expect(attachments).toEqual([])
  })

  it('treats an Image marker with a non-image path as a file by extension', () => {
    const { attachments } = splitAttachments('[File attached at: /tmp/shot.png]')
    expect(attachments[0]?.kind).toBe('image')
  })
})

describe('findImagePaths', () => {
  it('finds bare local image paths in prose', () => {
    const text = 'сохранил в /workspace/user/.hermes/screenshots/shot.png и ~/pics/b.webp'
    expect(findImagePaths(text)).toEqual([
      '/workspace/user/.hermes/screenshots/shot.png',
      '~/pics/b.webp',
    ])
  })

  it('skips code fences, inline code and urls', () => {
    const text =
      'см `/tmp/example.png` и\n```\n/tmp/fenced.png\n```\nа ещё https://x.io/pic.png\nно /tmp/real.png'
    expect(findImagePaths(text)).toEqual(['/tmp/real.png'])
  })

  it('dedupes repeated mentions', () => {
    expect(findImagePaths('/a/b.png снова /a/b.png')).toEqual(['/a/b.png'])
  })
})

describe('path helpers', () => {
  it('isImagePath follows the agent allowlist', () => {
    expect(isImagePath('/x/a.HEIC')).toBe(true)
    expect(isImagePath('/x/a.pdf')).toBe(false)
  })
  it('baseName trims directories', () => {
    expect(baseName('/home/u/files/report v2.pdf')).toBe('report v2.pdf')
  })
})
