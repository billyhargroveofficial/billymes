import { useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useProfileScope } from '@/features/profiles'
import { cn } from '@/shared/lib/cn'
import { errorMessage } from '@/shared/lib/error-message'
import { Button } from '@/shared/ui/button'
import { PageShell } from '@/shared/ui/page'
import { Segmented } from '@/shared/ui/segmented'
import { insightsApi, insightsKeys } from '../api/insights-api'
import { fillDailyGaps } from '../model/aggregate'
import {
  formatInt,
  formatMoney,
  formatPercent,
  formatRelativeTime,
  pluralRu,
} from '../model/format'
import { mergeModelRows } from '../model/model-rows'
import type { DailyUsage, ModelRow, SkillUsage, TaskUsage, ToolUsage } from '../model/types'
import type { BarRow } from './charts/BarSeries'
import { HostSection } from './HostSection'
import { CountUp } from './count-up'
import { InsightsHero } from './InsightsHero'
import { ModelsSection } from './ModelsSection'
import { RankedSection } from './RankedSection'
import { SessionsSection } from './SessionsSection'
import { TasksSection } from './TasksSection'

const RANGE_OPTIONS = [
  { value: '7', label: '7 дней' },
  { value: '30', label: '30 дней' },
  { value: '90', label: '90 дней' },
] as const

type RangeValue = (typeof RANGE_OPTIONS)[number]['value']

const EMPTY_DAILY: DailyUsage[] = []
const EMPTY_MODELS: ModelRow[] = []
const EMPTY_TOOLS: ToolUsage[] = []
const EMPTY_SKILLS: SkillUsage[] = []
const EMPTY_TASKS: TaskUsage[] = []
const STALE_MS = 45_000
const DAY_FORMS = ['день', 'дня', 'дней'] as const
const ROUTE_LOADED_AT = Date.now()

function readRange(raw: string | null): RangeValue {
  const match = RANGE_OPTIONS.find((option) => option.value === raw)
  return match ? match.value : '30'
}

