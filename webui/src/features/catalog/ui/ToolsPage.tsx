import { SlidersHorizontal } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useProfileScope } from '@/features/profiles'
import { combinedErrorMessage, errorMessage } from '@/shared/lib/error-message'
import { Button } from '@/shared/ui/button'
import { StaggerItem, SwapPane } from '@/shared/ui/motion'
import { Notice } from '@/shared/ui/notice'
import { EmptyHint } from '@/shared/ui/page'
import { Sheet } from '@/shared/ui/sheet'
import { SkeletonRows } from '@/shared/ui/skeleton'
import { catalogApi } from '../api/catalog-api'
import { toolsConfigApi } from '../api/tools-config-api'
import {
  assignedToolsets,
  buildDisabledToolsetsPatch,
  buildPlatformAssignmentPatch,
  knownToolsetKeys,
  platformOptions,
  type PlatformOption,
} from '../model/platform-assignment'
import {
  applyToolsetFacets,
  filterToolsets,
  toolsetUsage,
  type ToolsetFacets,
  type ToolsetSetup,
  type ToolsetState,
} from '../model/toolset-view'
import type { MessagingPlatform, Toolset, ToolsetProvider } from '../model/types'
import { useToolActions } from '../model/use-tool-actions'
import { useToolsQueries } from '../model/use-tools-queries'
import { CatalogSplitView } from './CatalogSplitView'
import { ToolSettingsSheet } from './ToolSettingsSheet'
import { ToolsetDetail } from './ToolsetDetail'
import { ToolsetFilters } from './ToolsetFilters'
import { ToolsetRow } from './ToolsetRow'

const EMPTY_TOOLSETS: Toolset[] = []
const EMPTY_PLATFORMS: MessagingPlatform[] = []
const EMPTY_OPTIONS: PlatformOption[] = []
const MOBILE = '(max-width: 1023px)'

type RouteKey = 'q' | 'toolset' | 'provider' | 'settings' | 'platform' | 'state' | 'setup'

function asState(value: string | null): ToolsetState {
  return value === 'on' || value === 'off' ? value : 'all'
}

function asSetup(value: string | null): ToolsetSetup {
  return value === 'ready' || value === 'pending' ? value : 'all'
}

