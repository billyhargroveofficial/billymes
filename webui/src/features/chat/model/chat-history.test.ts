import { describe, expect, it } from 'vitest'
import { extractTodos, prependHistoricalMessages, reconstructMessages } from './chat-history'
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
})
