import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'
import { errorMessage } from '@/shared/lib/error-message'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Notice } from '@/shared/ui/notice'
import { Sheet } from '@/shared/ui/sheet'
import { providersApi } from '../api/providers-api'
import { isTerminalOauthStatus, oauthStatusLabel, pollIntervalMs } from '../model/oauth-view'
import { providerKeys } from '../model/provider-keys'
import type { OauthProvider, OauthSession } from '../model/types'
import { CopyLine } from './CopyLine'

type Feedback = { tone: 'error' | 'success'; text: string }

/**
 * Shell for one in-flight login. The body is remounted per session id so its
 * draft code, feedback, and poll subscription live exactly as long as the flow.
 */
export function OauthFlowPanel({
  provider,
  session,
  profile,
  onOpenChange,
  onFinished,
}: {
  provider: OauthProvider | null
  session: OauthSession | null
  profile: string
  onOpenChange: (open: boolean) => void
  onFinished: () => void
}) {
  return (
    <Sheet
      open={Boolean(provider && session)}
      onOpenChange={onOpenChange}
      title={provider?.name ?? 'вход'}
    >
      {provider && session && (
        <OauthFlowBody
          key={`${profile}:${session.sessionId}`}
          provider={provider}
          session={session}
          profile={profile}
          onOpenChange={onOpenChange}
          onFinished={onFinished}
        />
      )}
    </Sheet>
  )
}

function OauthFlowBody({
  provider,
  session,
  profile,
  onOpenChange,
  onFinished,
}: {
  provider: OauthProvider
  session: OauthSession
  profile: string
  onOpenChange: (open: boolean) => void
  onFinished: () => void
}) {
  const [code, setCode] = useState('')
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [busy, setBusy] = useState<'submit' | 'cancel' | null>(null)

  const isDevice = session.flow === 'device_code'
  const interval = pollIntervalMs(session)

  const pollQ = useQuery({
    queryKey: providerKeys.oauthPoll(profile, provider.id, session.sessionId),
    queryFn: () => providersApi.pollOauth(provider.id, session.sessionId, profile),
    enabled: isDevice,
    refetchInterval: (query) =>
      isTerminalOauthStatus(query.state.data?.status) ? false : interval,
    retry: false,
    gcTime: 0,
  })

  const pollStatus = pollQ.data?.status ?? null
  useEffect(() => {
    if (pollStatus === 'approved') onFinished()
  }, [pollStatus, onFinished])

  const submit = useCallback(async () => {
    if (!code.trim()) return
    setBusy('submit')
    setFeedback(null)
    try {
      const result = await providersApi.submitOauthCode(
        provider.id,
        session.sessionId,
        code.trim(),
        profile,
      )
      if (result.ok) {
        setFeedback({ tone: 'success', text: 'подключено' })
        onFinished()
      } else {
        setFeedback({ tone: 'error', text: result.message ?? oauthStatusLabel(result.status) })
      }
    } catch (error) {
      setFeedback({ tone: 'error', text: errorMessage(error, 'код не принят') })
    } finally {
      setBusy(null)
    }
  }, [code, onFinished, profile, provider.id, session.sessionId])

  const cancel = useCallback(async () => {
    setBusy('cancel')
    try {
      await providersApi.cancelOauthSession(session.sessionId, profile)
      onOpenChange(false)
    } catch (error) {
      setFeedback({ tone: 'error', text: errorMessage(error, 'не удалось отменить вход') })
    } finally {
      setBusy(null)
    }
  }, [onOpenChange, profile, session.sessionId])

  const liveLabel = pollQ.error
    ? errorMessage(pollQ.error, 'сессия входа потерялась')
    : oauthStatusLabel(pollStatus)
  const done = pollStatus === 'approved' || feedback?.tone === 'success'

  return (
    <div className="space-y-4 pb-2">
      {session.userCode && (
        <div className="space-y-2">
          <p className="text-xs text-mute">код для подтверждения</p>
          <CopyLine value={session.userCode} label="код" />
        </div>
      )}

      {session.verificationUrl && (
        <div className="space-y-2">
          <p className="text-xs text-mute">открой страницу и подтверди вход</p>
          <CopyLine value={session.verificationUrl} href={session.verificationUrl} label="ссылку" />
        </div>
      )}

      {session.authUrl && (
        <div className="space-y-2">
          <p className="text-xs text-mute">открой ссылку, разреши доступ и вставь код ниже</p>
          <CopyLine value={session.authUrl} href={session.authUrl} label="ссылку" />
        </div>
      )}

      {isDevice && (
        <div className="flex items-center gap-2 rounded-xl border border-line bg-raised/40 px-3 py-2">
          <span
            aria-hidden="true"
            className={
              done
                ? 'size-2 shrink-0 rounded-full bg-ok'
                : 'size-2 shrink-0 animate-pulse rounded-full bg-mercury'
            }
          />
          <span className="text-xs text-paper" role="status" aria-live="polite">
            {liveLabel}
          </span>
        </div>
      )}

      {session.flow === 'pkce' && (
        <div className="space-y-2">
          <label className="block text-xs text-mute" htmlFor="oauth-code">
            код из браузера
          </label>
          <Input
            id="oauth-code"
            name="oauth-code"
            autoComplete="off"
            spellCheck={false}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="вставь код"
            className="font-mono"
          />
          <Button
            type="button"
            variant="mercury"
            size="sm"
            disabled={!code.trim() || busy === 'submit' || done}
            onClick={() => void submit()}
          >
            {busy === 'submit' ? 'отправляем…' : 'отправить'}
          </Button>
        </div>
      )}

      {feedback && <Notice tone={feedback.tone}>{feedback.text}</Notice>}
      {pollQ.data?.errorMessage && <Notice>{pollQ.data.errorMessage}</Notice>}

      <p className="text-[11px] text-mute/80">панель можно закрыть — вход продолжится в фоне</p>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy === 'cancel'}
          onClick={() => void cancel()}
        >
          {busy === 'cancel' ? 'отменяем…' : 'отменить'}
        </Button>
        {done && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            закрыть
          </Button>
        )}
      </div>

      {provider.cliCommand && (
        <div className="space-y-2 border-t border-line pt-3">
          <p className="text-[11px] text-mute">то же самое из терминала</p>
          <CopyLine value={provider.cliCommand} label="команду" />
        </div>
      )}
    </div>
  )
}
