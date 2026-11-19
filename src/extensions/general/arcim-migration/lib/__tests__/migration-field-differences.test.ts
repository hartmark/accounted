import { describe, it, expect } from 'vitest'
import { compareMigrationFields } from '../migration-field-differences'

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
  it('identifies a changed invoice line', () => {
    expect(compareMigrationFields({description:'New',quantity:2},{description:'Old',quantity:1},['description','quantity'],3))
      .toEqual([{field:'description',source:'New',accounted:'Old',line:3},{field:'quantity',source:2,accounted:1,line:3}])
  })
})
