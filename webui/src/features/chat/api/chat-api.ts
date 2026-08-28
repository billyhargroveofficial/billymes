import {
  ApiPayloadError,
  expectArray,
  expectRecord,
  expectString,
  optionalNumber,
  optionalString,
  requestJson,
  withProfile,
} from '@/shared/api'
import type { SessionContentPart, SessionInfo, SessionMessage, ToolCallRaw } from '../model/types'

/** The gateway caps an individual history page at this size. */
export const HISTORY_PAGE_SIZE = 500
const SESSION_LIST_LIMIT = 100

function numberOr(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function parseSession(value: unknown, label: string): SessionInfo {
  const row = expectRecord(value, label)
  return {
    id: expectString(row.id, `${label}.id`),
    source: optionalString(row.source, `${label}.source`),
    title: optionalString(row.title, `${label}.title`),
    model: optionalString(row.model, `${label}.model`),
    message_count: numberOr(row.message_count),
    tool_call_count: numberOr(row.tool_call_count),
    presentation_tool_call_count: optionalNumber(
      row.presentation_tool_call_count,
      `${label}.presentation_tool_call_count`,
    ),
    display_tool_call_count: optionalNumber(
      row.display_tool_call_count,
      `${label}.display_tool_call_count`,
    ),
    turn_count: optionalNumber(row.turn_count, `${label}.turn_count`),
    started_at: optionalNumber(row.started_at, `${label}.started_at`),
    last_activity_at: optionalNumber(row.last_activity_at, `${label}.last_activity_at`),
    ended_at: optionalNumber(row.ended_at, `${label}.ended_at`),
    end_reason: optionalString(row.end_reason, `${label}.end_reason`),
    parent_session_id: optionalString(row.parent_session_id, `${label}.parent_session_id`),
    profile_name: optionalString(row.profile_name, `${label}.profile_name`),
    estimated_cost_usd: optionalNumber(row.estimated_cost_usd, `${label}.estimated_cost_usd`),
    billing_provider: optionalString(row.billing_provider, `${label}.billing_provider`),
    input_tokens: optionalNumber(row.input_tokens, `${label}.input_tokens`),
    output_tokens: optionalNumber(row.output_tokens, `${label}.output_tokens`),
    reasoning_tokens: optionalNumber(row.reasoning_tokens, `${label}.reasoning_tokens`),
    cache_read_tokens: optionalNumber(row.cache_read_tokens, `${label}.cache_read_tokens`),
    ...(typeof row.pinned === 'boolean' ? { pinned: row.pinned } : {}),
    ...(typeof row.is_active === 'boolean' ? { is_active: row.is_active } : {}),
    ...(row.last_active == null
      ? {}
      : { last_active: optionalNumber(row.last_active, `${label}.last_active`) }),
  }
}

function parseToolCalls(value: unknown, label: string): ToolCallRaw[] | string | null {
  if (value == null) return null
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) throw new ApiPayloadError(label)
  return value.map((item, index) => {
    const row = expectRecord(item, `${label}[${index}]`)
    const fn =
      row.function == null ? undefined : expectRecord(row.function, `${label}[${index}].function`)
    return {
      ...(typeof row.id === 'string' ? { id: row.id } : {}),
      ...(typeof row.call_id === 'string' ? { call_id: row.call_id } : {}),
      ...(typeof row.type === 'string' ? { type: row.type } : {}),
      ...(fn
        ? {
            function: {
              ...(typeof fn.name === 'string' ? { name: fn.name } : {}),
              ...(typeof fn.arguments === 'string' ? { arguments: fn.arguments } : {}),
            },
          }
        : {}),
      ...(typeof row.name === 'string' ? { name: row.name } : {}),
      ...(typeof row.arguments === 'string' ? { arguments: row.arguments } : {}),
    }
  })
}

function parseContent(value: unknown, label: string): SessionMessage['content'] {
  if (value == null) return null
  if (typeof value === 'string') return value
  return expectArray(value, label).map((item, index): SessionContentPart => {
    if (typeof item === 'string') return item
    return expectRecord(item, `${label}[${index}]`)
  })
}

