/**
 * lib/usage.mjs —— token 记账（单次 / 每日 / 累计）
 * ============================================================================
 * 每次调用追加一行到 `usage.json`（JSONL 格式）：
 *   { ts, day, kind, model, in, out, cacheHit, cost }
 * kind = 'curate'（策展）/ 'reason'（展开理由）
 *
 * ⚠️ 计价的坑（踩过）：价格表（谷 1/4、峰 2/8）一直是对的，错的是**判断峰谷的时钟**。
 *    旧代码拿本机时间套自己编的窗口 —— 在悉尼（UTC+11）跑，傍晚 18:54 被判成谷时，
 *    实际北京时间 15:54 是周五下午的峰时，于是成本被算成一半（0.023 vs 平台 0.038）。
 *    现在按官方规则算：北京时间周一至周五 09:00–12:00、14:00–18:00 为峰，
 *    其余（含周末、法定节假日）半价。
 *    来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing（2026-10-10 核对）
 *
 * 单价（元 / 百万 token，峰时）：缓存命中 0.04、未命中 2、输出 8；谷时 ×0.5。
 * 历史行按它自己的 ts 重新算价，所以改规则能把旧账一起修正。
 * ============================================================================
 */
import { appendFileSync, readFileSync, existsSync, writeFileSync } from 'node:fs'

/** 北京时间固定 UTC+8，没有夏令时 */
const BJ_OFFSET_MS = 8 * 3600 * 1000

/** 峰时价格（元 / 百万 token） */
const PEAK = { cacheHit: 0.04, cacheMiss: 2, output: 8 }

/** 2026 年落在周一到周五的法定节假日（周末本来就整天算谷时） */
const HOLIDAYS = new Set([
  '2026-01-01', '2026-01-02',
  '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-23',
  '2026-04-06',
  '2026-05-01', '2026-05-04', '2026-05-05',
  '2026-06-19',
  '2026-09-25',
  '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07',
])

/** 节假日日历覆盖到哪年（没覆盖的按"工作日即峰时"估算） */
const CALENDAR_YEARS = new Set([2026])

const dayKey = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 拆北京时间日历字段 */
function beijing(ts = Date.now()) {
  const d = new Date(ts + BJ_OFFSET_MS)
  const p = (n) => String(n).padStart(2, '0')
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() + 1
  const day = d.getUTCDate()
  return {
    year: y,
    weekday: d.getUTCDay(),          // 0 周日 … 6 周六
    minuteOfDay: d.getUTCHours() * 60 + d.getUTCMinutes(),
    dateKey: `${y}-${p(m)}-${p(day)}`,
  }
}

/**
 * 这一刻是不是峰时（北京时间周一至周五 09:00–12:00、14:00–18:00，非节假日）。
 * @param {number} [ts] epoch 毫秒
 */
export function isPeak(ts = Date.now()) {
  const b = beijing(ts)
  if (b.weekday === 0 || b.weekday === 6) return false
  if (HOLIDAYS.has(b.dateKey)) return false
  return (b.minuteOfDay >= 9 * 60 && b.minuteOfDay < 12 * 60)
    || (b.minuteOfDay >= 14 * 60 && b.minuteOfDay < 18 * 60)
}

/** 当前时段：'peak' | 'off-peak'，以及对应的单价（元 / 百万 token） */
export function priceNow(ts = Date.now()) {
  const peak = isPeak(ts)
  const f = peak ? 1 : 0.5
  return {
    period: peak ? 'peak' : 'off-peak',
    unit: {
      cacheHit: PEAK.cacheHit * f,
      cacheMiss: PEAK.cacheMiss * f,
      output: PEAK.output * f,
    },
  }
}

export const estimateTokens = (text) => Math.max(1, Math.round(String(text || '').length / 1.6))

/**
 * 一次调用的成本（元）。
 * @param {number} inTok 提示 token 总数（含缓存命中）
 * @param {number} outTok 输出 token
 * @param {boolean} peak 是否峰时
 * @param {number} [inHit] 其中缓存命中的部分
 */
export function costOf(inTok, outTok, peak, inHit = 0) {
  const f = peak ? 1 : 0.5
  const hit = Math.min(Math.max(0, inHit), Math.max(0, inTok))
  const miss = Math.max(0, inTok - hit)
  return ((miss * PEAK.cacheMiss + hit * PEAK.cacheHit + outTok * PEAK.output) / 1e6) * f
}

/**
 * 从文件里抠出所有 JSON 对象。
 * 不能按行 split：早期版本写的是 `{"2026-10-21":{…}}` 这种整体 JSON，
 * 后来改成追加一行一条，可第一次追加时文件末尾没有换行，于是两坨粘在了同一行
 * （`}{`）。按行解析会把那一行整条丢掉 —— 记的账凭空少一笔。
 */
function splitObjects(raw) {
  const out = []
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') { if (depth === 0) start = i; depth++ ; continue }
    if (ch === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        try { out.push(JSON.parse(raw.slice(start, i + 1))) } catch { /* 坏块跳过 */ }
        start = -1
      }
    }
  }
  return out
}

