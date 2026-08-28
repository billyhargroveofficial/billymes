export type SessionInfo = {
  id: string
  source: string | null
  title: string | null
  model: string | null
  message_count: number
  tool_call_count: number
  /** Presentation ledger count, available on newer gateways. */
  presentation_tool_call_count?: number | null
  /** Visible tool count: normalized transcript calls plus hosted/nested cards. */
  display_tool_call_count?: number | null
  /** Count of user messages; absent on gateways that predate the field. */
  turn_count?: number | null
  started_at: number | null
  last_activity_at: number | null
  ended_at: number | null
  end_reason: string | null
  parent_session_id: string | null
  profile_name: string | null
  estimated_cost_usd: number | null
  billing_provider: string | null
  input_tokens: number | null
  output_tokens: number | null
  reasoning_tokens: number | null
  cache_read_tokens: number | null
  pinned?: boolean
  is_active?: boolean
  last_active?: number | null
}

export type SessionUsage = {
  model?: string
  input?: number
  output?: number
  reasoning?: number
  total?: number
  calls?: number
  context_used?: number
  context_max?: number
  context_percent?: number
}

export type SessionRuntime = {
  model: string
  provider: string
  reasoning: string
  usage: SessionUsage
  turnStartedAt: number | null
  sessionStartedAt: number | null
  /** Wall-clock seconds the previous user turn took, live sessions only. */
  lastTurnSeconds: number | null
  contextWindow: number
}

export type SessionContentPart = string | Record<string, unknown>

export type SessionMessage = {
  id: number
  session_id: string
  role: string
  content: string | SessionContentPart[] | null
  tool_call_id: string | null
  tool_calls: ToolCallRaw[] | string | null
  tool_name: string | null
  timestamp: number | null
  finish_reason: string | null
  reasoning: string | null
  reasoning_content: string | null
}

export type ToolCallRaw = {
  id?: string
  call_id?: string
  type?: string
  function?: { name?: string; arguments?: string }
  name?: string
  arguments?: string
}

type ChatRole = 'user' | 'assistant' | 'system'
type ToolStatus = 'running' | 'done' | 'error'

export type ToolCall = {
  id: string
  name: string
  args: string
  result: string
  status: ToolStatus
  preview?: string
  duration?: number | null
}

export type TodoItem = {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | string
}

export type Subagent = {
  id: string
  title: string
  status: string
  summary: string
}

export type ChatMessage = {
  localId: string
  role: ChatRole
  content: string
  thinking: string
  tools: ToolCall[]
  todos: TodoItem[]
  subagents: Subagent[]
  streaming: boolean
  timestamp?: number
}
