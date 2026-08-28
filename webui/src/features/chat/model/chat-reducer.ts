import type { GatewayEvent } from '@/features/gateway'
import { extractSubagent, extractTodos, payloadRecord, payloadText } from './chat-history'
import { toolPreview, unwrapTool } from './tool-display'
import { mergeTodos } from './todo-utils'
import type { ChatMessage, ToolCall } from './types'

let messageSequence = 0

function nextLocalId(prefix: string) {
  messageSequence += 1
  return `${prefix}-${Date.now()}-${messageSequence}`
}

function blankAssistant(): ChatMessage {
  return {
    localId: nextLocalId('a'),
    role: 'assistant',
    content: '',
    thinking: '',
    tools: [],
    todos: [],
    subagents: [],
    streaming: true,
  }
}

function streamingAssistantIndex(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'assistant' && message.streaming) return index
  }
  return -1
}

function copyAssistant(message: ChatMessage): ChatMessage {
  return {
    ...message,
    tools: message.tools.map((tool) => ({ ...tool })),
    todos: [...message.todos],
    subagents: message.subagents.map((subagent) => ({ ...subagent })),
  }
}

function mergeAssistantContent(message: ChatMessage, text: string) {
  if (!text) return
  if (!message.content || text.startsWith(message.content)) {
    message.content = text
  } else if (!message.content.startsWith(text) && !message.content.endsWith(text)) {
    message.content += text
  }
}

function mergeInterimContent(message: ChatMessage, text: string, alreadyStreamed: boolean) {
  if (alreadyStreamed && message.content === text) return
  mergeAssistantContent(message, text)
}

export function applyGatewayEvent(messages: ChatMessage[], event: GatewayEvent): ChatMessage[] {
  const type = event.type
  if (type === 'session.info' || type === 'session.usage') return messages
  if (type === 'message.start') return [...messages, blankAssistant()]

  const payload = event.payload
  const record = payloadRecord(payload)
  const existingIndex = streamingAssistantIndex(messages)
  let next: ChatMessage[] | null = null
  let assistant: ChatMessage | null = null

  const ensureAssistant = () => {
    if (assistant) return assistant
    if (existingIndex >= 0) {
      const current = messages[existingIndex]
      if (current) {
        assistant = copyAssistant(current)
        next = [...messages]
        next[existingIndex] = assistant
        return assistant
      }
    }
    assistant = blankAssistant()
    next = [...messages, assistant]
    return assistant
  }

  if (type === 'message.delta') {
    ensureAssistant().content += payloadText(payload)
    return next ?? messages
  }

  if (type === 'message.interim') {
    const interim = payloadText(payload)
    if (!interim) return messages

    // Hermes sends commentary as a segment boundary. The text can already be
    // present from message.delta, so `already_streamed` must not render it twice.
    // A later tool (or final answer) then receives a fresh assistant segment.
    const current = existingIndex >= 0 ? messages[existingIndex] : undefined
    if (current) {
      const sealed = copyAssistant(current)
      mergeInterimContent(sealed, interim, record.already_streamed === true)
      sealed.streaming = false
      const sealedMessages = [...messages]
      sealedMessages[existingIndex] = sealed
      return sealedMessages
    }

    const sealed = blankAssistant()
    mergeInterimContent(sealed, interim, record.already_streamed === true)
    sealed.streaming = false
    return [...messages, sealed]
  }

  if (type === 'thinking.delta' || type === 'reasoning.delta') {
    ensureAssistant().thinking += payloadText(payload)
    return next ?? messages
  }

  if (type === 'message.complete') {
    const message = ensureAssistant()
    message.streaming = false
    mergeAssistantContent(message, payloadText(payload))
    return next ?? messages
  }

  if (type === 'tool.start' || type === 'tool.generating') {
    const current = existingIndex >= 0 ? messages[existingIndex] : undefined
    const toolId = String(
      record.tool_id ?? record.id ?? record.tool_call_id ?? record.call_id ?? '',
    )
    const duplicate = Boolean(toolId && current?.tools.some((tool) => tool.id === toolId))
    if (current?.content.trim() && !duplicate) {
      // MessageRow deliberately renders its timeline before prose. Seal text
      // that arrived first so a later tool card cannot leap above it.
      const sealed = copyAssistant(current)
      sealed.streaming = false
      const split = [...messages]
      split[existingIndex] = sealed
      return applyGatewayEvent([...split, blankAssistant()], event)
    }
    const message = ensureAssistant()
    const id = String(
      record.tool_id ?? record.id ?? record.tool_call_id ?? record.call_id ?? nextLocalId('t'),
    )
    const rawName = String(record.name ?? record.tool ?? record.tool_name ?? 'tool')
    const rawArgs = record.arguments ?? record.args ?? record.input ?? ''
    const unwrapped = unwrapTool(
      rawName,
      typeof rawArgs === 'string' ? rawArgs : (rawArgs as Record<string, unknown>),
    )
    const args = stringify(rawArgs)
    const context = typeof record.context === 'string' ? record.context : ''
    const preview =
      context ||
      toolPreview(
        rawName,
        typeof rawArgs === 'string' ? rawArgs : (rawArgs as Record<string, unknown>),
      )
    const existing = message.tools.find((tool) => tool.id === id)
    if (existing) {
      existing.status = 'running'
      existing.args = args || existing.args
      existing.name = unwrapped.name || existing.name
      if (preview) existing.preview = preview
    } else {
      message.tools.push({
        id,
        name: unwrapped.name,
        args,
        result: '',
        status: 'running',
        ...(preview ? { preview } : {}),
      })
    }
    const todos = extractTodos(unwrapped.name, args)
    if (todos.length) message.todos = mergeTodos(message.todos, todos)
    const subagent = extractSubagent(unwrapped.name, args, '', id)
    if (subagent) {
      message.subagents = [...message.subagents.filter((item) => item.id !== id), subagent]
    }
    return next ?? messages
  }

  if (type === 'tool.progress') {
    const message = ensureAssistant()
    const id = String(record.tool_id ?? record.id ?? record.tool_call_id ?? record.call_id ?? '')
    const tool = message.tools.find((item) => item.id === id) ?? message.tools.at(-1)
    if (tool) {
      tool.result +=
        payloadText(payload) || stringify(record.output ?? record.chunk ?? record.progress ?? '')
    }
    return next ?? messages
  }

  if (type === 'tool.complete') {
    const message = ensureAssistant()
    const id = String(record.tool_id ?? record.id ?? record.tool_call_id ?? record.call_id ?? '')
    let tool = message.tools.find((item) => item.id === id)
    if (!tool && id && typeof record.name === 'string' && record.name) {
      // The start event can be gated off (tool progress disabled); the
      // completion still deserves its own row instead of hijacking the last.
      tool = {
        id,
        name: unwrapTool(record.name, record.args as Record<string, unknown> | undefined).name,
        args: '',
        result: '',
        status: 'done',
      }
      message.tools.push(tool)
    }
    tool = tool ?? message.tools.at(-1)
    const result =
      payloadText(payload) ||
      stringify(record.output ?? record.result ?? record.content ?? record.result_text ?? '')
    if (tool) completeTool(message, tool, record, result)
    return next ?? messages
  }

  if (type.includes('subagent') || type.includes('delegation')) {
    const message = ensureAssistant()
    const id = String(record.id ?? record.child_session_id ?? record.session_id ?? nextLocalId('s'))
    message.subagents = [
      ...message.subagents.filter((item) => item.id !== id),
      {
        id,
        title: String(record.title ?? record.name ?? record.goal ?? 'сабагент'),
        status: String(record.status ?? type.split('.').at(-1) ?? 'running'),
        summary: payloadText(payload) || stringify(record.summary ?? record.error ?? ''),
      },
    ]
    return next ?? messages
  }

  return messages
}

