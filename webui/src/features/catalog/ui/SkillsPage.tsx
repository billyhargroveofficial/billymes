import { useQuery, useQueryClient } from '@tanstack/react-query'
import { memo, useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useProfileScope } from '@/features/profiles'
import { cn } from '@/shared/lib/cn'
import { errorMessage } from '@/shared/lib/error-message'
import { Markdown } from '@/shared/ui/Markdown'
import { StaggerItem, SwapPane } from '@/shared/ui/motion'
import { Notice } from '@/shared/ui/notice'
import { EmptyHint } from '@/shared/ui/page'
import { Sheet } from '@/shared/ui/sheet'
import { SkeletonRows, SkeletonText } from '@/shared/ui/skeleton'
import { Switch } from '@/shared/ui/switch'
import { catalogApi } from '../api/catalog-api'
import { splitSkillMarkdown } from '../model/skill-markdown'
import type { Skill } from '../model/types'
import { CatalogSplitView } from './CatalogSplitView'

const EMPTY_SKILLS: Skill[] = []
const MOBILE = '(max-width: 1023px)'

export function SkillsPage() {
  const { profile } = useProfileScope()
  const qc = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const q = searchParams.get('q') ?? ''
  const open = searchParams.get('skill')
  const [mobileOpen, setMobileOpen] = useState(
    () => Boolean(open) && window.matchMedia(MOBILE).matches,
  )
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const skillsQ = useQuery({
    queryKey: ['skills', profile],
    queryFn: () => catalogApi.skills(profile),
  })
  const contentQ = useQuery({
    queryKey: ['skill-content', profile, open],
    queryFn: () => catalogApi.skillContent(open!, profile),
    enabled: Boolean(open),
  })

  const skills = skillsQ.data ?? EMPTY_SKILLS
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return [...skills]
      .filter((skill) =>
        !needle
          ? true
          : skill.name.toLowerCase().includes(needle) ||
            skill.description.toLowerCase().includes(needle) ||
            skill.category.toLowerCase().includes(needle),
      )
      .sort((left, right) => right.usage - left.usage || left.name.localeCompare(right.name))
  }, [q, skills])

  const updateRoute = useCallback(
    (key: 'q' | 'skill', value: string) => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous)
          if (value) next.set(key, value)
          else next.delete(key)
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  const toggle = useCallback(
    async (name: string, enabled: boolean) => {
      setBusy(name)
      setActionError(null)
      try {
        await catalogApi.toggleSkill(name, enabled, profile)
        await qc.invalidateQueries({ queryKey: ['skills', profile] })
      } catch (error) {
        setActionError(errorMessage(error, 'не удалось изменить скилл'))
      } finally {
        setBusy(null)
      }
    },
    [profile, qc],
  )

  const onToggle = useCallback(
    (name: string, enabled: boolean) => void toggle(name, enabled),
    [toggle],
  )
  const onSelect = useCallback(
    (name: string) => {
      updateRoute('skill', name)
      if (window.matchMedia(MOBILE).matches) setMobileOpen(true)
    },
    [updateRoute],
  )

  const loadError = skillsQ.error
    ? errorMessage(skillsQ.error, 'не удалось загрузить скиллы')
    : null
  const contentError = contentQ.error
    ? errorMessage(contentQ.error, 'не удалось прочитать SKILL.md')
    : null
  const listPane = skillsQ.isPending
    ? 'skeleton'
    : loadError
      ? 'error'
      : rows.length
        ? 'ready'
        : 'empty'
  const detailPane = !open
    ? 'blank'
    : contentError
      ? 'error'
      : contentQ.data?.content
        ? 'ready'
        : 'skeleton'

  const detail = (
    <SwapPane pane={`${open ?? ''}:${detailPane}`}>
      {detailPane === 'blank' ? (
        <EmptyHint>выбери скилл — справа откроется каноничный SKILL.md</EmptyHint>
      ) : detailPane === 'error' ? (
        <Notice>{contentError}</Notice>
      ) : detailPane === 'skeleton' ? (
        <div className="space-y-4">
          <SkeletonText lines={2} />
          <SkeletonText lines={6} />
        </div>
      ) : (
        <SkillDoc raw={contentQ.data?.content ?? ''} fallbackName={open ?? ''} />
      )}
    </SwapPane>
  )

  return (
    <>
      <CatalogSplitView
        eyebrow="каталог"
        title={`${skills.length} скиллов`}
        searchLabel="найти скилл"
        query={q}
        onQueryChange={(value) => updateRoute('q', value)}
        detail={detail}
      >
        {actionError && <Notice className="mb-3">{actionError}</Notice>}
        {open && contentError && <Notice className="mb-3 lg:hidden">{contentError}</Notice>}

        <SwapPane pane={listPane}>
          {listPane === 'skeleton' ? (
            <SkeletonRows rows={8} label="загружаем скиллы" />
          ) : listPane === 'error' ? (
            <Notice>{loadError}</Notice>
          ) : listPane === 'empty' ? (
            <EmptyHint>{skills.length ? 'по запросу скиллов нет' : 'скиллов нет'}</EmptyHint>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-line">
              {rows.map((skill, index) => (
                <StaggerItem key={skill.name} index={index}>
                  <SkillRow
                    skill={skill}
                    rank={index + 1}
                    selected={open === skill.name}
                    busy={busy === skill.name}
                    onSelect={onSelect}
                    onToggle={onToggle}
                  />
                </StaggerItem>
              ))}
            </div>
          )}
        </SwapPane>
      </CatalogSplitView>

      <Sheet
        open={mobileOpen && Boolean(open)}
        onOpenChange={setMobileOpen}
        title={open || 'скилл'}
        className="w-[min(94vw,38rem)]"
      >
        {detail}
      </Sheet>
    </>
  )
}

