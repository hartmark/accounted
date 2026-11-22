import { normalizeBokioUnitType } from '@/lib/providers/bokio/mapper'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { MigrationFieldDifference, MigrationResource } from '@/lib/providers/migration-contract'
import type { SalesInvoiceDto, SupplierInvoiceDto, CustomerDto, SupplierDto } from '@/lib/providers/dto'
import { mapSalesInvoice, mapSupplierInvoice, mapCustomer, mapSupplier } from './entity-mapper'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

const invoiceFields = ['invoice_number', 'supplier_invoice_number', 'invoice_date', 'due_date', 'delivery_date',
  'status', 'currency', 'subtotal', 'vat_amount', 'total', 'paid_amount', 'remaining_amount', 'paid_at',
  'payment_reference', 'notes', 'is_credit_note']
const partyFields = ['name', 'email', 'phone', 'address_line1', 'address_line2', 'postal_code', 'city', 'country',
  'org_number', 'vat_number', 'bankgiro', 'plusgiro', 'bank_account', 'default_payment_terms', 'notes']
const itemFields = ['description', 'quantity', 'unit', 'unit_price', 'line_total', 'vat_rate', 'vat_amount', 'account_number']

function scalar(value: unknown): MigrationFieldDifference['source'] {
  return typeof value === 'number' || typeof value === 'boolean' ? value : value == null || value === '' ? null : String(value)
}

/** Compare actual local values, never the old source hash or a proposed write. */
export function compareMigrationFields(source: Record<string, unknown>, local: Record<string, unknown>,
  fields: readonly string[], line?: number, provider?: string): MigrationFieldDifference[] {
  return fields.flatMap(field => {
    if (!(field in source)) return []
    const normalize = (value: unknown) => field === 'unit' && provider === 'bokio' && typeof value === 'string'
      ? normalizeBokioUnitType(value) : value
    const a = scalar(source[field]), b = scalar(local[field])
    // PostgREST numeric columns may be strings; timestamps may spell UTC differently.
    const equal = field === 'unit' && provider === 'bokio' ? scalar(normalize(a)) === scalar(normalize(b))
      : typeof a === 'number' && b != null && b !== '' ? Math.abs(a - Number(b)) < 0.000001
      : field === 'paid_at' && a && b ? Date.parse(String(a)) === Date.parse(String(b)) : a === b
    return equal ? [] : [{ field, source: a, accounted: b, ...(line ? { line } : {}) }]
  })
}

export async function readMigrationFieldDifferences(db: SupabaseClient, companyId: string,
  resource: MigrationResource, targetId: string, dto: unknown, revision?: { updatedAt?: string }, provider?: string,
): Promise<MigrationFieldDifference[] | null> {
  const sales = resource === 'salesInvoices', supplier = resource === 'supplierInvoices'
  const table = sales ? 'invoices' : supplier ? 'supplier_invoices' : resource
  const { data: local, error } = await db.from(table).select('*')
    .eq('company_id', companyId).eq('id', targetId).maybeSingle()
  if (error) throw error
  if (!local) return null
  if (revision && typeof local.updated_at === 'string') revision.updatedAt = local.updated_at
  if (!sales && !supplier) {
    const source = resource === 'customers' ? mapCustomer(dto as CustomerDto, '', companyId) : mapSupplier(dto as SupplierDto, '', companyId)
    return compareMigrationFields(source, local, partyFields)
  }
  const mapped = sales ? mapSalesInvoice(dto as SalesInvoiceDto, '', companyId, '')
    : mapSupplierInvoice(dto as SupplierInvoiceDto, '', companyId, '')
  // Missing VAT is unknown, not evidence that a reviewed document's VAT is zero.
  const fields = mapped.vatUnresolved ? invoiceFields.filter(field => field !== 'subtotal' && field !== 'vat_amount') : invoiceFields
  const result = compareMigrationFields(mapped.invoice, local, fields)
  const key = sales ? 'invoice_id' : 'supplier_invoice_id'
  // The company-scoped parent above authorizes these child rows.
  const items = await fetchAllRows<Record<string, unknown>>(({ from, to }) => db
    .from(sales ? 'invoice_items' : 'supplier_invoice_items').select('*').eq(key, targetId)
    .order('sort_order').order('id').range(from, to))
  // Incomplete provider evidence must not masquerade as deleted invoice rows.
  const raw = dto as SupplierInvoiceDto
  if (supplier && raw.supplierEvidence && !raw.supplierEvidence.itemsComplete) return result.map(diff => ({...diff,currency:String(mapped.invoice.currency)}))
  result.push(...compareMigrationInvoiceItems(mapped.items, items, provider))
  return result.map(diff => ({...diff,currency:String(mapped.invoice.currency)}))
}


/** Bokio may return the same identified rows in a different order on later reads. */
export function compareMigrationInvoiceItems(sourceItems: Record<string, unknown>[],
  localItems: Record<string, unknown>[], provider?: string): MigrationFieldDifference[] {
  const result: MigrationFieldDifference[] = []
  for (let i = 0; i < Math.max(sourceItems.length, localItems.length); i++) {
    const source = sourceItems[i], current = localItems[i]
    if (!source || !current) {
      result.push({ field: 'invoice_line', source: source ? String(source.description || '') : null,
        accounted: current ? String(current.description || '') : null, line: i + 1 })
    } else result.push(...compareMigrationFields(source, current, itemFields, i + 1, provider))
  }
  if (!result.length || provider !== 'bokio' || sourceItems.length !== localItems.length) return result

  // Match every occurrence once. A set would incorrectly hide missing duplicate rows.
  const unmatched = [...localItems]
  for (const source of sourceItems) {
    const index = unmatched.findIndex(current => !compareMigrationFields(source, current, itemFields, undefined, provider).length)
    if (index < 0) return result
    unmatched.splice(index, 1)
  }
  return []
}
