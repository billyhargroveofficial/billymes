import { describe, expect, it } from 'vitest'
import { splitFrontmatter } from './frontmatter'

const SKILL = `---
name: web-research-fallbacks
description: "Use for blocked web research."
version: 1.0.1
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [research, web-search]
category: research
---

# Web Research Fallbacks

Тело скилла.
`

describe('splitFrontmatter', () => {
  it('pulls the fields out and leaves the body as markdown', () => {
    const { fields, body } = splitFrontmatter(SKILL)
    expect(fields.map((field) => field.key)).toEqual([
      'name',
      'description',
      'version',
      'platforms',
      'tags',
      'category',
    ])
    expect(body.startsWith('# Web Research Fallbacks')).toBe(true)
    expect(body).not.toContain('name:')
  })

  it('unwraps quotes and list brackets', () => {
    const { fields } = splitFrontmatter(SKILL)
    const byKey = new Map(fields.map((field) => [field.key, field.value]))
    expect(byKey.get('description')).toBe('Use for blocked web research.')
    expect(byKey.get('platforms')).toBe('linux, macos, windows')
  })

  it('leaves content without front matter untouched', () => {
    const plain = 'просто воспоминание\n\nвторой абзац'
    expect(splitFrontmatter(plain)).toEqual({ fields: [], body: plain })
  })

  it('leaves an unterminated block untouched', () => {
    const broken = '---\nname: x\nникогда не закрылся'
    expect(splitFrontmatter(broken)).toEqual({ fields: [], body: broken })
  })

  it('keeps the first value when a key repeats at another depth', () => {
    const { fields } = splitFrontmatter('---\nname: outer\nblock:\n  name: inner\n---\nтело')
    expect(fields).toEqual([{ key: 'name', value: 'outer' }])
  })
})
