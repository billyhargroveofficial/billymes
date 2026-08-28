import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Brain, GraduationCap, RefreshCw, Search, Share2, Sparkles, X } from 'lucide-react'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useProfileScope } from '@/features/profiles'
import { cn } from '@/shared/lib/cn'
import { errorMessage } from '@/shared/lib/error-message'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Rise, SwapPane } from '@/shared/ui/motion'
import { Notice } from '@/shared/ui/notice'
import { EmptyHint, PageShell, SectionCard } from '@/shared/ui/page'
import { Segmented } from '@/shared/ui/segmented'
import { Sheet } from '@/shared/ui/sheet'
import { Skeleton, SkeletonBlock, SkeletonRows } from '@/shared/ui/skeleton'
import { memoryApi } from '../api/memory-api'
import {
  buildMemoryEntries,
  clusterBars,
  filterMemoryEntries,
  filterSkillNodes,
  formatCount,
  MEMORY_FORMS,
  memorySourceCounts,
  RECORD_FORMS,
  SKILL_FORMS,
} from '../model/graph-view'
import type { LearningCluster, LearningNode, MemoryChunk } from '../model/types'
import { LearnedSkillList } from './LearnedSkillList'
import { MemoryBackendSection } from './MemoryBackendSection'
import { MemoryHero } from './MemoryHero'
import { MemoryList } from './MemoryList'
import { ConnectionsPanel } from './MemoryStats'
import { NodeDetail } from './NodeDetail'

const EMPTY_NODES: LearningNode[] = []
const EMPTY_CHUNKS: MemoryChunk[] = []
const EMPTY_CLUSTERS: LearningCluster[] = []
const NARROW = '(max-width: 1023px)'

const SOURCE_LABEL: Record<string, string> = {
  memory: 'MEMORY.md',
  profile: 'о пользователе',
}

function subscribeNarrow(notify: () => void) {
  const media = window.matchMedia(NARROW)
  media.addEventListener('change', notify)
  return () => media.removeEventListener('change', notify)
}

const readNarrow = () => window.matchMedia(NARROW).matches
const narrowOnServer = () => false

/**
 * `/memory` — everything the agent has stored for the current profile: memory
 * chunks, learned skills, how they link up, and which backend holds them.
 * Every graph query is keyed by profile so the rail switch refetches.
 */
