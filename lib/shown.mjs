/**
 * lib/shown.mjs —— 「最近推过什么」的落盘格式与读写
 * ============================================================================
 * 之前 shown.json 是一个纯 BV 数组（只有最近一轮 5 条），排除集太小，
 * 池子里的老面孔每轮都回来。现在存 `{ rounds: [[...] ...] }`：最近 N 轮。
 * 读的时候兼容旧格式（纯数组 = 最近一轮），老用户升级不炸。
 *
 * 2026-11 起轮数可配（`shownRounds`，默认 8）：存的时候按「配置值和默认值的较大者」留，
 * 这样调小再调回来不会把历史轮次丢光；真正参与排除的是「最近 N 轮」。
 * ============================================================================
 */

/** 默认最多记几轮（用户可在设置里改，默认 8） */
export const SHOWN_ROUNDS = 8

/** 只能收长得像 BV 号的条目：数字、空串、垃圾值直接丢 */
const BV_RE = /^BV[0-9A-Za-z]+$/

const cleanBvids = (list) => (Array.isArray(list) ? list : [])
  .filter((x) => typeof x === 'string' && BV_RE.test(x.trim()))
  .map((x) => x.trim())

const capOf = (rounds) => Math.max(1, Math.round(Number(rounds) || SHOWN_ROUNDS))

/**
 * 兼容读：旧格式（纯数组）当成 1 轮；新格式 `{ rounds }`；垃圾一律回空。
 * ⚠️ 这里**不做裁剪**，存多少读多少 —— 裁剪交给 flattenShown，避免调小配置时把数据永久丢掉。
 * @param {unknown} raw
 * @returns {{rounds: string[][]}}
 */
export function parseShown(raw) {
  if (Array.isArray(raw)) {
    const round = cleanBvids(raw)
    return { rounds: round.length ? [round] : [] }
  }
  if (raw && typeof raw === 'object' && Array.isArray(raw.rounds)) {
    return { rounds: raw.rounds.map((r) => cleanBvids(r)).filter((r) => r.length) }
  }
  return { rounds: [] }
}

/** 追加一轮（最新的在最后）；落盘时按 max(默认, 当前配置) 轮保留 */
export function pushRound(state, bvids, rounds = SHOWN_ROUNDS) {
  const cap = Math.max(SHOWN_ROUNDS, capOf(rounds))
  const all = [...parseShown(state).rounds, cleanBvids(bvids)].filter((r) => r.length)
  return { rounds: all.slice(-cap) }
}

/** 拍平成排除集（只取最近 N 轮，跨轮去重） */
export function flattenShown(state, rounds = SHOWN_ROUNDS) {
  const cap = capOf(rounds)
  return [...new Set(parseShown(state).rounds.slice(-cap).flat())]
}
