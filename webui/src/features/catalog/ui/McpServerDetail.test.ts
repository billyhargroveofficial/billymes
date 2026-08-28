import { describe, expect, it } from 'vitest'
import { redactMcpArgs, redactMcpSecrets } from '../model/mcp-redaction'

describe('MCP connection redaction', () => {
  it('redacts URL credentials, query tokens, flags, assignments, and auth headers', () => {
    expect(redactMcpSecrets('https://user:password@example.test/mcp?token=secret&mode=read')).toBe(
      'https://[redacted]@example.test/mcp?token=[redacted]&mode=read',
    )
    expect(redactMcpSecrets('--api-key top-secret --mode read')).toBe(
      '--api-key [redacted] --mode read',
    )
    expect(redactMcpSecrets('CLIENT_SECRET="hidden"')).toBe('CLIENT_SECRET=[redacted]')
    expect(redactMcpSecrets('Authorization=Bearer abc.def')).not.toContain('abc.def')
  })

  it('leaves non-sensitive connection metadata readable', () => {
    expect(redactMcpSecrets('npx -y @modelcontextprotocol/server-github')).toBe(
      'npx -y @modelcontextprotocol/server-github',
    )
    expect(redactMcpSecrets('/home/alice/repos/mcp/bin/server')).toBe('~/repos/mcp/bin/server')
  })

  it('redacts a secret passed as the next argv item after a sensitive flag', () => {
    expect(redactMcpArgs(['--api-key', 'top-secret', '--mode', 'read'])).toEqual([
      '--api-key',
      '[redacted]',
      '--mode',
      'read',
    ])
  })
})
