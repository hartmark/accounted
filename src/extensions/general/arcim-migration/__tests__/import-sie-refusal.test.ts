/**
 * POST /import-sie must answer a refusal from the SIE job RPCs with the same
 * structured code the manual upload route gives it. Wrapped as
 * SIE_IMPORT_UNEXPECTED (500, "The import outcome could not be confirmed") a
 * re-import of a year that already held an import reached the migration
 * wizard as an unknown outcome, although the RPC had refused and rolled back:
 * nine times for six users since 2026-09-14, one of them retrying twice.
 *
 * The refusals are built by the real jobDatabaseError, so these tests pin the
 * mapping from the raised sentence and SQLSTATE as well as the route.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

vi.mock('@/lib/import/sie-resync', () => ({ planSIEResync: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

vi.mock('@/lib/import/sie-import', () => ({ loadMappings: vi.fn(), generateImportPreview: vi.fn() }))
vi.mock('@/lib/import/sie-jobs', async (load) => ({
  ...await load<typeof import('@/lib/import/sie-jobs')>(),
  submitSIEJob: vi.fn(),
}))
vi.mock('next/server', async (load) => ({ ...await load<typeof import('next/server')>(), after: vi.fn() }))
vi.mock('@/lib/import/sie-job-worker', () => ({ runSIEWorker: vi.fn() }))

import { arcimMigrationExtension } from '../index'
import { submitSIEJob, jobDatabaseError, SIEJobDatabaseError } from '@/lib/import/sie-jobs'
import { liveCorrectionSentence } from '@/lib/import/sie-live-corrections'
import { userFacing } from '@/lib/errors/user-facing'
import { memoryIntakeStorage, intakePath } from './intake-storage'
import { createClient } from '@/lib/supabase/server'
import { planSIEResync } from '@/lib/import/sie-resync'


type RouteHandler = (request: Request, ctx?: ExtensionContext) => Promise<Response>
const handler = (arcimMigrationExtension.apiRoutes ?? []).find(
  (r) => r.method === 'POST' && r.path === '/import-sie',
)!.handler as RouteHandler

const SIE = [
  '#FLAGGA 0', '#SIETYP 4', '#FNAMN "Migrerad AB"', '#RAR 0 20260101 20261231',
  '#KONTO 1930 "Företagskonto"', '#KONTO 3001 "Försäljning"',
  '#VER A 1 20260115 "Sale"', '{', '#TRANS 1930 {} 100.00', '#TRANS 3001 {} -100.00', '}',
].join('\n')
const MAPPINGS = [
  { sourceAccount: '1930', sourceName: 'Företagskonto', targetAccount: '1930' },
  { sourceAccount: '3001', sourceName: 'Försäljning', targetAccount: '3001' },
]
const PATH = intakePath('company-1')
const BODY = { storagePath: PATH, filename: 'migration-sie-2026.se', mappings: MAPPINGS, options: { createFiscalPeriod: true, importOpeningBalances: true, importTransactions: true } }

type Envelope = { error: { code: string; message: string; message_en: string; requestId?: string } }

// The dispatcher's context: the signed-in user, their company and client.
const ctx = {
  supabase: { storage: memoryIntakeStorage({ [PATH]: SIE }).storage },
  companyId: 'company-1',
  userId: 'user-1',
  requestId: 'req-9',
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
} as unknown as ExtensionContext
const post = (body: Record<string, unknown>) => handler(
  createMockRequest('http://localhost/api/extensions/ext/arcim-migration/import-sie', { method: 'POST', body }), ctx)

describe('POST /import-sie: job refusals', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(planSIEResync).mockResolvedValue(null)

  })

  it('400 without the storage path or mappings', async () => {
    const response = await post({ options: {} })
    expect(response.status).toBe(400)
    expect(submitSIEJob).not.toHaveBeenCalled()
  })

  it('409 SIE_IMPORT_PERIOD_ALREADY_IMPORTED when the year already holds an import', async () => {
    ;(submitSIEJob as Mock).mockRejectedValueOnce(jobDatabaseError({
      code: '55000', message: 'Existing SIE import requires reviewed replacement or reconciliation',
    }))
    const { status, body } = await parseJsonResponse<Envelope>(await post(BODY))
    expect(status).toBe(409)
    expect(body.error).toMatchObject({ code: 'SIE_IMPORT_PERIOD_ALREADY_IMPORTED', requestId: 'req-9' })
    expect(body.error.message).toContain('importhistoriken')
    expect(body.error.message).not.toContain('kunde inte bekräftas')
  })

  // 2026-11-11: the same fetched year submitted again after a mapping or an
  // option changed. As a bare CONFLICT it read "En konflikt uppstod. Ladda om
  // sidan och försök igen", and a reload never helps.
  it('409 with its own sentence when the same file is retried with another mapping or other options', async () => {
    ;(submitSIEJob as Mock).mockRejectedValueOnce(jobDatabaseError({
      code: '23505', message: 'SIE retry has different mapping or options',
    }))
    const { status, body } = await parseJsonResponse<Envelope>(await post(BODY))
    expect(status).toBe(409)
    expect(body.error.code).toBe('SIE_IMPORT_PERIOD_ALREADY_IMPORTED')
    expect(body.error.message).toBe('Den här filen har redan en import för räkenskapsåret, med en annan kontomappning eller andra ' +
      'inställningar än de du valde nu. Ska filen läsas in med de nya valen: öppna importhistoriken och ångra den tidigare importen först.')
  })

  it('keeps CONFLICT for any other unique violation', () => {
    expect(jobDatabaseError({ code: '23505', message: 'duplicate key value violates unique constraint "x"' }).code).toBe('CONFLICT')
  })

  // 2026-11-12: Fortnox's first year started 2026-09-21, the company's
  // 2026-10-05. ensureFiscalPeriod's sentence says what to change; wrapped as
  // SIE_IMPORT_UNEXPECTED the wizard got a 500 "kunde inte bekräftas".
  it('400 with the sentence when the file\'s fiscal year overlaps a company year without matching it', async () => {
    const sentence = 'SIE-filens räkenskapsår (2026-09-21 till 2027-12-31) överlappar men matchar inte ett befintligt räkenskapsår i Accounted ' +
      '(Första räkenskapsåret 2026/2027: 2026-10-05 till 2027-12-31). Justera räkenskapsåret i Inställningar → Företag så att det matchar ' +
      'SIE-filen exakt, eller importera en SIE-fil som täcker exakt samma period.'
    ;(submitSIEJob as Mock).mockRejectedValueOnce(userFacing(new Error(sentence)))
    const { status, body } = await parseJsonResponse<Envelope>(await post(BODY))
    expect(status).toBe(400)
    expect(body.error.message).toBe(sentence)
    expect(body.error.code).not.toBe('SIE_IMPORT_UNEXPECTED')
    expect(ctx.log.error).not.toHaveBeenCalled()
  })

  it('still answers an unexpected failure as SIE_IMPORT_UNEXPECTED', async () => {
    ;(submitSIEJob as Mock).mockRejectedValueOnce(new Error('socket hang up'))
    const { status, body } = await parseJsonResponse<Envelope>(await post(BODY))
    expect(status).toBe(500)
    expect(body.error.code).toBe('SIE_IMPORT_UNEXPECTED')
  })

  it('409 SIE_IMPORT_LEGACY_REVIEW_REQUIRED when the year to replace is a legacy import', async () => {
    ;(submitSIEJob as Mock).mockRejectedValueOnce(jobDatabaseError({
      code: '55000', message: 'Legacy SIE import requires reviewed reconciliation before replacement',
    }))
    const { status, body } = await parseJsonResponse<Envelope>(await post({ ...BODY, options: { ...BODY.options, supersedesImportId: 'import-0' } }))
    expect(status).toBe(409)
    expect(body.error.code).toBe('SIE_IMPORT_LEGACY_REVIEW_REQUIRED')
  })

  // PH 223: the year to replace had verifikat corrected after its import. The
  // migration showed "En konflikt uppstod. Ladda om sidan och försök igen."
  // with code CONFLICT; a retry never helps.
  it('409 SIE_IMPORT_HAS_LIVE_CORRECTION with the sentence that names the verifikat', async () => {
    const sentence = liveCorrectionSentence([{ original: 'D980', correction: 'D1471' }], 'replace')
    ;(submitSIEJob as Mock).mockRejectedValueOnce(userFacing(
      new SIEJobDatabaseError(sentence, 'SIE_IMPORT_HAS_LIVE_CORRECTION', '55000'), 'SIE_IMPORT_HAS_LIVE_CORRECTION'))
    const { status, body } = await parseJsonResponse<Envelope>(await post({ ...BODY, options: { ...BODY.options, supersedesImportId: 'import-0' } }))
    expect(status).toBe(409)
    expect(body.error).toMatchObject({ code: 'SIE_IMPORT_HAS_LIVE_CORRECTION', message: sentence, requestId: 'req-9' })
  })

  it('409 CONFLICT for any other guard, never the existing-import sentence', async () => {
    ;(submitSIEJob as Mock).mockRejectedValueOnce(jobDatabaseError({
      code: '55000', message: 'Fiscal period is locked or closed',
    }))
    const { status, body } = await parseJsonResponse<Envelope>(await post(BODY))
    expect(status).toBe(409)
    expect(body.error.code).toBe('CONFLICT')
  })

  it('409 SIE_IMPORT_UNFINISHED while another import of the company is not finished, never the existing-import sentence', async () => {
    ;(submitSIEJob as Mock).mockRejectedValueOnce(jobDatabaseError({
      code: '55000', message: 'SIE import is unfinished: resume or undo it',
    }))
    const { status, body } = await parseJsonResponse<Envelope>(await post(BODY))
    expect(status).toBe(409)
    expect(body.error.code).toBe('SIE_IMPORT_UNFINISHED')
    expect(body.error.message).toMatch(/^En annan SIE-import för företaget är inte klar än\./)
  })

  it('503 TRANSIENT_ERROR for a lock that is not available: a retry, not an existing import', async () => {
    ;(submitSIEJob as Mock).mockRejectedValueOnce(jobDatabaseError({
      code: '55P03', message: 'could not obtain lock on row in relation "fiscal_periods"',
    }))
    const { status, body } = await parseJsonResponse<Envelope>(await post(BODY))
    expect(status).toBe(503)
    expect(body.error.code).toBe('TRANSIENT_ERROR')
    expect(body.error.message).toContain('försök igen')
  })

  it('keeps SIE_IMPORT_UNEXPECTED when the database never answered', async () => {
    ;(submitSIEJob as Mock).mockRejectedValueOnce(jobDatabaseError({ code: '', message: 'TypeError: fetch failed' }))
    const { status, body } = await parseJsonResponse<Envelope>(await post(BODY))
    expect(status).toBe(500)
    expect(body.error.code).toBe('SIE_IMPORT_UNEXPECTED')
  })

  it('202 with the import id when the job is accepted', async () => {
    ;(submitSIEJob as Mock).mockResolvedValueOnce({ id: 'import-1', job_state: 'queued' })
    const { status, body } = await parseJsonResponse<{ importId: string; state: string; statusUrl: string }>(await post(BODY))
    expect(status).toBe(202)
    expect(body).toMatchObject({ importId: 'import-1', state: 'queued', statusUrl: '/api/import/sie/import-1' })
    // 'provider_migration': the verifikat's commit label says how the books came in.
    expect(submitSIEJob).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', SIE, MAPPINGS,
      expect.objectContaining({ onExistingPeriod: 'block' }), expect.any(File), 'provider_migration',
      expect.objectContaining({ source: 'migration', via: 'provider_migration' }))
  })
  it.each([true, false])('preserves the explicit no-document choice in a new job: %s', async markImportedNoDocRequired => {
    vi.mocked(submitSIEJob).mockResolvedValueOnce({ id: 'new-import', job_state: 'queued' } as never)
    const response = await post({ ...BODY, options: { ...BODY.options, markImportedNoDocRequired } })
    expect(response.status).toBe(202)
    expect(submitSIEJob).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', SIE, MAPPINGS,
      expect.objectContaining({ markImportedNoDocRequired }), expect.any(File), 'provider_migration', expect.objectContaining({source:'migration'}))
  })

  it('does not mark existing vouchers during a no-addition resync even with the choice enabled', async () => {
    vi.mocked(planSIEResync).mockResolvedValueOnce({ periodId: 'period', added: 0, unchanged: 12,
      reviewCount: 0, reviews: [], metadataChanged: false, newOrdinals: [] })
    const response = await post({ ...BODY, options: { ...BODY.options, markImportedNoDocRequired: true } })
    expect(response.status).toBe(200)
    expect(submitSIEJob).not.toHaveBeenCalled()
  })

  it('ignores an older client replacement request and admits only incremental additions', async () => {
    vi.mocked(planSIEResync).mockResolvedValueOnce({periodId:'period',added:1,unchanged:12,reviewCount:0,reviews:[],metadataChanged:false,newOrdinals:[12]})
    vi.mocked(submitSIEJob).mockResolvedValueOnce({id:'delta-1',job_state:'queued'} as never)
    const {status}=await parseJsonResponse(await post({...BODY,options:{...BODY.options,supersedesImportId:'old-import'}}))
    expect(status).toBe(202)
    expect(submitSIEJob).toHaveBeenCalledWith(expect.anything(),'company-1','user-1',expect.any(String),expect.any(Array),
      expect.objectContaining({onExistingPeriod:'incremental',importOpeningBalances:false,importTransactions:true,supersedesImportId:undefined}),expect.any(File),'provider_migration',expect.objectContaining({source:'migration'}))
  })

  it('resolves a SIE4I file without RAR before planning its incremental comparison', async () => {
    const period = { period_start: '2026-01-01', period_end: '2026-12-31' }
    const bounds = { select: vi.fn(), eq: vi.fn(), lte: vi.fn(), gte: vi.fn(), limit: vi.fn() }
    bounds.select.mockReturnValue(bounds)
    bounds.eq.mockReturnValue(bounds)
    bounds.lte.mockReturnValue(bounds)
    bounds.gte.mockReturnValue(bounds)
    Object.assign(bounds,{order:vi.fn().mockResolvedValue({data:[period],error:null})})
    const oldStorage=ctx.supabase
    Object.assign(ctx,{supabase:{storage:memoryIntakeStorage({[PATH]:SIE.replace('#RAR 0 20260101 20261231\n','')}).storage,from:vi.fn().mockReturnValue(bounds)}})
    vi.mocked(planSIEResync).mockResolvedValueOnce({ periodId: 'period', added: 0, unchanged: 1,
      reviewCount: 0, reviews: [], metadataChanged: false, newOrdinals: [] })

    const { status, body } = await parseJsonResponse<{ result: { details: { fiscalYear: { start: string; end: string } } } }>(
      await post({ ...BODY, rawContent: SIE.replace('#RAR 0 20260101 20261231\n', '') }),
    )

    expect(status).toBe(200)
    expect(bounds.eq).toHaveBeenCalledWith('company_id', 'company-1')
    expect(vi.mocked(planSIEResync).mock.calls[0][3].stats).toMatchObject({
      fiscalYearStart: period.period_start, fiscalYearEnd: period.period_end,
    })
    expect(body.result.details.fiscalYear).toEqual({ start: period.period_start, end: period.period_end })
    expect(submitSIEJob).not.toHaveBeenCalled()
  })

  it('returns current reviews without admitting a job when there are no additions', async () => {
    vi.mocked(planSIEResync).mockResolvedValueOnce({periodId:'closed-period',added:0,unchanged:12,reviewCount:1,
      reviews:[{sourceId:'A2',kind:'changed',entryId:'posted'}],metadataChanged:false,newOrdinals:[]})
    const {status,body}=await parseJsonResponse<{result:{resync:{reviewCount:number};journalEntriesCreated:number}}>(await post(BODY))
    expect(status).toBe(200)
    expect(body.result).toMatchObject({journalEntriesCreated:0,resync:{unchanged:12,reviewCount:1}})
    expect(submitSIEJob).not.toHaveBeenCalled()
  })

})
