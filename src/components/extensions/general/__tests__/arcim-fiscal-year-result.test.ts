import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import { expect, it } from 'vitest'
import type { ImportResult } from '@/lib/import/types'
import { FiscalYearLine } from '../ArcimMigrationWorkspace'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'

const base: ImportResult = { success:true,importId:null,fiscalPeriodId:'period',openingBalanceEntryId:null,
  journalEntriesCreated:0,journalEntryIds:[],errors:[],warnings:[],
  details:{fiscalYear:{start:'2019-01-01',end:'2019-12-31'},retriedBatches:0,failedBatches:0},
  resync:{added:0,unchanged:189,reviewCount:0,reviews:[],metadataChanged:false},
}
function render(result: ImportResult, locale='sv') {
  return renderToStaticMarkup(createElement(NextIntlClientProvider,{locale,messages:locale==='sv'?sv:en,timeZone:'Europe/Stockholm',
    children:createElement(FiscalYearLine,{result,index:0})}))
}
it('distinguishes new vouchers from unchanged source records',()=>{
  const html=render(base)
  expect(html).toContain('0 nya verifikationer')
  expect(html).toContain('189 oförändrade källposter')
  expect(html).toContain('Oförändrat')
  expect(html).not.toContain('Behöver granskas')
})
it('shows the actual references and reasons behind a real review',()=>{
  const html=render({...base,resync:{...base.resync!,reviewCount:1,reviews:[{sourceId:'A41',kind:'changed',entryId:'entry'}]}})
  expect(html).toContain('<details')
  expect(html).toContain('1 att granska')
  expect(html).toContain('A41')
  expect(html).toContain('/bookkeeping/entry')
  expect(html).toContain(sv.extensions.ext_arcim_resync_review_changed)
})
it('retains first-import voucher counts',()=>{
  expect(render({...base,resync:undefined,journalEntriesCreated:187})).toContain('187')
})
it('renders the sync counts in English too',()=>{
  const html=render(base,'en')
  expect(html).toContain('0 new vouchers')
  expect(html).toContain('189 unchanged source records')
})
