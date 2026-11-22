import type { SupabaseClient } from '@supabase/supabase-js'
import type { ProviderMigrationJob, MigrationResource, MigrationResourceCounts } from '@/lib/providers/migration-contract'
import type { SalesInvoiceDto } from '@/lib/providers/dto'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { openMigrationPayload } from '@/lib/providers/migration-payload'
import { readMigrationFieldDifferences } from './migration-field-differences'
import { ownInvoiceNumber, invoicePartyName } from './invoice-review-labels'

export async function readMigrationExtraDetails(supabase:SupabaseClient, companyId:string, job:ProviderMigrationJob, counts:MigrationResourceCounts[]) {
  const ctx = {supabase,companyId}
  const {data:changes,error} = await supabase.from('migration_job_chunks')
    .select('id,resource,source_id,target_id,payload,receipt')
    .eq('company_id',companyId).eq('job_id',job.id).not('target_id','is',null)
    .or('receipt->>imported.eq.true,receipt->>reason.eq.source_changed').order('resource_order').order('id').limit(500)
  if(error)throw error
  const issues: typeof changes = []
  const skipped = (counts ?? []).some((row: MigrationResourceCounts) => row.skipped > 0) ? await fetchAllRows<{id:string;resource:MigrationResource;source_id:string;target_id:string|null;payload:string;receipt:{reason?:string}}>(({from,to}) => ctx.supabase
    .from('migration_job_chunks').select('id,resource,source_id,target_id,payload,receipt')
    .eq('company_id',ctx.companyId).eq('job_id',job.id).eq('state','skipped')
    .neq('receipt->>reason','unchanged').order('id').range(from,to)) : []
  const comparisons = new Map<string, { differences?: import('@/lib/providers/migration-contract').MigrationFieldDifference[]; comparisonUnavailable?: boolean; targetUpdatedAt?: string }>()
  for (const row of (changes ?? []).filter(row => row.receipt?.reason === 'source_changed')) {
    try {
      const revision: { updatedAt?: string } = {}
      const differences = await readMigrationFieldDifferences(ctx.supabase,ctx.companyId,row.resource,row.target_id,openMigrationPayload(row.payload),revision,job.provider)
      if (differences && !differences.length) {
        // The imported source snapshot can be more complete than a provider
        // list response. Explain that actual hash change instead of implying
        // an unexplained change to the local invoice.
        const { data: prior, error: priorError } = await ctx.supabase.from('migration_job_chunks')
          .select('payload,migration_jobs!inner(provider,account_key,state)')
          .eq('company_id',ctx.companyId).eq('resource',row.resource).eq('source_id',row.source_id)
          .eq('target_id',row.target_id).eq('state','done').neq('job_id',job.id)
          .eq('migration_jobs.provider',job.provider).eq('migration_jobs.account_key',job.account_key)
          .eq('migration_jobs.state','completed').order('updated_at',{ascending:false}).order('id',{ascending:false})
          .limit(1).maybeSingle()
        if (priorError) throw priorError
        if (prior) {
          const current = openMigrationPayload<{lines?:unknown[]}>(row.payload)
          const previous = openMigrationPayload<{lines?:unknown[]}>(prior.payload)
          if (Array.isArray(current.lines) && Array.isArray(previous.lines) && current.lines.length !== previous.lines.length)
            differences.push({field:'source_line_count',source:current.lines.length,accounted:previous.lines.length})
        }
      }
      comparisons.set(row.id,differences ? { differences, targetUpdatedAt: revision.updatedAt } : { comparisonUnavailable:true })
    } catch { comparisons.set(row.id,{ comparisonUnavailable:true }) }
  }
  const describedChanges = (Array.isArray(changes) ? changes : []).map(row => {
    let label = row.source_id as string
    if (row.payload) try {
      const value = openMigrationPayload<Partial<SalesInvoiceDto> & {party?:{name?:string}}>(row.payload)
      label = ownInvoiceNumber(value, row.source_id) || invoicePartyName(value, row.resource) || value.party?.name || label
    } catch { /* A source ID remains a safe fallback. */ }
    return {...comparisons.get(row.id),id:row.id,resource:row.resource,source_id:row.source_id,targetId:row.target_id,label,
      kind:row.receipt?.reason==='source_changed' ? 'changed' as const : 'new' as const}
  })
  const describedSkipped = skipped.map(row => {
    let invoice: Partial<SalesInvoiceDto> | null = null
    try { invoice = openMigrationPayload(row.payload) } catch { /* Keep identity and reason visible. */ }
    const number = ownInvoiceNumber(invoice,row.source_id)
    const party = invoicePartyName(invoice,row.resource)
    const amount = invoice?.legalMonetaryTotal?.payableAmount?.value
    return { id:row.id, resource:row.resource, source_id:row.source_id, targetId:row.target_id,
      reason:row.receipt?.reason ?? 'unknown', ...(number ? {invoiceNumber:number} : {}),
      ...(party ? {partyName:party} : {}), ...(invoice?.issueDate ? {invoiceDate:invoice.issueDate} : {}),
      ...(typeof amount === 'number' ? {amount} : {}), ...(invoice?.currencyCode ? {currency:invoice.currencyCode} : {}) }
  })
  return {comparisons,changes:describedChanges,skipped:describedSkipped}
}
