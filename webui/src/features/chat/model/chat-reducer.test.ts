import { describe, expect, it } from 'vitest'
import { applyGatewayEvent } from './chat-reducer'
import type { ChatMessage } from './types'

function message(role: ChatMessage['role'], streaming = false): ChatMessage {
  return {
    localId: role,
    role,
    content: '',
    thinking: '',
    tools: [],
    todos: [],
    subagents: [],
    streaming,
  }
}

describe('applyGatewayEvent', () => {
  it('preserves structural sharing for messages untouched by a streaming delta', () => {
    const user = message('user')
    const assistant = message('assistant', true)
    const next = applyGatewayEvent([user, assistant], {
      type: 'message.delta',
      payload: { delta: 'hello' },
    })

    expect(next[0]).toBe(user)
    expect(next[1]).not.toBe(assistant)
    expect(next[1]?.content).toBe('hello')
    expect(assistant.content).toBe('')
  })

  it('reconciles a complete full message without duplicating streamed text', () => {
    const assistant = { ...message('assistant', true), content: 'hello' }
    const next = applyGatewayEvent([assistant], {
      type: 'message.complete',
      payload: { text: 'hello world' },
    })

    expect(next[0]?.content).toBe('hello world')
    expect(next[0]?.streaming).toBe(false)
  })

  it('tracks tool lifecycle on the active assistant only', () => {
    const initial = [message('user'), message('assistant', true)]
    const started = applyGatewayEvent(initial, {
      type: 'tool.start',
      payload: { id: 'tool-1', name: 'search', args: { q: 'agent' } },
    })
    const completed = applyGatewayEvent(started, {
      type: 'tool.complete',
      payload: { id: 'tool-1', result: 'found' },
    })

    expect(completed[0]).toBe(initial[0])
    expect(completed[1]?.tools).toEqual([
      expect.objectContaining({ id: 'tool-1', status: 'done', result: 'found' }),
    ])
  })

  it('seals interim commentary before the following tool card', () => {
    let messages = applyGatewayEvent([], { type: 'message.start', payload: {} })
    messages = applyGatewayEvent(messages, {
      type: 'message.interim',
      payload: { text: "I'll inspect the repo first.", already_streamed: false },
    })
    messages = applyGatewayEvent(messages, {
      type: 'tool.start',
      payload: { tool_id: 'inspect', name: 'terminal', args: { command: 'git status' } },
    })

    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({
      content: "I'll inspect the repo first.",
      streaming: false,
      tools: [],
    })
    expect(messages[1]).toMatchObject({ streaming: true })
    expect(messages[1]?.tools).toEqual([expect.objectContaining({ id: 'inspect' })])
  })

  it('does not duplicate commentary that was already emitted as a delta', () => {
    let messages = applyGatewayEvent([], { type: 'message.start', payload: {} })
    messages = applyGatewayEvent(messages, {
      type: 'message.delta',
      payload: { text: 'Checking the configuration.' },
    })
    messages = applyGatewayEvent(messages, {
      type: 'message.interim',
      payload: { text: 'Checking the configuration.', already_streamed: true },
    })

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      content: 'Checking the configuration.',
      streaming: false,
    })
  })

  it('splits streamed prose before a tool even when no interim event arrives', () => {
    let messages = applyGatewayEvent([], { type: 'message.start', payload: {} })
    messages = applyGatewayEvent(messages, {
      type: 'message.delta',
      payload: { text: 'One moment.' },
    })
    messages = applyGatewayEvent(messages, {
      type: 'tool.generating',
      payload: { tool_id: 'lookup', name: 'web_search', args: { query: 'Hermes docs' } },
    })

    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ content: 'One moment.', streaming: false, tools: [] })
    expect(messages[1]?.tools).toEqual([expect.objectContaining({ id: 'lookup' })])
  })

  it('keeps tool, later prose, and the next tool in chronological segments', () => {
    let messages = applyGatewayEvent([], { type: 'message.start', payload: {} })
    messages = applyGatewayEvent(messages, {
      type: 'tool.start',
      payload: { tool_id: 'first', name: 'web_search', args: { query: 'first' } },
    })
    messages = applyGatewayEvent(messages, {
      type: 'tool.complete',
      payload: { tool_id: 'first', result: 'done' },
    })
    messages = applyGatewayEvent(messages, {
      type: 'message.delta',
      payload: { text: 'Found it.' },
    })
    messages = applyGatewayEvent(messages, {
      type: 'tool.start',
      payload: { tool_id: 'second', name: 'web_extract', args: { url: 'https://example.test' } },
    })

    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ content: 'Found it.', streaming: false })
    expect(messages[0]?.tools).toEqual([expect.objectContaining({ id: 'first' })])
    expect(messages[1]?.tools).toEqual([expect.objectContaining({ id: 'second' })])
  })

  it('creates a final assistant segment after sealed interim commentary', () => {
    let messages = applyGatewayEvent([], { type: 'message.start', payload: {} })
    messages = applyGatewayEvent(messages, {
      type: 'message.interim',
      payload: { text: 'I have the result.', already_streamed: false },
    })
    messages = applyGatewayEvent(messages, {
      type: 'message.complete',
      payload: { text: 'Here is the final answer.' },
    })

    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ content: 'I have the result.', streaming: false })
    expect(messages[1]).toMatchObject({ content: 'Here is the final answer.', streaming: false })
  })

  it('keeps commentary, hosted activity, and final prose in chronological rows', () => {
    let messages = applyGatewayEvent([], { type: 'message.start', payload: {} })
    messages = applyGatewayEvent(messages, {
      type: 'message.interim',
      payload: { text: 'Сначала проверю веб.', already_streamed: false },
    })
    messages = applyGatewayEvent(messages, {
      type: 'tool.start',
      payload: { tool_id: 'hosted-search', name: 'web_search', args: { query: 'Hermes' } },
    })
    messages = applyGatewayEvent(messages, {
      type: 'tool.complete',
      payload: { tool_id: 'hosted-search', result: 'found' },
    })
    messages = applyGatewayEvent(messages, {
      type: 'message.complete',
      payload: { text: 'Готово: вот результат.' },
    })

    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({
      content: 'Сначала проверю веб.',
      tools: [],
      streaming: false,
    })
    expect(messages[1]).toMatchObject({
      content: 'Готово: вот результат.',
      streaming: false,
      tools: [expect.objectContaining({ id: 'hosted-search', status: 'done' })],
    })
  })

  it('returns the original array for unrelated events', () => {
    const current = [message('user')]
    expect(applyGatewayEvent(current, { type: 'heartbeat' })).toBe(current)
  })
})