export function ToolsPage() {
  const { profile } = useProfileScope()
  const [searchParams, setSearchParams] = useSearchParams()
  const q = searchParams.get('q') ?? ''
  const open = searchParams.get('toolset')
  const selectedProvider = searchParams.get('provider')
  const settingsOpen = searchParams.get('settings') === '1'
  const [mobileOpen, setMobileOpen] = useState(
    () => Boolean(open) && window.matchMedia(MOBILE).matches,
  )
  const [postSetupKey, setPostSetupKey] = useState<string | null>(null)

  const facets: ToolsetFacets = useMemo(
    () => ({
      platform: searchParams.get('platform'),
      state: asState(searchParams.get('state')),
      setup: asSetup(searchParams.get('setup')),
    }),
    [searchParams],
  )

  const {
    toolsetsQ,
    usageQ,
    policyQ,
    configQ,
    modelsQ,
    platformsQ,
    schemaQ,
    backendsQ,
    computerUseQ,
    postSetupQ,
    effectiveProvider,
    usage,
    counts,
  } = useToolsQueries({
    profile,
    toolset: open,
    selectedProvider,
    settingsOpen,
    postSetupRunning: postSetupKey !== null,
  })
  const { busy, error, setError, run, patchPolicy } = useToolActions({ profile, toolset: open })

  const toolsets = toolsetsQ.data ?? EMPTY_TOOLSETS
  const policy = policyQ.data
  const known = useMemo(
    () => (policy ? knownToolsetKeys(policy, toolsets) : null),
    [policy, toolsets],
  )
  const assigned = useMemo(
    () =>
      facets.platform && policy && known ? assignedToolsets(policy, facets.platform, known) : null,
    [facets.platform, known, policy],
  )
  const rows = useMemo(
    () => filterToolsets(applyToolsetFacets(toolsets, facets, assigned), q, counts),
    [assigned, counts, facets, q, toolsets],
  )
  const denied = useMemo(() => new Set(policy?.disabledToolsets ?? []), [policy])
  const platformChoices = useMemo(
    () =>
      policy
        ? platformOptions(policy, platformsQ.data ?? EMPTY_PLATFORMS).filter((row) => row.primary)
        : EMPTY_OPTIONS,
    [platformsQ.data, policy],
  )
  const selected = toolsets.find((toolset) => toolset.name === open) ?? null

  const updateRoute = useCallback(
    (values: Partial<Record<RouteKey, string | null>>) => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous)
          for (const [key, value] of Object.entries(values)) {
            if (value) next.set(key, value)
            else next.delete(key)
          }
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  const selectToolset = useCallback(
    (name: string) => {
      updateRoute({ toolset: name, provider: null })
      setError(null)
      setPostSetupKey(null)
      if (window.matchMedia(MOBILE).matches) setMobileOpen(true)
    },
    [setError, updateRoute],
  )

  const toggleToolset = useCallback(
    (name: string, enabled: boolean) => {
      void run(
        `toggle:${name}`,
        () => catalogApi.toggleToolset(name, enabled, profile),
        'не удалось переключить набор',
      )
    },
    [profile, run],
  )

  const denyToolset = useCallback(
    (value: boolean) => {
      if (!selected) return
      void patchPolicy(
        'deny',
        (config) => buildDisabledToolsetsPatch(config, selected.name, value),
        'не удалось изменить глобальный запрет',
      )
    },
    [patchPolicy, selected],
  )

  const assignPlatform = useCallback(
    (platform: string, assign: boolean) => {
      if (!selected) return
      void patchPolicy(
        `platform:${platform}`,
        (config) =>
          buildPlatformAssignmentPatch(
            config,
            selected,
            platform,
            assign,
            knownToolsetKeys(config, toolsets),
          ),
        'не удалось изменить площадки набора',
      )
    },
    [patchPolicy, selected, toolsets],
  )

  const selectProviderFor = useCallback(
    (provider: ToolsetProvider, capability?: 'search' | 'extract') => {
      if (!open) return
      updateRoute({ provider: provider.name })
      const suffix = capability ? `:${capability}` : ''
      void run(
        `provider:${provider.name}${suffix}`,
        () => catalogApi.selectToolsetProvider(open, provider.name, capability, profile),
        'не удалось выбрать провайдера',
      )
    },
    [open, profile, run, updateRoute],
  )

  const selectModel = useCallback(
    (model: string) => {
      if (!open) return
      void run(
        'model',
        () => catalogApi.selectToolsetModel(open, model, effectiveProvider, profile),
        'не удалось выбрать модель',
      )
    },
    [effectiveProvider, open, profile, run],
  )

  const saveEnv = useCallback(
    (provider: ToolsetProvider, values: Record<string, string>) => {
      if (!open) return Promise.resolve(false)
      return run(
        `env:${provider.name}`,
        () => toolsConfigApi.saveToolsetEnv(open, values, profile),
        'не удалось сохранить ключи провайдера',
      )
    },
    [open, profile, run],
  )

  const startPostSetup = useCallback(
    (provider: ToolsetProvider, key: string) => {
      if (!open) return
      void run(
        `post-setup:${provider.name}`,
        async () => {
          await toolsConfigApi.runPostSetup(open, key, profile)
          setPostSetupKey(key)
        },
        'не удалось запустить доустановку',
      )
    },
    [open, profile, run],
  )

  const selectBackend = useCallback(
    (backend: string) => {
      void run(
        `backend:${backend}`,
        () => toolsConfigApi.selectTerminalBackend(backend, profile),
        'не удалось сменить бэкенд терминала',
      )
    },
    [profile, run],
  )

  const grantComputerUse = useCallback(() => {
    void run(
      'computer-use-grant',
      () => toolsConfigApi.grantComputerUse(profile),
      'не удалось запросить доступ',
    )
  }, [profile, run])

  // Scalar leaves under maps: `_deep_merge` updates exactly the keys we send and
  // leaves their siblings alone, so unlike a list write this needs no re-read.
  const saveSettings = useCallback(
    (patch: Record<string, unknown>) =>
      run(
        'tool-settings',
        () => toolsConfigApi.patchConfig(patch, profile),
        'не удалось сохранить настройки тулов',
      ),
    [profile, run],
  )

  const listError = combinedErrorMessage(
    [toolsetsQ.error, 'не удалось загрузить наборы тулов'],
    [usageQ.error, 'не удалось загрузить статистику тулов'],
  )
  const policyError = policyQ.error
    ? errorMessage(policyQ.error, 'не удалось прочитать конфигурацию агента')
    : null
  const platformsError = platformsQ.error
    ? errorMessage(platformsQ.error, 'не удалось загрузить площадки')
    : null
  const configError = combinedErrorMessage(
    [configQ.error, 'не удалось загрузить конфигурацию набора'],
    [modelsQ.error, 'не удалось загрузить модели провайдера'],
  )
  const listPane = toolsetsQ.isPending
    ? 'skeleton'
    : listError
      ? 'error'
      : rows.length
        ? 'ready'
        : 'empty'

  const detail = selected ? (
    <ToolsetDetail
      toolset={selected}
      toolsets={toolsets}
      profile={profile}
      usage={usage}
      counts={counts}
      policy={policy}
      policyPending={policyQ.isPending}
      policyError={policyError}
      platforms={platformsQ.data}
      platformsPending={platformsQ.isPending}
      platformsError={platformsError}
      config={configQ.data}
      models={modelsQ.data}
      configPending={configQ.isPending}
      configError={configError}
      selectedProvider={effectiveProvider}
      busy={busy}
      actionError={error}
      postSetupKey={postSetupKey}
      postSetupStatus={postSetupQ.data}
      onToggle={(enabled) => toggleToolset(selected.name, enabled)}
      onDeny={denyToolset}
      onAssign={assignPlatform}
      onInspectProvider={(provider) => updateRoute({ provider })}
      onSelectProvider={selectProviderFor}
      onSelectModel={selectModel}
      onSaveEnv={saveEnv}
      onPostSetup={startPostSetup}
    />
  ) : (
    <EmptyHint>выбери набор — справа откроются его тулы, площадки и провайдеры</EmptyHint>
  )

  return (
    <>
      <CatalogSplitView
        eyebrow="нативные наборы"
        title={`${toolsets.length} наборов`}
        searchLabel="найти набор или тул"
        query={q}
        onQueryChange={(value) => updateRoute({ q: value })}
        actions={
          <Button
            size="pill"
            variant="outline"
            aria-pressed={settingsOpen}
            onClick={() => updateRoute({ settings: settingsOpen ? null : '1' })}
          >
            <SlidersHorizontal aria-hidden="true" className="size-4" /> настройки
          </Button>
        }
        detail={detail}
      >
        <ToolsetFilters
          facets={facets}
          platforms={platformChoices}
          onChange={(patch) =>
            updateRoute({
              ...('platform' in patch ? { platform: patch.platform ?? null } : {}),
              ...(patch.state ? { state: patch.state === 'all' ? null : patch.state } : {}),
              ...(patch.setup ? { setup: patch.setup === 'all' ? null : patch.setup } : {}),
            })
          }
        />

        {error && <Notice className="mb-3 lg:hidden">{error}</Notice>}

        <SwapPane pane={listPane}>
          {listPane === 'skeleton' ? (
            <SkeletonRows rows={8} label="загружаем наборы" />
          ) : listPane === 'error' ? (
            <Notice>{listError}</Notice>
          ) : listPane === 'empty' ? (
            <EmptyHint>{toolsets.length ? 'по фильтрам наборов нет' : 'наборов нет'}</EmptyHint>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-line">
              {rows.map((toolset, index) => (
                <StaggerItem key={toolset.name} index={index}>
                  <ToolsetRow
                    toolset={toolset}
                    rank={index + 1}
                    calls={toolsetUsage(toolset, counts)}
                    selected={open === toolset.name}
                    denied={denied.has(toolset.name)}
                    busy={busy === `toggle:${toolset.name}`}
                    onSelect={selectToolset}
                    onToggle={toggleToolset}
                  />
                </StaggerItem>
              ))}
            </div>
          )}
        </SwapPane>
      </CatalogSplitView>

      <Sheet
        open={mobileOpen && Boolean(selected)}
        onOpenChange={setMobileOpen}
        title={selected?.label || selected?.name || 'набор тулов'}
        className="w-[min(94vw,38rem)]"
      >
        {detail}
      </Sheet>

      <ToolSettingsSheet
        open={settingsOpen}
        onOpenChange={(next) => updateRoute({ settings: next ? '1' : null })}
        policyQ={policyQ}
        schemaQ={schemaQ}
        backendsQ={backendsQ}
        computerUseQ={computerUseQ}
        busy={busy}
        error={error}
        onSelectBackend={selectBackend}
        onGrantComputerUse={grantComputerUse}
        onSaveSettings={saveSettings}
      />
    </>
  )
}
