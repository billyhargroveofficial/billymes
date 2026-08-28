import { describe, expect, it } from 'vitest'
import { applyGatewayEvent } from './chat-reducer'
import {
  earlierHistoryPageMatchesBoundary,
  extractTodos,
  omitActiveReplayTail,
  prependHistoricalMessages,
  reconstructActiveReplayHistory,
  reconstructMessages,
  resolveReplayHistoryPaging,
} from './chat-history'
import type { ChatMessage, SessionMessage } from './types'

function row(overrides: Partial<SessionMessage>): SessionMessage {
  return {
    id: 1,
    session_id: 'session-1',
    role: 'assistant',
    content: '',
    tool_call_id: null,
    tool_calls: null,
    tool_name: null,
    timestamp: null,
    finish_reason: null,
    reasoning: null,
    reasoning_content: null,
    ...overrides,
  }
}

describe('chat history reconstruction', () => {
  it('disables unbounded pagination for a first-turn active tail', () => {
    expect(
      resolveReplayHistoryPaging(
        { limit: 500, offset: 0, returned: 500, user_turn_offset: 17 },
        {
          omitActiveReplayTail: true,
          historyAnchorDisplayKey: null,
          throughDisplayKeyFound: false,
        },
      ),
    ).toEqual({
      pageOffset: 0,
      userTurnOffset: 0,
      throughDisplayKey: null,
      hasEarlier: false,
    })
  })

  it('pages only a confirmed active replay prefix and otherwise fails closed', () => {
    const pagination = { limit: 500, offset: 0, returned: 500, user_turn_offset: 17 }
    const displayKey = `display:v1:${'a'.repeat(64)}`

    expect(
      resolveReplayHistoryPaging(pagination, {
        omitActiveReplayTail: true,
        historyAnchorDisplayKey: displayKey,
        throughDisplayKeyFound: false,
      }),
    ).toEqual({
      pageOffset: 0,
      userTurnOffset: 17,
      throughDisplayKey: null,
      hasEarlier: false,
    })
    expect(
      resolveReplayHistoryPaging(pagination, {
        omitActiveReplayTail: true,
        historyAnchorDisplayKey: displayKey,
        throughDisplayKeyFound: true,
      }),
    ).toEqual({
      pageOffset: 500,
      userTurnOffset: 17,
      throughDisplayKey: displayKey,
      hasEarlier: true,
    })
    expect(
      resolveReplayHistoryPaging(pagination, {
        omitActiveReplayTail: false,
        historyAnchorDisplayKey: undefined,
        throughDisplayKeyFound: false,
      }),
    ).toEqual({
      pageOffset: 500,
      userTurnOffset: 17,
      throughDisplayKey: null,
      hasEarlier: true,
    })
  })

  it('rejects an older page when its retained active boundary disappeared', () => {
    const displayKey = `display:v1:${'b'.repeat(64)}`
    expect(earlierHistoryPageMatchesBoundary(displayKey, true)).toBe(true)
    expect(earlierHistoryPageMatchesBoundary(displayKey, false)).toBe(false)
    expect(earlierHistoryPageMatchesBoundary(displayKey, undefined)).toBe(false)
    expect(earlierHistoryPageMatchesBoundary(null, undefined)).toBe(true)
  })

  it('joins assistant tool calls with later tool results', () => {
    const messages = reconstructMessages([
      row({
        id: 1,
        content: 'working',
        reasoning_content: 'plan',
        tool_calls: [{ id: 'call-1', function: { name: 'search', arguments: '{"q":"x"}' } }],
      }),
      row({
        id: 2,
        role: 'tool',
        tool_call_id: 'call-1',
        tool_name: 'search',
        content: 'result',
      }),
    ])

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ content: 'working', thinking: 'plan' })
    expect(messages[0]?.tools[0]).toMatchObject({
      id: 'call-1',
      name: 'search',
      result: 'result',
      status: 'done',
    })
  })

  it('extracts todo payloads and ignores unrelated tools', () => {
    expect(
      extractTodos('todo_write', '{"todos":[{"content":"verify","status":"completed"}]}'),
    ).toEqual([{ id: '0', content: 'verify', status: 'completed' }])
    expect(extractTodos('search', '{}')).toEqual([])
  })

  it('reconstructs multimodal content blocks without leaking arrays into the UI', () => {
    const messages = reconstructMessages([
      row({
        role: 'user',
        content: [
          { type: 'text', text: 'first block' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,safe-fixture' } },
          { type: 'text', text: 'second block' },
        ],
      }),
    ])

    expect(messages[0]?.content).toBe('first block\nsecond block')
  })

  it('places durable semantic commentary immediately before its canonical final row', () => {
    const messages = reconstructMessages([
      row({
        id: 44,
        content: 'final answer',
        interim_messages: [{ id: 'commentary-1', text: 'checking sources first' }],
      }),
    ])

    expect(messages.map((message) => [message.localId, message.content])).toEqual([
      ['h-44-interim-commentary-1', 'checking sources first'],
      ['h-44', 'final answer'],
    ])
  })

  it('leaves canonical history unchanged when commentary projection is absent', () => {
    const messages = reconstructMessages([row({ id: 44, content: 'final answer' })])

    expect(messages.map((message) => [message.localId, message.content])).toEqual([
      ['h-44', 'final answer'],
    ])
  })

  it('normalizes repeated todo ids from history tool results', () => {
    const messages = reconstructMessages([
      row({
        id: 1,
        tool_calls: [
          {
            id: 'call-1',
            function: {
              name: 'todo_write',
              arguments: '{"todos":[{"id":"verify","content":"verify","status":"pending"}]}',
            },
          },
        ],
      }),
      row({
        id: 2,
        role: 'tool',
        tool_call_id: 'call-1',
        tool_name: 'todo_write',
        content:
          '{"todos":[{"id":"verify","content":"verify","status":"completed"},{"id":"write","content":"write","status":"pending"}]}',
      }),
    ])

    expect(messages[0]?.todos).toEqual([
      { id: 'verify', content: 'verify', status: 'completed' },
      { id: 'write', content: 'write', status: 'pending' },
    ])
  })

  it('prepends only historical rows with stable local IDs', () => {
    const message = (localId: string): ChatMessage => ({
      localId,
      role: 'user',
      content: localId,
      thinking: '',
      tools: [],
      todos: [],
      subagents: [],
      streaming: false,
    })

    expect(
      prependHistoricalMessages(
        [message('h-500'), message('live-1')],
        [message('h-498'), message('h-499'), message('h-500'), message('h-499')],
      ).map((item) => item.localId),
    ).toEqual(['h-498', 'h-499', 'h-500', 'live-1'])
  })

  it('uses replay, not the partially persisted active tail, after a reload', () => {
    // Compaction can clone rows, so physical ids do not form a display
    // boundary. The server already returned the exact prefix through the
    // stable display key; deliberately make ids non-monotonic here.
    const boundedPrefixRows = [
      row({ id: 900, role: 'user', content: 'previous prompt' }),
      row({ id: 3, content: 'previous final' }),
    ]

    let messages = reconstructActiveReplayHistory(boundedPrefixRows, {
      historyAnchorDisplayKey: 'before-current-turn',
      throughDisplayKeyFound: true,
      inflightUser: 'current prompt',
      turnStartedAt: 123,
    })
    for (const event of [
      { type: 'message.start', session_id: 'live', seq: 1 },
      {
        type: 'message.interim',
        session_id: 'live',
        seq: 2,
        payload: { text: 'LOCAL PRELUDE' },
      },
      {
        type: 'tool.start',
        session_id: 'live',
        seq: 3,
        payload: { tool_id: 'terminal-1', name: 'terminal', args: { cmd: 'sleep' } },
      },
    ] as const) {
      messages = applyGatewayEvent(messages, event)
    }

    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'assistant',
    ])
    expect(messages[2]).toMatchObject({
      localId: 'inflight-user-after-before-current-turn',
      content: 'current prompt',
    })
    expect(messages[3]?.content).toBe('LOCAL PRELUDE')
    expect(messages[4]?.tools.map((tool) => tool.id)).toEqual(['terminal-1'])
    expect(messages.flatMap((message) => message.tools)).toHaveLength(1)
  })

  it('keeps history untouched when an old gateway has no durable user anchor', () => {
    const rows = [row({ id: 3, content: 'legacy assistant tail' })]
    expect(omitActiveReplayTail(rows)).toBe(rows)
  })

  it('rebuilds the first in-flight user from an explicit before-first-row anchor', () => {
    expect(
      reconstructActiveReplayHistory([], {
        historyAnchorDisplayKey: null,
        throughDisplayKeyFound: false,
        inflightUser: 'first prompt has not reached SQLite yet',
        turnStartedAt: 123,
      }),
    ).toMatchObject([
      {
        localId: 'inflight-user-after-start',
        role: 'user',
        content: 'first prompt has not reached SQLite yet',
        timestamp: 123,
      },
    ])
  })

  it('hides a first-turn tail that reached SQLite before the replay starts', () => {
    const persistedTail = [
      row({ id: 17, role: 'user', content: 'first prompt' }),
      row({ id: 18, content: 'partial first answer' }),
      row({ id: 19, role: 'tool', tool_call_id: 'tool-1', content: 'partial tool result' }),
    ]
    let messages = reconstructActiveReplayHistory(persistedTail, {
      historyAnchorDisplayKey: null,
      throughDisplayKeyFound: false,
      inflightUser: 'first prompt',
      turnStartedAt: 123,
    })
    for (const event of [
      { type: 'message.start', session_id: 'live', seq: 1 },
      { type: 'message.interim', session_id: 'live', seq: 2, payload: { text: 'checking' } },
      {
        type: 'tool.start',
        session_id: 'live',
        seq: 3,
        payload: { tool_id: 'tool-1', name: 'terminal', args: { cmd: 'sleep' } },
      },
    ] as const) {
      messages = applyGatewayEvent(messages, event)
    }
    expect(messages).toMatchObject([
      {
        localId: 'inflight-user-after-start',
        role: 'user',
        content: 'first prompt',
      },
      { role: 'assistant', content: 'checking' },
      { role: 'assistant', tools: [{ id: 'tool-1' }] },
    ])
    expect(messages.flatMap((message) => message.tools)).toHaveLength(1)
  })

  it('uses the conservative boundary for an older gateway with no anchor field', () => {
    const rows = [
      row({ id: 3, role: 'user', content: 'previous prompt' }),
      row({ id: 4, content: 'previous final' }),
      row({ id: 5, role: 'user', content: 'active legacy prompt' }),
      row({ id: 6, content: 'partial active answer' }),
    ]
    expect(
      reconstructActiveReplayHistory(rows, {
        historyAnchorDisplayKey: undefined,
        throughDisplayKeyFound: false,
        inflightUser: 'active legacy prompt',
        turnStartedAt: 123,
      }).map((message) => message.content),
    ).toEqual(['previous prompt', 'previous final', 'active legacy prompt'])
  })

  it('falls back structurally when a requested display key is not found', () => {
    const rows = [
      row({ id: 101, role: 'user', content: 'previous prompt' }),
      row({ id: 102, content: 'previous final' }),
      row({ id: 103, role: 'user', content: 'active prompt' }),
      row({ id: 104, content: 'partial active answer' }),
    ]
    expect(
      reconstructActiveReplayHistory(rows, {
        historyAnchorDisplayKey: 'compacted-away-key',
        throughDisplayKeyFound: false,
        inflightUser: 'active prompt',
        turnStartedAt: 123,
      }).map((message) => message.content),
    ).toEqual(['previous prompt', 'previous final', 'active prompt'])
  })
})