const SkillRow = memo(function SkillRow({
  skill,
  rank,
  selected,
  busy,
  onSelect,
  onToggle,
}: {
  skill: Skill
  rank: number
  selected: boolean
  busy: boolean
  onSelect: (name: string) => void
  onToggle: (name: string, enabled: boolean) => void
}) {
  return (
    <div
      data-selected={String(selected)}
      className="row-interactive flex items-center gap-3 border-b border-line/60 px-3 py-2 last:border-0"
    >
      <span className="w-7 shrink-0 pl-1 font-mono text-[10px] text-mercury tabular-nums">
        #{rank}
      </span>
      <button
        type="button"
        aria-pressed={selected}
        className={cn('min-w-0 flex-1 text-left', !skill.enabled && 'opacity-60')}
        onClick={() => onSelect(skill.name)}
      >
        <div className="truncate font-medium">{skill.name}</div>
        <div className="truncate text-[11px] text-mute">
          {skill.category || skill.provenance}
          {skill.description ? ` · ${skill.description}` : ''}
        </div>
      </button>
      <span className="shrink-0 font-mono text-xs tabular-nums text-paper">{skill.usage}×</span>
      <Switch
        aria-label={`${skill.enabled ? 'выключить' : 'включить'} скилл ${skill.name}`}
        checked={skill.enabled}
        disabled={busy}
        onCheckedChange={(enabled) => onToggle(skill.name, enabled)}
      />
    </div>
  )
})

function SkillDoc({ raw, fallbackName }: { raw: string; fallbackName: string }) {
  const { meta, body } = splitSkillMarkdown(raw)
  const chips = [meta.author, meta.version && `v${meta.version}`, meta.license].filter(
    Boolean,
  ) as string[]

  return (
    <article>
      <div className="mb-6 border-b border-line pb-5">
        <div className="text-[10px] uppercase tracking-[0.2em] text-mute">SKILL.md</div>
        <h2 className="mt-1 font-display text-3xl italic leading-none text-mercury">
          {meta.name || fallbackName}
        </h2>
        {meta.description && <p className="mt-3 text-sm leading-6 text-mute">{meta.description}</p>}
        {chips.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-mute">
            {chips.map((chip) => (
              <span key={chip}>{chip}</span>
            ))}
          </div>
        )}
      </div>
      <Markdown text={body} />
    </article>
  )
}
