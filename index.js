/**
 * 牛皮藓无限重试 — Host half.
 *
 * 模型请求失败后无限重试：默认固定 1 秒间隔，可在侧边栏设置菜单切换
 * 固定间隔 / 递增间隔 / 不间隔，配置不应用的供应商，并支持临时关闭。
 * 设置通过 settings 命名空间（行 id = `niupi-retry`）即时生效并持久化到
 * profile patch；所有字段都是 `.volatile()`，改动不需要重启插件。
 *
 * 两层覆盖（"适用于任何模型调用"）：
 *  1. `agent/request-error` 瀑布 —— agent 循环每一步的失败都在这里兜底，
 *     返回 `{ kind: 'retry' }` 让循环在同一个打开的 turn 里重跑该步；
 *     主对话、子代理、workflow 的全部模型调用都走这条路。
 *  2. `llm/stream` 瀑布 —— 直接调用 `ctx.llm.stream()` 的辅助请求
 *     （session 标题、压缩摘要、web search 等，带 `purpose` 标记）在这层
 *     重放整条流；只重放"一个 chunk 都还没吐出来"的失败，避免污染消费者。
 *
 * 与内置 `@deepseek-ai/dsh-llm-retry` 的组合：它先按供应商策略处理瞬态
 * 错误；策略耗尽或错误码不在其白名单（鉴权失败、配额、无效请求等）时
 * 委托到本插件，由本插件无限接管，直到成功、用户终止（信号中止）或插件关闭。
 */

import z from './vendor/schemastery/lib/index.mjs'

export const name = 'niupi-retry'

const MODES = ['fixed', 'incremental', 'none']
const MAX_DELAY_LIMIT = 3600000
const ATTEMPT_MAP_CAP = 800
const RETRY_LOG_CAP = 30

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  mode: z.union([z.const('fixed'), z.const('incremental'), z.const('none')])
    .default('fixed').volatile(),
  delayMs: z.number().step(1).min(0).max(MAX_DELAY_LIMIT).default(1000).volatile(),
  maxDelayMs: z.number().step(1).min(0).max(MAX_DELAY_LIMIT).default(60000).volatile(),
  auxiliary: z.boolean().default(true).volatile(),
  excludeProviders: z.array(z.string()).default([]).volatile(),
})

function clampDelay(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(Math.trunc(n), MAX_DELAY_LIMIT)
}

/** 归一化供应商排除表：小写、去空白；支持 `*` 前缀通配（`deepseek-*`）。 */
function exclusionMatcher(rawList) {
  const patterns = (Array.isArray(rawList) ? rawList : [])
    .map((entry) => String(entry ?? '').trim().toLowerCase())
    .filter(Boolean)
  return function isExcluded(provider) {
    const id = String(provider ?? '').trim().toLowerCase()
    if (!id) return false
    return patterns.some((pattern) => {
      if (pattern.endsWith('*')) return id.startsWith(pattern.slice(0, -1))
      return pattern === id
    })
  }
}

function computeDelay(mode, delayMs, maxDelayMs, attempt) {
  if (mode === 'none') return 0
  const base = clampDelay(delayMs)
  if (mode === 'fixed') return base
  const cap = clampDelay(maxDelayMs)
  return Math.min(base * Math.max(1, attempt || 1), cap)
}

