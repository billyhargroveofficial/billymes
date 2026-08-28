import { isIP } from 'node:net'

export function isLoopbackHost(host: string) {
  if (host === 'localhost' || host === '::1') return true
  if (isIP(host) !== 4) return false
  return host.split('.')[0] === '127'
}
