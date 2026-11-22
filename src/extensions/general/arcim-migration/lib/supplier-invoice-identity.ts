/**
 * How a provider's supplier invoice is matched to a stored row when a repair
 * pass joins the two (the import itself matches inside
 * commit_provider_migration_records).
 *
 * Fortnox numbers every supplier invoice itself (löpnummer, `GivenNumber`, the
 * record id its mapper hands on), apart from the number the supplier printed
 * (`InvoiceNumber`, the supplier number since crm#1157). An invoice imported
 * from Fortnox keeps the löpnummer in `fortnox_number`, and a row imported
 * before that column holds it as its supplier number. The supplier number
 * alone never identifies a Fortnox record: suppliers reuse one on invoice
 * after invoice (crm#1039).
 */

/**
 * The number a listed provider invoice is matched to a stored row on: the
 * löpnummer for a Fortnox record, the supplier's number for any other.
 */
export function listedMatchNumber(provider: string, dto: { id: string; invoiceNumber: string }): string | null {
  return (provider === 'fortnox' && dto.id?.trim()) || dto.invoiceNumber
}

/**
 * The number a stored row is matched to a listed provider invoice on: for
 * Fortnox its löpnummer, which a row imported before fortnox_number existed
 * holds as its supplier number.
 */
export function storedMatchNumber(
  provider: string,
  row: { supplier_invoice_number: string | null; fortnox_number?: string | null },
): string | null {
  return provider === 'fortnox' ? (row.fortnox_number ?? row.supplier_invoice_number) : row.supplier_invoice_number
}

export interface ExistingSupplierInvoiceIdentity {
  supplier_id: string | null
  supplier_invoice_number: string | null
  invoice_date: string | null
  total: number | string | null
  currency?: string | null
  is_credit_note?: boolean | null
}

export interface ListedSupplierInvoiceIdentity {
  id: string
  invoiceNumber: string
  issueDate: string
  currencyCode?: string
  invoiceTypeCode?: string
  legalMonetaryTotal: { payableAmount: { value: number } }
}

function headerKey(supplierId: string, number: string | null, date: string | null, total: number | string | null,
  currency = 'SEK', credit = false): string | null {
  if (!date || total === null || total === '') return null
  const amount = Number(total)
  if (!Number.isFinite(amount)) return null
  return JSON.stringify([supplierId, number && number !== '-' ? number : null, date, currency, Math.round(Math.abs(amount) * 100), credit])
}

export function existingInvoiceKey(row: ExistingSupplierInvoiceIdentity): string | null {
  if (!row.supplier_id) return null
  return headerKey(row.supplier_id, row.supplier_invoice_number, row.invoice_date, row.total, row.currency ?? 'SEK', row.is_credit_note ?? false)
}

export function listedInvoiceKeys(supplierId: string, dto: ListedSupplierInvoiceIdentity): string[] {
  const key = (number: string | null) => headerKey(supplierId, number, dto.issueDate,
    dto.legalMonetaryTotal?.payableAmount?.value, dto.currencyCode, dto.invoiceTypeCode === '381')
  const numbered = dto.invoiceNumber && dto.invoiceNumber !== '-'
  const keys = [key(numbered ? dto.invoiceNumber : null)]
  if (!numbered && dto.id) keys.push(key(dto.id))
  return keys.filter((value): value is string => value !== null)
}
