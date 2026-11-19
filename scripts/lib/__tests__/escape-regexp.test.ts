import {expect,it} from 'vitest'
import {escapeRegExp} from '../escape-regexp.mjs'
it.each(['x$y','a.b','a\\b','x[0]','a|b','(?<name>.*)','x-y'])('matches only the literal value %s',value=>{
 const match=new RegExp(`^${escapeRegExp(value)}$`)
 expect(match.test(value)).toBe(true)
 expect(match.test(value+'extra')).toBe(false)
})
