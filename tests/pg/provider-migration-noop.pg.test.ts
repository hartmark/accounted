import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { getClient } from './setup'

it('acknowledges equivalent outcomes with revision checks, preserved evidence and unchanged counts', async () => {
  const read = (name: string) => readFileSync(fileURLToPath(new URL('./sql/' + name, import.meta.url)), 'utf8')
  // Reuse the full decision fixture and insert automatic-decision assertions before queueing.
  const fixture = read('provider-record-decisions.sql')
  const marker = '  -- Queueing one stopped record never resets the other outstanding records.'
  expect(fixture).toContain(marker)
  const sql = fixture.replace(marker, read('provider-migration-noop.sql') + marker)
  const client = await getClient()
  try { await expect(client.query(sql)).resolves.toBeDefined() }
  finally { await client.query('ROLLBACK'); client.release() }
})
