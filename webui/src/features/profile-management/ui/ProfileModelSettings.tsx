import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  modelCapabilityFor,
  modelKeys,
  modelSelectionApi,
  ReasoningPicker,
} from '@/features/model-selection'
import { profileApi, profileKeys } from '@/features/profiles'
import { combinedErrorMessage, errorMessage } from '@/shared/lib/error-message'
import { Notice } from '@/shared/ui/notice'
import { Skeleton, SkeletonBlock } from '@/shared/ui/skeleton'
import { Spinner } from '@/shared/ui/spinner'
import { Switch } from '@/shared/ui/switch'

type SettingKey = 'reasoning_effort' | 'service_tier'

export function ProfileModelSettings({
  profile,
  model,
  provider,
}: {
  profile: string
  model: string
  provider: string
}) {
  const queryClient = useQueryClient()
  const [saving, setSaving] = useState<SettingKey | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const config = useQuery({
    queryKey: profileKeys.config(profile),
    queryFn: () => profileApi.config(profile),
  })
  const options = useQuery({
    queryKey: modelKeys.options(profile),
    queryFn: () => modelSelectionApi.options(profile),
  })
  const selectedModel = config.data?.model || model
  const info = useQuery({
    queryKey: modelKeys.info(profile),
    queryFn: () => modelSelectionApi.info(profile),
    enabled: Boolean(selectedModel),
  })

  async function updateSetting(key: SettingKey, value: string) {
    setSaveError(null)
    setSaving(key)
    try {
      if (key === 'reasoning_effort') {
        await profileApi.updateSettings(profile, { reasoning_effort: value })
      } else {
        await profileApi.updateSettings(profile, { service_tier: value })
      }
      await queryClient.invalidateQueries({ queryKey: profileKeys.config(profile) })
    } catch (error) {
      setSaveError(errorMessage(error, 'не удалось сохранить настройки модели'))
    } finally {
      setSaving(null)
    }
  }

  const configError = config.error
    ? errorMessage(config.error, 'не удалось загрузить настройки модели')
    : null
  if (configError) return <Notice className="mt-3">{configError}</Notice>
  if (config.isPending || config.isFetching || !config.data) {
    return (
      <SkeletonBlock label="загружаем настройки модели" className="mt-3 flex gap-2">
        <Skeleton className="h-8 w-28 rounded-full" />
        <Skeleton className="h-8 w-24 rounded-full" />
        <Skeleton className="h-8 w-20 rounded-full" />
      </SkeletonBlock>
    )
  }
  if (!selectedModel) {
    return <div className="mt-3 text-xs text-mute">модель не выбрана</div>
  }

  const capability = modelCapabilityFor(options.data?.providers ?? [], provider, selectedModel)
  const supportsReasoning = capability
    ? capability.reasoning
    : info.data?.capabilities.supports_reasoning === true
  const supportsPriority = capability?.fast === true
  const hasCapabilityEvidence =
    capability !== null || typeof info.data?.capabilities.supports_reasoning === 'boolean'
  const capabilityError = hasCapabilityEvidence
    ? null
    : combinedErrorMessage(
        [options.error, 'не удалось проверить capabilities модели'],
        [info.error, 'не удалось загрузить информацию о модели'],
      )
  const checkingCapabilities =
    !hasCapabilityEvidence &&
    (options.isPending || options.isFetching || info.isPending || info.isFetching)
  const capabilitiesReady = !checkingCapabilities && !capabilityError

  return (
    <div className="mt-3 border-t border-line/70 pt-3">
      <div className="text-[10px] uppercase tracking-[0.16em] text-mute">настройки модели</div>
      {checkingCapabilities && !capability && (
        <div className="mt-2 text-xs text-mute">проверка capabilities…</div>
      )}
      {!checkingCapabilities && capabilityError && (
        <Notice className="mt-2">{capabilityError}</Notice>
      )}
      {capabilitiesReady && !supportsReasoning && !supportsPriority && (
        <div className="mt-2 text-xs text-mute">
          для этой модели дополнительные настройки недоступны
        </div>
      )}
      {capabilitiesReady && supportsReasoning && (
        <div className="mt-2 flex items-center justify-between gap-3 text-xs">
          <span className="text-mute">reasoning effort</span>
          <ReasoningPicker
            value={config.data.agent.reasoning_effort}
            canDisable={capability?.can_disable_reasoning !== false}
            disabled={saving !== null}
            onPick={(value) => void updateSetting('reasoning_effort', value)}
          />
        </div>
      )}
      {capabilitiesReady && supportsPriority && (
        <div className="mt-2 flex items-center justify-between gap-3 text-xs">
          <span className="text-mute">priority / service tier</span>
          <Switch
            aria-label={`priority mode для ${profile}`}
            checked={['fast', 'priority', 'on'].includes(
              config.data.agent.service_tier.toLowerCase(),
            )}
            disabled={saving !== null}
            onCheckedChange={(checked) =>
              void updateSetting('service_tier', checked ? 'priority' : 'normal')
            }
          />
        </div>
      )}
      {saving && (
        <div className="mt-2 flex items-center gap-2 text-[11px] text-mute">
          <Spinner className="size-3" />
          сохранение…
        </div>
      )}
      {saveError && <Notice className="mt-2">{saveError}</Notice>}
    </div>
  )
}
