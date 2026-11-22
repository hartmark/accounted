'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatCurrency, formatDate } from '@/lib/utils'
import type { MigrationVatWarning, ProviderMigrationStatus } from '@/lib/providers/migration-contract'

function InvoiceVatReview({ item, jobId, provider, onUpdated }: {
  item: MigrationVatWarning; jobId: string; provider: string; onUpdated?: (status: ProviderMigrationStatus) => void
}) {
  const t = useTranslations()
  const [vat, setVat] = useState('')
  const [rate, setRate] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  async function confirm() {
    setBusy(true); setError(false)
    try {
      const response = await fetch('/api/extensions/ext/arcim-migration/migration-jobs/vat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, recordId: item.id, expectedUpdatedAt: item.updatedAt,
          vat: Number(vat.replace(',', '.')), rate: Number(rate) }),
      })
      if (!response.ok) throw new Error('refused')
      const status = await fetch('/api/extensions/ext/arcim-migration/migration-jobs?jobId=' + jobId, { cache: 'no-store' })
      if (!status.ok) throw new Error('refresh')
      onUpdated?.((await status.json()).data)
    } catch { setError(true) } finally { setBusy(false) }
  }
  return <div className="space-y-3 border-b py-4">
    <Link className="underline" href={item.resource === 'supplierInvoices' ? '/supplier-invoices/' + item.targetId : '/invoices/' + item.targetId}>
      {item.partyName} · {item.invoiceNumber || t('ext_arcim_vat_no_number')}
    </Link>
    {provider === 'bokio' && item.resource === 'supplierInvoices' && <a className="block text-sm underline" target="_blank" rel="noreferrer"
      href={'/api/extensions/ext/arcim-migration/migration-jobs/vat-document?jobId=' + jobId + '&recordId=' + item.id}>
      {t('ext_arcim_vat_document')}
    </a>}
    <p className="text-sm text-muted-foreground">{formatDate(item.invoiceDate)} · {formatCurrency(item.total, item.currency)}</p>
    {item.canConfirm ? <div className="flex flex-wrap items-end gap-3">
      <label className="space-y-1 text-sm">{t('ext_arcim_vat_amount')}
        <Input inputMode="decimal" value={vat} onChange={event => setVat(event.target.value)} />
      </label>
      <label className="space-y-1 text-sm">{t('ext_arcim_vat_rate')}
        <select className="block h-10 rounded-lg border bg-background px-3" value={rate} onChange={event => setRate(event.target.value)}>
          <option value="">{t('ext_arcim_vat_select')}</option>
          {[6, 12, 25].map(value => <option key={value} value={value}>{value} %</option>)}
        </select>
      </label>
      <Button disabled={busy || !vat.trim() || !rate || !Number.isFinite(Number(vat.replace(',', '.')))} onClick={() => void confirm()}>
        {t('ext_arcim_vat_confirm')}
      </Button>
    </div> : <p className="text-sm text-muted-foreground">{t('ext_arcim_vat_protected')}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{t('ext_arcim_vat_refused')}</p>}
  </div>
}

export default function MigrationVatReview({ items, jobId, provider, onUpdated }: {
  items: MigrationVatWarning[]; jobId: string; provider: string; onUpdated?: (status: ProviderMigrationStatus) => void
}) {
  const t = useTranslations()
  if (!items.length) return null
  return <details className="space-y-3">
    <summary className="cursor-pointer text-sm underline">{t('ext_arcim_vat_show', { count: items.length })}</summary>
    <p className="text-sm text-muted-foreground">{t('ext_arcim_vat_explanation')}</p>
    {items.map(item => <InvoiceVatReview key={item.id} item={item} jobId={jobId} provider={provider} onUpdated={onUpdated} />)}
  </details>
}
