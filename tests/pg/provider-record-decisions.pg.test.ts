import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { getClient } from './setup'

it('applies or ignores individual records, preserves accounting evidence and remembers source versions', async () => {
  const client = await getClient()
  try {
    await expect(client.query(readFileSync(fileURLToPath(new URL('./sql/provider-record-decisions.sql', import.meta.url)), 'utf8'))).resolves.toBeDefined()
  } finally { await client.query('ROLLBACK'); client.release() }
})