/** 可被插件生命周期与请求信号中止的 sleep；返回 false 表示已中止。 */
function sleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve(false)
  if (!(ms > 0)) return Promise.resolve(!signal?.aborted)
  return new Promise((resolve) => {
    const timer = setTimeout(settled, ms)
    function settled() {
      signal?.removeEventListener('abort', onAbort)
      clearTimeout(timer)
      resolve(true)
    }
    function onAbort() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function safeString(value) {
  try {
    return String(value ?? '')
  } catch {
    return ''
  }
}

export function apply(ctx, config) {
  const lifetime = new AbortController()
  const log = (message, ...rest) => {
    try { ctx.logger?.info?.(`niupi-retry: ${message}`, ...rest) } catch {}
  }

  const isExcluded = exclusionMatcher(config.excludeProviders?.get?.() ?? [])
  // 每次判断都实时读取 volatile 引用，设置改动立即生效。
  function live() {
    return {
      enabled: config.enabled?.get?.() !== false,
      mode: MODES.includes(config.mode?.get?.()) ? config.mode.get() : 'fixed',
      delayMs: config.delayMs?.get?.(),
      maxDelayMs: config.maxDelayMs?.get?.(),
      auxiliary: config.auxiliary?.get?.() !== false,
      excludeProviders: Array.isArray(config.excludeProviders?.get?.()) ? config.excludeProviders.get() : [],
    }
  }
  function excludedNow(provider) {
    return exclusionMatcher(live().excludeProviders)(provider)
  }

  /** 每个 (session, turn, step) 一条重试链：计数 + 稳定 retryId。 */
  const chains = new Map()
  function chainOf(sessionId, turn, step, provider, policyKey) {
    const key = `${sessionId}:${turn}:${step}:${provider}:${policyKey}`
    let chain = chains.get(key)
    if (chain === undefined) {
      chain = { retry: 0, retryId: `${sessionId}:${turn}:${step}:${Math.random().toString(36).slice(2, 10)}`, appending: true }
      chains.set(key, chain)
    }
    if (chains.size > ATTEMPT_MAP_CAP) chains.clear()
    return chain
  }

  const retryLog = []
  function record(entry) {
    retryLog.push({ time: Date.now(), ...entry })
    if (retryLog.length > RETRY_LOG_CAP) retryLog.shift()
  }

  /** 写入内置的 `llm/retry` 词汇事件，让会话里出现"模型重试"行。
   *  类型由随 base 挂载的 dsh-llm-retry 提供；如果某部署没挂它，追加会
   *  抛错 —— 捕获后对该链禁用追加，重试本身不受影响。 */
  function appendRetryEvents(agent, turn, step, chain, provider, policyKey, attempt, delayMs, failure) {
    if (!chain.appending) return
    try {
      const session = agent?.session
      if (!session || typeof session.append !== 'function') { chain.appending = false; return }
      session.append('llm/retry', {
        retryId: chain.retryId,
        turn,
        step,
        provider,
        mode: 'always',
        policyKey,
        retry: attempt,
        delayMs,
        failure,
      })
    } catch {
      chain.appending = false
    }
  }
  function appendRetryStarted(agent, turn, step, chain, attempt) {
    if (!chain.appending) return
    try {
      const session = agent?.session
      session?.append?.('llm/retry-started', { retryId: chain.retryId, turn, step, retry: attempt })
    } catch {
      chain.appending = false
    }
  }

  function policyKeyOf(state) {
    return `niupi:${state.mode}:${clampDelay(state.delayMs)}:${clampDelay(state.maxDelayMs)}`
  }

  // ── 第 1 层：agent 循环步骤失败 → 无限重试 ──────────────────────────────
  const offRequestError = ctx.on('agent/request-error', async (payload, next) => {
    const signal = payload?.signal
    if (lifetime.signal.aborted || signal?.aborted) return next()
    const state = live()
    if (!state.enabled) return next()
    if (excludedNow(payload?.provider)) return next()

    // 先让下游策略（内置 5 次瞬态重试、图片卸载、上下文压缩）决定；
    // 它们给出 retry 就沿用，否则由本插件无限接管。
    let downstream
    try {
      downstream = await next()
    } finally {
      /* next 的异常原样上抛，由循环决定终局 */
    }
    if (downstream && downstream.kind === 'retry') return downstream
    if (lifetime.signal.aborted || signal?.aborted) return downstream

    const sessionId = safeString(payload?.agent?.session?.id) || 'unknown'
    const turn = Number.isFinite(payload?.turn) ? payload.turn : 0
    const step = Number.isFinite(payload?.step) ? payload.step : 0
    const provider = safeString(payload?.provider) || 'unknown'
    const policyKey = policyKeyOf(state)
    const chain = chainOf(sessionId, turn, step, provider, policyKey)
    const attempt = chain.retry + 1
    const delay = computeDelay(state.mode, state.delayMs, state.maxDelayMs, attempt)
    chain.retry = attempt
    record({ sessionId, turn, step, provider, code: safeString(payload?.failure?.code), attempt, delay })
    log(`step ${sessionId}#${turn}.${step} provider "${provider}" failed (${safeString(payload?.failure?.code)}); retry #${attempt} in ${delay}ms`)
    appendRetryEvents(payload?.agent, turn, step, chain, provider, policyKey, attempt, delay, payload?.failure)

    const finished = await sleep(delay, AbortSignal.any([signal, lifetime.signal].filter(Boolean)))
    if (!finished) return downstream ?? undefined
    appendRetryStarted(payload?.agent, turn, step, chain, attempt)
    return { kind: 'retry' }
  })

  // ── 第 2 层：辅助模型调用（带 purpose 的直接 ctx.llm.stream）→ 流级重试 ──
  const offStream = ctx.on('llm/stream', (options, next) => {
    if (lifetime.signal.aborted) return next()
    const state = live()
    if (!state.enabled || !state.auxiliary) return next()
    if (excludedNow(options?.provider)) return next()
    const purpose = typeof options?.purpose === 'string' ? options.purpose : ''
    // 只覆盖带 purpose 标记的辅助请求；agent 循环的请求没有 purpose，
    // 交给第 1 层在 durable 步边界重跑，避免同一请求双层重试。
    if (!purpose) return next()
    return auxiliaryRetryStream(state, options, next)
  })

  async function* auxiliaryRetryStream(stateAtStart, options, next) {
    const signal = options?.signal
    const provider = safeString(options?.provider) || 'unknown'
    const purpose = safeString(options?.purpose)
    let attempt = 0
    while (true) {
      let emitted = 0
      let finishChunk
      try {
        const stream = await next()
        for await (const chunk of stream) {
          if (chunk && chunk.type === 'finish') { finishChunk = chunk; break }
          emitted += 1
          yield chunk
        }
      } catch (error) {
        // 已吐过 chunk 的失败无法安全重放，原样抛给消费者。
        if (emitted > 0 || lifetime.signal.aborted || signal?.aborted) throw error
        attempt += 1
        const delay = computeDelay(stateAtStart.mode, stateAtStart.delayMs, stateAtStart.maxDelayMs, attempt)
        record({ provider, purpose, code: 'THROWN', attempt, delay })
        log(`auxiliary "${purpose}" provider "${provider}" threw (${safeString(error?.message)}); retry #${attempt} in ${delay}ms`)
        const finished = await sleep(delay, AbortSignal.any([signal, lifetime.signal].filter(Boolean)))
        if (!finished) throw error
        continue
      }
      const reason = finishChunk?.reason
      const retryable = reason?.kind === 'error' && emitted === 0
      if (!retryable) {
        if (finishChunk) yield finishChunk
        return
      }
      if (lifetime.signal.aborted || signal?.aborted) { yield finishChunk; return }
      attempt += 1
      const delay = computeDelay(stateAtStart.mode, stateAtStart.delayMs, stateAtStart.maxDelayMs, attempt)
      record({ provider, purpose, code: safeString(reason?.failure?.code), attempt, delay })
      log(`auxiliary "${purpose}" provider "${provider}" failed (${safeString(reason?.failure?.code)}); retry #${attempt} in ${delay}ms`)
      const finished = await sleep(delay, AbortSignal.any([signal, lifetime.signal].filter(Boolean)))
      if (!finished) { yield finishChunk; return }
    }
  }

  // 本插件自带设置页：关闭自动生成表单，避免重复的配置入口。
  try {
    const settings = ctx.get('settings')
    if (settings && typeof settings.configure === 'function') {
      settings.configure({ auto: false }, ctx.fiber)
    }
  } catch (error) {
    log(`settings presentation policy skipped: ${safeString(error?.message)}`)
  }

  return () => {
    offRequestError()
    offStream()
    lifetime.abort(new Error('niupi-retry disposed'))
  }
}
