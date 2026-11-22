import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { ExtensionContext } from '@/lib/extensions/types'
import { validateBody } from '@/lib/api/validate'
import { requireWritePermission } from '@/lib/auth/require-write'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'

const schema = z.object({
  jobId: z.uuid(), recordId: z.uuid(), expectedUpdatedAt: z.string().datetime({ offset: true }),
  vat: z.number().finite().nonnegative(), rate: z.union([z.literal(6), z.literal(12), z.literal(25)]),
}).strict()

export async function confirmMigrationVat(request: Request, ctx: ExtensionContext) {
  const input = await validateBody(request, schema)
  if (!input.success) return input.response
  const permission = await requireWritePermission(ctx.supabase, ctx.userId, { companyId: ctx.companyId })
  if (!permission.ok) return permission.response
  const body = input.data
  const { data: record, error } = await ctx.supabase.from('migration_job_chunks').select('id')
    .eq('company_id', ctx.companyId).eq('job_id', body.jobId).eq('id', body.recordId).maybeSingle()
  if (error) return NextResponse.json({ error: { code: 'MIGRATION_LOOKUP_FAILED' } }, { status: 500 })
  if (!record) return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 })
  const { data, error: refused } = await createServiceClientNoCookies().rpc('confirm_migration_invoice_vat', {
    p_job_id: body.jobId, p_record_id: body.recordId, p_company_id: ctx.companyId, p_user_id: ctx.userId,
    p_expected_updated_at: body.expectedUpdatedAt, p_vat: body.vat, p_rate: body.rate,
  })
  if (refused) {
    ctx.log.warn('Invoice VAT review refused', { recordId: body.recordId, code: refused.code })
    return NextResponse.json({ error: { code: 'MIGRATION_VAT_REVIEW_REFUSED' } }, { status: 409 })
  }
  return NextResponse.json({ data })
}
