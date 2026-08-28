import {
  ApiPayloadError,
  expectRecord,
  expectString,
  optionalNumber,
  optionalString,
} from '@/shared/api'
import type { GatewayEvent } from '@/features/gateway'
import type { SessionUsage } from './types'

export type SessionResumeResult = {
  session_id: string | null
  stored_session_id: string | null
  info: Record<string, unknown> | null
  running: boolean | null
  turn_started_at: number | null
}

export type SessionEventsSinceResult = {
  events: GatewayEvent[]
  latest_seq: number
  /** Last event already represented by the durable REST session snapshot. */
  durable_seq: number
  /** Safe replay discard baseline; may also retire superseded ephemeral work. */
  replay_base_seq: number
  truncated: boolean
  epoch: string | null
}

export type SessionPresentationCard = {
  id: string
  sequence: number
  origin: 'hosted' | 'nested'
  name: string
  args: string
  preview: string
  status: 'running' | 'done' | 'error' | 'unknown'
  ok: boolean | null
  duration_s: number | null
  started_at: number | null
  completed_at: number | null
  turn_id: string | null
  turn_index: number | null
}

export type ContextBreakdown = Pick<
  SessionUsage,
  'context_used' | 'context_max' | 'context_percent'
>

export function parseSessionCreateResult(value: unknown) {
  const result = expectRecord(value, 'session.create result')
  const sessionId = expectString(result.session_id, 'session.create result.session_id')
  if (!sessionId) throw new ApiPayloadError('session.create result.session_id')
  return {
    session_id: sessionId,
    stored_session_id:
      optionalString(result.stored_session_id, 'session.create result.stored_session_id') ??
      sessionId,
  }
}

export function parseSessionResumeResult(value: unknown): SessionResumeResult {
  const result = expectRecord(value, 'session.resume result')
  const info = result.info == null ? null : expectRecord(result.info, 'session.resume result.info')
  return {
    session_id: optionalString(result.session_id, 'session.resume result.session_id'),
    stored_session_id:
      optionalString(result.stored_session_id, 'session.resume result.stored_session_id') ??
      optionalString(result.session_key, 'session.resume result.session_key'),
    info,
    running:
      optionalBoolean(result.running, 'session.resume result.running') ??
      (info ? optionalBoolean(info.running, 'session.resume result.info.running') : null),
    turn_started_at:
      optionalNumber(result.turn_started_at, 'session.resume result.turn_started_at') ??
      (info
        ? optionalNumber(info.turn_started_at, 'session.resume result.info.turn_started_at')
        : null),
  }
}

export function parseSessionEventsSinceResult(value: unknown): SessionEventsSinceResult {
  const result = expectRecord(value, 'session.events.since result')
  const eventsRaw = result.events
  if (!Array.isArray(eventsRaw)) throw new ApiPayloadError('session.events.since result.events')
  const events = eventsRaw.map((value, index) => parseGatewayEvent(value, index))
  const durableSeq =
    optionalNumber(result.durable_seq, 'session.events.since result.durable_seq') ?? 0
  return {
    events,
    latest_seq: optionalNumber(result.latest_seq, 'session.events.since result.latest_seq') ?? 0,
    durable_seq: durableSeq,
    replay_base_seq:
      optionalNumber(result.replay_base_seq, 'session.events.since result.replay_base_seq') ??
      durableSeq,
    truncated: optionalBoolean(result.truncated, 'session.events.since result.truncated') ?? false,
    epoch: optionalString(result.epoch, 'session.events.since result.epoch'),
  }
}

export function parseSessionPresentationListResult(value: unknown) {
  const result = expectRecord(value, 'session.presentation.list result')
  const sessionId = expectString(result.session_id, 'session.presentation.list result.session_id')
  if (!sessionId) throw new ApiPayloadError('session.presentation.list result.session_id')
  if (!Array.isArray(result.cards))
    throw new ApiPayloadError('session.presentation.list result.cards')
  return {
    session_id: sessionId,
    cards: result.cards.map((value, index) => parsePresentationCard(value, index)),
  }
}

