'use client'

import { useTranslations, useLocale } from 'next-intl'
import { formatCurrency, formatDate } from '@/lib/utils'
import type { MigrationFieldDifference, MigrationResource } from '@/lib/providers/migration-contract'

export default function MigrationDifferenceTable({ differences, unavailable, resource }: {
  differences?: MigrationFieldDifference[]; unavailable?: boolean; resource: MigrationResource
}) {
  const t = useTranslations('extensions')
  const locale = useLocale()
  if (unavailable) return <p className="text-sm text-muted-foreground">{t('ext_arcim_diff_unavailable')}</p>
  if (!differences) return null
  if (!differences.length) return <p className="text-sm text-muted-foreground">{t('ext_arcim_diff_none')}</p>
  function value(diff: MigrationFieldDifference, input: MigrationFieldDifference['source']): string {
    if (input === null) return t('ext_arcim_diff_empty')
    if (typeof input === 'boolean') return t(input ? 'ext_arcim_diff_yes' : 'ext_arcim_diff_no')
    if (diff.field === 'status') {
      const key = `ext_arcim_diff_status_${input}`
      return t.has(key) ? t(key) : String(input)
    }
    if (['invoice_date','due_date','delivery_date','paid_at'].includes(diff.field)) return formatDate(String(input))
    if (typeof input === 'number' || (['subtotal','vat_amount','total','paid_amount','remaining_amount','unit_price','line_total'].includes(diff.field) && Number.isFinite(Number(input)))) {
      if (['subtotal','vat_amount','total','paid_amount','remaining_amount','unit_price','line_total'].includes(diff.field))
        return formatCurrency(Number(input),diff.currency)
      if (diff.field === 'vat_rate') return `${Number(input) * (resource === 'supplierInvoices' ? 100 : 1)} %`
      return new Intl.NumberFormat(locale).format(Number(input))
    }
    return String(input)
  }
  return <div className="overflow-x-auto" data-ph-mask="">
    <table className="w-full text-sm">
      <thead><tr className="border-b border-border text-left">
        <th scope="col" className="px-3 py-2 font-medium">{t('ext_arcim_diff_source')}</th>
        <th scope="col" className="px-3 py-2 font-medium">Accounted</th>
      </tr></thead>
      <tbody>{differences.map((diff, index) => <tr key={`${diff.line ?? 0}-${diff.field}-${index}`} className="border-b border-border">
        <td className="px-3 py-2 tabular-nums align-top">
          <span className="text-muted-foreground">{diff.line ? `${t('ext_arcim_diff_line', {number:diff.line})} · ` : ''}{t(`ext_arcim_diff_field_${diff.field}`)}: </span>
          {value(diff,diff.source)}
        </td>
        <td className="px-3 py-2 tabular-nums align-top">{value(diff,diff.accounted)}</td>
      </tr>)}</tbody>
    </table>
    {differences.some(diff => diff.field === 'source_line_count') && <p className="mt-2 text-sm text-muted-foreground">{t('ext_arcim_diff_source_snapshot')}</p>}
  </div>
}
