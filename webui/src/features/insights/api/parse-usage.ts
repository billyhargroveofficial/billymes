import { expectArray, expectRecord, expectString } from '@/shared/api'
import type {
  DailyUsage,
  ModelReport,
  ModelRow,
  ModelUsage,
  SkillUsage,
  TaskUsage,
  ToolUsage,
  UsageReport,
  UsageTotals,
} from '../model/types'

export function numberOr(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function stringOr(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

export function booleanOr(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function names(value: unknown): string[] {
  const seen = new Set<string>()
  for (const entry of list(value)) {
    const name = typeof entry === 'string' ? entry : stringOr(record(entry).task)
    if (name) seen.add(name)
  }
  return [...seen]
}

function parseDay(value: unknown, index: number): DailyUsage {
  const label = `analytics usage.daily[${index}]`
  const row = expectRecord(value, label)
  return {
    day: expectString(row.day, `${label}.day`),
    inputTokens: numberOr(row.input_tokens),
    outputTokens: numberOr(row.output_tokens),
    cacheReadTokens: numberOr(row.cache_read_tokens),
    reasoningTokens: numberOr(row.reasoning_tokens),
    estimatedCost: numberOr(row.estimated_cost),
    actualCost: numberOr(row.actual_cost),
    sessions: numberOr(row.sessions),
    apiCalls: numberOr(row.api_calls),
  }
}

function parseModelUsage(value: unknown, index: number): ModelUsage {
  const label = `analytics usage.by_model[${index}]`
  const row = expectRecord(value, label)
  return {
    model: expectString(row.model, `${label}.model`),
    inputTokens: numberOr(row.input_tokens),
    outputTokens: numberOr(row.output_tokens),
    estimatedCost: numberOr(row.estimated_cost),
    sessions: numberOr(row.sessions),
    apiCalls: numberOr(row.api_calls),
    auxTasks: names(row.aux_tasks),
  }
}

function parseTaskUsage(value: unknown, index: number): TaskUsage {
  const label = `analytics usage.by_task[${index}]`
  const row = expectRecord(value, label)
  return {
    task: expectString(row.task, `${label}.task`),
    inputTokens: numberOr(row.input_tokens),
    outputTokens: numberOr(row.output_tokens),
    estimatedCost: numberOr(row.estimated_cost),
    apiCalls: numberOr(row.api_calls),
    models: names(row.models),
  }
}

function parseSkill(value: unknown, index: number): SkillUsage {
  const label = `analytics usage.skills.top_skills[${index}]`
  const row = expectRecord(value, label)
  return {
    skill: expectString(row.skill, `${label}.skill`),
    viewCount: numberOr(row.view_count),
    manageCount: numberOr(row.manage_count),
    totalCount: numberOr(row.total_count),
    percentage: numberOr(row.percentage),
    lastUsedAt: nullableNumber(row.last_used_at),
  }
}

function parseTool(value: unknown, index: number): ToolUsage {
  const label = `analytics usage.tools[${index}]`
  const row = expectRecord(value, label)
  return {
    tool: expectString(row.tool, `${label}.tool`),
    count: numberOr(row.count),
    percentage: numberOr(row.percentage),
  }
}

function parseTotals(value: unknown): UsageTotals {
  const row = record(value)
  return {
    input: numberOr(row.total_input),
    output: numberOr(row.total_output),
    cacheRead: numberOr(row.total_cache_read),
    reasoning: numberOr(row.total_reasoning),
    estimatedCost: numberOr(row.total_estimated_cost),
    actualCost: numberOr(row.total_actual_cost),
    sessions: numberOr(row.total_sessions),
    apiCalls: numberOr(row.total_api_calls),
  }
}

export function parseUsageReport(payload: unknown, requestedDays: number): UsageReport {
  const root = expectRecord(payload, 'analytics usage')
  const skills = record(root.skills)
  const summary = record(skills.summary)
  return {
    daily: list(root.daily).map(parseDay),
    byModel: list(root.by_model).map(parseModelUsage),
    byTask: list(root.by_task).map(parseTaskUsage),
    totals: parseTotals(root.totals),
    periodDays: numberOr(root.period_days, requestedDays),
    skills: {
      summary: {
        totalLoads: numberOr(summary.total_skill_loads),
        totalEdits: numberOr(summary.total_skill_edits),
        totalActions: numberOr(summary.total_skill_actions),
        distinctSkills: numberOr(summary.distinct_skills_used),
      },
      top: list(skills.top_skills).map(parseSkill),
    },
    tools: list(root.tools).map(parseTool),
  }
}

function parseModelRow(value: unknown, index: number): ModelRow {
  const label = `analytics models.models[${index}]`
  const row = expectRecord(value, label)
  const caps = record(row.capabilities)
  return {
    model: expectString(row.model, `${label}.model`),
    provider: stringOr(row.provider),
    inputTokens: numberOr(row.input_tokens),
    outputTokens: numberOr(row.output_tokens),
    cacheReadTokens: numberOr(row.cache_read_tokens),
    reasoningTokens: numberOr(row.reasoning_tokens),
    estimatedCost: numberOr(row.estimated_cost),
    actualCost: numberOr(row.actual_cost),
    sessions: numberOr(row.sessions),
    apiCalls: numberOr(row.api_calls),
    toolCalls: numberOr(row.tool_calls),
    lastUsedAt: nullableNumber(row.last_used_at),
    avgTokensPerSession: numberOr(row.avg_tokens_per_session),
    capabilities: {
      supportsTools: booleanOr(caps.supports_tools),
      supportsVision: booleanOr(caps.supports_vision),
      supportsReasoning: booleanOr(caps.supports_reasoning),
      contextWindow: nullableNumber(caps.context_window),
      maxOutputTokens: nullableNumber(caps.max_output_tokens),
      family: stringOr(caps.model_family),
    },
  }
}

export function parseModelReport(payload: unknown, requestedDays: number): ModelReport {
  const root = expectRecord(payload, 'analytics models')
  return {
    models: expectArray(root.models ?? [], 'analytics models.models').map(parseModelRow),
    periodDays: numberOr(root.period_days, requestedDays),
  }
}
