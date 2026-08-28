import type { ChatMessage, SessionMessage, TodoItem, ToolCall, ToolCallRaw } from './types'
import { toolPreview, unwrapTool } from './tool-display'
import { mergeTodos } from './todo-utils'

function asString(value: unknown) {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function contentText(value: SessionMessage['content']) {
  if (typeof value === 'string') return value
  if (value == null) return ''
  const text = value.flatMap((part) => {
    if (typeof part === 'string') return part
    return typeof part.text === 'string' ? part.text : []
  })
  return text.length > 0 ? text.join('\n') : asString(value)
}

export function extractTodos(name: string, args: string, result = ''): TodoItem[] {
  if (!/todo/i.test(name)) return []
  for (const raw of [result, args]) {
    try {
      const parsed = JSON.parse(raw) as { todos?: unknown; items?: unknown }
      const list = parsed.todos ?? parsed.items
      if (!Array.isArray(list)) continue
      return list.map((item, i) => {
        const row = item as { id?: string; content?: string; text?: string; status?: string }
        return {
          id: String(row.id ?? i),
          content: String(row.content ?? row.text ?? ''),
          status: row.status ?? 'pending',
        }
      })
    } catch {
      /* ignore */
    }
  }
  return []
}

export function extractSubagent(name: string, args: string, result: string, id: string) {
  if (!/subagent|delegat|spawn|task/i.test(name)) return null
  let title = name
  try {
    const parsed = JSON.parse(args) as { prompt?: string; title?: string; goal?: string }
    title = parsed.title || parsed.goal || parsed.prompt?.slice(0, 80) || name
  } catch {
    /* ignore */
  }
  return {
    id,
    title,
    status: result ? 'done' : 'running',
    summary: result.slice(0, 400),
  }
}

function parseToolCalls(
  raw: SessionMessage['tool_calls'] | string | null | undefined,
): ToolCallRaw[] {
  if (!raw) return []
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown
      return Array.isArray(parsed) ? (parsed as ToolCallRaw[]) : []
    } catch {
      return []
    }
  }
  return Array.isArray(raw) ? raw : []
}

function lastAssistant(out: ChatMessage[]) {
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const message = out[i]
    if (message?.role === 'assistant') return message
  }
  return null
}

export function reconstructMessages(rows: SessionMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  const toolsById = new Map<string, ToolCall>()

  for (const row of rows) {
    if (row.role === 'user') {
      out.push({
        localId: `h-${row.id}`,
        role: 'user',
        content: contentText(row.content),
        thinking: '',
        tools: [],
        todos: [],
        subagents: [],
        streaming: false,
        ...(row.timestamp == null ? {} : { timestamp: row.timestamp }),
      })
      continue
    }

    if (row.role === 'tool' || row.tool_call_id) {
      const id = row.tool_call_id || String(row.id)
      const result = asString(row.content)
      let existing = toolsById.get(id)
      const rawName = existing?.name || row.tool_name || 'tool'
      const unwrapped = unwrapTool(rawName, existing?.args || result)
      if (!existing) {
        existing = {
          id,
          name: unwrapped.name,
          args: '',
          result,
          status: 'done',
          preview: toolPreview(rawName, result),
        }
        toolsById.set(id, existing)
        const host = lastAssistant(out)
        if (host && !host.tools.some((t) => t.id === id)) host.tools.push(existing)
      } else {
        existing.result = result
        existing.status = 'done'
        existing.name = unwrapped.name || existing.name
      }
      const last = lastAssistant(out)
      if (last) {
        last.todos = mergeTodos(
          last.todos,
          extractTodos(existing.name, existing.args || '', result),
        )
        const sub = extractSubagent(existing.name, existing.args || '', result, id)
        if (sub) last.subagents = [...last.subagents.filter((s) => s.id !== id), sub]
      }
      continue
    }

    if (row.role === 'assistant' || row.role === 'system') {
      const tools: ToolCall[] = parseToolCalls(row.tool_calls).map((call, i) => {
        const id = call.id || call.call_id || `call-${row.id}-${i}`
        const rawName = call.function?.name || call.name || row.tool_name || 'tool'
        const rawArgs = call.function?.arguments || call.arguments || ''
        const unwrapped = unwrapTool(rawName, rawArgs)
        const args = asString(rawArgs)
        const tool: ToolCall = {
          id,
          name: unwrapped.name,
          args,
          result: '',
          status: 'done',
          preview: toolPreview(rawName, rawArgs),
        }
        toolsById.set(id, tool)
        return tool
      })
      const todos = mergeTodos(
        [],
        tools.flatMap((t) => extractTodos(t.name, t.args, t.result)),
      )
      const subagents = tools
        .map((t) => extractSubagent(t.name, t.args, t.result, t.id))
        .filter((s): s is NonNullable<typeof s> => Boolean(s))
      // The API derives these from semantic Responses commentary phases, not
      // from a text comparison. Keep them as independent durable segments so
      // the presentation ledger can place hosted cards before the final row.
      if (row.role === 'assistant') {
        for (const interim of row.interim_messages ?? []) {
          out.push({
            localId: `h-${row.id}-interim-${interim.id}`,
            role: 'assistant',
            content: interim.text,
            thinking: '',
            tools: [],
            todos: [],
            subagents: [],
            streaming: false,
            ...(row.timestamp == null ? {} : { timestamp: row.timestamp }),
          })
        }
      }
      out.push({
        localId: `h-${row.id}`,
        role: row.role === 'system' ? 'system' : 'assistant',
        content: contentText(row.content),
        thinking: row.reasoning_content || row.reasoning || '',
        tools,
        todos,
        subagents,
        streaming: false,
        ...(row.timestamp == null ? {} : { timestamp: row.timestamp }),
      })
    }
  }

  return out
}

/**
 * Page boundaries can overlap after a live turn or a compacted-history
 * refresh. History row IDs are durable and become `h-<id>` local IDs, so use
 * them to prepend only genuinely older rows without remounting current ones.
 */
export function prependHistoricalMessages(
  current: ChatMessage[],
  older: ChatMessage[],
): ChatMessage[] {
  const seen = new Set(current.map((message) => message.localId))
  const uniqueOlder: ChatMessage[] = []
  for (const message of older) {
    if (seen.has(message.localId)) continue
    seen.add(message.localId)
    uniqueOlder.push(message)
  }
  return uniqueOlder.length ? [...uniqueOlder, ...current] : current
}

export function payloadText(payload: unknown): string {
  if (typeof payload === 'string') return payload
  if (!payload || typeof payload !== 'object') return ''
  const rec = payload as Record<string, unknown>
  for (const key of ['text', 'delta', 'content', 'chunk', 'output']) {
    if (typeof rec[key] === 'string') return rec[key] as string
  }
  return ''
}

export function payloadRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') return {}
  return payload as Record<string, unknown>
}
