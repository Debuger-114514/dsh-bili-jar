/**
 * lib/usage.mjs —— token 记账（单次 / 每日 / 累计）
 * ============================================================================
 * 每次调用追加一行到 `usage.jsonl`：
 *   { ts, day, kind, model, in, out, cost }
 * kind = 'curate'（策展）/ 'reason'（展开理由）
 *
 * 单价（¥/百万 token，谷/峰）：miss 1/2、out 4/8。
 * 服务端给了真实 usage 就用真实的，否则按字符估算（会标 est:true）。
 * ============================================================================
 */
import { appendFileSync, readFileSync, existsSync } from 'node:fs'

const PRICE = { miss: [1, 2], out: [4, 8] }

const dayKey = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 工作日 9–12、14–18 是高峰 */
export function isPeak(d = new Date()) {
  const day = d.getDay()
  if (day === 0 || day === 6) return false
  const h = d.getHours()
  return (h >= 9 && h < 12) || (h >= 14 && h < 18)
}

export const estimateTokens = (text) => Math.max(1, Math.round(String(text || '').length / 1.6))

export function costOf(inTok, outTok, peak) {
  const i = peak ? 1 : 0
  return (inTok / 1e6) * PRICE.miss[i] + (outTok / 1e6) * PRICE.out[i]
}

function readLines(file) {
  try {
    if (!existsSync(file)) return []
    const raw = readFileSync(file, 'utf8').trim()
    if (!raw) return []
    return raw.split('\n').map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

/** 记一次调用 */
export function record(file, { kind = 'other', model = '', system = '', user = '', output = '', usage = null } = {}) {
  const est = !usage?.prompt_tokens
  const inTok = Number(usage?.prompt_tokens) || (estimateTokens(system) + estimateTokens(user))
  const outTok = Number(usage?.completion_tokens) || estimateTokens(output)
  const cost = Number(costOf(inTok, outTok, isPeak()).toFixed(6))
  const row = { ts: Date.now(), day: dayKey(), kind, model, in: inTok, out: outTok, cost, ...(est ? { est: true } : {}) }
  try { appendFileSync(file, JSON.stringify(row) + '\n', 'utf8') } catch { /* 写不进去就算了 */ }
  return row
}

/** 兼容旧调用：只要今天那一层 */
export function todayUsage(file) {
  const s = summary(file)
  return { ...s.today, last: s.last, total: s.total, recent: s.recent }
}

export function summary(file, recentN = 5) {
  const rows = readLines(file)
  const today = dayKey()
  const acc = (list) => list.reduce((a, r) => ({
    calls: a.calls + 1,
    in: a.in + (r.in || 0),
    out: a.out + (r.out || 0),
    cost: Number((a.cost + (r.cost || 0)).toFixed(6)),
  }), { calls: 0, in: 0, out: 0, cost: 0 })
  return {
    last: rows.length ? rows[rows.length - 1] : null,
    today: acc(rows.filter((r) => r.day === today)),
    total: acc(rows),
    recent: rows.slice(-recentN).reverse(),
    estimated: rows.some((r) => r.est),
  }
}
