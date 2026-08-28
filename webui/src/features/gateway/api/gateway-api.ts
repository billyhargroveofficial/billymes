import { expectRecord, expectString, requestJson } from '@/shared/api'

export const gatewayApi = {
  health: async () => {
    const payload = expectRecord(await requestJson('/api/health'), 'gateway health')
    return {
      ok: typeof payload.ok === 'boolean' ? payload.ok : true,
      version: expectString(payload.version, 'gateway health.version'),
    }
  },
}
