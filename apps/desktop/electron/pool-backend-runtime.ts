interface PoolBackendDescriptor {
  kind?: string
}

interface PoolBackendRuntimeDeps<Backend extends PoolBackendDescriptor, RuntimeBackend> {
  ensureRuntime: (backend: Backend) => Promise<RuntimeBackend>
  resolveBackend: (backendArgs: string[]) => Backend | Promise<Backend>
}

export class LocalRuntimeNotInstalledError extends Error {
  readonly code = 'HERMES_LOCAL_RUNTIME_NOT_INSTALLED'
  readonly localRuntimeNotInstalled = true

  constructor() {
    super(
      'Local Hermes Agent is not installed. Switch the primary Gateway to Local and confirm installation before opening This device.'
    )
    this.name = 'LocalRuntimeNotInstalledError'
  }
}

/**
 * Resolve an auxiliary/profile-pool backend without allowing it to own the
 * first-launch installer. Only the primary startup path has the explicit
 * Local-vs-Remote setup gate; background roster, pane, and stale-session
 * requests must never turn a remote-only desktop into a local installation.
 */
export async function preparePoolBackendRuntime<Backend extends PoolBackendDescriptor, RuntimeBackend>(
  backendArgs: string[],
  { ensureRuntime, resolveBackend }: PoolBackendRuntimeDeps<Backend, RuntimeBackend>
): Promise<RuntimeBackend> {
  const backend = await resolveBackend(backendArgs)

  if (backend?.kind === 'bootstrap-needed') {
    throw new LocalRuntimeNotInstalledError()
  }

  return ensureRuntime(backend)
}