function completeTool(
  message: ChatMessage,
  tool: ToolCall,
  record: Record<string, unknown>,
  result: string,
) {
  tool.result = result || tool.result
  tool.status = record.ok === false || record.error ? 'error' : 'done'
  if (typeof record.duration_s === 'number') tool.duration = record.duration_s
  const rawName = typeof record.name === 'string' && record.name ? record.name : tool.name
  if (typeof record.name === 'string' && record.name) {
    tool.name = unwrapTool(record.name, record.args as Record<string, unknown> | undefined).name
  }
  // tool.complete carries the authoritative args: some tools stream their
  // start event before arguments are parsed, so this is the first (and last)
  // chance to show what the call actually was. The args-derived preview is
  // the row's identity — the gateway's summary («Did 5 searches in 12s»)
  // must never replace it, it only fills rows that have nothing better.
  const argsRaw = record.args as string | Record<string, unknown> | undefined
  if (argsRaw && !tool.args) tool.args = stringify(argsRaw)
  const argsPreview = toolPreview(rawName, argsRaw)
  if (argsPreview) tool.preview = argsPreview
  else if (!tool.preview && typeof record.summary === 'string' && record.summary) {
    tool.preview = record.summary
  }
  const todos = extractTodos(tool.name, tool.args, tool.result)
  if (todos.length) message.todos = mergeTodos(message.todos, todos)
  const subagent = extractSubagent(tool.name, tool.args, tool.result, tool.id)
  if (subagent) {
    message.subagents = [...message.subagents.filter((item) => item.id !== tool.id), subagent]
  }
}

function stringify(value: unknown) {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
