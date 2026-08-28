const BRIDGE_TOOLS = new Set(['tool_call', 'tool_search', 'tool_describe'])

function parseArgs(raw: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

export function unwrapTool(name: string, argsRaw?: string | Record<string, unknown>) {
  const args = parseArgs(argsRaw)
  if (name === 'tool_call') {
    const inner = String(args.name ?? args.tool ?? args.function ?? '')
    const innerArgs =
      args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
        ? (args.arguments as Record<string, unknown>)
        : parseArgs(typeof args.arguments === 'string' ? args.arguments : undefined)
    if (inner) return { name: inner, args: Object.keys(innerArgs).length ? innerArgs : args }
  }
  return { name, args }
}

export function shortToolName(name: string) {
  if (name.startsWith('mcp__')) {
    const parts = name.split('__').filter(Boolean)
    if (parts.length >= 3) return `${parts[1]}.${parts.slice(2).join('.')}`
  }
  return name
}

const PREVIEW_KEYS = [
  'command',
  'query',
  'path',
  'file',
  'url',
  'code',
  'prompt',
  'text',
  'pattern',
  'target',
  'message',
  'skill',
  'name',
]

export function toolPreview(
  name: string,
  argsRaw?: string | Record<string, unknown>,
  fallback = '',
) {
  const { name: real, args } = unwrapTool(name, argsRaw)
  for (const key of PREVIEW_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) {
      return collapse(value)
    }
  }
  if (BRIDGE_TOOLS.has(real) && typeof args.query === 'string') return collapse(args.query)
  const first = Object.values(args).find((v) => typeof v === 'string' && v.trim())
  if (typeof first === 'string') return collapse(first)
  return collapse(fallback)
}

function collapse(text: string) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 72)
}

export function fmtDuration(seconds?: number | null) {
  if (seconds == null || Number.isNaN(seconds) || seconds < 0) return ''
  if (seconds < 10) return `${seconds.toFixed(1)}s`
  if (seconds < 60) return `${Math.round(seconds)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return s ? `${m}m ${s}s` : `${m}m`
}
