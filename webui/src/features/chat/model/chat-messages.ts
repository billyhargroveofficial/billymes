import type { ChatMessage } from './types'

export function systemMessage(content: string): ChatMessage {
  return {
    localId: `system-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'system',
    content,
    thinking: '',
    tools: [],
    todos: [],
    subagents: [],
    streaming: false,
  }
}

export function userMessage(content: string): ChatMessage {
  return {
    localId: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content,
    thinking: '',
    tools: [],
    todos: [],
    subagents: [],
    streaming: false,
    timestamp: Date.now() / 1000,
  }
}
