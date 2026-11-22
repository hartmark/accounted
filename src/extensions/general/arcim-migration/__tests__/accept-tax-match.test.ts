import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase, createMockRequest } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

const { autoMatch, accept } = vi.hoisted(() => ({ autoMatch: vi.fn(), accept: vi.fn() }))
vi.mock('../../skatteverket/lib/skattekonto-import-match', () => ({ matchImportedSkattekonto: autoMatch }))
vi.mock('../lib/provider-client', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/provider-client')>()), acceptConsent: accept,
}))
import { arcimMigrationExtension } from '../index'

const route = arcimMigrationExtension.apiRoutes!.find(r => r.method === 'POST' && r.path === '/accept')!
const result = { considered: 3, linked: 2, skipped: 0, failed: false }
beforeEach(() => {
  vi.clearAllMocks()
  accept.mockResolvedValue(undefined)
  autoMatch.mockResolvedValue(result)
})

function setup(provider: string | null) {
  const db = createQueuedMockSupabase()
  db.enqueue({ data: provider ? { id: 'consent', provider } : null })
  const ctx = { supabase: db.supabase, companyId: 'company', userId: 'user',
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } } as unknown as ExtensionContext
  return { db, ctx }
}
const request = (body = { consentId: 'consent' }) =>
  createMockRequest('http://localhost/accept', { method: 'POST', body })

describe('SIE-only Bokio import acceptance', () => {
  it('matches tax events after accepting the company consent and reports the outcome', async () => {
    const { db, ctx } = setup('bokio')
    const res = await route.handler(request(), ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, skattekonto: result })
    expect(db.findCalls('provider_consents', 'eq')).toContainEqual(['company_id', 'company'])
    expect(accept).toHaveBeenCalledWith('consent')
    expect(autoMatch).toHaveBeenCalledWith(db.supabase, 'company', 'user')
    expect(accept.mock.invocationCallOrder[0]).toBeLessThan(autoMatch.mock.invocationCallOrder[0])
  })
  it('does not match another company consent', async () => {
    const { ctx } = setup(null)
    const res = await route.handler(request(), ctx)
    expect(res.ok).toBe(false)
    expect(accept).not.toHaveBeenCalled()
    expect(autoMatch).not.toHaveBeenCalled()
  })
  it('rejects an absent consent id before matching', async () => {
    const { ctx } = setup('bokio')
    const res = await route.handler(request({ consentId: '' }), ctx)
    expect(res.status).toBe(400)
    expect(autoMatch).not.toHaveBeenCalled()
  })
  it('does not change acceptance for other providers', async () => {
    const { ctx } = setup('fortnox')
    expect((await route.handler(request(), ctx)).status).toBe(200)
    expect(autoMatch).not.toHaveBeenCalled()
  })
  it('keeps a completed import successful when matching was deferred', async () => {
    const { ctx } = setup('bokio')
    autoMatch.mockResolvedValueOnce({ ...result, linked: 0, failed: true })
    expect((await route.handler(request(), ctx)).status).toBe(200)
  })
})
