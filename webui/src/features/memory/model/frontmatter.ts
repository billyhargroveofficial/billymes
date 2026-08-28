/**
 * SKILL.md opens with a YAML front matter block. Markdown has no idea what
 * that is: the keys before the closing `---` parse as a setext heading, so an
 * unsplit skill renders its own metadata as a giant display-serif paragraph.
 * Splitting it off lets the page show the fields as fields and the body as
 * prose — and the editor still writes back the untouched original text.
 */

type FrontmatterField = { key: string; value: string }

export type SplitContent = {
  fields: FrontmatterField[]
  body: string
}

const FENCE = /^---[ \t]*$/
const PAIR = /^[ \t]*([A-Za-z_][\w-]*):[ \t]*(.*)$/

/** `[a, b]` and quoted scalars read better as plain text in a chip. */
function cleanValue(raw: string) {
  const trimmed = raw.trim().replace(/^\[(.*)\]$/su, '$1')
  const unquoted = trimmed.replace(/^["'](.*)["']$/su, '$1')
  return unquoted.replace(/\s+/gu, ' ').trim()
}

export function splitFrontmatter(content: string): SplitContent {
  const lines = content.split('\n')
  if (!lines[0] || !FENCE.test(lines[0])) return { fields: [], body: content }
  const end = lines.findIndex((line, index) => index > 0 && FENCE.test(line))
  if (end < 0) return { fields: [], body: content }

  const seen = new Set<string>()
  const fields: FrontmatterField[] = []
  for (const line of lines.slice(1, end)) {
    const pair = PAIR.exec(line)
    if (!pair) continue
    const key = pair[1] ?? ''
    const value = cleanValue(pair[2] ?? '')
    // A key with no value opens a nested block; its leaves are picked up by
    // their own lines, so the container itself carries nothing to show.
    if (!value || seen.has(key)) continue
    seen.add(key)
    fields.push({ key, value })
  }
  return {
    fields,
    body: lines
      .slice(end + 1)
      .join('\n')
      .replace(/^\n+/u, ''),
  }
}