describe('tool preview priority', () => {
  it('keeps the args-derived query when tool.complete ships a summary', () => {
    let messages = applyGatewayEvent([], { type: 'message.start', payload: {} })
    messages = applyGatewayEvent(messages, {
      type: 'tool.start',
      payload: { tool_id: 't1', name: 'web_search', args: { query: 'GLM-5.5 release date' } },
    })
    messages = applyGatewayEvent(messages, {
      type: 'tool.complete',
      payload: {
        tool_id: 't1',
        name: 'web_search',
        args: { query: 'GLM-5.5 release date' },
        summary: 'Did 5 searches in 12s',
        result: '{}',
      },
    })
    const tool = messages.at(-1)?.tools[0]
    expect(tool?.status).toBe('done')
    expect(tool?.preview).toBe('GLM-5.5 release date')
  })

  it('fills a missing preview from completion args', () => {
    let messages = applyGatewayEvent([], { type: 'message.start', payload: {} })
    messages = applyGatewayEvent(messages, {
      type: 'tool.generating',
      payload: { tool_id: 't2', name: 'web_extract' },
    })
    messages = applyGatewayEvent(messages, {
      type: 'tool.complete',
      payload: {
        tool_id: 't2',
        name: 'web_extract',
        args: { url: 'https://z.ai/blog/glm-5.3-flash' },
        result: 'ok',
      },
    })
    const tool = messages.at(-1)?.tools[0]
    expect(tool?.preview).toBe('https://z.ai/blog/glm-5.3-flash')
    expect(tool?.args).toContain('z.ai/blog')
  })

  it('creates its own row when tool.complete arrives without a start event', () => {
    let messages = applyGatewayEvent([], { type: 'message.start', payload: {} })
    messages = applyGatewayEvent(messages, {
      type: 'tool.start',
      payload: { tool_id: 'first', name: 'terminal', args: { command: 'ls' } },
    })
    messages = applyGatewayEvent(messages, {
      type: 'tool.complete',
      payload: { tool_id: 'orphan', name: 'web_search', args: { query: 'q' }, result: '{}' },
    })
    const tools = messages.at(-1)?.tools ?? []
    expect(tools).toHaveLength(2)
    expect(tools[0]?.status).toBe('running')
    expect(tools[1]?.id).toBe('orphan')
    expect(tools[1]?.preview).toBe('q')
  })

  it('falls back to the summary when completion has no args', () => {
    let messages = applyGatewayEvent([], { type: 'message.start', payload: {} })
    messages = applyGatewayEvent(messages, {
      type: 'tool.start',
      payload: { tool_id: 't3', name: 'noop' },
    })
    messages = applyGatewayEvent(messages, {
      type: 'tool.complete',
      payload: { tool_id: 't3', name: 'noop', summary: 'done in 1s', result: '{}' },
    })
    expect(messages.at(-1)?.tools[0]?.preview).toBe('done in 1s')
  })
})