function readLines(file) {
  try {
    if (!existsSync(file)) return []
    const raw = readFileSync(file, 'utf8')
    if (!raw.trim()) return []
    const rows = []
    for (const obj of splitObjects(raw)) {
      if (obj && typeof obj.ts === 'number') { rows.push(obj); continue }
      // 旧格式：{ "YYYY-MM-DD": { calls, inTok, outTok, cost } }
      for (const [day, v] of Object.entries(obj || {})) {
        if (v && typeof v.calls === 'number' && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
          rows.push({
            ts: Date.parse(`${day}T12:00:00+08:00`),
            day, kind: 'legacy', model: '',
            in: Number(v.inTok) || 0, out: Number(v.outTok) || 0,
            cost: Number(v.cost) || 0, legacy: true,
          })
        }
      }
    }
    return rows.sort((a, b) => a.ts - b.ts)
  } catch { return [] }
}

/** 记一次调用 */
export function record(file, { kind = 'other', model = '', system = '', user = '', output = '', usage = null } = {}) {
  const est = !usage?.prompt_tokens
  const inTok = Number(usage?.prompt_tokens) || (estimateTokens(system) + estimateTokens(user))
  const outTok = Number(usage?.completion_tokens) || estimateTokens(output)
  const cacheHit = Number(usage?.prompt_cache_hit_tokens) || 0
  const ts = Date.now()
  const cost = Number(costOf(inTok, outTok, isPeak(ts), cacheHit).toFixed(6))
  const row = { ts, day: dayKey(), kind, model, in: inTok, out: outTok, ...(cacheHit ? { cacheHit } : {}), cost, ...(est ? { est: true } : {}) }
  try {
    // 上一次留下的内容可能没有以换行收尾，直接 append 会粘成 `}{`（踩过一次）
    let lead = ''
    if (existsSync(file)) {
      const raw = readFileSync(file, 'utf8')
      if (raw && !raw.endsWith('\n')) lead = '\n'
    }
    appendFileSync(file, lead + JSON.stringify(row) + '\n', 'utf8')
  } catch { /* 写不进去就算了 */ }
  return row
}

/** 兼容旧调用：只要今天那一层 */
export function todayUsage(file) {
  const s = summary(file)
  return { ...s.today, last: s.last, total: s.total, recent: s.recent, pricing: s.pricing, estimated: s.estimated }
}

export function summary(file, recentN = 5) {
  const all = readLines(file)
  // 旧格式那坨聚合和后来的逐条记录**记的是同一批调用**（in 15399 ≈ 前六条之和），
  // 一起相加就会翻倍，所以聚合只留作参考，不进账。
  const rows = all.filter((r) => !r.legacy)
  const today = dayKey()
  // 成本按行自己的 ts 重算 —— 规则修正过以后，旧账也跟着对
  const rowsWithCost = rows.map((r) => ({
    ...r,
    cost: Number(costOf(r.in || 0, r.out || 0, isPeak(r.ts || Date.now()), r.cacheHit || 0).toFixed(6)),
  }))
  const acc = (list) => list.reduce((a, r) => ({
    calls: a.calls + 1,
    in: a.in + (r.in || 0),
    out: a.out + (r.out || 0),
    cost: Number((a.cost + (r.cost || 0)).toFixed(6)),
  }), { calls: 0, in: 0, out: 0, cost: 0 })
  return {
    last: rowsWithCost.length ? rowsWithCost[rowsWithCost.length - 1] : null,
    today: acc(rowsWithCost.filter((r) => r.day === today)),
    total: acc(rowsWithCost),
    recent: rowsWithCost.slice(-recentN).reverse(),
    estimated: rows.some((r) => r.est),
    pricing: { ...priceNow(), calendarYear: beijing().year, covered: CALENDAR_YEARS.has(beijing().year) },
  }
}

/**
 * 迁移：把「整体 JSON + 粘在一起的 JSONL」这种老文件改成一行为一条。
 * 旧的按天聚合（`{"2026-10-21":{calls,inTok,…}}`）与逐条记录重复，备份后从账本里去掉。
 */
export function migrateUsage(file) {
  try {
    if (!existsSync(file)) return null
    const raw = readFileSync(file, 'utf8')
    if (!raw || !raw.includes('"inTok"')) return null
    const all = readLines(file)
    const real = all.filter((r) => !r.legacy)
    const legacy = all.filter((r) => r.legacy)
    if (!legacy.length) return null
    const backup = `${file}.bak-${Date.now()}`
    writeFileSync(backup, raw, 'utf8')
    const body = real.map((r) => JSON.stringify({
      ts: r.ts, day: r.day, kind: r.kind, model: r.model,
      in: r.in, out: r.out,
      ...(r.cacheHit ? { cacheHit: r.cacheHit } : {}),
      ...(r.est ? { est: true } : {}),
    })).join('\n')
    writeFileSync(file, body ? body + '\n' : '', 'utf8')
    return { dropped: legacy.length, kept: real.length, backup }
  } catch (e) { return { error: String(e?.message ?? e) } }
}
