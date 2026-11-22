import { AsyncLocalStorage } from 'node:async_hooks'
import { globalSingleton } from '@/lib/global-singleton'

/** A work deadline is a deferral, never an authentication or provider failure. */
export class ExecutionBudgetExceeded extends Error {
  constructor(readonly stage: string) {
    super(`Execution budget exhausted during ${stage}`)
    this.name = 'ExecutionBudgetExceeded'
  }
}

/** Provider responses must fit the request quota before callers buffer them. */
export class ResponseByteLimitExceeded extends Error {
  constructor(readonly limit: number) {
    super(`Response byte budget exceeded: ${limit}`)
    this.name = 'ResponseByteLimitExceeded'
  }
}

interface ExecutionBudget {
  bytes?: { response: number; total: number; used: number }
  deadline: number
  stage: string
  signal: AbortSignal
}

// Clients are singletons. A request-local scope keeps concurrent invocations
// independent without putting mutable deadlines on those shared clients.
// One scope per process, not per module copy (lib/global-singleton.ts): a
// route opens it through its copy of this module, and extension code, which
// lib/init loads from instrumentation.ts, reads it through another.
const budgets = globalSingleton('executionBudgets', () => new AsyncLocalStorage<ExecutionBudget>())

export function currentExecutionBudget(): ExecutionBudget | undefined {
  return budgets.getStore()
}

export function executionBudgetSignal(): AbortSignal | undefined {
  checkExecutionBudget()
  return budgets.getStore()?.signal
}

export function checkExecutionBudget(): void {
  const budget = budgets.getStore()
  if (budget && (budget.signal.aborted || Date.now() >= budget.deadline)) {
    throw new ExecutionBudgetExceeded(budget.stage)
  }
}

export async function withExecutionDeadline<T>(
  deadline: number,
  stage: string,
  operation: () => Promise<T>,
  byteLimits?: { response: number; total: number },
): Promise<T> {
  const parent = budgets.getStore()
  const end = Math.min(deadline, parent?.deadline ?? Infinity)
  if (Date.now() >= end || parent?.signal.aborted) throw new ExecutionBudgetExceeded(stage)
  const controller = new AbortController()
  const signal = parent ? AbortSignal.any([parent.signal, controller.signal]) : controller.signal
  const timer = setTimeout(() => controller.abort(new ExecutionBudgetExceeded(stage)), end - Date.now())
  try {
    return await budgets.run({ deadline: end, signal, stage, bytes: parent?.bytes ?? (byteLimits ? { ...byteLimits, used: 0 } : undefined) }, operation)
  } finally {
    clearTimeout(timer)
    controller.abort(new ExecutionBudgetExceeded(stage))
  }
}

/** Keep the signal attached while callers consume the response body too. */
export async function fetchInExecutionBudget(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  checkExecutionBudget()
  const budget = budgets.getStore()
  const signal = budget
    ? init?.signal ? AbortSignal.any([budget.signal, init.signal]) : budget.signal
    : init?.signal
  try {
    const quota = budget?.bytes
    if (quota && quota.used >= quota.total) throw new ResponseByteLimitExceeded(quota.total)
    const response = await fetch(input, { ...init, ...(signal ? { signal } : {}) })
    return quota ? byteBoundResponse(response, quota) : response
  } catch (error) {
    checkExecutionBudget()
    throw error
  }
}

/** PostgREST cancellation bounds the request; a cancelled write may have committed. */
export async function queryInExecutionBudget<T>(query: PromiseLike<T> & { abortSignal?: (signal: AbortSignal) => unknown }): Promise<T> {
  checkExecutionBudget()
  const budget = budgets.getStore()
  if (budget) query.abortSignal?.(budget.signal)
  try {
    const result = await query
    // PostgREST normally returns cancellation as { error }, not a rejection.
    checkExecutionBudget()
    if (budget && (result as { error?: { code?: string } } | null)?.error?.code === '57014') {
      throw new ExecutionBudgetExceeded(budget.stage)
    }
    return result
  } catch (error) {
    checkExecutionBudget()
    throw error
  }
}

/** Do not start a delay that cannot fit; cancellation also removes its timer. */
export async function waitInExecutionBudget(ms: number): Promise<void> {
  checkExecutionBudget()
  const budget = budgets.getStore()
  if (budget && ms >= budget.deadline - Date.now()) throw new ExecutionBudgetExceeded(budget.stage)
  await new Promise<void>((resolve, reject) => {
    const finish = () => { budget?.signal.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(finish, Math.max(0, ms))
    const abort = () => {
      clearTimeout(timer)
      budget?.signal.removeEventListener('abort', abort)
      reject(new ExecutionBudgetExceeded(budget!.stage))
    }
    budget?.signal.addEventListener('abort', abort, { once: true })
  })
  checkExecutionBudget()
}

/** Only for queued work that checks the budget before it eventually starts. */
export async function waitForExecutionTurn<T>(turn: Promise<T>): Promise<T> {
  const budget = budgets.getStore()
  if (!budget) return turn
  checkExecutionBudget()
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new ExecutionBudgetExceeded(budget.stage))
    budget.signal.addEventListener('abort', abort, { once: true })
    turn.then(resolve, reject).finally(() => budget.signal.removeEventListener('abort', abort))
  })
}

/** Enforce declared and streamed response sizes before a provider client buffers the body. */
async function byteBoundResponse(
  response: Response,
  quota: { response: number; total: number; used: number },
): Promise<Response> {
  const declared = Number(response.headers.get('content-length'))
  if (declared > quota.response || declared > quota.total - quota.used) {
    await response.body?.cancel()
    throw new ResponseByteLimitExceeded(Math.min(quota.response, quota.total - quota.used))
  }
  if (!response.body) return response
  const reader = response.body.getReader()
  let received = 0
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        checkExecutionBudget()
        const chunk = await reader.read()
        checkExecutionBudget()
        if (chunk.done) {
          controller.close()
          reader.releaseLock()
          return
        }
        received += chunk.value.byteLength
        quota.used += chunk.value.byteLength
        if (received > quota.response || quota.used > quota.total) {
          throw new ResponseByteLimitExceeded(Math.min(quota.response, quota.total))
        }
        controller.enqueue(chunk.value)
      } catch (error) {
        controller.error(error)
        await reader.cancel(error)
        reader.releaseLock()
      }
    },
    async cancel(reason) {
      await reader.cancel(reason)
      reader.releaseLock()
    },
  })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}
