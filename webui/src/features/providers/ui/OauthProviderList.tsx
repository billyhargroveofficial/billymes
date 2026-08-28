import { useQueryClient } from '@tanstack/react-query'
import { memo, useCallback, useState } from 'react'
import { errorMessage } from '@/shared/lib/error-message'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { StaggerItem } from '@/shared/ui/motion'
import { Notice } from '@/shared/ui/notice'
import { SkeletonRows } from '@/shared/ui/skeleton'
import { providersApi } from '../api/providers-api'
import { paneState } from '../model/pane-state'
import { connectionSummary, flowLabel } from '../model/oauth-view'
import { providerKeys } from '../model/provider-keys'
import type { OauthProvider, OauthSession } from '../model/types'
import { CopyLine } from './CopyLine'
import { OauthFlowPanel } from './OauthFlowPanel'
import { SectionPane } from './SectionPane'

const EMPTY: OauthProvider[] = []

export function OauthProviderList({
  profile,
  providers = EMPTY,
  pending,
  loadError,
}: {
  profile: string
  providers: OauthProvider[] | undefined
  pending: boolean
  loadError: string | null
}) {
  const qc = useQueryClient()
  const [session, setSession] = useState<OauthSession | null>(null)
  const [active, setActive] = useState<OauthProvider | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  // Frozen for the life of the page so memoised rows keep stable props.
  const [now] = useState(() => Date.now())

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: providerKeys.oauth(profile) })
    void qc.invalidateQueries({ queryKey: providerKeys.pool() })
  }, [profile, qc])

  const start = useCallback(
    async (provider: OauthProvider) => {
      setBusyId(provider.id)
      setConfirmId(null)
      setActionError(null)
      try {
        const started = await providersApi.startOauth(provider.id, profile)
        setActive(provider)
        setSession(started)
      } catch (error) {
        setActionError(errorMessage(error, 'не удалось начать вход'))
      } finally {
        setBusyId(null)
      }
    },
    [profile],
  )

  const disconnect = useCallback(
    async (provider: OauthProvider) => {
      if (confirmId !== provider.id) {
        setConfirmId(provider.id)
        return
      }
      setConfirmId(null)
      setBusyId(provider.id)
      setActionError(null)
      try {
        await providersApi.disconnectOauth(provider.id, profile)
        refresh()
      } catch (error) {
        setActionError(errorMessage(error, 'не удалось отключить провайдера'))
      } finally {
        setBusyId(null)
      }
    },
    [confirmId, profile, refresh],
  )

  const closePanel = useCallback((open: boolean) => {
    if (open) return
    setSession(null)
    setActive(null)
  }, [])

  const state = paneState({ pending, error: loadError, empty: providers.length === 0 })

  return (
    <>
      {actionError && <Notice className="mb-3">{actionError}</Notice>}
      <SectionPane
        state={state}
        skeleton={<SkeletonRows rows={5} label="загружаем входы" />}
        error={loadError}
        empty="входов нет"
      >
        <div className="overflow-hidden rounded-2xl border border-line">
          {providers.map((provider, index) => (
            <StaggerItem key={provider.id} index={index}>
              <OauthProviderRow
                provider={provider}
                now={now}
                busy={busyId === provider.id}
                confirming={confirmId === provider.id}
                onStart={start}
                onDisconnect={disconnect}
              />
            </StaggerItem>
          ))}
        </div>
      </SectionPane>

      <OauthFlowPanel
        provider={active}
        session={session}
        profile={profile}
        onOpenChange={closePanel}
        onFinished={refresh}
      />
    </>
  )
}

const OauthProviderRow = memo(function OauthProviderRow({
  provider,
  now,
  busy,
  confirming,
  onStart,
  onDisconnect,
}: {
  provider: OauthProvider
  now: number
  busy: boolean
  confirming: boolean
  onStart: (provider: OauthProvider) => void
  onDisconnect: (provider: OauthProvider) => void
}) {
  const status = provider.status
  const summary = connectionSummary(provider, now)
  const external = provider.flow === 'external'

  return (
    <div
      data-selected={String(status.loggedIn)}
      className="row-interactive flex flex-col gap-2 border-b border-line/60 px-3 py-3 last:border-0 sm:flex-row sm:items-center"
    >
      <span aria-hidden="true" className="relative mt-0.5 shrink-0 sm:mt-0">
        <span
          className={`grid size-8 place-items-center rounded-xl border font-display text-sm italic ${
            status.loggedIn
              ? 'border-accent/40 bg-accent-soft text-mercury'
              : 'border-line/70 bg-raised/40 text-mute'
          }`}
        >
          {provider.name.slice(0, 1).toUpperCase()}
        </span>
        <span
          className={`absolute -bottom-0.5 -right-0.5 size-2 rounded-full border-2 border-panel ${
            status.loggedIn ? 'bg-ok' : 'bg-line'
          }`}
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm text-paper">{provider.name}</span>
          <Badge>{flowLabel(provider.flow)}</Badge>
          {provider.docsUrl && (
            <a
              href={provider.docsUrl}
              target="_blank"
              rel="noreferrer"
              className="text-[11px] text-signal underline-offset-2 hover:underline"
            >
              документация
            </a>
          )}
        </div>
        <p className="mt-0.5 truncate text-[11px] text-mute">
          {status.loggedIn ? summary.join(' · ') || 'подключён' : 'не подключён'}
        </p>
        {status.loggedIn && !provider.disconnectable && (
          <p className="mt-1 text-[11px] text-mute/80">
            {provider.disconnectHint ?? 'отключается вне hermes'}
          </p>
        )}
        {status.loggedIn && !provider.disconnectable && provider.disconnectCommand && (
          <CopyLine
            className="mt-1.5"
            value={provider.disconnectCommand}
            label="команду отключения"
          />
        )}
        {!status.loggedIn && external && provider.cliCommand && (
          <CopyLine className="mt-1.5" value={provider.cliCommand} label="команду входа" />
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {status.loggedIn ? (
          provider.disconnectable ? (
            <Button
              type="button"
              variant={confirming ? 'ember' : 'outline'}
              size="sm"
              disabled={busy}
              onClick={() => onDisconnect(provider)}
            >
              {busy ? 'отключаем…' : confirming ? 'точно отключить?' : 'отключить'}
            </Button>
          ) : null
        ) : external ? null : (
          <Button
            type="button"
            variant="mercury"
            size="sm"
            disabled={busy}
            onClick={() => onStart(provider)}
          >
            {busy ? 'открываем…' : 'войти'}
          </Button>
        )}
      </div>
    </div>
  )
})
