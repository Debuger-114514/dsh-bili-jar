/**
 * lib/ups.mjs —— 熟人名单：从互动记录里认出「你喜欢谁」
 * ============================================================================
 * 纯逻辑：不联网、不读文件、不依赖其它模块，所有输入由调用方传进来。
 * 契约见 docs/ups-and-refresh.md §1，签名 / 字段名 / 判定规则都以那份为准。
 *
 * 计数：
 *   1. 先按 bvid 去重，再计数   —— 同一条视频点赞三次仍然只算 1 次互动
 *   2. open / like / later 分开  —— 同一个 bvid 点开又点赞是两次互动
 *   3. 只看最近 180 天
 *   4. net = open + like + later - 2 * dislike
 *      net >= 3 → regular（熟人，预测优秀）
 *      net 1..2 → observing（观察中）
 *      net <= 0 → black（拉黑，永不再探测）
 *   5. regular 最多 20 个、observing 最多 30 个，都按 lastAt 倒序保留
 * ============================================================================
 */

/** net 到多少算熟人（>= 这个值 → regular） */
export const UP_OBSERVE_AT = 3

/** 只看最近 180 天（毫秒） */
export const UP_WINDOW_MS = 180 * 86400e3

/** regular 档最多保留几个（按 lastAt 倒序） */
export const UP_REGULAR_CAP = 20

/** observing 档最多保留几个 —— 契约没要求导出，只在本模块内部用 */
const UP_OBSERVING_CAP = 30

/** 输入一律按数组处理：调用方传 null / 垃圾也不炸 */
const asList = (x) => (Array.isArray(x) ? x : [])

/** 字段一律转成去空白的字符串 */
const asText = (x) => (x == null ? '' : String(x).trim())

/** mid 归一：'' 和 '0' 都算没有 —— history.json 里老数据全是 mid: 0 */
const asMid = (x) => {
  const s = asText(x)
  return s === '0' ? '' : s
}

/** 时间戳归一：缺失 / 非数字 → NaN，后面自然被窗口挡掉 */
const asStamp = (x) => {
  if (x == null || x === '') return NaN
  const n = typeof x === 'number' ? x : Number(x)
  return Number.isFinite(n) ? n : NaN
}

/**
 * net → 档位。用户定的三档，边界写死在这里。
 * @param {number} net
 * @returns {'regular'|'observing'|'black'}
 */
export function tierOf(net) {
  const n = Number(net)
  if (!Number.isFinite(n)) return 'black'
  if (n >= UP_OBSERVE_AT) return 'regular'
  if (n >= 1) return 'observing'
  return 'black'
}

/**
 * 从互动记录里算出熟人名单。纯函数：不改入参、没有副作用。
 *
 * 输入：feedback / history / later / pool / now（字段见契约 §1.1）
 * 输出：{ ups, byTier, midOf }（字段见契约 §1.4）
 *
 * @param {{
 *   feedback?: Array<{bvid:string, action:'like'|'dislike', ts:number}>,
 *   history?: Array<{bvid:string, mid?:string|number, author?:string, watchedAt:number}>,
 *   later?: Array<{bvid:string, mid?:string|number, author?:string, addedAt:number}>,
 *   pool?: Array<{bvid:string, mid?:string|number, author?:string}>,
 *   now?: number,
 * }} [input]
 * @returns {{
 *   ups: Array<{mid:string, name:string, open:number, like:number, later:number,
 *     dislike:number, net:number, tier:string, firstAt:number, lastAt:number, bvids:string[]}>,
 *   byTier: {regular:Array, observing:Array, black:Array},
 *   midOf: Map<string,string>,
 * }}
 */
