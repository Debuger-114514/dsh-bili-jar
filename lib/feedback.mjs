/**
 * lib/feedback.mjs —— 赞 / 踩 / 无感 的「当前状态」折算（纯函数，不读写文件）
 * ============================================================================
 * feedback.jsonl 是**追加日志**：同一条视频会被反复写（改主意、撤销）。
 * 真正关心的是「这条现在是什么状态」，所以按时间顺序折一遍，最后一条说了算。
 *
 * 动作：
 *   like    赞        计入熟人名单（+1 次互动）
 *   dislike 踩        计入熟人名单（-2 次互动）
 *   skip    无感 😐   只在 N 天内不再推这条；**不计入**熟人名单（没态度 ≠ 不喜欢）
 *   none    撤销      把这条的选择清掉（不写进状态）
 * ============================================================================
 */

/** 会留在状态里的动作（none 只用来清） */
export const CHOICES = ['like', 'dislike', 'skip']
export const CLEAR = 'none'
export const ALL_ACTIONS = [...CHOICES, CLEAR]

/** 「无感」默认压多久不再推 */
export const SKIP_DAYS = 14

const BV_RE = /^BV[0-9A-Za-z]+$/

const tsOf = (r) => (Number.isFinite(Number(r?.ts)) ? Number(r.ts) : 0)

/**
 * 把追加日志折成「每条当前状态」。
 * 同一 bvid 按 ts 升序取最后一条；最后一条是 none 就把这条删掉。
 * @param {Array<{ts:number,bvid:string,action:string}>} rows
 * @returns {Map<string, object>} bvid → 最新那条记录
 */
export function foldFeedback(rows = []) {
  const sorted = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && typeof r.bvid === 'string' && BV_RE.test(r.bvid.trim()))
    .map((r) => ({ ...r, bvid: r.bvid.trim() }))
    .sort((a, b) => tsOf(a) - tsOf(b))
  const out = new Map()
  for (const r of sorted) {
    const action = String(r.action || '')
    if (action === CLEAR) { out.delete(r.bvid); continue }
    if (!CHOICES.includes(action)) continue
    out.set(r.bvid, r)
  }
  return out
}

/** 状态映射 → 给前端的最小形状 `{bvid: action}` */
export function stateOf(state) {
  const out = {}
  for (const [bvid, r] of state) out[bvid] = r.action
  return out
}

/** 只要赞/踩的（熟人名单用）——无感不算互动 */
export function upsRows(state) {
  return [...state.values()].filter((r) => r.action === 'like' || r.action === 'dislike')
}

/** 某个动作的全部 bvid */
export function bvidsWith(state, action) {
  const out = []
  for (const [bvid, r] of state) if (r.action === action) out.push(bvid)
  return out
}

/**
 * N 天内「无感」过的 bvid —— 这些不再进推荐。
 * 过了窗口自然失效，不需要额外清理。
 */
export function recentSkips(state, { now = Date.now(), days = SKIP_DAYS } = {}) {
  const limit = Math.max(0, Number(days) || 0) * 86400e3
  const out = []
  for (const [bvid, r] of state) {
    if (r.action !== 'skip') continue
    if (limit > 0 && now - tsOf(r) > limit) continue
    out.push(bvid)
  }
  return out
}

/** 赞/踩的当前条数（给 affinity 的「攒够 20 条」阈值用） */
export function countVotes(state) {
  let like = 0
  let dislike = 0
  for (const r of state.values()) {
    if (r.action === 'like') like += 1
    else if (r.action === 'dislike') dislike += 1
  }
  return { like, dislike, total: like + dislike }
}
