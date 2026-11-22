import type { SupabaseClient } from '@supabase/supabase-js'
import type { ProviderMigrationJob, MigrationResource } from '@/lib/providers/migration-contract'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { openMigrationPayload } from '@/lib/providers/migration-payload'
import { createLogger } from '@/lib/logger'
import { readMigrationFieldDifferences } from './migration-field-differences'

const log = createLogger('migration-noop-review')

/** A changed source snapshot needs no decision when applying it would write nothing. */
export async function resolveMigrationNoops(db: SupabaseClient, job: ProviderMigrationJob, deadline = Infinity): Promise<number> {
  if (job.phase !== 'completed' || !['completed', 'needs_attention'].includes(job.state)) return 0
  const rows = await fetchAllRows<{ id: string; resource: MigrationResource; target_id: string | null; payload: string }>(({ from, to }) =>
    db.from('migration_job_chunks').select('id,resource,target_id,payload')
      .eq('company_id', job.company_id).eq('job_id', job.id)
      .eq('state', 'needs_attention').eq('error_code', 'MIGRATION_SOURCE_CHANGED').order('id').range(from, to))
  let resolved = 0
  for (const row of rows) {
    if (Date.now() >= deadline - 1000) break
    if (!row.target_id) continue
    try {
      const revision: { updatedAt?: string } = {}
      const differences = await readMigrationFieldDifferences(db, job.company_id, row.resource,
        row.target_id, openMigrationPayload(row.payload), revision, job.provider)
      // Failed/missing evidence and any actual field/line change stay reviewable.
      if (!differences || differences.length || !revision.updatedAt) continue
      const { data, error } = await db.rpc('acknowledge_provider_migration_noop', {
        p_job_id: job.id, p_record_id: row.id, p_company_id: job.company_id,
        p_user_id: job.user_id, p_expected_updated_at: revision.updatedAt,
      })
      if (error) throw error
      if (data === true) resolved++
    } catch {
      // A stale revision, unreadable snapshot or database refusal never hides a difference.
      log.warn('Migration no-op left for review', { jobId: job.id, recordId: row.id })
    }
  }
  return resolved
}
