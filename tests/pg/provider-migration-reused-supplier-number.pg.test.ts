import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { getClient } from './setup'

/** Reused supplier references keep their printed value; source identity and full headers prevent duplicate adoption. */
it('retains reused supplier references and OCR while adopting existing matching headers', async () => {
  const client = await getClient()
  try {
    const sql = readFileSync(
      fileURLToPath(new URL('./sql/provider-migration-reused-supplier-number.sql', import.meta.url)),
      'utf8',
    )
    await expect(client.query(sql)).resolves.toBeDefined()
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
})
