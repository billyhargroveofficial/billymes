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

/**
 * A running agent persists ordinary assistant/tool rows before its terminal
 * event.  Those rows are useful after a process death, but on a live reload
 * they overlap the exact event-replay tail.  Keep the durable conversation
 * through the current user turn and let the sequenced replay reconstruct only
 * that in-flight tail.
 *
 * This is deliberately a role/row boundary, never a content comparison:
 * identical text and tool previews are valid in different turns.  A missing
 * user anchor is left untouched as a conservative compatibility fallback for
 * older gateways that have not persisted the submitted prompt yet.
 */
export function omitActiveReplayTail(rows: SessionMessage[]): SessionMessage[] {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.role === 'user') return rows.slice(0, index + 1)
  }
  return rows
}

type ActiveReplayHistory = {
  /**
   * Stable display-lineage boundary supplied by newer gateways. It is never
   * compared to SQLite row ids: compaction can clone/reorder physical rows.
   */
  historyAnchorDisplayKey: string | null | undefined
  /** The bounded endpoint confirmed that `rows` ends at the display key. */
  throughDisplayKeyFound: boolean
  /** The current prompt survives even when its partially persisted row is cut. */
  inflightUser: string | null
  turnStartedAt: number | null
}

type HistoryPagination = {
  limit: number
  offset: number
  returned: number
  user_turn_offset: number
}

/**
 * Keep older-page reads on the same authoritative prefix as active replay.
 * Without a confirmed string boundary there is no safe second page: an
 * unbounded page can contain the persisted active tail that reconstruction
 * intentionally discarded. Explicit `null` is the exact empty prefix of a
 * first turn, while undefined/missing anchors retain only the current page's
 * structural compatibility fallback.
 */
export function resolveReplayHistoryPaging(
  pagination: HistoryPagination,
  {
    omitActiveReplayTail,
    historyAnchorDisplayKey,
    throughDisplayKeyFound,
  }: Pick<ActiveReplayHistory, 'historyAnchorDisplayKey' | 'throughDisplayKeyFound'> & {
    omitActiveReplayTail: boolean
  },
) {
  const hasBoundedPrefix = typeof historyAnchorDisplayKey === 'string' && throughDisplayKeyFound
  const pagingIsSafe = !omitActiveReplayTail || hasBoundedPrefix
  return {
    pageOffset: pagingIsSafe ? pagination.offset + pagination.returned : 0,
    userTurnOffset:
      omitActiveReplayTail && historyAnchorDisplayKey === null ? 0 : pagination.user_turn_offset,
    throughDisplayKey: omitActiveReplayTail && hasBoundedPrefix ? historyAnchorDisplayKey : null,
    hasEarlier: pagingIsSafe && pagination.returned >= pagination.limit,
  }
}

/** Reject an unbounded fallback page after an active prefix was established. */
export function earlierHistoryPageMatchesBoundary(
  throughDisplayKey: string | null,
  throughDisplayKeyFound: boolean | undefined,
) {
  return throughDisplayKey == null || throughDisplayKeyFound === true
}

/**
 * Reconstruct a REST snapshot that will be followed by the current event
 * replay. New gateways supply a stable display key and the server returns the
 * prefix through that key. Do not infer this prefix from physical row ids:
 * compression may clone rows. Older gateways retain the conservative
 * last-user fallback above.
 */
export function reconstructActiveReplayHistory(
  rows: SessionMessage[],
  {
    historyAnchorDisplayKey,
    throughDisplayKeyFound,
    inflightUser,
    turnStartedAt,
  }: ActiveReplayHistory,
): ChatMessage[] {
  // `undefined` is the old gateway contract: do not guess beyond the
  // conservative last-user boundary. `null` is a newer gateway's exact
  // before-first-row anchor, so an active first turn still gets its prompt.
  if (
    historyAnchorDisplayKey === undefined ||
    inflightUser == null ||
    (historyAnchorDisplayKey !== null && !throughDisplayKeyFound)
  ) {
    return reconstructMessages(omitActiveReplayTail(rows))
  }

  const messages = reconstructMessages(historyAnchorDisplayKey == null ? [] : rows)
  messages.push({
    localId: `inflight-user-after-${historyAnchorDisplayKey ?? 'start'}`,
    role: 'user',
    content: inflightUser,
    thinking: '',
    tools: [],
    todos: [],
    subagents: [],
    streaming: false,
    ...(turnStartedAt == null ? {} : { timestamp: turnStartedAt }),
  })
  return messages
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
