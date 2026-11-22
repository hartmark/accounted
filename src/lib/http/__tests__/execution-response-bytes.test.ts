import { afterEach, expect, it, vi } from 'vitest'
import { fetchInExecutionBudget, withExecutionDeadline, ResponseByteLimitExceeded } from '../execution-budget'

afterEach(() => vi.unstubAllGlobals())

it('refuses a declared oversized body and cancels it before buffering', async () => {
  const cancel = vi.fn()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
    new ReadableStream({ cancel }),
    { headers: { 'Content-Length': '100' } },
  )))
  await expect(withExecutionDeadline(Date.now() + 1000, 'declared', async () => {
    await fetchInExecutionBudget('https://provider.test')
  }, { response: 4, total: 8 })).rejects.toBeInstanceOf(ResponseByteLimitExceeded)
  expect(cancel).toHaveBeenCalledOnce()
})

it('counts streamed chunks even when Content-Length is missing', async () => {
  const cancel = vi.fn()
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]))
      controller.enqueue(new Uint8Array([4, 5, 6]))
    },
    cancel,
  })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)))
  await expect(withExecutionDeadline(Date.now() + 1000, 'chunked', async () => {
    const response = await fetchInExecutionBudget('https://provider.test')
    await response.arrayBuffer()
  }, { response: 4, total: 8 })).rejects.toBeInstanceOf(ResponseByteLimitExceeded)
  expect(cancel).toHaveBeenCalledOnce()
})

it('shares the total byte quota with nested per-year deadlines', async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('123')))
  await expect(withExecutionDeadline(Date.now() + 1000, 'batch', async () => {
    for (let index = 0; index < 2; index++) {
      await withExecutionDeadline(Date.now() + 1000, 'year', async () => {
        const response = await fetchInExecutionBudget('https://provider.test')
        await response.text()
      })
    }
  }, { response: 4, total: 5 })).rejects.toBeInstanceOf(ResponseByteLimitExceeded)
})