export function parseSessionUsageResult(value: unknown): SessionUsage {
  const result = expectRecord(value, 'session.usage result')
  return {
    ...optionalText(result, 'model', 'session.usage result.model'),
    ...optionalMetric(result, 'input', 'session.usage result.input'),
    ...optionalMetric(result, 'output', 'session.usage result.output'),
    ...optionalMetric(result, 'reasoning', 'session.usage result.reasoning'),
    ...optionalMetric(result, 'total', 'session.usage result.total'),
    ...optionalMetric(result, 'calls', 'session.usage result.calls'),
    ...optionalMetric(result, 'context_used', 'session.usage result.context_used'),
    ...optionalMetric(result, 'context_max', 'session.usage result.context_max'),
    ...optionalMetric(result, 'context_percent', 'session.usage result.context_percent'),
  }
}

export function parseContextBreakdownResult(value: unknown): ContextBreakdown {
  const result = expectRecord(value, 'session.context_breakdown result')
  return {
    ...optionalMetric(result, 'context_used', 'session.context_breakdown result.context_used'),
    ...optionalMetric(result, 'context_max', 'session.context_breakdown result.context_max'),
    ...optionalMetric(
      result,
      'context_percent',
      'session.context_breakdown result.context_percent',
    ),
  }
}

function optionalMetric<K extends keyof SessionUsage>(
  record: Record<string, unknown>,
  key: K,
  label: string,
): Partial<Pick<SessionUsage, K>> {
  if (record[key] == null) return {}
  return { [key]: optionalNumber(record[key], label) } as Partial<Pick<SessionUsage, K>>
}

function optionalText<K extends keyof SessionUsage>(
  record: Record<string, unknown>,
  key: K,
  label: string,
): Partial<Pick<SessionUsage, K>> {
  if (record[key] == null) return {}
  return { [key]: optionalString(record[key], label) } as Partial<Pick<SessionUsage, K>>
}

function optionalBoolean(value: unknown, label: string) {
  if (value == null) return null
  if (typeof value !== 'boolean') throw new ApiPayloadError(label)
  return value
}

function parseGatewayEvent(value: unknown, index: number): GatewayEvent {
  const row = expectRecord(value, `session.events.since result.events[${index}]`)
  const type = expectString(row.type, `session.events.since result.events[${index}].type`)
  if (!type) throw new ApiPayloadError(`session.events.since result.events[${index}].type`)
  const seq = optionalNumber(row.seq, `session.events.since result.events[${index}].seq`)
  return {
    type,
    ...(typeof row.session_id === 'string' ? { session_id: row.session_id } : {}),
    ...(typeof row.profile === 'string' ? { profile: row.profile } : {}),
    ...('payload' in row ? { payload: row.payload } : {}),
    ...(seq != null && Number.isSafeInteger(seq) ? { seq } : {}),
  }
}

function parsePresentationCard(value: unknown, index: number): SessionPresentationCard {
  const label = `session.presentation.list result.cards[${index}]`
  const row = expectRecord(value, label)
  const id = expectString(row.id, `${label}.id`)
  const name = expectString(row.name, `${label}.name`)
  const origin = expectString(row.origin, `${label}.origin`)
  if (!id || !name || (origin !== 'hosted' && origin !== 'nested')) throw new ApiPayloadError(label)
  const status = optionalString(row.status, `${label}.status`) ?? 'unknown'
  if (!['running', 'done', 'error', 'unknown'].includes(status))
    throw new ApiPayloadError(`${label}.status`)
  return {
    id,
    sequence: optionalNumber(row.sequence, `${label}.sequence`) ?? index,
    origin,
    name,
    args: jsonText(row.args, `${label}.args`),
    preview: optionalString(row.preview, `${label}.preview`) ?? '',
    status: status as SessionPresentationCard['status'],
    ok: optionalBoolean(row.ok, `${label}.ok`),
    duration_s: optionalNumber(row.duration_s, `${label}.duration_s`),
    started_at: optionalNumber(row.started_at, `${label}.started_at`),
    completed_at: optionalNumber(row.completed_at, `${label}.completed_at`),
    turn_id: optionalString(row.turn_id, `${label}.turn_id`),
    turn_index: optionalNumber(row.turn_index, `${label}.turn_index`),
  }
}

function jsonText(value: unknown, label: string) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value !== 'object' || Array.isArray(value)) throw new ApiPayloadError(label)
  try {
    return JSON.stringify(value)
  } catch {
    throw new ApiPayloadError(label)
  }
}
