import type { GatewayEvent } from '@/features/gateway'
import type { SessionInfo, SessionRuntime, SessionUsage } from './types'
import { estimateContext, mergeUsage } from './session-utils'

export const DEFAULT_CONTEXT_WINDOW = 272_000

export function emptyRuntime(
  profileModel: string,
  profileProvider: string,
  contextWindow = DEFAULT_CONTEXT_WINDOW,
): SessionRuntime {
  return {
    model: profileModel,
    provider: profileProvider,
    reasoning: 'xhigh',
    usage: {},
    turnStartedAt: null,
    sessionStartedAt: null,
    lastTurnSeconds: null,
    contextWindow,
  }
}

export function usageFromSession(
  session: SessionInfo,
  contextWindow = DEFAULT_CONTEXT_WINDOW,
): SessionUsage {
  const context = estimateContext(session, contextWindow)
  return {
    ...(session.model == null ? {} : { model: session.model }),
    ...(session.input_tokens == null ? {} : { input: session.input_tokens }),
    ...(session.output_tokens == null ? {} : { output: session.output_tokens }),
    ...(session.reasoning_tokens == null ? {} : { reasoning: session.reasoning_tokens }),
    total:
      (session.input_tokens ?? 0) + (session.output_tokens ?? 0) + (session.reasoning_tokens ?? 0),
    context_used: context.used,
    context_max: context.max,
    context_percent: context.pct,
  }
}

export function mergeRuntime(previous: SessionRuntime, event: GatewayEvent): SessionRuntime {
  const record =
    event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : {}
  const usageRaw =
    record.usage && typeof record.usage === 'object' && !Array.isArray(record.usage)
      ? (record.usage as SessionUsage)
      : (record as SessionUsage)
  const next = { ...previous, usage: mergeUsage(previous.usage, usageRaw) }
  if (typeof record.model === 'string' && record.model) next.model = record.model
  if (typeof record.provider === 'string' && record.provider) next.provider = record.provider
  if (typeof record.reasoning_effort === 'string') next.reasoning = record.reasoning_effort
  if (typeof record.turn_started_at === 'number') next.turnStartedAt = record.turn_started_at
  if (typeof record.started_at === 'number') next.sessionStartedAt = record.started_at
  return next
}
