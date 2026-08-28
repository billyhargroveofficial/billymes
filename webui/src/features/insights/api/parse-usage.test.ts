import { describe, expect, it } from 'vitest'
import { ApiPayloadError } from '@/shared/api'
import { parseModelReport, parseUsageReport } from './parse-usage'

const USAGE = {
  daily: [
    {
      day: '2026-08-26',
      input_tokens: 4_529_155,
      output_tokens: 248_394,
      cache_read_tokens: 78_103_680,
      reasoning_tokens: 118_529,
      estimated_cost: 0.0,
      actual_cost: 0,
      sessions: 14,
      api_calls: 614,
    },
  ],
  by_model: [
    {
      model: 'gpt-5.6-sol',
      input_tokens: 32_370_691,
      output_tokens: 2_743_048,
      estimated_cost: 0.0515886616,
      sessions: 88,
      api_calls: 4607,
      aux_tasks: [
        { task: 'background_review', input_tokens: 419_409, output_tokens: 64_914, api_calls: 105 },
        { task: 'compression', input_tokens: 195_650, output_tokens: 95_188, api_calls: 16 },
        { task: 'compression', input_tokens: 1, output_tokens: 1, api_calls: 1 },
      ],
    },
    { model: 'gpt-5.6-luna', input_tokens: 1, output_tokens: 1, sessions: 1, api_calls: 8 },
  ],
  by_task: [
    {
      task: 'background_review',
      input_tokens: 2_172_146,
      output_tokens: 267_182,
      estimated_cost: 0,
      api_calls: 332,
      models: ['grok-4.6', 'gpt-5.6-sol'],
    },
  ],
  totals: {
    total_input: 64_114_573,
    total_output: 4_674_005,
    total_cache_read: 966_552_995,
    total_reasoning: 2_378_466,
    total_estimated_cost: 1.2045999669999998,
    total_actual_cost: 0,
    total_sessions: 220,
    total_api_calls: 8157,
  },
  period_days: 30,
  skills: {
    summary: {
      total_skill_loads: 971,
      total_skill_edits: 70,
      total_skill_actions: 1041,
      distinct_skills_used: 71,
    },
    top_skills: [
      {
        skill: 'grounded-citations',
        view_count: 143,
        manage_count: 6,
        total_count: 149,
        percentage: 14.31316042267051,
        last_used_at: 1_787_757_421.9767702,
      },
    ],
  },
  tools: [{ tool: 'terminal', count: 4631, percentage: 19.166459730154788 }],
}

describe('parseUsageReport', () => {
  it('normalises the live payload', () => {
    const report = parseUsageReport(USAGE, 30)
    expect(report.periodDays).toBe(30)
    expect(report.daily[0]).toEqual({
      day: '2026-08-26',
      inputTokens: 4_529_155,
      outputTokens: 248_394,
      cacheReadTokens: 78_103_680,
      reasoningTokens: 118_529,
      estimatedCost: 0,
      actualCost: 0,
      sessions: 14,
      apiCalls: 614,
    })
    expect(report.totals.cacheRead).toBe(966_552_995)
    expect(report.tools[0]?.tool).toBe('terminal')
    expect(report.skills.summary.distinctSkills).toBe(71)
    expect(report.skills.top[0]?.lastUsedAt).toBeCloseTo(1_787_757_421.98)
  })

  it('flattens aux_tasks objects into distinct task names', () => {
    const report = parseUsageReport(USAGE, 30)
    expect(report.byModel[0]?.auxTasks).toEqual(['background_review', 'compression'])
  })

  it('accepts aux_tasks sent as plain strings and as nothing at all', () => {
    const report = parseUsageReport(
      { ...USAGE, by_model: [{ model: 'a', aux_tasks: ['vision', 'vision'] }, { model: 'b' }] },
      30,
    )
    expect(report.byModel[0]?.auxTasks).toEqual(['vision'])
    expect(report.byModel[1]?.auxTasks).toEqual([])
    expect(report.byModel[1]?.apiCalls).toBe(0)
  })

  it('survives a payload without skills, tools or totals', () => {
    const report = parseUsageReport({ daily: [] }, 7)
    expect(report.periodDays).toBe(7)
    expect(report.totals.apiCalls).toBe(0)
    expect(report.skills.top).toEqual([])
    expect(report.tools).toEqual([])
    expect(report.byTask).toEqual([])
  })

  it('rejects a day row without its date', () => {
    expect(() => parseUsageReport({ daily: [{ input_tokens: 1 }] }, 7)).toThrow(ApiPayloadError)
  })

  it('rejects a non-object payload', () => {
    expect(() => parseUsageReport([], 7)).toThrow(ApiPayloadError)
  })
})

const MODELS = {
  models: [
    {
      model: 'gpt-5.6-sol',
      provider: 'openai-codex',
      input_tokens: 31_237_993,
      output_tokens: 2_476_749,
      cache_read_tokens: 544_013_568,
      reasoning_tokens: 1_197_725,
      estimated_cost: 0.0334194784,
      actual_cost: 0,
      sessions: 87,
      api_calls: 4338,
      tool_calls: 5636,
      last_used_at: 1_787_759_192.9002945,
      avg_tokens_per_session: 387_525.7701149425,
      capabilities: {
        supports_tools: true,
        supports_vision: true,
        supports_reasoning: true,
        context_window: 272_000,
        max_output_tokens: 128_000,
        model_family: 'gpt-sol',
      },
    },
  ],
  totals: { distinct_models: 11 },
  period_days: 30,
}

describe('parseModelReport', () => {
  it('normalises a model row with its capabilities', () => {
    const report = parseModelReport(MODELS, 30)
    expect(report.periodDays).toBe(30)
    expect(report.models[0]?.provider).toBe('openai-codex')
    expect(report.models[0]?.toolCalls).toBe(5636)
    expect(report.models[0]?.capabilities.contextWindow).toBe(272_000)
    expect(report.models[0]?.capabilities.family).toBe('gpt-sol')
  })

  it('fills in missing capability and provider fields', () => {
    const report = parseModelReport({ models: [{ model: 'bare' }] }, 90)
    expect(report.periodDays).toBe(90)
    expect(report.models[0]?.provider).toBe('')
    expect(report.models[0]?.lastUsedAt).toBeNull()
    expect(report.models[0]?.capabilities).toEqual({
      supportsTools: false,
      supportsVision: false,
      supportsReasoning: false,
      contextWindow: null,
      maxOutputTokens: null,
      family: '',
    })
  })

  it('rejects a model row without a name', () => {
    expect(() => parseModelReport({ models: [{ provider: 'x' }] }, 30)).toThrow(ApiPayloadError)
  })
})