export function InsightsPage() {
  const { profile } = useProfileScope()
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const range = readRange(searchParams.get('days'))
  const days = Number(range)
  const [cursor, setCursor] = useState<number | null>(null)

  const usageQuery = useQuery({
    queryKey: insightsKeys.usage(profile, days),
    queryFn: () => insightsApi.usage(profile, days),
    staleTime: STALE_MS,
  })
  const modelsQuery = useQuery({
    queryKey: insightsKeys.models(profile, days),
    queryFn: () => insightsApi.models(profile, days),
    staleTime: STALE_MS,
  })
  const sessionsQuery = useQuery({
    queryKey: insightsKeys.sessions(profile),
    queryFn: () => insightsApi.sessions(profile),
    staleTime: STALE_MS,
  })
  const systemQuery = useQuery({
    queryKey: insightsKeys.system(),
    queryFn: () => insightsApi.system(),
    staleTime: STALE_MS,
  })

  const usage = usageQuery.data ?? null
  const nowMs = usageQuery.dataUpdatedAt || modelsQuery.dataUpdatedAt || ROUTE_LOADED_AT

  const daily = useMemo(
    () => fillDailyGaps(usage?.daily ?? EMPTY_DAILY, days, nowMs),
    [days, nowMs, usage],
  )
  const models = useMemo(
    () => mergeModelRows(modelsQuery.data?.models ?? EMPTY_MODELS),
    [modelsQuery.data],
  )
  const tools = useMemo<BarRow[]>(
    () =>
      (usage?.tools ?? EMPTY_TOOLS).map((tool) => ({
        key: tool.tool,
        label: tool.tool,
        value: tool.count,
        share: formatPercent(tool.percentage),
      })),
    [usage],
  )
  const skills = useMemo<BarRow[]>(
    () =>
      (usage?.skills.top ?? EMPTY_SKILLS).map((skill) => ({
        key: skill.skill,
        label: skill.skill,
        value: skill.totalCount,
        share: formatPercent(skill.percentage),
        hint: formatRelativeTime(skill.lastUsedAt, nowMs),
      })),
    [nowMs, usage],
  )

  const onRangeChange = useCallback(
    (value: RangeValue) => {
      setCursor(null)
      const next = new URLSearchParams(searchParams)
      next.set('days', value)
      setSearchParams(next, { replace: true })
    },
    [searchParams, setSearchParams],
  )

  const onRefresh = useCallback(() => {
    void queryClient.invalidateQueries({
      predicate: (query) => String(query.queryKey[0] ?? '').startsWith('insights-'),
    })
  }, [queryClient])

  const usageError = usageQuery.error
    ? errorMessage(usageQuery.error, 'не удалось загрузить аналитику')
    : null
  const modelsError = modelsQuery.error
    ? errorMessage(modelsQuery.error, 'не удалось загрузить модели')
    : null
  const sessionsError = sessionsQuery.error
    ? errorMessage(sessionsQuery.error, 'не удалось загрузить сессии')
    : null
  const systemError = systemQuery.error
    ? errorMessage(systemQuery.error, 'не удалось загрузить хост')
    : null

  const busy =
    usageQuery.isFetching ||
    modelsQuery.isFetching ||
    sessionsQuery.isFetching ||
    systemQuery.isFetching

  const updatedLabel = usageQuery.dataUpdatedAt
    ? formatRelativeTime(usageQuery.dataUpdatedAt / 1000, nowMs)
    : null

  const inspected = cursor != null ? (daily[cursor] ?? null) : null
  const headlineCost = inspected ? inspected.estimatedCost : (usage?.totals.estimatedCost ?? 0)
  const eyebrow = [
    'аналитика',
    `${days} ${pluralRu(days, DAY_FORMS)}`,
    updatedLabel ? `обновлено ${updatedLabel}` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <PageShell
      eyebrow={eyebrow}
      title={
        usage ? (
          <CountUp
            className="tabular-nums"
            value={headlineCost}
            format={formatMoney}
            duration={inspected ? 0 : 700}
          />
        ) : (
          '—'
        )
      }
      actions={
        <>
          <Segmented
            label="окно аналитики"
            value={range}
            options={RANGE_OPTIONS}
            onChange={onRangeChange}
          />
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={busy}>
            <RefreshCw
              aria-hidden="true"
              className={cn('size-3.5', busy && 'animate-spin motion-reduce:animate-none')}
            />
            {busy ? 'обновляем…' : 'обновить'}
          </Button>
        </>
      }
    >
      <InsightsHero
        totals={usage?.totals ?? null}
        daily={daily}
        days={days}
        pending={usageQuery.isPending}
        error={usageError}
        cursor={cursor}
        onCursor={setCursor}
      />

      <div className="mt-8 grid gap-8 lg:grid-cols-3">
        <ModelsSection
          rows={models}
          pending={modelsQuery.isPending}
          error={modelsError}
          nowMs={nowMs}
        />
        <RankedSection
          title="тулы"
          rows={tools}
          format={formatInt}
          colorIndex={1}
          ariaLabel="тулы, ранжированные по числу вызовов"
          emptyText="тулы не вызывались"
          pending={usageQuery.isPending}
          error={usageError}
        />
        <RankedSection
          title="скиллы"
          rows={skills}
          format={formatInt}
          colorIndex={2}
          ariaLabel="скиллы, ранжированные по числу обращений"
          emptyText="скиллы не грузились"
          pending={usageQuery.isPending}
          error={usageError}
        />
      </div>

      <div className="mt-8 space-y-5 border-t border-line pt-5">
        <div className="grid gap-8 lg:grid-cols-2">
          <SessionsSection
            stats={sessionsQuery.data ?? null}
            pending={sessionsQuery.isPending}
            error={sessionsError}
          />
          <TasksSection
            tasks={usage?.byTask ?? EMPTY_TASKS}
            pending={usageQuery.isPending}
            error={usageError}
          />
        </div>
        <HostSection
          stats={systemQuery.data ?? null}
          pending={systemQuery.isPending}
          error={systemError}
        />
      </div>
    </PageShell>
  )
}
