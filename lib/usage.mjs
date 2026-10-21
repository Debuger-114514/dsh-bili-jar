/**
 * lib/usage.mjs —— token 记账（估算）
 * ============================================================================
 * 宿主没把 usage 直接递给我们，所以这里是**按字符估算**：
 *   中文约 1.6 字符/token（含标点、英文混排）
 * 单价用 whale-widget 里那张表（¥/百万 token，峰/谷两档）：
 *   miss 1/2 · out 4/8
 * 明确标成"估算"，不假装是精确账单。
 * ============================================================================
 */
import { readFileSync, writeFileSync } from 'node:fs'

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

export function loadUsage(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) || {} } catch { return {} }
}

export function addUsage(file, { system = '', user = '', output = '' }) {
  const book = loadUsage(file)
  const day = dayKey()
  const row = book[day] || { calls: 0, inTok: 0, outTok: 0, cost: 0 }
  const inTok = estimateTokens(system) + estimateTokens(user)
  const outTok = estimateTokens(output)
  row.calls += 1
  row.inTok += inTok
  row.outTok += outTok
  row.cost = Number((row.cost + costOf(inTok, outTok, isPeak())).toFixed(4))
  book[day] = row
  // 只留最近 30 天
  const days = Object.keys(book).sort()
  for (const d of days.slice(0, Math.max(0, days.length - 30))) delete book[d]
  try { writeFileSync(file, JSON.stringify(book), 'utf8') } catch { /* 无所谓 */ }
  return book
}

export function todayUsage(file) {
  const book = loadUsage(file)
  return book[dayKey()] || { calls: 0, inTok: 0, outTok: 0, cost: 0 }
}
