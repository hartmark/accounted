import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { chunk } from '@/lib/utils'
import { matchPairs, type ReconciliationPair } from '@/lib/reconciliation/actions'
import { findMatchSuggestionsBulk } from './skattekonto-match'

const log = createLogger('skattekonto-import-match')

interface OpenRow {
  id: string
  transaktionsdatum: string
  transaktionstext: string
  belopp_skatteverket: number | string
  journal_entry_id: null
}

export interface ImportedTaxMatchResult {
  considered: number
  linked: number
  skipped: number
  failed: boolean
}

/**
 * Connect settled SKV events to unambiguous, already posted SIE imports.
 * Called after import and after SKV sync, so either arrival order works.
 * Uses the regular matcher and guarded link service; never books, ignores,
 * accepts a remainder or touches a voucher. Ambiguous rows remain open.
 * Repeating a completed run finds no open rows to link again.
 */
export async function matchImportedSkattekonto(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
): Promise<ImportedTaxMatchResult> {
  const result: ImportedTaxMatchResult = { considered: 0, linked: 0, skipped: 0, failed: false }
  try {
    const rows = await fetchAllRows<OpenRow>(({ from, to }) => supabase
      .from('skattekonto_transactions')
      .select('id,transaktionsdatum,transaktionstext,belopp_skatteverket,journal_entry_id')
      .eq('company_id', companyId).eq('status', 'booked').eq('is_ignored', false)
      .is('journal_entry_id', null)
      .order('transaktionsdatum').order('id').range(from, to),
    { dedupeBy: row => row.id })
    result.considered = rows.length
    if (!rows.length) return result

    const suggestions = await findMatchSuggestionsBulk(supabase, companyId,
      rows.map(row => ({ ...row, belopp_skatteverket: Number(row.belopp_skatteverket) })))
    const imported = new Set<string>()
    const targets = [...new Set([...suggestions.values()].map(s => s.journal_entry_id))]
    for (const ids of chunk(targets, 100)) {
      const { data, error } = await supabase.from('journal_entries').select('id')
        .eq('company_id', companyId).eq('status', 'posted').eq('source_type', 'import').in('id', ids)
      if (error) throw new Error(error.message)
      for (const entry of data ?? []) imported.add(entry.id)
    }

    const pairs: ReconciliationPair[] = []
    const assigned = new Set<string>()
    for (const row of rows) {
      if (assigned.has(row.id)) continue
      const suggestion = suggestions.get(row.id)
      if (!suggestion || !imported.has(suggestion.journal_entry_id)) continue
      const ids = [row.id, ...(suggestion.combined_with ?? []).map(other => other.id)]
      // Only complete, consistent groups from this exact matcher run.
      if (ids.some(id => assigned.has(id) ||
        suggestions.get(id)?.journal_entry_id !== suggestion.journal_entry_id)) continue
      pairs.push({ external_ids: ids, journal_entry_ids: [suggestion.journal_entry_id] })
      ids.forEach(id => assigned.add(id))
    }
    for (const batch of chunk(pairs, 25)) {
      const linked = await matchPairs(supabase, companyId, userId, 'skattekonto', { pairs: batch })
      if (!linked) throw new Error('Skattekonto account unavailable')
      result.linked += linked.applied.length
      result.skipped += linked.skipped.reduce((n, skip) => n + skip.pair.external_ids.length, 0)
    }
    if (result.linked || result.skipped) {
      log.info('imported skattekonto events matched', { companyId, ...result })
    }
  } catch (error) {
    result.failed = true
    log.warn('imported skattekonto matching deferred', {
      companyId, ...result, message: error instanceof Error ? error.message : String(error),
    })
  }
  return result
}
