import { SIE_LIMITS } from '@/lib/import/sie-job-contract'

/** One bounded request can still carry a company's full recent migration history. */
export const SIE_REQUEST_LIMITS = {
  years: 32,
  bytes: 64 * 1024 * 1024,
  fileBytes: SIE_LIMITS.fileBytes,
  durationMs: 240_000,
} as const

/** An explicit refusal: never report an oversized or partial selection as a complete export. */
export class SieRequestLimitError extends Error {
  constructor(readonly field: 'years' | 'bytes', readonly limit: number) {
    super(`SIE request exceeds ${field} limit ${limit}`)
    this.name = 'SieRequestLimitError'
  }
}
