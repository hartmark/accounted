import { describe, it, expect } from 'vitest'
import { compareMigrationFields, compareMigrationInvoiceItems } from '../migration-field-differences'

describe('migration field differences', () => {
  it('shows source on the left and actual Accounted values on the right', () => {
    expect(compareMigrationFields({status:'paid',paid_amount:1499,remaining_amount:0},
      {status:'registered',paid_amount:0,remaining_amount:'1499'},['status','paid_amount','remaining_amount']))
      .toEqual([{field:'status',source:'paid',accounted:'registered'},
        {field:'paid_amount',source:1499,accounted:0},{field:'remaining_amount',source:0,accounted:'1499'}])
  })
  it('ignores equal numerics, empty values and equivalent timestamps', () => {
    expect(compareMigrationFields({total:1499,notes:null,paid_at:'2026-11-12T00:00:00Z'},
      {total:'1499.00',notes:'',paid_at:'2026-11-12T00:00:00+00:00'},['total','notes','paid_at'])).toEqual([])
  })
  it('does not publish unrelated or missing source fields', () => {
    expect(compareMigrationFields({notes:'Changed',personal_number:'secret'},
      {notes:'Original',due_date:'2026-12-01'},['notes','due_date']))
      .toEqual([{field:'notes',source:'Changed',accounted:'Original'}])
  })
  it.each([
    ['tim', 'hour'], ['st', 'piece'], ['min', 'minute'], ['dag', 'day'],
    ['månad', 'month'], ['år', 'year'], ['kg', 'kilogram'],
  ])('compares the Bokio unit %s with its legacy enum %s as equal', (current, legacy) => {
    expect(compareMigrationFields({unit:current},{unit:legacy},['unit'],1,'bokio')).toEqual([])
  })
  it('keeps real units, custom units and quantity changes reviewable', () => {
    expect(compareMigrationFields({unit:'tim',quantity:2},{unit:'hour',quantity:1},['unit','quantity'],1,'bokio'))
      .toEqual([{field:'quantity',source:2,accounted:1,line:1}])
    expect(compareMigrationFields({unit:'tim'},{unit:'day'},['unit'],1,'bokio'))
      .toEqual([{field:'unit',source:'tim',accounted:'day',line:1}])
    expect(compareMigrationFields({unit:''},{unit:'custom'},['unit'],1,'bokio')).toHaveLength(1)
    expect(compareMigrationFields({unit:'tim'},{unit:'hour'},['unit'],1,'fortnox')).toHaveLength(1)
  })
  it('identifies a changed invoice line', () => {
    expect(compareMigrationFields({description:'New',quantity:2},{description:'Old',quantity:1},['description','quantity'],3))
      .toEqual([{field:'description',source:'New',accounted:'Old',line:3},{field:'quantity',source:2,accounted:1,line:3}])
  })
})

describe('Bokio invoice row order', () => {
  const charged = {description:'Utveckling',quantity:106,unit:'tim',unit_price:1000,line_total:106000,vat_rate:25,vat_amount:26500,account_number:'3041'}
  const note = {description:'Fakturan för december är inte betald',quantity:0,unit:'st',unit_price:0,line_total:0,vat_rate:0,vat_amount:0,account_number:null}
  const legacy = {...charged,unit:'hour',quantity:'106',line_total:'106000.00'}
  it('recognizes the same charged and description rows in reverse order without rewriting them', () => {
    expect(compareMigrationInvoiceItems([charged,note],[note,legacy],'bokio')).toEqual([])
  })
  it('preserves changed amounts even when rows are reordered', () => {
    const differences=compareMigrationInvoiceItems([charged,note],[note,{...legacy,line_total:107000}],'bokio')
    expect(differences.some(diff=>diff.field==='line_total')).toBe(true)
  })
  it('preserves changed descriptions, account numbers, VAT and units', () => {
    for (const patch of [{description:'Other'},{account_number:'3001'},{vat_amount:26000},{unit:'dag'}]) {
      expect(compareMigrationInvoiceItems([charged,note],[note,{...legacy,...patch}],'bokio').length).toBeGreaterThan(0)
    }
  })
  it('counts duplicate occurrences instead of treating rows as a set', () => {
    expect(compareMigrationInvoiceItems([charged,charged,note],[note,legacy,note],'bokio').length).toBeGreaterThan(0)
    expect(compareMigrationInvoiceItems([charged,charged,note],[note,legacy,legacy],'bokio')).toEqual([])
  })
  it('preserves added and missing rows', () => {
    expect(compareMigrationInvoiceItems([charged,note],[legacy],'bokio').some(diff=>diff.field==='invoice_line')).toBe(true)
    expect(compareMigrationInvoiceItems([charged],[note,legacy],'bokio').some(diff=>diff.field==='invoice_line')).toBe(true)
  })
  it('does not change other providers row ordering rules', () => {
    expect(compareMigrationInvoiceItems([charged,note],[note,charged],'fortnox').length).toBeGreaterThan(0)
  })
})
