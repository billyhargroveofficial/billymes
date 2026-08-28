/** Normalised analytics shapes. The gateway payloads use snake_case. */

export type DailyUsage = {
  day: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  reasoningTokens: number
  estimatedCost: number
  actualCost: number
  sessions: number
  apiCalls: number
}

export type UsageTotals = {
  input: number
  output: number
  cacheRead: number
  reasoning: number
  estimatedCost: number
  actualCost: number
  sessions: number
  apiCalls: number
}

export type ModelUsage = {
  model: string
  inputTokens: number
  outputTokens: number
  estimatedCost: number
  sessions: number
  apiCalls: number
  /** Names only — the gateway sends either bare strings or per-task rows. */
  auxTasks: string[]
}

export type TaskUsage = {
  task: string
  inputTokens: number
  outputTokens: number
  estimatedCost: number
  apiCalls: number
  models: string[]
}

export type SkillUsage = {
  skill: string
  viewCount: number
  manageCount: number
  totalCount: number
  percentage: number
  lastUsedAt: number | null
}

type SkillsSummary = {
  totalLoads: number
  totalEdits: number
  totalActions: number
  distinctSkills: number
}

export type ToolUsage = {
  tool: string
  count: number
  percentage: number
}

export type UsageReport = {
  daily: DailyUsage[]
  byModel: ModelUsage[]
  byTask: TaskUsage[]
  totals: UsageTotals
  periodDays: number
  skills: { summary: SkillsSummary; top: SkillUsage[] }
  tools: ToolUsage[]
}

type ModelCapabilities = {
  supportsTools: boolean
  supportsVision: boolean
  supportsReasoning: boolean
  contextWindow: number | null
  maxOutputTokens: number | null
  family: string
}

export type ModelRow = {
  model: string
  provider: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  reasoningTokens: number
  estimatedCost: number
  actualCost: number
  sessions: number
  apiCalls: number
  toolCalls: number
  lastUsedAt: number | null
  avgTokensPerSession: number
  capabilities: ModelCapabilities
}

export type ModelReport = {
  models: ModelRow[]
  periodDays: number
}

type SourceCount = {
  source: string
  count: number
}

export type SessionStats = {
  total: number
  activeStore: number
  archived: number
  messages: number
  bySource: SourceCount[]
}

export type ResourceUsage = {
  total: number
  used: number
  free: number
  percent: number
}

export type SystemStats = {
  os: string
  osRelease: string
  arch: string
  hostname: string
  pythonVersion: string
  hermesVersion: string
  cpuCount: number | null
  cpuPercent: number | null
  loadAvg: number[]
  memory: ResourceUsage | null
  disk: ResourceUsage | null
  uptimeSeconds: number | null
  processRss: number | null
  processThreads: number | null
  psutil: boolean
}
