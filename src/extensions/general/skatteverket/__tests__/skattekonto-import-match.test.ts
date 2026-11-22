import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { suggestions, match } = vi.hoisted(() => ({ suggestions: vi.fn(), match: vi.fn() }))
vi.mock('../lib/skattekonto-match', () => ({ findMatchSuggestionsBulk: suggestions }))
vi.mock('@/lib/reconciliation/actions', () => ({ matchPairs: match }))

import { matchImportedSkattekonto } from '../lib/skattekonto-import-match'

const COMPANY = 'company-1'
const USER = 'user-1'
const row = (id: string) => ({
  id, transaktionsdatum: '2026-05-12', transaktionstext: 'Inbetalning',
  belopp_skatteverket: 100, journal_entry_id: null,
})
const candidate = (entry: string) => ({ journal_entry_id: entry })
const run = (db: ReturnType<typeof createQueuedMockSupabase>) =>
  matchImportedSkattekonto(db.supabase as never, COMPANY, USER)

beforeEach(() => {
  vi.clearAllMocks()
  suggestions.mockResolvedValue(new Map())
  match.mockImplementation(async (_db, _company, _user, _key, input) => ({
    applied: input.pairs.flatMap((p: { external_ids: string[]; journal_entry_ids: string[] }) =>
      p.external_ids.map(id => ({ external_id: id, journal_entry_id: p.journal_entry_ids[0] }))),
    skipped: [],
  }))
})

describe('matchImportedSkattekonto', () => {
  it('does nothing on an empty or repeated completed run', async () => {
    const db = createQueuedMockSupabase()
    db.enqueue({ data: [] })
    expect(await run(db)).toEqual({ considered: 0, linked: 0, skipped: 0, failed: false })
    expect(suggestions).not.toHaveBeenCalled()
    expect(match).not.toHaveBeenCalled()
  })

  it('links only posted imported targets using the existing guarded service', async () => {
    const db = createQueuedMockSupabase()
    db.enqueue({ data: [row('one'), row('manual'), row('draft'), row('ambiguous')] })
    suggestions.mockResolvedValue(new Map([
      ['one', candidate('imported')], ['manual', candidate('manual-entry')], ['draft', candidate('draft-entry')],
    ]))
    db.enqueue({ data: [{ id: 'imported' }] })
    expect(await run(db)).toEqual({ considered: 4, linked: 1, skipped: 0, failed: false })
    expect(db.findCalls('journal_entries', 'eq')).toEqual([
      ['company_id', COMPANY], ['status', 'posted'], ['source_type', 'import'],
    ])
    expect(db.findCalls('skattekonto_transactions', 'eq')).toContainEqual(['company_id', COMPANY])
    expect(db.findCalls('skattekonto_transactions', 'eq')).toContainEqual(['status', 'booked'])
    expect(db.findCalls('skattekonto_transactions', 'eq')).toContainEqual(['is_ignored', false])
    expect(db.findCalls('skattekonto_transactions', 'is')).toContainEqual(['journal_entry_id', null])
    expect(match).toHaveBeenCalledWith(db.supabase, COMPANY, USER, 'skattekonto', {
      pairs: [{ external_ids: ['one'], journal_entry_ids: ['imported'] }],
    })
  })

  it('normalizes numeric strings from PostgREST before matching', async () => {
    const db = createQueuedMockSupabase()
    db.enqueue({ data: [{ ...row('one'), belopp_skatteverket: '100.25' }] })
    await run(db)
    expect(suggestions).toHaveBeenCalledWith(db.supabase, COMPANY, [
      expect.objectContaining({ id: 'one', belopp_skatteverket: 100.25 }),
    ])
  })

  it('keeps uncertain matches open and never invokes a write', async () => {
    const db = createQueuedMockSupabase()
    db.enqueue({ data: [row('uncertain')] })
    expect(await run(db)).toMatchObject({ linked: 0, failed: false })
    expect(db.findCalls('journal_entries', 'select')).toHaveLength(0)
    expect(match).not.toHaveBeenCalled()
  })

  it('links complete combined matches together and leaves incomplete groups open', async () => {
    const db = createQueuedMockSupabase()
    db.enqueue({ data: [row('tax'), row('fee'), row('incomplete')] })
    suggestions.mockResolvedValue(new Map([
      ['tax', { ...candidate('agi'), combined_with: [{ id: 'fee' }] }],
      ['fee', { ...candidate('agi'), combined_with: [{ id: 'tax' }] }],
      ['incomplete', { ...candidate('other'), combined_with: [{ id: 'missing' }] }],
    ]))
    db.enqueue({ data: [{ id: 'agi' }, { id: 'other' }] })
    expect(await run(db)).toMatchObject({ linked: 2, failed: false })
    expect(match).toHaveBeenCalledExactlyOnceWith(db.supabase, COMPANY, USER, 'skattekonto', {
      pairs: [{ external_ids: ['tax', 'fee'], journal_entry_ids: ['agi'] }],
    })
  })

  it('bounds write batches and reads every open row through pagination', async () => {
    const db = createQueuedMockSupabase()
    const rows = Array.from({ length: 1000 }, (_, i) => row('r' + i))
    db.enqueue({ data: rows })
    db.enqueue({ data: [row('last')] })
    suggestions.mockResolvedValue(new Map(rows.slice(0, 26).map(r => [r.id, candidate('e' + r.id)])))
    db.enqueue({ data: rows.slice(0, 26).map(r => ({ id: 'e' + r.id })) })
    expect(await run(db)).toMatchObject({ considered: 1001, linked: 26, failed: false })
    expect(db.findCalls('skattekonto_transactions', 'range')).toEqual([[0, 999], [1000, 1999]])
    expect(match.mock.calls.map(c => c[4].pairs.length)).toEqual([25, 1])
  })

  it('reports race refusals without forcing links or allowing a remainder', async () => {
    const db = createQueuedMockSupabase()
    db.enqueue({ data: [row('one')] })
    suggestions.mockResolvedValue(new Map([['one', candidate('entry')]]))
    db.enqueue({ data: [{ id: 'entry' }] })
    match.mockResolvedValueOnce({ applied: [], skipped: [{ pair: { external_ids: ['one'] } }] })
    expect(await run(db)).toMatchObject({ linked: 0, skipped: 1, failed: false })
    expect(match.mock.calls[0][4].pairs[0]).not.toHaveProperty('allow_remainder')
  })

  it('fails closed if imported-target eligibility cannot be read', async () => {
    const db = createQueuedMockSupabase()
    db.enqueue({ data: [row('one')] })
    suggestions.mockResolvedValue(new Map([['one', candidate('entry')]]))
    db.enqueue({ error: { message: 'target read unavailable' } })
    expect(await run(db)).toMatchObject({ linked: 0, failed: true })
    expect(match).not.toHaveBeenCalled()
  })

  it('keeps import usable on a failed read or link operation', async () => {
    const db = createQueuedMockSupabase()
    db.enqueue({ error: { message: 'database unavailable' } })
    expect(await run(db)).toMatchObject({ linked: 0, failed: true })
    expect(match).not.toHaveBeenCalled()
    db.enqueue({ data: [row('one')] })
    suggestions.mockResolvedValue(new Map([['one', candidate('entry')]]))
    db.enqueue({ data: [{ id: 'entry' }] })
    match.mockRejectedValueOnce(new Error('temporary link failure'))
    expect(await run(db)).toMatchObject({ linked: 0, failed: true })
  })
})
