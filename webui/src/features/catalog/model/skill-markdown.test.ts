import { describe, expect, it } from 'vitest'
import { splitSkillMarkdown } from './skill-markdown'

describe('splitSkillMarkdown', () => {
  it('extracts flat frontmatter and removes a duplicate top-level title', () => {
    expect(
      splitSkillMarkdown('---\nname: "Agent Skill"\nversion: 2\n---\n# Agent Skill\n\nBody'),
    ).toEqual({ meta: { name: 'Agent Skill', version: '2' }, body: 'Body' })
  })

  it('leaves ordinary Markdown intact apart from surrounding whitespace', () => {
    expect(splitSkillMarkdown('\n# Plain\n')).toEqual({ meta: {}, body: '# Plain' })
  })
})
