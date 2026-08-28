export function splitSkillMarkdown(raw: string) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { meta: {} as Record<string, string>, body: raw.trim() }
  const meta: Record<string, string> = {}
  for (const line of match[1]?.split('\n') ?? []) {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!field?.[1]) continue
    meta[field[1]] = (field[2] ?? '').trim().replace(/^["']|["']$/g, '')
  }
  const body = (match[2] ?? '').replace(/^#\s+.+\n+/, '').trim()
  return { meta, body }
}
