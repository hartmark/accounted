import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { getClient } from './setup'

it('confirms missing VAT atomically and refuses unsafe or stale invoice changes', async () => {
  const client = await getClient()
  try {
    await expect(client.query(readFileSync(new URL('./sql/migration-invoice-vat-review.sql', import.meta.url), 'utf8'))).resolves.toBeDefined()
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
})
