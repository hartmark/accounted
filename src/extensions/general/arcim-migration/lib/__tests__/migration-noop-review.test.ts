import { beforeEach, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ProviderMigrationJob } from '@/lib/providers/migration-contract'
const mocks = vi.hoisted(() => ({ compare: vi.fn(), open: vi.fn() }))
vi.mock('../migration-field-differences', () => ({ readMigrationFieldDifferences: mocks.compare }))
vi.mock('@/lib/providers/migration-payload', () => ({ openMigrationPayload: mocks.open }))
import { resolveMigrationNoops } from '../migration-noop-review'
const db = createQueuedMockSupabase()
const client = db.supabase as unknown as SupabaseClient
const job = { id: 'job', company_id: 'company', user_id: 'user', phase: 'completed', state: 'needs_attention' } as ProviderMigrationJob
const row = { id: 'record', resource: 'suppliers', target_id: 'supplier', payload: 'encrypted' }
beforeEach(() => {
  vi.clearAllMocks(); db.reset(); mocks.open.mockReturnValue({ id: 'source' })
  mocks.compare.mockImplementation(async (_db, _company, _resource, _target, _dto, revision) => { revision.updatedAt = '2026-11-22T01:00:00Z'; return [] })
})
it('acknowledges an empty patch under the target revision and scopes the candidates', async () => {
  db.enqueue({ data: [row], error: null }); db.enqueue({ data: true, error: null })
  expect(await resolveMigrationNoops(client, job)).toBe(1)
  expect(db.findCalls('migration_job_chunks','eq')).toEqual(expect.arrayContaining([
    ['company_id','company'],['job_id','job'],['state','needs_attention'],['error_code','MIGRATION_SOURCE_CHANGED'],
  ]))
  expect(db.supabase.rpc).toHaveBeenCalledWith('acknowledge_provider_migration_noop', {
    p_job_id:'job',p_record_id:'record',p_company_id:'company',p_user_id:'user',p_expected_updated_at:'2026-11-22T01:00:00Z',
  })
})
it.each([
  [{ field:'bankgiro',source:'5050-1055',accounted:null }],
  [{ field:'paid_at',source:null,accounted:'2026-09-01' }],
  [{ field:'description',source:'Changed',accounted:'Original',line:1 }],
])('preserves actual field or line changes: %j', async differences => {
  db.enqueue({ data:[row],error:null });mocks.compare.mockImplementation(async (...args) => { args[5].updatedAt='2026-11-22T01:00:00Z'; return [differences] })
  expect(await resolveMigrationNoops(client,job)).toBe(0)
  expect(db.supabase.rpc).not.toHaveBeenCalled()
})
it.each([null,[]])('preserves missing records or revisions', async differences => {
  db.enqueue({data:[row],error:null});mocks.compare.mockResolvedValue(differences)
  expect(await resolveMigrationNoops(client,job)).toBe(0)
  expect(db.supabase.rpc).not.toHaveBeenCalled()
})
it('preserves unreadable snapshots',async()=>{
  db.enqueue({data:[row],error:null});mocks.open.mockImplementation(()=>{throw new Error('unavailable')})
  expect(await resolveMigrationNoops(client,job)).toBe(0)
  expect(db.supabase.rpc).not.toHaveBeenCalled()
})
it('leaves a concurrent local change reviewable',async()=>{
  db.enqueue({data:[row],error:null});db.enqueue({data:null,error:{message:'MIGRATION_REVIEW_STALE'}})
  expect(await resolveMigrationNoops(client,job)).toBe(0)
})
it('does not process an import still running or another kind of review',async()=>{
  expect(await resolveMigrationNoops(client,{...job,phase:'import',state:'running'})).toBe(0)
  expect(db.supabase.from).not.toHaveBeenCalled()
})