export function MemoryPage() {
  const { profile } = useProfileScope()
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const query = searchParams.get('q') ?? ''
  const source = searchParams.get('src') ?? ''
  const category = searchParams.get('cat') ?? ''
  const selected = searchParams.get('node')
  const expandedProvider = searchParams.get('prov') ?? ''

  const narrow = useSyncExternalStore(subscribeNarrow, readNarrow, narrowOnServer)
  const [now] = useState(() => Date.now())
  const [sheetOpen, setSheetOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const graphQuery = useQuery({
    queryKey: ['memory', 'graph', profile],
    queryFn: () => memoryApi.graph(profile),
  })
  /** Shares the backend section's cache entry; the hero only reads the name. */
  const statusQuery = useQuery({
    queryKey: ['memory', 'status'],
    queryFn: () => memoryApi.status(),
  })
  const graph = graphQuery.data

  const entries = useMemo(
    () => buildMemoryEntries(graph?.memory ?? EMPTY_CHUNKS, graph?.nodes ?? EMPTY_NODES),
    [graph],
  )
  const visibleMemory = useMemo(
    () => filterMemoryEntries(entries, query, source),
    [entries, query, source],
  )
  const skills = useMemo(
    () => filterSkillNodes(graph?.nodes ?? EMPTY_NODES, query, category),
    [graph, query, category],
  )
  const bars = useMemo(() => clusterBars(graph?.clusters ?? EMPTY_CLUSTERS), [graph])
  const sourceOptions = useMemo(
    () => [
      { value: '', label: 'все' },
      ...memorySourceCounts(entries).map((entry) => ({
        value: entry.category,
        label: SOURCE_LABEL[entry.category] ?? entry.category,
      })),
    ],
    [entries],
  )
  const selectedNode = useMemo(
    () => graph?.nodes.find((node) => node.id === selected) ?? null,
    [graph, selected],
  )
  const skillTotal = useMemo(
    () => (graph?.nodes ?? EMPTY_NODES).filter((node) => node.kind === 'skill').length,
    [graph],
  )

  const setParam = useCallback(
    (key: string, value: string) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current)
          if (value) next.set(key, value)
          else next.delete(key)
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  const selectSkill = useCallback(
    (id: string) => {
      setNotice(null)
      setParam('node', id)
      if (narrow) setSheetOpen(true)
    },
    [narrow, setParam],
  )
  const openMemory = useCallback(
    (id: string) => {
      setNotice(null)
      setParam('node', id)
      setSheetOpen(true)
    },
    [setParam],
  )
  const handleDeleted = useCallback(
    (message: string) => {
      setNotice(message)
      setParam('node', '')
      setSheetOpen(false)
    },
    [setParam],
  )
  /** Picking a category anywhere on the page means «покажи эти скиллы». */
  const setCategory = useCallback(
    (value: string) => {
      setParam('cat', value)
      if (value) {
        document
          .getElementById('sec-skills')
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    },
    [setParam],
  )
  const setSource = useCallback((value: string) => setParam('src', value), [setParam])
  const setQuery = useCallback((value: string) => setParam('q', value), [setParam])
  const expandProvider = useCallback((value: string) => setParam('prov', value), [setParam])
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['memory'] })
  }, [queryClient])

  const pane = graphQuery.isPending
    ? 'skeleton'
    : graphQuery.error
      ? 'error'
      : graph && graph.nodes.length
        ? 'ready'
        : 'empty'

  const showDetail = !narrow && selectedNode?.kind === 'skill' && Boolean(selected)
  const nodeDetail = (showHeader: boolean) =>
    selected ? (
      <NodeDetail
        key={selected}
        nodeId={selected}
        profile={profile}
        meta={selectedNode}
        now={now}
        showHeader={showHeader}
        onDeleted={handleDeleted}
      />
    ) : null

  return (
    <PageShell
      eyebrow="память"
      title={graph ? formatCount(graph.nodes.length, RECORD_FORMS) : 'что помнит'}
      actions={
        <>
          <SearchField value={query} onChange={setQuery} />
          <Button type="button" variant="outline" size="sm" onClick={refresh}>
            <RefreshCw
              aria-hidden="true"
              className={cn(
                'size-3.5',
                (graphQuery.isFetching || statusQuery.isFetching) &&
                  'animate-spin motion-reduce:animate-none',
              )}
            />
            обновить
          </Button>
        </>
      }
    >
      {notice && (
        <Rise className="mb-3">
          <Notice tone="success">{notice}</Notice>
        </Rise>
      )}

      <SwapPane pane={pane} className="space-y-4">
        {pane === 'skeleton' ? (
          <MemorySkeleton />
        ) : pane === 'error' ? (
          <Notice>{errorMessage(graphQuery.error, 'не удалось загрузить память')}</Notice>
        ) : pane === 'empty' ? (
          <EmptyHint>агент пока ничего не запомнил в этом профиле</EmptyHint>
        ) : graph ? (
          <>
            <MemoryHero
              stats={graph.stats}
              edges={graph.edges.length}
              bars={bars}
              backend={statusQuery.data?.active ?? ''}
              activeCategory={category}
              onCategory={setCategory}
            />

            <SectionCard
              id="sec-memory"
              icon={<Brain aria-hidden="true" className="size-3" />}
              title="воспоминания"
              hint={`${visibleMemory.length} из ${formatCount(entries.length, MEMORY_FORMS)}`}
              actions={
                sourceOptions.length > 2 ? (
                  <Segmented
                    label="источник воспоминания"
                    value={source}
                    options={sourceOptions}
                    onChange={setSource}
                  />
                ) : null
              }
            >
              {visibleMemory.length ? (
                <MemoryList
                  entries={visibleMemory}
                  now={now}
                  selectedId={selected}
                  onOpen={openMemory}
                />
              ) : (
                <EmptyHint>
                  {query ? `по запросу «${query}» ничего нет` : 'в этом источнике пусто'}
                </EmptyHint>
              )}
            </SectionCard>

            <SectionCard
              id="sec-skills"
              icon={<GraduationCap aria-hidden="true" className="size-3" />}
              title="выученные скиллы"
              hint={`${skills.length} из ${formatCount(skillTotal, SKILL_FORMS)}`}
              actions={
                category ? (
                  <button
                    type="button"
                    onClick={() => setCategory('')}
                    className="inline-flex items-center gap-1.5 rounded-full border border-line bg-raised/60 px-2.5 py-1 text-[11px] text-mute transition-colors hover:text-paper"
                  >
                    {category}
                    <X aria-hidden="true" className="size-3" />
                    <span className="sr-only">сбросить категорию</span>
                  </button>
                ) : null
              }
            >
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] xl:grid-cols-[minmax(0,1fr)_minmax(0,30rem)]">
                {skills.length ? (
                  <LearnedSkillList
                    nodes={skills}
                    now={now}
                    selectedId={selected}
                    onSelect={selectSkill}
                  />
                ) : (
                  <EmptyHint>
                    {query
                      ? `по запросу «${query}» скиллов нет`
                      : category
                        ? `в категории «${category}» пусто`
                        : 'скиллов пока нет'}
                  </EmptyHint>
                )}
                <aside
                  className={cn(
                    'relative hidden self-start rounded-2xl lg:sticky lg:top-2 lg:block',
                    showDetail
                      ? 'border border-line bg-raised/20'
                      : 'border border-dashed border-line',
                  )}
                >
                  {showDetail ? (
                    <>
                      <div className="max-h-[70vh] overflow-y-auto p-4">{nodeDetail(true)}</div>
                      {/* The scrollbars are hidden desk-wide, so the panel says
                          «здесь ещё есть текст» with a fade instead. */}
                      <div
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-x-px bottom-px h-8 rounded-b-2xl bg-gradient-to-t from-panel to-transparent"
                      />
                    </>
                  ) : (
                    <div className="grid place-items-center px-4 py-14 text-center">
                      <Sparkles aria-hidden="true" className="size-5 text-mute/60" />
                      <p className="mt-2 text-sm text-mute">выбери скилл слева</p>
                      <p className="mt-0.5 text-[11px] text-mute/70">
                        здесь откроется его SKILL.md — с правкой и архивацией
                      </p>
                    </div>
                  )}
                </aside>
              </div>
            </SectionCard>

            <SectionCard
              id="sec-links"
              icon={<Share2 aria-hidden="true" className="size-3" />}
              title="связи"
              hint="категории и плотность графа"
            >
              <ConnectionsPanel
                bars={bars}
                stats={graph.stats}
                activeCategory={category}
                onCategory={setCategory}
              />
            </SectionCard>
          </>
        ) : null}
      </SwapPane>

      <div className="mt-4">
        <MemoryBackendSection
          profile={profile}
          expandedProvider={expandedProvider}
          onExpandProvider={expandProvider}
        />
      </div>

      <Sheet
        open={sheetOpen && Boolean(selected)}
        onOpenChange={setSheetOpen}
        title={sheetTitle(selectedNode)}
        className="w-[min(94vw,42rem)]"
      >
        {nodeDetail(false)}
      </Sheet>
    </PageShell>
  )
}

/**
 * A memory chunk has no name — the gateway derives its «title» by truncating
 * its own body, so the panel says what it is and lets the body speak.
 */
function sheetTitle(node: LearningNode | null) {
  if (!node) return 'узел памяти'
  return node.kind === 'memory' ? 'воспоминание' : node.label
}

/** Search over both memory chunks and skills, with a visible way back out. */
function SearchField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="relative w-full sm:w-72">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-mute"
      />
      <Input
        type="search"
        name="memory-search"
        autoComplete="off"
        aria-label="найти в памяти"
        className="pl-9 pr-9"
        placeholder="найти в памяти"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {value && (
        <button
          type="button"
          aria-label="очистить поиск"
          onClick={() => onChange('')}
          className="absolute right-2 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-lg text-mute transition-colors hover:text-paper"
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
      )}
    </div>
  )
}

/** Mirrors the loaded layout: hero band, memory cards, then the skill list. */
function MemorySkeleton() {
  return (
    <SkeletonBlock label="читаем память" className="space-y-4">
      <Skeleton className="h-32 rounded-3xl" />
      <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-40 rounded-2xl" />
        ))}
      </div>
      <SkeletonRows rows={6} label="читаем скиллы" />
    </SkeletonBlock>
  )
}
