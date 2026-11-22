import { afterEach, describe, expect, it, vi } from 'vitest'
import { isConnectorState } from '@/lib/connect/hosted/state'
import { newSkvOAuthState } from '../lib/oauth-routing'

afterEach(() => vi.unstubAllEnvs())

describe('Skatteverket callback routing state', () => {
  it('keeps the original random state when no namespace is configured', () => {
    vi.stubEnv('SKATTEVERKET_OAUTH_STATE_NAMESPACE', '')
    expect(newSkvOAuthState()).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('adds an unambiguous routing hint without reducing randomness', () => {
    vi.stubEnv('SKATTEVERKET_OAUTH_STATE_NAMESPACE', 'accounted-dev')
    const states = Array.from({ length: 20 }, () => newSkvOAuthState())
    expect(new Set(states).size).toBe(states.length)
    for (const state of states) {
      expect(state).toMatch(/^instance\.accounted-dev\.[A-Za-z0-9_-]{43}$/)
      expect(isConnectorState(state)).toBe(false)
    }
  })

  it.each(['../dev', 'dev.example', 'dev*', 'dev&state=x', 'a'.repeat(33)])(
    'rejects invalid deployment namespaces: %s',
    (namespace) => {
      vi.stubEnv('SKATTEVERKET_OAUTH_STATE_NAMESPACE', namespace)
      expect(() => newSkvOAuthState()).toThrow('Invalid SKATTEVERKET_OAUTH_STATE_NAMESPACE')
    },
  )
})
