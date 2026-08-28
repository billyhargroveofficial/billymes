import { describe, expect, it } from 'vitest'
import { categoryHue } from './category-color'

describe('categoryHue', () => {
  it('is stable for the same label', () => {
    expect(categoryHue('research')).toBe(categoryHue('research'))
  })

  it('stays inside the hue circle for any input', () => {
    for (const label of ['', 'a', 'research', 'software-development', 'ЖЖЖ', '🙂']) {
      const hue = categoryHue(label)
      expect(hue).toBeGreaterThanOrEqual(0)
      expect(hue).toBeLessThan(360)
      expect(Number.isInteger(hue)).toBe(true)
    }
  })

  it('separates labels that differ by one character', () => {
    expect(categoryHue('ops')).not.toBe(categoryHue('mlops'))
    expect(categoryHue('media')).not.toBe(categoryHue('medias'))
  })
})
