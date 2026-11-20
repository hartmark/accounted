import type { ExtensionContext } from '@/lib/extensions/types'
import { NextResponse, after } from 'next/server'
import { z } from 'zod'
import { validateBody } from '@/lib/api/validate'
import { requireWritePermission } from '@/lib/auth/require-write'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import type { MigrationResource } from '@/lib/providers/migration-contract'
import type { CustomerDto, SupplierDto, SalesInvoiceDto, SupplierInvoiceDto } from '@/lib/providers/dto'
import { openMigrationPayload } from '@/lib/providers/migration-payload'
import { readMigrationFieldDifferences } from './migration-field-differences'
import { mapCustomer, mapSupplier, mapSalesInvoice, mapSupplierInvoice } from './entity-mapper'
import { runProviderMigrationWorker } from './migration-job-worker'

const schema = z.object({
  jobId: z.uuid(), recordId: z.uuid(), action: z.enum(['source', 'ignore']),
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
}).strict()

/** Apply one reviewed source snapshot, or acknowledge it without changing the local record. */
export async function decideMigrationRecord(request: Request, ctx: ExtensionContext) {
  const input = await validateBody(request, schema)
  if (!input.success) return input.response
  const permission = await requireWritePermission(ctx.supabase, ctx.userId, { companyId: ctx.companyId })
  if (!permission.ok) return permission.response
  const body = input.data
  const { data: row, error } = await ctx.supabase.from('migration_job_chunks')
    .select('id,resource,target_id,payload,error_code')
    .eq('company_id', ctx.companyId).eq('job_id', body.jobId).eq('id', body.recordId).maybeSingle()
  if (error) return NextResponse.json({ error: { code: 'MIGRATION_REVIEW_FAILED' } }, { status: 500 })
  if (!row) return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 })
  let patch: Record<string, unknown> = {}
  let items: Record<string, unknown>[] | null = null
  if (body.action === 'source' && row.error_code === 'MIGRATION_SOURCE_CHANGED' && row.target_id) {
    try {
      const resource = row.resource as MigrationResource
      const dto = openMigrationPayload(row.payload)
      const differences = await readMigrationFieldDifferences(ctx.supabase, ctx.companyId, resource, row.target_id, dto)
      if (!differences) return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 })
      const mapped = resource === 'supplierInvoices' ? mapSupplierInvoice(dto as SupplierInvoiceDto, ctx.userId, ctx.companyId, '')
        : resource === 'salesInvoices' ? mapSalesInvoice(dto as SalesInvoiceDto, ctx.userId, ctx.companyId, '') : null
      const values = mapped?.invoice ?? (resource === 'customers'
        ? mapCustomer(dto as CustomerDto, ctx.userId, ctx.companyId) : mapSupplier(dto as SupplierDto, ctx.userId, ctx.companyId))
      patch = Object.fromEntries(differences.filter(diff => !diff.line && diff.field !== 'source_line_count' && diff.field in values)
        .map(diff => [diff.field, (values as Record<string, unknown>)[diff.field]]))
      if (mapped && differences.some(diff => ['subtotal', 'vat_amount', 'total', 'currency', 'is_credit_note'].includes(diff.field))) {
        if (mapped.fxUnresolved || mapped.vatUnresolved) throw new Error('Source monetary evidence is incomplete')
        for (const key of ['subtotal_sek', 'vat_amount_sek', 'total_sek', 'exchange_rate', 'vat_rate', 'vat_treatment', 'reverse_charge']) {
          if (key in values) patch[key] = (values as Record<string, unknown>)[key]
        }
      }
      if (mapped && differences.some(diff => diff.line)) {
        const sourceLines = (dto as SalesInvoiceDto | SupplierInvoiceDto).lines
        if (!Array.isArray(sourceLines) || !sourceLines.length || mapped.items.length !== sourceLines.length) {
          throw new Error('Source invoice rows are incomplete')
        }
        items = mapped.items
      }
    } catch (failure) {
      ctx.log.warn('Migration review snapshot unavailable', failure)
      return NextResponse.json({ error: { code: 'MIGRATION_REVIEW_SNAPSHOT_UNAVAILABLE' } }, { status: 409 })
    }
  }
  const { data, error: refused } = await createServiceClientNoCookies().rpc('decide_provider_migration_record', {
    p_job_id: body.jobId, p_record_id: body.recordId, p_company_id: ctx.companyId, p_user_id: ctx.userId,
    p_action: body.action, p_values: patch, p_items: items, p_expected_updated_at: body.expectedUpdatedAt ?? null,
  })
  if (refused) {
    const code = ['MIGRATION_REVIEW_BOOKED_CONFLICT', 'MIGRATION_REVIEW_STALE', 'MIGRATION_REVIEW_BUSY']
      .find(value => refused.message.includes(value)) ?? 'MIGRATION_REVIEW_FAILED'
    ctx.log.warn('Migration record decision refused', { code, recordId: row.id })
    return NextResponse.json({ error: { code } }, { status: 409 })
  }
  if (data?.queued) after(async () => {
    await runProviderMigrationWorker({ jobId: body.jobId }).catch(failure => ctx.log.error('Selected migration record failed', failure))
  })
  return NextResponse.json({ data })
}
