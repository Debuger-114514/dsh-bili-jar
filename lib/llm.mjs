/**
 * lib/llm.mjs —— 直接的 OpenAI 兼容调用（DeepSeek 官方就是这个协议）
 * ============================================================================
 * 为什么不走宿主：`ctx.llm.prepareCall` 那套签名没有文档，反推的两种写法都失败了。
 * 直接 POST /chat/completions 最确定，而且 token 用量能从响应里直接读出来。
 *
 * ⚠️ 0.4.2 的大坑（issue #4，谢谢 @yunxiaolixie）：
 *    思考模型（deepseek-flash / deepseek-reasoner 这类）**先写思维链再写正文**，
 *    而思维链的 token **算在 max_tokens 里**。以前策展只给 900、单条理由只给 220，
 *    25 条候选的真实思考量就 684 token —— 一超限 `finish_reason=length`，
 *    `content` 直接是空的，表面看就是「API 空响应」，策展退回规则片单。
 *
 * 现在的三层防线：
 *   ① 预算不再是「够不够写」的预算，起点抬到 MIN_BUDGET，并且有阶梯（1024 → 2048 → 8192）。
 *   ② 短任务默认把思考关掉（`thinking:{type:'disabled'}`，官方文档的开关）——
 *      一句 40–70 字的推荐语用不着思维链，关掉既不会空响应，也便宜一半以上。
 *   ③ 真遇到 `finish_reason=length`（或正文为空）就换下一档重试，最后一档强制关思考：
 *      宁可少一点思考，也得把结果交出来，而不是空手回去。
 *
 * 参数是否被支持要能兜住：非 DeepSeek 的 OpenAI 兼容网关可能不认 `thinking`，
 * 那就按 base|model 记住「这家不认」，后面同一家不再发这个字段。
 * ============================================================================ */

/** 太小 = 等于没给：思考模型的思维链随便就几百上千 token */
export const MIN_BUDGET = 1024

/** 单次输出上限（含思维链）。再大也没有意义，只会让跑飞的模型更贵 */
export const BUDGET_CAP = 8192

/** 思考关闭开关（OpenAI 格式的 chat completions 顶层字段） */
const NO_THINK = { type: 'disabled' }

const clamp = (n) => Math.min(Math.max(Math.round(Number(n) || 0), MIN_BUDGET), BUDGET_CAP)

/**
 * 预算阶梯：起点 → 翻倍 → 上限；最后一档一定关思考。
 * 纯函数，好测。
 * @param {number} base 调用方想要的预算
 * @param {boolean} [noThink] 调用方希望第一档就关思考
 * @returns {{budget:number, noThink:boolean}[]}
 */
export function budgetLadder(base, noThink = true) {
  const start = clamp(base)
  const rungs = [{ budget: start, noThink: Boolean(noThink) }]
  const wide = Math.min(start * 2, BUDGET_CAP)
  if (wide > start) rungs.push({ budget: wide, noThink: Boolean(noThink) })
  if (rungs[rungs.length - 1].budget < BUDGET_CAP) rungs.push({ budget: BUDGET_CAP, noThink: true })
  // 兜底档必须关思考（否则同一条死路再走一遍）；只有一档时不强改调用方的意愿
  if (rungs.length > 1) rungs[rungs.length - 1].noThink = true
  return rungs
}

export function normalizeBase(base) {
  const b = String(base || '').trim().replace(/\/+$/, '')
  if (!b) return 'https://api.deepseek.com'
  return b.endsWith('/v1') ? b : b + '/v1'
}

/** 这家 base|model 不认 `thinking` 字段（记下来别再试） */
const noThinkUnsupported = new Set()

/** 测试用：清掉「不认 thinking」的记忆 */
export function resetNoThinkMemo() { noThinkUnsupported.clear() }

/** 最后一次调用的现场（/debug 直接看，出问题时不用猜） */
export const lastCall = { at: 0, model: '', attempts: [], usage: null, error: '' }

/** 思考 token（有的网关放在 usage.reasoning_tokens，有的放 completion_tokens_details 里） */
export function reasoningTokens(usage) {
  const a = Number(usage?.completion_tokens_details?.reasoning_tokens) || 0
  const b = Number(usage?.reasoning_tokens) || 0
  return Math.max(a, b)
}

function sumUsage(acc, usage) {
  if (!usage) return acc
  acc.prompt_tokens += Number(usage.prompt_tokens) || 0
  acc.completion_tokens += Number(usage.completion_tokens) || 0
  acc.reasoning_tokens += reasoningTokens(usage)
  const hit = Number(usage.prompt_cache_hit_tokens) || 0
  if (hit) acc.prompt_cache_hit_tokens = (acc.prompt_cache_hit_tokens || 0) + hit
  return acc
}

/** 「空响应」到底是什么空法 —— /debug 里要能直接看出是超限还是别的原因 */
function emptyReason({ finish, usage, budget }) {
  const ct = Number(usage?.completion_tokens) || 0
  const rt = reasoningTokens(usage)
  const bits = [
    `finish_reason=${finish || '无'}`,
    `completion ${ct}/${budget}`,
    rt > 0 ? `其中思考 ${rt}` : '',
  ].filter(Boolean)
  return `空响应（${bits.join('，')}）`
}

