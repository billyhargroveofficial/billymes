import type { UseQueryResult } from '@tanstack/react-query'
import { errorMessage } from '@/shared/lib/error-message'
import { Sheet } from '@/shared/ui/sheet'
import type {
  ComputerUseStatus,
  ConfigField,
  TerminalBackends,
  ToolPolicyConfig,
} from '../model/types'
import { ToolRuntimeSettings } from './ToolRuntimeSettings'

/** The page-level settings panel: wiring only, so the page keeps its shape. */
export function ToolSettingsSheet({
  open,
  onOpenChange,
  policyQ,
  schemaQ,
  backendsQ,
  computerUseQ,
  busy,
  error,
  onSelectBackend,
  onGrantComputerUse,
  onSaveSettings,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  policyQ: UseQueryResult<ToolPolicyConfig>
  schemaQ: UseQueryResult<Record<string, ConfigField>>
  backendsQ: UseQueryResult<TerminalBackends>
  computerUseQ: UseQueryResult<ComputerUseStatus>
  busy: string | null
  error: string | null
  onSelectBackend: (backend: string) => void
  onGrantComputerUse: () => void
  onSaveSettings: (patch: Record<string, unknown>) => Promise<boolean>
}) {
  const policyError = policyQ.error
    ? errorMessage(policyQ.error, 'не удалось прочитать конфигурацию агента')
    : null
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="настройки тулов"
      className="w-[min(94vw,34rem)]"
    >
      <ToolRuntimeSettings
        backends={backendsQ.data}
        backendsPending={backendsQ.isPending}
        backendsError={
          backendsQ.error ? errorMessage(backendsQ.error, 'не удалось прочитать бэкенды') : null
        }
        computerUse={computerUseQ.data}
        computerUsePending={computerUseQ.isPending}
        computerUseError={
          computerUseQ.error
            ? errorMessage(computerUseQ.error, 'не удалось прочитать статус computer use')
            : null
        }
        policy={policyQ.data}
        schema={schemaQ.data}
        schemaPending={schemaQ.isPending || policyQ.isPending}
        schemaError={
          schemaQ.error
            ? errorMessage(schemaQ.error, 'не удалось прочитать схему конфигурации')
            : policyError
        }
        busy={busy}
        error={error}
        onSelectBackend={onSelectBackend}
        onGrantComputerUse={onGrantComputerUse}
        onSaveSettings={onSaveSettings}
      />
    </Sheet>
  )
}
