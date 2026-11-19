'use client'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { formatCurrency } from '@/lib/utils'
import type { ProviderMigrationStatus,MigrationResource } from '@/lib/providers/migration-contract'
export default function MigrationSkippedRecords({status,resource}:{status:ProviderMigrationStatus;resource:MigrationResource}) {
 const t=useTranslations('extensions')
 const row=status.counts.find(row=>row.resource===resource)
 if(!row)return null
 return <>            {(row.skipped ?? 0) > 0 && <details>
              <summary className="cursor-pointer underline">{t('ext_arcim_job_show_skipped',{count:row.skipped})}</summary>
              <ul className="mt-3 space-y-3">{status.skipped?.filter(item => item.resource === row.resource).map(item => <li key={item.id} className="space-y-1" data-ph-mask="">
                <p>{[item.partyName,item.invoiceNumber].filter(Boolean).join(' ') || item.source_id}
                  {item.invoiceDate && ` · ${item.invoiceDate}`}{item.amount !== undefined && ` · ${formatCurrency(item.amount,item.currency)}`}</p>
                <p className="text-muted-foreground">{t.has(`ext_arcim_job_skip_${item.reason}`) ? t(`ext_arcim_job_skip_${item.reason}`) : t('ext_arcim_job_skip_unknown')}</p>
                {item.targetId && ['salesInvoices','supplierInvoices'].includes(item.resource) && <Link className="underline" href={`/${item.resource === 'salesInvoices' ? 'invoices' : 'supplier-invoices'}/${item.targetId}`}>{t('ext_arcim_job_open_invoice')}</Link>}
              </li>)}</ul>
            </details>}</>
}
