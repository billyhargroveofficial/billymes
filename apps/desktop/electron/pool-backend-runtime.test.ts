import assert from 'node:assert/strict'

import { test, vi } from 'vitest'

import { LocalRuntimeNotInstalledError, preparePoolBackendRuntime } from './pool-backend-runtime'

test('an auxiliary bootstrap-needed backend fails closed without starting the installer', async () => {
  const bootstrapBackend = {
    installStamp: { commit: '981101239a064c020a9d18fc3b1060ae306934ed' },
    kind: 'bootstrap-needed'
  }

  const resolveBackend = vi.fn(async () => bootstrapBackend)
  const ensureRuntime = vi.fn(async backend => backend)

  await assert.rejects(
    preparePoolBackendRuntime(['--profile', 'default'], { ensureRuntime, resolveBackend }),
    error =>
      error instanceof LocalRuntimeNotInstalledError &&
      error.code === 'HERMES_LOCAL_RUNTIME_NOT_INSTALLED' &&
      error.localRuntimeNotInstalled
  )
  assert.deepEqual(resolveBackend.mock.calls, [[['--profile', 'default']]])
  assert.equal(ensureRuntime.mock.calls.length, 0)
})

test('an existing managed runtime is still prepared even when its descriptor carries bootstrap ownership', async () => {
  const activeBackend = { bootstrap: true, command: '/tmp/hermes/venv/bin/python', kind: 'python' }
  const runtimeBackend = { ...activeBackend, ready: true }
  const resolveBackend = vi.fn(async () => activeBackend)
  const ensureRuntime = vi.fn(async () => runtimeBackend)

  assert.deepEqual(
    await preparePoolBackendRuntime(['serve'], { ensureRuntime, resolveBackend }),
    runtimeBackend
  )
  assert.deepEqual(resolveBackend.mock.calls, [[['serve']]])
  assert.deepEqual(ensureRuntime.mock.calls, [[activeBackend]])
})
