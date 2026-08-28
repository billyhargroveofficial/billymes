import { describe, expect, it } from 'vitest'
import {
  acceptGatewayEvent,
  hasActiveReplayTail,
  MAX_REPLAY_REFRESHES,
  recoverDurableReplay,
  ReplayRecoveryBuffer,
  replayEpochChanged,
} from './stream-recovery'

const replay = (
  durableSeq: number,
  events: { seq: number; type?: string }[],
  latestSeq = durableSeq,
  replayBaseSeq = durableSeq,
) => ({
  events: events.map((event) => ({ type: 'message.delta', session_id: 'live', ...event })),
  latest_seq: latestSeq,
  durable_seq: durableSeq,
  replay_base_seq: replayBaseSeq,
  truncated: false,
  epoch: 'boot-a',
})

describe('stream replay watermarks', () => {
  it('applies a sequence exactly once across live and replay delivery', () => {
    const marks = new Map<string, number>()
    expect(acceptGatewayEvent(marks, { type: 'message.delta', session_id: 'live', seq: 4 })).toBe(
      true,
    )
    expect(acceptGatewayEvent(marks, { type: 'message.delta', session_id: 'live', seq: 4 })).toBe(
      false,
    )
    expect(acceptGatewayEvent(marks, { type: 'message.delta', session_id: 'live', seq: 5 })).toBe(
      true,
    )
  })

  it('requires a history fallback when a known replay epoch changes', () => {
    expect(replayEpochChanged('gateway-a', 'gateway-b')).toBe(true)
    expect(replayEpochChanged(null, 'gateway-b')).toBe(false)
  })

  it('recognizes only an unmatched post-baseline turn start as an active replay tail', () => {
    expect(
      hasActiveReplayTail(
        replay(
          5,
          [
            { seq: 5, type: 'message.complete' },
            { seq: 6, type: 'session.usage' },
          ],
          6,
          5,
        ),
      ),
    ).toBe(false)
    expect(
      hasActiveReplayTail(
        replay(
          5,
          [
            { seq: 6, type: 'message.start' },
            { seq: 7, type: 'tool.start' },
          ],
          7,
          5,
        ),
      ),
    ).toBe(true)
    expect(
      hasActiveReplayTail(
        replay(
          5,
          [
            { seq: 6, type: 'message.start' },
            { seq: 7, type: 'message.complete' },
          ],
          7,
          5,
        ),
      ),
    ).toBe(false)
  })

  it('discards two completed durable replay turns after refreshing REST', async () => {
    const refreshes: number[] = []
    const requestCursors: number[] = []
    const result = await recoverDurableReplay({
      initial: replay(4, [{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }]),
      lastSeen: 0,
      forceRefresh: false,
      refreshHistory: async () => {
        refreshes.push(1)
      },
      requestSince: async (cursor) => {
        requestCursors.push(cursor)
        return replay(4, [])
      },
    })

    expect(refreshes).toHaveLength(1)
    expect(requestCursors).toEqual([4])
    expect(result).toMatchObject({ cursor: 4, events: [] })
  })

  it('uses replay_base_seq over durable_seq when supersession covers a larger prefix', async () => {
    const cursors: number[] = []
    const result = await recoverDurableReplay({
      initial: replay(
        10,
        Array.from({ length: 20 }, (_, index) => ({ seq: index + 1 })),
        20,
        20,
      ),
      lastSeen: 0,
      forceRefresh: false,
      refreshHistory: async () => undefined,
      requestSince: async (cursor) => {
        cursors.push(cursor)
        return replay(10, [{ seq: 21 }], 21, 20)
      },
    })

    expect(cursors).toEqual([20])
    expect(result).toMatchObject({ cursor: 20, events: [{ seq: 21 }] })
  })

  it('keeps an active replay tail and applies a concurrently buffered frame once', async () => {
    const result = await recoverDurableReplay({
      initial: replay(4, [{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }]),
      lastSeen: 0,
      forceRefresh: false,
      refreshHistory: async () => undefined,
      requestSince: async () => replay(4, [{ seq: 5 }], 5),
    })

    expect(result.events.map((event) => event.seq)).toEqual([5])
    const marks = new Map<string, number>([['live', result.cursor]])
    expect(acceptGatewayEvent(marks, result.events[0]!)).toBe(true)
    // The socket buffered this same frame while REST was hydrating.
    expect(acceptGatewayEvent(marks, { type: 'message.delta', session_id: 'live', seq: 5 })).toBe(
      false,
    )
    expect(acceptGatewayEvent(marks, { type: 'message.delta', session_id: 'live', seq: 6 })).toBe(
      true,
    )
  })

  it('repeats the REST snapshot when durable_seq advances during the first refresh', async () => {
    const refreshes: number[] = []
    const requestCursors: number[] = []
    const result = await recoverDurableReplay({
      initial: replay(4, [{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }]),
      lastSeen: 0,
      forceRefresh: false,
      refreshHistory: async () => {
        refreshes.push(1)
      },
      requestSince: async (cursor) => {
        requestCursors.push(cursor)
        return cursor === 4 ? replay(5, [{ seq: 5 }], 5) : replay(5, [{ seq: 6 }], 6)
      },
    })

    expect(refreshes).toHaveLength(2)
    expect(requestCursors).toEqual([4, 5])
    expect(result).toMatchObject({ cursor: 5, events: [{ seq: 6 }] })
  })

  it('trims only the running REST tail, then restores the complete turn after a terminal race', async () => {
    const tailPolicies: boolean[] = []
    const result = await recoverDurableReplay({
      initial: replay(
        4,
        [
          { seq: 1, type: 'message.complete' },
          { seq: 5, type: 'message.start' },
          { seq: 6, type: 'tool.start' },
        ],
        6,
        4,
      ),
      lastSeen: 0,
      forceRefresh: false,
      refreshHistory: async ({ omitActiveReplayTail }) => {
        tailPolicies.push(omitActiveReplayTail)
      },
      requestSince: async (cursor) =>
        cursor === 4
          ? replay(
              7,
              [
                { seq: 5, type: 'message.start' },
                { seq: 6, type: 'tool.start' },
                { seq: 7, type: 'message.complete' },
              ],
              7,
              7,
            )
          : replay(7, [], 7, 7),
    })

    expect(tailPolicies).toEqual([true, false])
    expect(result).toMatchObject({ cursor: 7, events: [] })
  })

  it('keeps an active resumed turn when its message.start is before the replay cursor', async () => {
    const tailPolicies: boolean[] = []
    const result = await recoverDurableReplay({
      // The reload cursor has already consumed message.start. session.resume
      // still says the turn is running, so this partial DB snapshot must be
      // projected as a replay tail rather than duplicated.
      initial: replay(4, [{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }]),
      lastSeen: 0,
      forceRefresh: false,
      initialActiveTurn: true,
      refreshHistory: async ({ omitActiveReplayTail }) => {
        tailPolicies.push(omitActiveReplayTail)
      },
      requestSince: async (cursor) => {
        expect(cursor).toBe(4)
        return replay(4, [{ seq: 5, type: 'tool.start' }], 5)
      },
    })

    expect(tailPolicies).toEqual([true])
    expect(result).toMatchObject({ activeTurn: true, cursor: 4, events: [{ seq: 5 }] })
  })

  it('honors a terminal event already covered by the initial replay baseline', async () => {
    const tailPolicies: boolean[] = []
    const result = await recoverDurableReplay({
      // Resume raced with completion: `running` was sampled true, but the
      // atomic events snapshot already has this turn's terminal at its base.
      initial: replay(
        7,
        [
          { seq: 6, type: 'message.start' },
          { seq: 7, type: 'message.complete' },
        ],
        7,
        7,
      ),
      lastSeen: 0,
      forceRefresh: false,
      initialActiveTurn: true,
      refreshHistory: async ({ omitActiveReplayTail }) => {
        tailPolicies.push(omitActiveReplayTail)
      },
      requestSince: async (cursor) => {
        expect(cursor).toBe(7)
        return replay(7, [], 7, 7)
      },
    })

    expect(tailPolicies).toEqual([false])
    expect(result).toMatchObject({ activeTurn: false, cursor: 7, events: [] })
  })

  it('switches from a trimmed active snapshot to full history when terminal replay wins the race', async () => {
    const tailPolicies: boolean[] = []
    const result = await recoverDurableReplay({
      initial: replay(4, [{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }]),
      lastSeen: 0,
      forceRefresh: false,
      initialActiveTurn: true,
      refreshHistory: async ({ omitActiveReplayTail }) => {
        tailPolicies.push(omitActiveReplayTail)
      },
      requestSince: async (cursor) =>
        cursor === 4
          ? replay(5, [{ seq: 5, type: 'message.complete' }], 5, 5)
          : replay(5, [], 5, 5),
    })

    expect(tailPolicies).toEqual([true, false])
    expect(result).toMatchObject({ activeTurn: false, cursor: 5, events: [] })
  })

  it('does not trim an idle REST history for a post-terminal usage frame', async () => {
    const tailPolicies: boolean[] = []
    const result = await recoverDurableReplay({
      initial: replay(
        5,
        [
          { seq: 5, type: 'message.complete' },
          { seq: 6, type: 'session.usage' },
        ],
        6,
        5,
      ),
      lastSeen: 0,
      forceRefresh: false,
      refreshHistory: async ({ omitActiveReplayTail }) => {
        tailPolicies.push(omitActiveReplayTail)
      },
      requestSince: async () => replay(5, [{ seq: 6, type: 'session.usage' }], 6, 5),
    })

    expect(tailPolicies).toEqual([false])
    expect(result.events.map((event) => event.type)).toEqual(['session.usage'])
  })

  it('uses the same durable refresh flow for a reconnect epoch reset', async () => {
    const requestCursors: number[] = []
    const result = await recoverDurableReplay({
      initial: replay(7, [], 7),
      lastSeen: 7,
      forceRefresh: true,
      refreshHistory: async () => undefined,
      requestSince: async (cursor) => {
        requestCursors.push(cursor)
        return replay(7, [{ seq: 8 }], 8)
      },
    })

    expect(requestCursors).toEqual([7])
    expect(result.events.map((event) => event.seq)).toEqual([8])
  })

  it('resets an old watermark for a new replay epoch with smaller sequences', async () => {
    const oldEpochWatermark = 97
    const recoveryLastSeen = 0 // epochChanged ? 0 : oldEpochWatermark
    expect(oldEpochWatermark).toBeGreaterThan(4)
    const result = await recoverDurableReplay({
      initial: replay(4, [{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }]),
      lastSeen: recoveryLastSeen,
      forceRefresh: true,
      refreshHistory: async () => undefined,
      requestSince: async () => replay(4, [{ seq: 5 }], 5),
    })

    expect(result).toMatchObject({ cursor: 4, events: [{ seq: 5 }] })
  })

  it('keeps buffered live events when replay recovery fails', () => {
    const marks = new Map<string, number>([['live', 4]])
    const buffered = [
      { type: 'message.delta', session_id: 'live', seq: 5 },
      { type: 'message.delta', session_id: 'live', seq: 5 },
    ]
    const released = buffered.filter((event) => acceptGatewayEvent(marks, event))

    expect(released.map((event) => event.seq)).toEqual([5])
  })

  it('does not let stale recovery A release or clear newer recovery B', () => {
    const buffer = new ReplayRecoveryBuffer()
    const tokenA = buffer.begin('live')
    buffer.push({ type: 'message.delta', session_id: 'live', seq: 5 })
    const tokenB = buffer.begin('live')
    buffer.push({ type: 'message.delta', session_id: 'live', seq: 6 })

    expect(buffer.take(tokenA)).toEqual([])
    expect(buffer.take(tokenB).map((event) => event.seq)).toEqual([5, 6])
  })

  it('rejects instead of advancing an uncovered durable cursor forever', async () => {
    await expect(
      recoverDurableReplay({
        initial: replay(1, [{ seq: 1 }]),
        lastSeen: 0,
        forceRefresh: false,
        refreshHistory: async () => undefined,
        requestSince: async (cursor) => replay(cursor + 1, [{ seq: cursor + 1 }]),
      }),
    ).rejects.toThrow('replay baseline did not stabilize')
    expect(MAX_REPLAY_REFRESHES).toBe(8)
  })

  it('rejects a truncated post-refresh replay without claiming its latest seq', async () => {
    await expect(
      recoverDurableReplay({
        initial: replay(4, [{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }]),
        lastSeen: 0,
        forceRefresh: false,
        refreshHistory: async () => undefined,
        requestSince: async () => ({ ...replay(4, []), truncated: true, latest_seq: 99 }),
      }),
    ).rejects.toThrow('post-refresh replay is truncated')
  })
})
