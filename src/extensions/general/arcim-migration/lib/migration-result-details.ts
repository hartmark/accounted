import { isLedgerCurrency } from '@/lib/bookkeeping/currency-utils'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { UNSETTLED_SUPPLIER_INVOICE_STATUSES } from '@/lib/supplier-invoices/lifecycle'
import type { MigrationResource, MigrationResourceCounts, PendingImportPayables } from '@/lib/providers/migration-contract'

const reasonKeys = {historical_receivable:'historicalReceivable',outsideFiscalYears:'outsideFiscalYears',
  inactive:'inactive',zeroTotal:'zeroTotal',creditNoteInOldShape:'creditNoteInOldShape'} as const

/** Read recorded reasons rather than guessing why a counter is nonzero. */
export async function readMigrationSkipReasons(db:SupabaseClient,companyId:string,jobId:string) {
  const rows=await fetchAllRows<{resource:MigrationResource;receipt:{reason?:string}}>(({from,to})=>db
    .from('migration_job_chunks').select('resource,receipt').eq('company_id',companyId).eq('job_id',jobId)
    .eq('state','skipped').neq('receipt->>reason','unchanged').order('id').range(from,to))
  const result:Partial<Record<MigrationResource,MigrationResourceCounts['skipReasons']>>={}
  for(const row of rows){
    const key=reasonKeys[row.receipt.reason as keyof typeof reasonKeys]
    if(!key)continue
    const counts=result[row.resource]??={}
    counts[key]=(counts[key]??0)+1
  }
  return result
}

/** These invoices ARE imported; only payment matching awaits the due date. */
export async function readPendingImportPayables(db:SupabaseClient,companyId:string,jobId:string,
  today=todayIsoStockholm(),
):Promise<PendingImportPayables>{
  const invoices=await fetchAllRows<{id:string;supplier_invoice_number:string;due_date:string;remaining_amount:number;currency:string}>(({from,to})=>db
    .from('supplier_invoices').select('id,supplier_invoice_number,due_date,remaining_amount,currency')
    .eq('company_id',companyId).in('status',[...UNSETTLED_SUPPLIER_INVOICE_STATUSES,'partially_paid'])
    .gt('remaining_amount',0.005).gte('due_date',today).or('is_credit_note.is.null,is_credit_note.eq.false')
    .order('due_date').order('id').range(from,to))
  const imported=new Set<string>()
  for(let offset=0;offset<invoices.length;offset+=100){
    const rows=await fetchAllRows<{target_id:string}>(({from,to})=>db.from('migration_job_chunks').select('target_id')
      .eq('company_id',companyId).eq('job_id',jobId).eq('resource','supplierInvoices')
      .in('target_id',invoices.slice(offset,offset+100).map(row=>row.id)).order('id').range(from,to))
    for(const row of rows)imported.add(row.target_id)
  }
  const pending=invoices.filter(invoice=>imported.has(invoice.id))
  return {count:pending.length,items:pending.slice(0,20).map(row=>({id:row.id,invoiceNumber:row.supplier_invoice_number,
    dueDate:row.due_date,remaining:row.remaining_amount,currency:row.currency}))}
}

/** A VAT warning names the retained invoice, including after job acceptance. */
export async function readMigrationVatWarnings(db: SupabaseClient, companyId: string, jobId: string) {
  const chunks = await fetchAllRows<{ id: string; resource: 'supplierInvoices' | 'salesInvoices'; target_id: string | null }>(
    ({ from, to }) => db.from('migration_job_chunks').select('id,resource,target_id')
      .eq('company_id', companyId).eq('job_id', jobId)
      .eq('receipt->warnings->>vatUnresolved', 'true').order('id').range(from, to))
  const result: import('@/lib/providers/migration-contract').MigrationVatWarning[] = []
  for (const resource of ['supplierInvoices', 'salesInvoices'] as const) {
    const records = chunks.filter(chunk => chunk.resource === resource && chunk.target_id)
    for (let offset = 0; offset < records.length; offset += 100) {
      const batch = records.slice(offset, offset + 100)
      const supplier = resource === 'supplierInvoices'
      const rows = await fetchAllRows<Record<string, unknown>>(({ from, to }) => db
        .from(supplier ? 'supplier_invoices' : 'invoices')
        .select(supplier
          ? 'id,supplier_invoice_number,invoice_date,total,currency,updated_at,status,approved_at,document_id,registration_journal_entry_id,payment_journal_entry_id,paid_at,paid_amount,is_credit_note,reverse_charge,party:suppliers(name),items:supplier_invoice_items(id)'
          : 'id,invoice_number,invoice_date,total,currency,updated_at,party:customers(name)')
        .eq('company_id', companyId).in('id', batch.map(chunk => chunk.target_id!)).order('id').range(from, to))
      for (const row of rows) {
        const party = row.party as { name?: string } | null
        for (const record of batch.filter(chunk => chunk.target_id === row.id)) result.push({
          id: record.id, resource, targetId: String(row.id),
          invoiceNumber: (supplier ? row.supplier_invoice_number : row.invoice_number) as string | null,
          partyName: party?.name ?? '', invoiceDate: String(row.invoice_date),
          total: Number(row.total), currency: String(row.currency), updatedAt: String(row.updated_at),
          canConfirm: supplier && ['registered', 'overdue'].includes(String(row.status))
            && isLedgerCurrency(String(row.currency)) && !row.approved_at && !row.is_credit_note && !row.reverse_charge
            && !row.registration_journal_entry_id && !row.payment_journal_entry_id && !row.paid_at
            && Number(row.paid_amount ?? 0) === 0 && Array.isArray(row.items) && row.items.length === 0,
        })
      }
    }
  }
  return result
}
