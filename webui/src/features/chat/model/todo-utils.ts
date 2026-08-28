import type { ChatMessage, TodoItem } from './types'

export function mergeTodos(current: TodoItem[], incoming: TodoItem[]) {
  const byId = new Map(current.map((todo) => [todo.id, todo]))
  for (const todo of incoming) {
    byId.delete(todo.id)
    byId.set(todo.id, todo)
  }
  return [...byId.values()]
}

export function recentTodos(messages: ChatMessage[], limit = 12) {
  let merged: TodoItem[] = []
  for (const message of messages) merged = mergeTodos(merged, message.todos)
  return merged.slice(-limit)
}
