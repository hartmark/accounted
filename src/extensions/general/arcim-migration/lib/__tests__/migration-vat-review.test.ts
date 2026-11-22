import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionContext } from '@/lib/extensions/types'
import { createMockSupabase } from '@/tests/helpers'
const { permission, rpc } = vi.hoisted(() => ({ permission: vi.fn(), rpc: vi.fn() }))
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: permission }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: () => ({ rpc }) }))
import { confirmMigrationVat } from '../migration-vat-review'
const id = '5c4da29a-b51a-44ef-9705-fcf437d6c658'
const input = { jobId: id, recordId: id, expectedUpdatedAt: '2026-11-22T00:00:00Z', vat: 43.2, rate: 6 }
function setup() {
  const mock = createMockSupabase()
  const ctx = { supabase: mock.supabase, companyId: 'company', userId: 'user', log: { warn: vi.fn() } } as unknown as ExtensionContext
  return { ...mock, ctx }
}
const request = (body: unknown) => new Request('http://localhost/vat', { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
beforeEach(() => { vi.clearAllMocks(); permission.mockResolvedValue({ ok: true }); rpc.mockResolvedValue({ data: { invoiceId: id }, error: null }) })
describe('migration VAT confirmation', () => {
  it('rejects invalid rates, negative VAT, absent revision and tenant overrides', async () => {
    for (const body of [{ ...input, rate: 20 }, { ...input, vat: -1 }, { ...input, expectedUpdatedAt: null }, { ...input, companyId: 'foreign' }]) {
      expect((await confirmMigrationVat(request(body), setup().ctx)).status).toBe(400)
    }
    expect(rpc).not.toHaveBeenCalled()
  })
  it('requires write permission', async () => {
    permission.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) })
    expect((await confirmMigrationVat(request(input), setup().ctx)).status).toBe(403)
    expect(rpc).not.toHaveBeenCalled()
  })
  it('hides missing and foreign records', async () => {
    const { ctx, mockResult } = setup(); mockResult({ data: null })
    expect((await confirmMigrationVat(request(input), ctx)).status).toBe(404)
    expect(rpc).not.toHaveBeenCalled()
  })
  it('passes only trusted identity and the expected revision to the atomic confirmation', async () => {
    const { ctx, mockResult, supabase } = setup(); mockResult({ data: { id } })
    expect((await confirmMigrationVat(request(input), ctx)).status).toBe(200)
    expect(supabase.from).toHaveBeenCalledWith('migration_job_chunks')
    expect(rpc).toHaveBeenCalledWith('confirm_migration_invoice_vat', {
      p_job_id: id, p_record_id: id, p_company_id: 'company', p_user_id: 'user',
      p_expected_updated_at: input.expectedUpdatedAt, p_vat: 43.2, p_rate: 6,
    })
  })
  it('reports a booked or concurrently changed invoice without acknowledging the warning', async () => {
    const { ctx, mockResult } = setup(); mockResult({ data: { id } })
    rpc.mockResolvedValue({ error: { code: 'P0001', message: 'MIGRATION_REVIEW_STALE' } })
    expect((await confirmMigrationVat(request(input), ctx)).status).toBe(409)
  })
})