function parseMessage(value: unknown, index: number): SessionMessage {
  const label = `session messages[${index}]`
  const row = expectRecord(value, label)
  return {
    id: numberOr(row.id),
    session_id: expectString(row.session_id, `${label}.session_id`),
    role: expectString(row.role, `${label}.role`),
    content: parseContent(row.content, `${label}.content`),
    tool_call_id: optionalString(row.tool_call_id, `${label}.tool_call_id`),
    tool_calls: parseToolCalls(row.tool_calls, `${label}.tool_calls`),
    tool_name: optionalString(row.tool_name, `${label}.tool_name`),
    timestamp: optionalNumber(row.timestamp, `${label}.timestamp`),
    finish_reason: optionalString(row.finish_reason, `${label}.finish_reason`),
    reasoning: optionalString(row.reasoning, `${label}.reasoning`),
    reasoning_content: optionalString(row.reasoning_content, `${label}.reasoning_content`),
  }
}

export const chatApi = {
  sessions: async (profile?: string, limit = SESSION_LIST_LIMIT) => {
    const payload = expectRecord(
      await requestJson(withProfile(`/api/sessions?order=recent&limit=${limit}`, profile)),
      'sessions response',
    )
    // The WebUI gateway exposes `sessions`; the native API uses OpenAI-style
    // `data`. Accept both while keeping the presentation contract strict.
    const rows = payload.sessions ?? payload.data
    return {
      sessions: expectArray(rows, 'sessions response.sessions').map((item, index) =>
        parseSession(item, `sessions[${index}]`),
      ),
      total: numberOr(payload.total),
    }
  },
  messages: async (
    id: string,
    profile?: string,
    { limit = HISTORY_PAGE_SIZE, offset = 0 }: { limit?: number; offset?: number } = {},
  ) => {
    const payload = expectRecord(
      await requestJson(
        withProfile(
          `/api/sessions/${encodeURIComponent(id)}/messages?include_compacted=true&order=latest&limit=${limit}&offset=${offset}`,
          profile,
        ),
      ),
      'session messages response',
    )
    const rows = payload.messages ?? payload.data
    const messages = expectArray(rows, 'session messages response.messages').map(parseMessage)
    const pagination =
      payload.pagination == null ? {} : expectRecord(payload.pagination, 'messages pagination')
    const returned = numberOr(pagination.returned, messages.length)
    return {
      session_id: expectString(payload.session_id, 'session messages response.session_id'),
      messages,
      pagination: {
        limit: numberOr(pagination.limit, limit),
        offset: numberOr(pagination.offset, offset),
        returned,
        // Additive pagination metadata. Older Hermes servers did not expose
        // it; zero preserves their full-history and first-page behavior.
        user_turn_offset: numberOr(pagination.user_turn_offset),
      },
    }
  },
  detail: async (id: string, profile?: string) =>
    parseSession(
      await requestJson(withProfile(`/api/sessions/${encodeURIComponent(id)}`, profile)),
      'session detail',
    ),
  patch: async (
    id: string,
    body: {
      title?: string
      pinned?: boolean
      archived?: boolean
      unread?: boolean
      profile?: string
    },
    profile?: string,
  ) => {
    const payload = expectRecord(
      await requestJson(withProfile(`/api/sessions/${encodeURIComponent(id)}`, profile), {
        method: 'PATCH',
        body: JSON.stringify({
          ...body,
          profile: body.profile ?? (profile && profile !== 'default' ? profile : undefined),
        }),
      }),
      'session patch response',
    )
    return {
      ok: typeof payload.ok === 'boolean' ? payload.ok : true,
      ...(typeof payload.title === 'string' ? { title: payload.title } : {}),
      ...(typeof payload.pinned === 'boolean' ? { pinned: payload.pinned } : {}),
    }
  },
  remove: (id: string, profile?: string) =>
    requestJson(withProfile(`/api/sessions/${encodeURIComponent(id)}`, profile), {
      method: 'DELETE',
    }),
  wsTicket: async () => {
    const payload = expectRecord(
      await requestJson('/api/auth/ws-ticket', { method: 'POST' }),
      'WebSocket ticket response',
    )
    return expectString(payload.ticket, 'WebSocket ticket response.ticket')
  },
}
