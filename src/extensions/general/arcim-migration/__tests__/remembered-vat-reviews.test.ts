import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccountMapping } from '@/lib/import/types'
import { enrichAccountMappingsWithVat } from '@/lib/import/account-vat-treatment'
import type { BASAccount } from '@/types'
import { rememberCompletedVatReviews, restoreReviewedBasDefaults } from '../lib/remembered-vat-reviews'
import { canSkipMappingStep } from '../lib/mapping-step'

const row = (extra: Partial<AccountMapping> = {}): AccountMapping => ({
  sourceAccount: '3071', targetAccount: '3071', sourceName: 'Förutbetalda intäkter',
  targetName: 'Förutbetalda intäkter', confidence: 1, matchType: 'manual', isOverride: true, ...extra,
})
const reviewed = row({ defaultVatTreatment: null, defaultVatRate: null, vatTreatmentReviewed: true })

describe('remembered BAS-standard reviews', () => {
  it('skips repeated review even with new vouchers after the full wizard enrichment', () => {
    const restored = restoreReviewedBasDefaults([row()], [reviewed])
    const enriched = enrichAccountMappingsWithVat(restored, [])
    expect(enriched[0]).toMatchObject({ defaultVatTreatment: null, vatTreatmentReviewed: true })
    expect(canSkipMappingStep(enriched, { unmapped: 0, fileStatuses: [{ delta: { added: 1 } }] })).toBe(true)
  })

  it('remembers BAS-standard with an explicit zero rate such as rounding account 3740', () => {
    const restored = restoreReviewedBasDefaults([row()], [{ ...reviewed, defaultVatRate: 0 }])
    expect(enrichAccountMappingsWithVat(restored, [])[0]).toMatchObject({
      defaultVatTreatment: null, defaultVatRate: 0, vatTreatmentReviewed: true,
    })
  })

  it.each([
    { vatTreatmentReviewed: false },
    { defaultVatTreatment: undefined },
    { targetAccount: '3099' },
    { sourceName: 'Ändrad kontobeskrivning' },
    { defaultVatRate: 25 },
  ] satisfies Partial<AccountMapping>[])('does not reuse an unconfirmed or changed answer: %j', extra => {
    const current = row()
    expect(restoreReviewedBasDefaults([current], [{ ...reviewed, ...extra }])[0]).toBe(current)
  })

  it('shows new accounts and changed provider VAT codes for review', () => {
    const current = row({ providerVatTreatment: 'standard_25' })
    expect(restoreReviewedBasDefaults([current], [reviewed])[0]).toBe(current)
    expect(enrichAccountMappingsWithVat(restoreReviewedBasDefaults([row()], []), [])[0].vatTreatmentReviewed).toBe(false)
  })

  it('keeps the current company chart override ahead of the earlier BAS answer', () => {
    const result = enrichAccountMappingsWithVat(restoreReviewedBasDefaults([row()], [reviewed]),
      [{ account_number: '3071', default_vat_treatment: 'standard_25', default_vat_rate: 25 } as BASAccount])
    expect(result[0]).toMatchObject({ defaultVatTreatment: 'standard_25', defaultVatRate: 25, vatTreatmentReviewed: true })
  })

  it('reads only the company latest completed import and reuses its persisted review', async () => {
    const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { manifest: { input: { mappings: [reviewed] } } }, error: null }) }
    const db = { from: vi.fn(() => query) } as unknown as SupabaseClient
    expect((await rememberCompletedVatReviews(db, 'company-1', [row()]))[0].vatTreatmentReviewed).toBe(true)
    expect(query.eq.mock.calls).toEqual([['company_id', 'company-1'], ['job_state', 'completed']])
    expect(query.limit).toHaveBeenCalledWith(1)
  })

  it('falls back to normal review for legacy imports with no mapping snapshot', async () => {
    const query = { select: () => query, eq: () => query, order: () => query, limit: () => query,
      maybeSingle: async () => ({ data: { manifest: {} }, error: null }) }
    const db = { from: () => query } as unknown as SupabaseClient
    const current = [row()]
    expect(await rememberCompletedVatReviews(db, 'company-1', current)).toBe(current)
  })
})
