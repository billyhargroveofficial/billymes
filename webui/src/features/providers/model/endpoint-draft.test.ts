import { describe, expect, it } from 'vitest'
import {
  EMPTY_ENDPOINT_DRAFT,
  draftFromEndpoint,
  endpointDraftError,
  probeVerdict,
} from './endpoint-draft'
import type { CustomEndpoint } from './types'

const ENDPOINT: CustomEndpoint = {
  id: 'local',
  name: 'Local',
  baseUrl: 'http://localhost:1234/v1',
  model: 'qwen',
  models: ['qwen', 'llama'],
  contextLength: 32768,
  discoverModels: false,
  hasApiKey: true,
  apiKeyPreview: '${LOCAL_KEY}',
  isCurrent: true,
  source: 'providers',
}

describe('draftFromEndpoint', () => {
  it('carries the endpoint into the form without its secret', () => {
    expect(draftFromEndpoint(ENDPOINT)).toEqual({
      id: 'local',
      name: 'Local',
      baseUrl: 'http://localhost:1234/v1',
      model: 'qwen',
      apiKey: '',
      contextLength: '32768',
      discoverModels: false,
      makeDefault: true,
    })
  })

  it('leaves the context field blank when the endpoint has none', () => {
    expect(draftFromEndpoint({ ...ENDPOINT, contextLength: null }).contextLength).toBe('')
  })
})

describe('endpointDraftError', () => {
  it('names the first missing field', () => {
    expect(endpointDraftError(EMPTY_ENDPOINT_DRAFT)).toBe('укажи название')
    expect(endpointDraftError({ ...EMPTY_ENDPOINT_DRAFT, name: 'x' })).toBe('укажи адрес эндпоинта')
    expect(
      endpointDraftError({ ...EMPTY_ENDPOINT_DRAFT, name: 'x', baseUrl: 'localhost' }),
    ).toMatch(/http/)
    expect(
      endpointDraftError({ ...EMPTY_ENDPOINT_DRAFT, name: 'x', baseUrl: 'https://h/v1' }),
    ).toBe('укажи модель')
  })

  it('accepts a complete draft', () => {
    expect(endpointDraftError(draftFromEndpoint(ENDPOINT))).toBeNull()
  })
})

describe('probeVerdict', () => {
  it('accepts a good credential', () => {
    expect(probeVerdict({ ok: true, reachable: true, message: '', models: [] }).kind).toBe('ok')
  })

  it('blocks a rejected credential and keeps the gateway message', () => {
    expect(probeVerdict({ ok: false, reachable: true, message: 'bad key', models: [] })).toEqual({
      kind: 'blocked',
      message: 'bad key',
    })
  })

  it('only warns when the probe itself could not run', () => {
    expect(probeVerdict({ ok: false, reachable: false, message: '', models: [] }).kind).toBe('warn')
  })

  it('uses the caller fallback when the gateway sends no message', () => {
    expect(
      probeVerdict({ ok: false, reachable: true, message: '', models: [] }, 'нет').message,
    ).toBe('нет')
  })
})
