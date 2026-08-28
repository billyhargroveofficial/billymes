import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { isLoopbackHost } from './scripts/lib/is-loopback-host.ts'
import { mesGatewayPlugin } from './server/gateway-proxy.ts'

const here = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const token = env.HERMES_ACCESS_TOKEN || ''
  const target = env.HERMES_PROXY_TARGET || 'http://127.0.0.1:9119'
  const dashboardHost = env.HERMES_DASHBOARD_HOST || '127.0.0.2:9119'
  const uiHost = env.HERMES_UI_HOST || '127.0.0.1'

  if (!isLoopbackHost(uiHost)) {
    throw new Error('The built-in dashboard proxy supports loopback bindings only')
  }

  return {
    plugins: [
      react(),
      tailwindcss(),
      mesGatewayPlugin({
        defaults: { origin: target, host: dashboardHost, token },
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(here, 'src'),
      },
    },
    server: {
      host: uiHost,
      port: 5173,
    },
    preview: {
      host: uiHost,
      port: 4173,
    },
    build: {
      manifest: true,
    },
  }
})
