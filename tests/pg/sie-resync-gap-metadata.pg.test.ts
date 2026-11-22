import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { getClient } from './setup'

it('compares generated gap metadata without hiding actual source edits or writing journal entries', async () => {
  const client = await getClient()
  try {
    const sql = readFileSync(fileURLToPath(new URL('./sql/sie-resync-gap-metadata.sql', import.meta.url)), 'utf8')
    await expect(client.query(sql)).resolves.toBeDefined()
  } finally { await client.query('ROLLBACK'); client.release() }
})
