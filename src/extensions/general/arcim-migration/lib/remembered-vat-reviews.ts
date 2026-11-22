import type { SupabaseClient } from '@supabase/supabase-js'
import { SIEJobMappingsSchema } from '@/lib/api/schemas'
import type { AccountMapping } from '@/lib/import/types'

/** Null in the chart cannot distinguish BAS-standard from never reviewed. */
export function restoreReviewedBasDefaults(
  mappings: AccountMapping[], previous: AccountMapping[],
): AccountMapping[] {
  const bySource = new Map(previous.map(row => [row.sourceAccount, row]))
  return mappings.map(mapping => {
    const saved = bySource.get(mapping.sourceAccount)
    if (!saved?.vatTreatmentReviewed || saved.defaultVatTreatment !== null
      || (saved.defaultVatRate != null && saved.defaultVatRate !== 0) || mapping.providerVatTreatment
      || mapping.sourceAccount !== mapping.targetAccount
      || saved.targetAccount !== mapping.targetAccount
      || saved.sourceName !== mapping.sourceName) return mapping
    return { ...mapping, defaultVatTreatment: null, defaultVatRate: saved.defaultVatRate ?? null,
      vatTreatmentReviewed: true, vatTreatmentSuggested: false, requiresVatTreatmentReview: true }
  })
}

/** Use a completed import, never an abandoned review, failed job or undone run. */
export async function rememberCompletedVatReviews(
  supabase: SupabaseClient, companyId: string, mappings: AccountMapping[],
): Promise<AccountMapping[]> {
  const { data, error } = await supabase.from('sie_imports')
    .select('manifest').eq('company_id', companyId).eq('job_state', 'completed')
    .order('created_at', { ascending: false }).order('id', { ascending: false })
    .limit(1).maybeSingle()
  if (error) throw error
  const previous = SIEJobMappingsSchema.safeParse(data?.manifest?.input?.mappings)
  return previous.success ? restoreReviewedBasDefaults(mappings, previous.data) : mappings
}
