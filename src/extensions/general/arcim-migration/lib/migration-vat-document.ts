import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { ExtensionContext } from '@/lib/extensions/types'
import { openMigrationPayload } from '@/lib/providers/migration-payload'
import { resolveConsent } from '@/lib/providers/resolve-consent'
import { BokioClient } from '@/lib/providers/bokio/client'
import type { SupplierInvoiceDto } from '@/lib/providers/dto'

const query = z.object({ jobId: z.uuid(), recordId: z.uuid() })

/** Read only the attachment named by this company's imported invoice snapshot. */
export async function readMigrationVatDocument(request: Request, ctx: ExtensionContext) {
  const input = query.safeParse(Object.fromEntries(new URL(request.url).searchParams))
  if (!input.success) return NextResponse.json({ error: 'INVALID_QUERY' }, { status: 400 })
  const { data: record, error } = await ctx.supabase.from('migration_job_chunks')
    .select('payload,migration_jobs!inner(consent_id,provider)')
    .eq('company_id', ctx.companyId).eq('job_id', input.data.jobId)
    .eq('id', input.data.recordId).eq('resource', 'supplierInvoices').maybeSingle()
  if (error) return NextResponse.json({ error: 'LOOKUP_FAILED' }, { status: 500 })
  if (!record) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  try {
    const job = record.migration_jobs as unknown as { consent_id: string; provider: string }
    const dto = openMigrationPayload<SupplierInvoiceDto>(record.payload)
    const refs = z.array(z.object({ id: z.uuid() })).length(1).safeParse(dto._raw?.uploadRefs)
    if (job.provider !== 'bokio' || !refs.success) return NextResponse.json({ error: 'DOCUMENT_NOT_AVAILABLE' }, { status: 404 })
    const connection = await resolveConsent(ctx.companyId, job.consent_id)
    if (connection.consent.provider !== 'bokio' || !connection.providerCompanyId) throw new Error('Invalid provider')
    const file = await new BokioClient().getBytes(connection.accessToken, connection.providerCompanyId,
      '/uploads/' + refs.data[0].id + '/download')
    if (!Buffer.from(file.bytes).subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Unsupported document')
    return new Response(file.bytes, { headers: {
      'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="invoice.pdf"',
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    } })
  } catch (failure) {
    ctx.log.warn('Migration source document unavailable', { recordId: input.data.recordId,
      reason: failure instanceof Error ? failure.name : 'unknown' })
    return NextResponse.json({ error: 'DOCUMENT_NOT_AVAILABLE' }, { status: 409 })
  }
}