export function buildUpList({ feedback, history, later, pool, now } = {}) {
  const fbList = asList(feedback)
  const hisList = asList(history)
  const latList = asList(later)
  const poolList = asList(pool)
  const at = asStamp(now)
  // 契约要求调用方传 now；没传时退回当前时刻，只为「空输入不炸」
  const anchor = Number.isFinite(at) ? at : Date.now()

  // ── 1. 建索引：pool 是补全 mid / author 的来源 ──────────────────────────────
  const midOf = new Map()         // bvid → mid，给 history 回填用
  const nameByMid = new Map()     // mid → 昵称
  const midsByAuthor = new Map()  // author → Set<mid>；同名多 mid 视为不可判

  const noteName = (mid, name) => {
    if (mid && name && !nameByMid.has(mid)) nameByMid.set(mid, name)
  }

  for (const p of poolList) {
    if (!p) continue
    const bvid = asText(p.bvid)
    const mid = asMid(p.mid)
    const name = asText(p.author)
    if (bvid && mid && !midOf.has(bvid)) midOf.set(bvid, mid)
    noteName(mid, name)
    if (name && mid) {
      if (!midsByAuthor.has(name)) midsByAuthor.set(name, new Set())
      midsByAuthor.get(name).add(mid)
    }
  }

  // ── 2. 条目自带的 mid 最可信，先收进 midOf（覆盖 pool 的映射）──────────────
  const entries = [...hisList, ...latList]
  for (const e of entries) {
    if (!e) continue
    const bvid = asText(e.bvid)
    const mid = asMid(e.mid)
    if (!bvid || !mid) continue
    midOf.set(bvid, mid)
    noteName(mid, asText(e.author))
  }

  // 反查顺序：显式 mid > 同一个 bvid 的精确映射 > author 在 pool 里反查。
  // 同名 author 对应多个 mid 时视为「查不到」，不按名字瞎猜。
  const midFor = (e) => {
    const explicit = asMid(e.mid)
    if (explicit) return explicit
    const bvid = asText(e.bvid)
    const exact = bvid ? midOf.get(bvid) : ''
    if (exact) return exact
    const name = asText(e.author)
    const set = name ? midsByAuthor.get(name) : null
    return set && set.size === 1 ? [...set][0] : ''
  }

  // ── 3. 逐条互动归到 UP 名下：先按 (bvid, 动作) 去重，再计数 ───────────────
  const buckets = new Map()

  const bucketOf = (mid) => {
    let b = buckets.get(mid)
    if (!b) {
      b = {
        mid,
        open: new Set(),
        like: new Set(),
        dislike: new Set(),
        later: new Set(),
        firstAt: Infinity,
        lastAt: -Infinity,
        firstByBvid: new Map(),  // bvid → 最早互动时间（bvids 的排序依据）
      }
      buckets.set(mid, b)
    }
    return b
  }

  const record = (entry, kind, timeField) => {
    if (!entry) return
    const t = asStamp(entry[timeField])
    if (!Number.isFinite(t)) return
    if (anchor - t > UP_WINDOW_MS) return   // 180 天窗口外，不计
    const bvid = asText(entry.bvid)
    if (!bvid) return
    const mid = midFor(entry)
    if (!mid) return                        // mid 反查不到 → 跳过，不猜
    if (!midOf.has(bvid)) midOf.set(bvid, mid)
    const b = bucketOf(mid)
    b[kind].add(bvid)                       // Set 去重：同一条视频重复点赞只算 1 次
    if (t < b.firstAt) b.firstAt = t
    if (t > b.lastAt) b.lastAt = t
    const seen = b.firstByBvid.get(bvid)
    if (seen == null || t < seen) b.firstByBvid.set(bvid, t)
  }

  for (const e of hisList) record(e, 'open', 'watchedAt')
  for (const e of latList) record(e, 'later', 'addedAt')
  for (const e of fbList) {
    if (!e) continue
    const action = asText(e.action).toLowerCase()
    if (action === 'like') record(e, 'like', 'ts')
    else if (action === 'dislike') record(e, 'dislike', 'ts')
    // 兼容旧日志里可能出现的 open；和 history 的 open 按 bvid 合并去重
    else if (action === 'open') record(e, 'open', 'ts')
  }

  // ── 4. 算 net、分档、裁上限 ────────────────────────────────────────────────
  const ups = []
  for (const b of buckets.values()) {
    const open = b.open.size
    const like = b.like.size
    const later = b.later.size
    const dislike = b.dislike.size
    const positive = open + like + later
    const net = positive - 2 * dislike
    const bvids = [...b.firstByBvid.entries()]
      .sort((x, y) => x[1] - y[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
      .map(([bvid]) => bvid)
    ups.push({
      mid: b.mid,
      name: nameByMid.get(b.mid) || '',
      open,
      like,
      later,
      dislike,
      net,
      tier: tierOf(net),
      firstAt: b.firstAt,
      lastAt: b.lastAt,
      bvids,
    })
  }

  // lastAt 倒序；同一时刻按 mid 排，保证结果可重放
  const byLast = (a, b) => b.lastAt - a.lastAt || (a.mid < b.mid ? -1 : a.mid > b.mid ? 1 : 0)
  const pick = (tier, cap) => ups.filter((u) => u.tier === tier).sort(byLast).slice(0, cap)

  const byTier = {
    regular: pick('regular', UP_REGULAR_CAP),
    observing: pick('observing', UP_OBSERVING_CAP),
    black: ups.filter((u) => u.tier === 'black').sort(byLast),   // 拉黑档不设上限
  }

  return {
    ups: [...byTier.regular, ...byTier.observing, ...byTier.black],
    byTier,
    midOf,
  }
}
