import { beforeEach, expect, it, vi } from 'vitest'
import { createMockRequest, createQueuedMockSupabase } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), permission: vi.fn(), differences: vi.fn(), open: vi.fn() }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: () => ({ rpc: mocks.rpc }) }))
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: mocks.permission }))
vi.mock('@/lib/providers/migration-payload', () => ({ openMigrationPayload: mocks.open }))
vi.mock('../migration-field-differences', () => ({ readMigrationFieldDifferences: mocks.differences }))
vi.mock('../entity-mapper', () => ({ mapSupplierInvoice: () => ({ invoice: { status: 'paid', paid_amount: 100, remaining_amount: 0, company_id: 'wrong' }, items: [] }) }))
vi.mock('../migration-job-worker', () => ({ runProviderMigrationWorker: vi.fn() }))
import { decideMigrationRecord } from '../migration-record-decision'

const db = createQueuedMockSupabase()
const jobId = '00000000-0000-4000-8000-000000000001'
const recordId = '00000000-0000-4000-8000-000000000002'
const updatedAt = '2026-11-20T12:00:00Z'
const ctx = { supabase: db.supabase, companyId: 'company-1', userId: 'user-1',
  log: { warn: vi.fn(), error: vi.fn() } } as unknown as ExtensionContext
const row = { id: recordId, resource: 'supplierInvoices', target_id: 'invoice-1', payload: 'encrypted', error_code: 'MIGRATION_SOURCE_CHANGED' }
const call = (body: unknown) => decideMigrationRecord(createMockRequest('/decision', { method: 'POST', body }), ctx)
beforeEach(() => {
  vi.clearAllMocks(); db.reset()
  mocks.permission.mockResolvedValue({ ok: true })
  mocks.rpc.mockResolvedValue({ data: { queued: false }, error: null })
  mocks.open.mockReturnValue({ id: 'source-1' })
  mocks.differences.mockResolvedValue([{ field: 'status', source: 'paid', accounted: 'overdue' }])
})
it('rejects client-supplied patches instead of trusting arbitrary fields', async () => {
  expect((await call({ jobId, recordId, action: 'source', values: { paid_amount: 100 } })).status).toBe(400)
  expect(mocks.rpc).not.toHaveBeenCalled()
})
it('refuses viewers before reading the source snapshot', async () => {
  mocks.permission.mockResolvedValue({ ok: false, response: new Response('{}', { status: 403 }) })
  expect((await call({ jobId, recordId, action: 'ignore' })).status).toBe(403)
  expect(db.supabase.from).not.toHaveBeenCalled()
})
it('scopes the record lookup to the requested job and active company', async () => {
  db.enqueue({ data: null, error: null })
  expect((await call({ jobId, recordId, action: 'ignore' })).status).toBe(404)
  expect(db.findCalls('migration_job_chunks', 'eq')).toContainEqual(['company_id', 'company-1'])
  expect(db.findCalls('migration_job_chunks', 'eq')).toContainEqual(['job_id', jobId])
  expect(mocks.rpc).not.toHaveBeenCalled()
})
it('ignores one record without opening or applying the source payload', async () => {
  db.enqueue({ data: row, error: null })
  expect((await call({ jobId, recordId, action: 'ignore' })).status).toBe(200)
  expect(mocks.open).not.toHaveBeenCalled()
  expect(mocks.rpc).toHaveBeenCalledWith('decide_provider_migration_record', expect.objectContaining({ p_job_id: jobId,
    p_record_id: recordId, p_action: 'ignore', p_company_id: 'company-1', p_user_id: 'user-1', p_values: {}, p_items: null }))
})
it('derives only changed fields from the retained source and passes the displayed revision', async () => {
  db.enqueue({ data: row, error: null })
  expect((await call({ jobId, recordId, action: 'source', expectedUpdatedAt: updatedAt })).status).toBe(200)
  expect(mocks.rpc).toHaveBeenCalledWith('decide_provider_migration_record', expect.objectContaining({ p_values: { status: 'paid' }, p_expected_updated_at: updatedAt }))
})
it('leaves the decision unsaved when the source snapshot cannot be compared', async () => {
  db.enqueue({ data: row, error: null });mocks.open.mockImplementationOnce(() => { throw new Error('unavailable') })
  expect((await call({ jobId, recordId, action: 'source' })).status).toBe(409)
  expect(mocks.rpc).not.toHaveBeenCalled()
})
it.each(['MIGRATION_REVIEW_BOOKED_CONFLICT', 'MIGRATION_REVIEW_STALE', 'MIGRATION_REVIEW_BUSY'])('reports the database refusal %s', async code => {
  db.enqueue({ data: row, error: null });mocks.rpc.mockResolvedValue({ data: null, error: { message: code } })
  const response = await call({ jobId, recordId, action: 'ignore' })
  expect(response.status).toBe(409);expect((await response.json()).error.code).toBe(code)
})

it('does not replace retained invoice rows with incomplete provider evidence', async () => {
  db.enqueue({ data: row, error: null })
  mocks.differences.mockResolvedValueOnce([{ field: 'invoice_line', line: 1, source: null, accounted: 'Retained row' }])
  expect((await call({ jobId, recordId, action: 'source', expectedUpdatedAt: updatedAt })).status).toBe(409)
  expect(mocks.rpc).not.toHaveBeenCalled()
})
