/**
 * lib/shown.mjs —— 「最近推过什么」的落盘格式与读写
 * ============================================================================
 * 之前 shown.json 是一个纯 BV 数组（只有最近一轮 5 条），排除集太小，
 * 池子里的老面孔每轮都回来。现在存 `{ rounds: [[...] ...] }`：最近 5 轮、最多 25 条。
 * 读的时候兼容旧格式（纯数组 = 最近一轮），老用户升级不炸。
 * ============================================================================
 */

/** 最多记几轮 */
export const SHOWN_ROUNDS = 5

/** 只收长得像 BV 号的条目：数字、空串、垃圾值直接丢 */
const BV_RE = /^BV[0-9A-Za-z]+$/

const cleanBvids = (list) => (Array.isArray(list) ? list : [])
  .filter((x) => typeof x === 'string' && BV_RE.test(x.trim()))
  .map((x) => x.trim())

/**
 * 兼容读：旧格式（纯数组）当成 1 轮；新格式 `{ rounds }`；垃圾一律回空。
 * @param {unknown} raw
 * @returns {{rounds: string[][]}}
 */
export function parseShown(raw) {
  if (Array.isArray(raw)) {
    const round = cleanBvids(raw)
    return { rounds: round.length ? [round] : [] }
  }
  if (raw && typeof raw === 'object' && Array.isArray(raw.rounds)) {
    const rounds = raw.rounds
      .map((r) => cleanBvids(r))
      .filter((r) => r.length)
      .slice(-SHOWN_ROUNDS)
    return { rounds }
  }
  return { rounds: [] }
}

/** 追加一轮（最新的在最后），超过 SHOWN_ROUNDS 轮丢最旧的 */
export function pushRound(state, bvids) {
  const rounds = [...parseShown(state).rounds, cleanBvids(bvids)].filter((r) => r.length)
  return { rounds: rounds.slice(-SHOWN_ROUNDS) }
}

/** 拍平成排除集（跨轮去重） */
export function flattenShown(state) {
  return [...new Set(parseShown(state).rounds.flat())]
}
