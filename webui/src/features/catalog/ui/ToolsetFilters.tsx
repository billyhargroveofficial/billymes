import { Button } from '@/shared/ui/button'
import { Segmented, type SegmentedOption } from '@/shared/ui/segmented'
import type { PlatformOption } from '../model/platform-assignment'
import {
  DEFAULT_FACETS,
  facetsActive,
  type ToolsetFacets,
  type ToolsetSetup,
  type ToolsetState,
} from '../model/toolset-view'

const STATE_OPTIONS: readonly SegmentedOption<ToolsetState>[] = [
  { value: 'all', label: 'все' },
  { value: 'on', label: 'вкл' },
  { value: 'off', label: 'выкл' },
]

const SETUP_OPTIONS: readonly SegmentedOption<ToolsetSetup>[] = [
  { value: 'all', label: 'любые' },
  { value: 'ready', label: 'настроены' },
  { value: 'pending', label: 'без настройки' },
]

/** Facet bar over the набор list: платформа, состояние, готовность. */
export function ToolsetFilters({
  facets,
  platforms,
  onChange,
}: {
  facets: ToolsetFacets
  platforms: readonly PlatformOption[]
  onChange: (patch: Partial<ToolsetFacets>) => void
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <select
        aria-label="площадка"
        title="набор явно указан в platform_toolsets этой площадки"
        className="h-8 rounded-full border border-line bg-raised/60 px-3 text-xs text-paper"
        value={facets.platform ?? ''}
        onChange={(event) => onChange({ platform: event.target.value || null })}
      >
        <option value="">все площадки</option>
        {platforms.map((platform) => (
          <option key={platform.id} value={platform.id}>
            {platform.label}
          </option>
        ))}
      </select>
      <Segmented
        label="состояние набора"
        value={facets.state}
        options={STATE_OPTIONS}
        onChange={(state) => onChange({ state })}
      />
      <Segmented
        label="готовность набора"
        value={facets.setup}
        options={SETUP_OPTIONS}
        onChange={(setup) => onChange({ setup })}
      />
      {facetsActive(facets) && (
        <Button size="sm" variant="ghost" onClick={() => onChange(DEFAULT_FACETS)}>
          сбросить
        </Button>
      )}
    </div>
  )
}
