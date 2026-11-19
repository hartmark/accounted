export function ownInvoiceNumber(invoice: { invoiceNumber?: unknown } | null | undefined, sourceId: string): string | undefined {
  const value = typeof invoice?.invoiceNumber === 'string' ? invoice.invoiceNumber.trim() : ''
  return value && value !== sourceId ? value : undefined
}

/** The supplier's name on a supplier invoice, the customer's on a sales invoice. */
export function invoicePartyName(invoice: object | null | undefined, resource: string): string | undefined {
  const party = (invoice as Record<string, unknown> | null | undefined)?.[resource === 'supplierInvoices' ? 'supplier' : 'customer'] as { name?: unknown } | undefined
  const name = typeof party?.name === 'string' ? party.name.trim() : ''
  return name || undefined
}

