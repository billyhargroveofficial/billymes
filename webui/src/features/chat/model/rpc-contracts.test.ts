import { describe, expect, it } from 'vitest'
import {
  parseContextBreakdownResult,
  parseSessionCreateResult,
  parseSessionEventsSinceResult,
  parseSessionPresentationListResult,
  parseSessionResumeResult,
  parseSessionUsageResult,
} from './rpc-contracts'

describe('chat JSON-RPC result contracts', () => {
  it('accepts only a non-empty session id from session.create', () => {
    expect(parseSessionCreateResult({ session_id: 'session-1', ignored: true })).toEqual({
      session_id: 'session-1',
      stored_session_id: 'session-1',
    })
    expect(() => parseSessionCreateResult({ session_id: '' })).toThrow(
      'session.create result.session_id',
    )
    expect(() => parseSessionCreateResult({ session_id: 7 })).toThrow(
      'session.create result.session_id',
    )
  })

  it('validates the optional session.resume envelope', () => {
    expect(
      parseSessionResumeResult({
        session_id: 'session-1',
        info: { model: 'fixture', running: true, turn_started_at: 12 },
      }),
    ).toEqual({
      session_id: 'session-1',
      stored_session_id: null,
      info: { model: 'fixture', running: true, turn_started_at: 12 },
      running: true,
      turn_started_at: 12,
    })
    expect(() => parseSessionResumeResult({ info: [] })).toThrow('session.resume result.info')
  })

  it('parses replay envelopes and durable hosted presentation cards', () => {
    expect(
      parseSessionEventsSinceResult({
        latest_seq: 7,
        durable_seq: 6,
        truncated: false,
        epoch: 'boot-a',
        events: [{ type: 'message.delta', session_id: 'live', seq: 7, payload: { text: 'x' } }],
      }),
    ).toMatchObject({
      latest_seq: 7,
      durable_seq: 6,
      replay_base_seq: 6,
      epoch: 'boot-a',
      events: [{ seq: 7 }],
    })
    expect(
      parseSessionPresentationListResult({
        session_id: 'stored',
        cards: [
          {
            id: 'hosted-1',
            sequence: 3,
            origin: 'hosted',
            name: 'web.search',
            args: { q: 'query' },
            preview: 'query',
            status: 'done',
            ok: true,
            duration_s: 1.2,
            started_at: 1,
            completed_at: 2,
            turn_id: 'turn-a',
            turn_index: 1,
          },
        ],
      }),
    ).toMatchObject({
      cards: [{ id: 'hosted-1', args: '{"q":"query"}', turn_index: 1, duration_s: 1.2 }],
    })
  })

  it('filters known numeric usage and context fields and rejects drift', () => {
    expect(
      parseSessionUsageResult({ model: 'fixture', input: 12, output: 0, unknown: 'ignored' }),
    ).toEqual({ model: 'fixture', input: 12, output: 0 })
    expect(parseContextBreakdownResult({ context_used: 25, context_max: 100 })).toEqual({
      context_used: 25,
      context_max: 100,
    })
    expect(() => parseSessionUsageResult({ input: '12' })).toThrow('session.usage result.input')
    expect(() => parseContextBreakdownResult({ context_percent: Number.NaN })).toThrow(
      'session.context_breakdown result.context_percent',
    )
  })
})
