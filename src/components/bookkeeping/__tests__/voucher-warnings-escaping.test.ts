import React from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {expect,it,vi} from 'vitest'
vi.mock('next-intl',()=>({useLocale:()=> 'en',useTranslations:()=> (key:string)=>key}))
vi.mock('@/components/ui/dialog',()=>{
 const Container=({children}:{children:React.ReactNode})=>React.createElement('div',null,children)
 return {Dialog:Container,DialogContent:Container,DialogHeader:Container,DialogTitle:Container}
})
vi.mock('@/components/ui/button',()=>({Button:({children}:{children:React.ReactNode})=>React.createElement('button',null,children)}))
vi.mock('@/components/ui/help-popover',()=>({HelpPopover:({children}:{children:React.ReactNode})=>React.createElement('span',null,children)}))
import VoucherWarningsDialog from '../VoucherWarningsDialog'
it('renders exception-derived warning messages as escaped text, never HTML',()=>{
 const message='<img src=x onerror="alert(1)"><script>alert(2)</script>'
 const html=renderToStaticMarkup(React.createElement(VoucherWarningsDialog,{processing:false,onCancel:()=>{},onConfirm:()=>{},warnings:[{code:'INPUT_VAT_ABOVE_RATE',message_en:message,message_sv:message,details:{}}]}))
 expect(html).toContain('&lt;img')
 expect(html).toContain('&lt;script&gt;')
 expect(html).not.toContain('<img')
 expect(html).not.toContain('<script>')
})
