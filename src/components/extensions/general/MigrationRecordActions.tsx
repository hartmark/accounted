'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import type { ProviderMigrationIssue, ProviderMigrationStatus } from '@/lib/providers/migration-contract'

const ROOT = '/api/extensions/ext/arcim-migration/migration-jobs'

/** A decision belongs to this source record; other unresolved records are not retried. */
export default function MigrationRecordActions({ jobId, issue, onUpdated }: {
  jobId: string; issue: ProviderMigrationIssue; onUpdated: (status: ProviderMigrationStatus) => void
}) {
  const t = useTranslations('extensions')
  const [busy, setBusy] = useState<'source' | 'ignore' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  async function decide(action: 'source' | 'ignore') {
    setBusy(action)
    setMessage(null)
    try {
      const response = await fetch(`${ROOT}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, recordId: issue.id, action, expectedUpdatedAt: issue.targetUpdatedAt }) })
      if (!response.ok) {
        const failure = await response.json().catch(() => null)
        const key = failure?.error?.code === 'MIGRATION_REVIEW_BOOKED_CONFLICT' ? 'ext_arcim_decision_booked'
          : failure?.error?.code === 'MIGRATION_REVIEW_STALE' ? 'ext_arcim_decision_stale'
          : failure?.error?.code === 'MIGRATION_REVIEW_BUSY' ? 'ext_arcim_decision_busy' : 'ext_arcim_decision_failed'
        setMessage(key)
        return
      }
      const deadline = Date.now() + 60_000
      do {
        const current = await fetch(`${ROOT}?jobId=${encodeURIComponent(jobId)}`, { cache: 'no-store' })
        if (!current.ok) throw new Error('Review status unavailable')
        const { data } = await current.json() as { data: ProviderMigrationStatus }
        if (data.job.state === 'completed' || data.job.state === 'needs_attention') {
          onUpdated(data)
          return
        }
        await new Promise(resolve => setTimeout(resolve, 750))
      } while (Date.now() < deadline)
      setMessage('ext_arcim_decision_processing')
    } catch { setMessage('ext_arcim_decision_failed') }
    finally { setBusy(null) }
  }
  return <div className="mt-3 space-y-2">
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="toolbar" onClick={() => void decide('source')} loading={busy === 'source'} disabled={busy !== null}>
        {t('ext_arcim_decision_source')}
      </Button>
      <Button variant="ghost" size="toolbar" onClick={() => void decide('ignore')} loading={busy === 'ignore'} disabled={busy !== null}>
        {t('ext_arcim_decision_ignore')}
      </Button>
    </div>
    {message && <p role="status" className="text-sm text-muted-foreground">{t(message)}</p>}
  </div>
}
