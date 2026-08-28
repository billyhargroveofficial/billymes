import { describe, expect, it } from 'vitest'
import { mergeTodos, recentTodos } from './todo-utils'
import type { ChatMessage, TodoItem } from './types'

function todo(id: string, status = 'pending'): TodoItem {
  return { id, content: id, status }
}

function message(localId: string, todos: TodoItem[]): ChatMessage {
  return {
    localId,
    role: 'assistant',
    content: '',
    thinking: '',
    tools: [],
    todos,
    subagents: [],
    streaming: false,
  }
}

describe('todo normalization', () => {
  it('keeps the latest value for a repeated id and moves it to the latest position', () => {
    expect(mergeTodos([todo('verify'), todo('write')], [todo('verify', 'completed')])).toEqual([
      todo('write'),
      todo('verify', 'completed'),
    ])
  })

  it('deduplicates repeated ids across messages before applying the inspector limit', () => {
    const messages = [
      message('one', [todo('verify'), todo('write')]),
      message('two', [todo('verify', 'completed'), todo('ship')]),
    ]

    expect(recentTodos(messages, 2)).toEqual([todo('verify', 'completed'), todo('ship')])
  })
})
