import { memo, useMemo, useState } from 'react'
import { Button } from '@/shared/ui/button'
import { SwapPane } from '@/shared/ui/motion'
import { Notice } from '@/shared/ui/notice'
import { EmptyHint, SectionCard } from '@/shared/ui/page'
import { SkeletonRows } from '@/shared/ui/skeleton'
import { Switch } from '@/shared/ui/switch'
import {
  describeAssignment,
  knownToolsetKeys,
  platformOptions,
  type PlatformAssignment,
} from '../model/platform-assignment'
import type { MessagingPlatform, Toolset, ToolPolicyConfig } from '../model/types'

const EMPTY_PLATFORMS: MessagingPlatform[] = []

/**
 * Which platforms are served this набор. Writes `platform_toolsets.<platform>`
 * through the config endpoint; rows Hermes would ignore or that would narrow a
 * platform's default bundle are inert and say why.
 */
export function ToolsetPlatformsSection({
  toolset,
  toolsets,
  config,
  platforms,
  pending,
  error,
  busy,
  onAssign,
}: {
  toolset: Toolset
  toolsets: readonly Toolset[]
  config: ToolPolicyConfig | undefined
  platforms: MessagingPlatform[] | undefined
  pending: boolean
  error: string | null
  /** the busy key currently saving, e.g. `platform:telegram` */
  busy: string | null
  onAssign: (platform: string, assign: boolean) => void
}) {
  const [showAll, setShowAll] = useState(false)
  const rows = useMemo(() => {
    if (!config) return []
    const known = knownToolsetKeys(config, toolsets)
    return platformOptions(config, platforms ?? EMPTY_PLATFORMS).map((option) => ({
      ...option,
      assignment: describeAssignment(config, toolset, option.id, known),
    }))
  }, [config, platforms, toolset, toolsets])

  const visible = showAll ? rows : rows.filter((row) => row.primary)
  const hidden = rows.length - visible.length
  const pane = pending ? 'skeleton' : error ? 'error' : rows.length ? 'ready' : 'empty'

  return (
    <SectionCard
      title="площадки"
      hint="список platform_toolsets решает, каким каналам hermes отдаёт этот набор"
      {...(hidden > 0 || showAll
        ? {
            actions: (
              <Button size="sm" variant="ghost" onClick={() => setShowAll((value) => !value)}>
                {showAll ? 'только активные' : `все площадки · ${rows.length}`}
              </Button>
            ),
          }
        : {})}
    >
      <SwapPane pane={pane}>
        {pane === 'skeleton' ? (
          <SkeletonRows rows={4} label="читаем площадки" />
        ) : pane === 'error' ? (
          <Notice>{error}</Notice>
        ) : pane === 'empty' ? (
          <EmptyHint>площадок нет</EmptyHint>
        ) : (
          <div className="overflow-hidden rounded-xl border border-line">
            {visible.map((row) => (
              <PlatformRow
                key={row.id}
                platform={row.id}
                label={row.label}
                assignment={row.assignment}
                busy={busy === `platform:${row.id}`}
                onAssign={onAssign}
              />
            ))}
          </div>
        )}
      </SwapPane>
    </SectionCard>
  )
}

const PlatformRow = memo(function PlatformRow({
  platform,
  label,
  assignment,
  busy,
  onAssign,
}: {
  platform: string
  label: string
  assignment: PlatformAssignment
  busy: boolean
  onAssign: (platform: string, assign: boolean) => void
}) {
  const bundles = assignment.extras.filter((entry) => entry.startsWith('hermes-'))
  return (
    <div className="flex items-start gap-3 border-b border-line/60 px-3 py-2.5 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs text-paper">{label}</span>
          <span className="shrink-0 font-mono text-[10px] text-mute">{platform}</span>
        </div>
        {assignment.locked ? (
          <p className="mt-1 text-[11px] leading-4 text-mute">{assignment.locked}</p>
        ) : bundles.length > 0 ? (
          <p className="mt-1 text-[11px] leading-4 text-mute">
            площадка также получает базовый набор {bundles.join(', ')} — часть тулов придёт оттуда
          </p>
        ) : null}
      </div>
      <Switch
        aria-label={`${assignment.assigned ? 'убрать' : 'отдать'} набор площадке ${label}`}
        checked={assignment.assigned}
        disabled={busy || Boolean(assignment.locked)}
        onCheckedChange={(assign) => onAssign(platform, assign)}
      />
    </div>
  )
})
