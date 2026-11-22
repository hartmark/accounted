import { beforeEach, expect, it, vi } from 'vitest'
import type { ExtensionContext } from '@/lib/extensions/types'
import { createMockSupabase } from '@/tests/helpers'
import { sealMigrationPayload } from '@/lib/providers/migration-payload'
const { resolve, download } = vi.hoisted(() => ({ resolve: vi.fn(), download: vi.fn() }))
vi.mock('@/lib/providers/resolve-consent', () => ({ resolveConsent: resolve }))
vi.mock('@/lib/providers/bokio/client', () => ({ BokioClient: class { getBytes = download } }))
import { readMigrationVatDocument } from '../migration-vat-document'
const id = '5c4da29a-b51a-44ef-9705-fcf437d6c658'
const request = () => new Request('http://localhost/document?jobId=' + id + '&recordId=' + id)
function setup() {
  const mock = createMockSupabase()
  return { ...mock, ctx: { supabase: mock.supabase, companyId: 'company', userId: 'user', log: { warn: vi.fn() } } as unknown as ExtensionContext }
}
const record = (refs = [{ id }]) => ({ payload: sealMigrationPayload({ _raw: { uploadRefs: refs } }).payload,
  migration_jobs: { provider: 'bokio', consent_id: id } })
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', 'migration-document-test')
  resolve.mockResolvedValue({ consent: { provider: 'bokio' }, accessToken: 'private', providerCompanyId: 'provider-company' })
  download.mockResolvedValue({ bytes: new TextEncoder().encode('%PDF-1.7 original').buffer })
})
it('validates query identifiers', async () => {
  expect((await readMigrationVatDocument(new Request('http://localhost/document'), setup().ctx)).status).toBe(400)
})
it('does not fetch an unknown or foreign record', async () => {
  const { ctx, mockResult } = setup(); mockResult({ data: null })
  expect((await readMigrationVatDocument(request(), ctx)).status).toBe(404)
  expect(download).not.toHaveBeenCalled()
})
it('reads only the single original attachment in the tenant source snapshot', async () => {
  const { ctx, mockResult } = setup(); mockResult({ data: record() })
  const response = await readMigrationVatDocument(request(), ctx)
  expect(response.status).toBe(200)
  expect(response.headers.get('Content-Type')).toBe('application/pdf')
  expect(response.headers.get('Cache-Control')).toContain('no-store')
  expect(resolve).toHaveBeenCalledWith('company', id)
  expect(download).toHaveBeenCalledWith('private', 'provider-company', '/uploads/' + id + '/download')
})
it('keeps multiple or absent attachments explicit instead of picking an arbitrary file', async () => {
  for (const refs of [[], [{ id }, { id }]]) {
    const { ctx, mockResult } = setup(); mockResult({ data: record(refs) })
    expect((await readMigrationVatDocument(request(), ctx)).status).toBe(404)
  }
  expect(download).not.toHaveBeenCalled()
})
it('does not serve executable content returned as an attachment', async () => {
  const { ctx, mockResult } = setup(); mockResult({ data: record() })
  download.mockResolvedValue({ bytes: new TextEncoder().encode('<html>bad</html>').buffer })
  expect((await readMigrationVatDocument(request(), ctx)).status).toBe(409)
})
