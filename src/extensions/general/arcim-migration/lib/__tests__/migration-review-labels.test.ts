import { describe, it, expect } from 'vitest'

import { invoicePartyName, ownInvoiceNumber } from '../migration-job-routes'

/**
 * Review rows were labelled with Bokio's document UUID whenever the source
 * invoice carried no number of its own (Skatteverket payables): the label now
 * falls back to the supplier or customer name instead.
 */
describe('migration review labels', () => {
  const SOURCE = '102ef5fb-7927-453b-802c-e4cba8ebcdb4'

  it('keeps a real invoice number', () => {
    expect(ownInvoiceNumber({ invoiceNumber: '1630948303' }, SOURCE)).toBe('1630948303')
  })

  it('drops a number that is only the source document id, or empty', () => {
    expect(ownInvoiceNumber({ invoiceNumber: SOURCE }, SOURCE)).toBeUndefined()
    expect(ownInvoiceNumber({ invoiceNumber: '  ' }, SOURCE)).toBeUndefined()
    expect(ownInvoiceNumber(null, SOURCE)).toBeUndefined()
  })

  it('names the supplier on a supplier invoice and the customer on a sales invoice', () => {
    const invoice = { supplier: { name: 'Skatteverket' }, customer: { name: 'Kund AB' } }
    expect(invoicePartyName(invoice, 'supplierInvoices')).toBe('Skatteverket')
    expect(invoicePartyName(invoice, 'salesInvoices')).toBe('Kund AB')
    expect(invoicePartyName({ supplier: { name: '' } }, 'supplierInvoices')).toBeUndefined()
  })
})