/** 400 且是因为不认参数 —— 才能安全地去掉 thinking 再试 */
function looksLikeUnknownParam(status, body) {
  if (status !== 400) return false
  const s = String(body || '')
  if (!/thinking|reasoning/i.test(s)) return false
  return /(unrecogni[sz]ed|unknown|unexpected|unsupported|invalid|extra|not permitted|不支持)/i.test(s)
}

/**
 * 一次请求。失败也返回对象，不抛。
 * @returns {Promise<{ok:boolean,text:string,status:number,error?:string,finish?:string,usage?:object,raw?:string}>}
 */
async function once({ url, key, model, system, user, budget, timeoutMs, noThink }) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: model || 'deepseek-chat',
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user },
        ],
        max_tokens: budget,
        // 思考模式下 temperature 不生效（官方文档：不报错也不管用），留着给非思考模型
        temperature: 0.7,
        ...(noThink ? { thinking: NO_THINK } : {}),
        stream: false,
      }),
      signal: ac.signal,
    })
    const raw = await res.text()
    let j = null
    try { j = JSON.parse(raw) } catch { /* 不是 JSON */ }

    if (!res.ok) {
      return {
        ok: false, text: '', status: res.status, raw,
        error: `HTTP ${res.status} ${String(j?.error?.message || raw).slice(0, 160)}`,
        usage: j?.usage,
      }
    }
    const choice = j?.choices?.[0] || {}
    const out = String(choice?.message?.content || '').trim()
    const finish = String(choice?.finish_reason || '')
    const usage = j?.usage || null
    if (!out) {
      return { ok: false, text: '', status: 200, finish, usage, error: emptyReason({ finish, usage, budget }) }
    }
    return { ok: true, text: out, status: 200, finish, usage }
  } catch (e) {
    return { ok: false, text: '', status: 0, error: String(e?.message || e).slice(0, 160) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 调一次模型，拿一段文本。
 * @param {object} o
 * @param {string} [o.base] 默认 https://api.deepseek.com
 * @param {string} o.key
 * @param {string} [o.model]
 * @param {string} [o.system]
 * @param {string} o.user
 * @param {number} [o.maxTokens] 想要的输出预算（含思维链）；低于 MIN_BUDGET 会被抬上来
 * @param {number} [o.timeoutMs] 每一档的超时
 * @param {boolean} [o.noThink] 是否第一档就关思考（默认 true：短任务不需要思维链）
 * @returns {Promise<{ok:boolean,text:string,usage?:object,error?:string,truncated?:boolean,attempts?:object[]}>}
 */
export async function chat({
  base, key, model, system, user,
  maxTokens = MIN_BUDGET, timeoutMs = 45000, noThink = true,
}) {
  if (!key) {
    Object.assign(lastCall, { at: Date.now(), model: model || '', attempts: [], usage: null, error: '没有 API key' })
    return { ok: false, text: '', error: '没有 API key' }
  }
  const url = normalizeBase(base) + '/chat/completions'
  const sig = `${normalizeBase(base)}|${model || ''}`
  const rungs = budgetLadder(maxTokens, noThink)
  const usage = { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, prompt_cache_hit_tokens: 0 }
  const attempts = []
  let last = null
  let truncated = false

  let i = 0
  while (i < rungs.length) {
    const rung = rungs[i]
    const useNoThink = rung.noThink && !noThinkUnsupported.has(sig)
    const r = await once({ url, key, model, system, user, budget: rung.budget, timeoutMs, noThink: useNoThink })
    sumUsage(usage, r.usage)
    attempts.push({
      budget: rung.budget, noThink: useNoThink,
      ok: r.ok, finish: r.finish || '', error: r.error || '',
    })

    // 这家网关不认 thinking 字段：记住，然后**同预算**重发一次
    if (!r.ok && useNoThink && looksLikeUnknownParam(r.status, r.raw)) {
      noThinkUnsupported.add(sig)
      continue
    }

    if (r.ok) {
      // 输出被预算截断（思考吃光了）：换下一档，最后一档已经关思考了就交出去
      if (r.finish === 'length' && i + 1 < rungs.length) { truncated = true; i++; continue }
      Object.assign(lastCall, { at: Date.now(), model: model || '', attempts, usage, error: '' })
      return { ok: true, text: r.text, usage, truncated: truncated || r.finish === 'length', attempts }
    }

    // 超限 / 空正文：还有下一档就继续抬预算
    const retryable = r.finish === 'length' || (r.status === 200 && !r.finish)
    last = r
    if (retryable && i + 1 < rungs.length) { truncated = true; i++; continue }
    break
  }

  const lastRung = attempts[attempts.length - 1]?.budget
  const error = `${last?.error || '模型没返回正文'}（预算试到 ${lastRung}）`
  Object.assign(lastCall, { at: Date.now(), model: model || '', attempts, usage, error })
  return { ok: false, text: '', usage, truncated, attempts, error }
}
