/**
 * lib/pool.mjs —— 候选池：搜、筛、打分、组片单
 * ============================================================================
 * 这一层**完全不碰 LLM**。规则写在这儿，所以行为可复现、可解释、可回放。
 *
 * 2026-10-21 第五轮：轴从「一层词表」升级成**树**
 *   · 轴 = 一级（时政 / 科技测评 / 健身教程 / deepseek）
 *   · 子簇 = 二级（时政→中东/美国/俄乌/台海；科技测评→硬件/耳机/手机/笔记本）
 *     子簇来自 tag 共现聚类（见 docs/tag-tree.md），不是拍脑袋写的
 *   · **分区（typename）当骨架**：命中分区给先验加分，但因为分区很粗，只加分不否决
 *   · 检索词 = 主词 + 每小时轮换的一个子簇词 ⇒ 每天搜到的东西不一样
 *
 * 上一轮（投币/收藏）：质量信号 = 点赞率 + 投币率 + 收藏率 + 弹幕率
 * ============================================================================
 */
import { searchVideos, userVideos, searchUsers, userInfo, videoDetail, relatedVideos } from './bili.mjs'
import { nodeFor, AXIS_TREE, SYNONYMS } from './tree.mjs'
import { freshnessOf, decideFreshness, EVERGREEN_AFTER_DAYS } from './freshness.mjs'

// 树数据本身搬到了 lib/tree.mjs（内置 + 用户长出来的枝）
export { AXIS_TREE, SYNONYMS }

/**
 * 轴树。改这里就够了 —— 用户加一根轴、改一个子簇，都在这一个对象里。
 *
 * 字段：
 *   search  检索词（前 2 个固定用，第 3 个从 subs 里轮换）
 *   groups  匹配规则：每一组都要命中（多组时第一组是"领域词"，必须在 tag 里）
 *   subs    子簇：用于检索轮换 和 卡片上的细分标签
 *   cats    分区名（typename）：命中即加分，不命中不否决
 *   none    否决词
 */
/** 直播回放 / 录播 */
const REPLAY_RE = /直播回放|回放|录播|直播录像|直播切片|直播实录/
/** 泛 tag：一条内容只有这些 tag，说明 UP 没认真分类 */
const GENERIC_TAGS = new Set(['必剪创作', '直播', '高能', '生活记录', 'vlog', '原创', '日常', '记录', '自制', '剪辑'])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 检索混血：综合排序天然把老爆款排前面，全部走它 = 池子进料偏老。
 * 第 1 个词（主词）走综合保相关性，第 3 个（按小时轮换的子簇词）走「最新发布」，
 * 给新视频留一个稳定入口。没有子簇词的轴自然没有这一槽。
 */
const ORDER_BY_SLOT = ['totalrank', 'totalrank', 'pubdate']

/**
 * 这根轴这一轮用哪几个检索词：前两个固定，第三个从子簇里按小时轮换。
 * ⇒ 每天搜到的东西不一样，池子才会长。
 */
export function termsOf(axis, hour = new Date().getHours()) {
  const t = nodeFor(axis)
  const base = (t.search || []).slice(0, 2)
  const subs = t.subs || []
  const sub = subs.length ? subs[Math.abs(hour) % subs.length] : null
  const list = [...base, sub?.terms?.[0]].filter(Boolean)
  return Array.from(new Set(list)).slice(0, 3)
}

const isAscii = (s) => /^[\x00-\x7F]+$/.test(s)
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 命不命中一个词（5 字符以内的 ASCII 词按词边界，否则 ai 会命中 detail） */
function hitTerm(hay, term) {
  const t = String(term).toLowerCase().trim()
  if (!t) return false
  if (isAscii(t) && t.length <= 5) return new RegExp(`(^|[^a-z0-9])${esc(t)}([^a-z0-9]|$)`, 'i').test(hay)
  return hay.includes(t)
}

/**
 * 一条视频有多贴近一根轴。
 * @returns {{sim:number, qualified:boolean, hits:string[], sub:string, vetoed:boolean, catHit:boolean}}
 */
export function axisSim(item, axis) {
  const t = nodeFor(axis)
  const tags = (item.tags || []).map((x) => String(x).toLowerCase())
  const tagHay = ' ' + tags.join(' ') + ' '
  const hay = (String(item.title || '') + ' ' + tags.join(' ')).toLowerCase()

  const empty = { sim: 0, qualified: false, hits: [], sub: '', vetoed: false, catHit: false }
  if ((t.none || []).some((w) => hitTerm(hay, w))) return { ...empty, vetoed: true }

  const all = t.groups || []
  const noTags = tags.length === 0
  const hits = []
  let groupHits = 0
  all.forEach((g, gi) => {
    // 多组轴的第一组是「领域词」，必须在 tag 里命中；但整条没 tag 时放宽
    const scope = gi === 0 && all.length > 1 && !noTags ? tagHay : hay
    const hit = g.find((w) => hitTerm(scope, w))
    if (hit) { groupHits += 1; hits.push(hit) }
  })

  const ratio = all.length ? groupHits / all.length : 0
  const partial = Math.min(1, hits.length / 3)
  // 分区先验：分区很粗，只加分不否决
  const catHit = (t.cats || []).includes(String(item.typeName || ''))
  const sim = Math.min(1, ratio * 0.85 + partial * 0.15 + (catHit ? 0.1 : 0))

  // 子簇：命中的第一个就是这一条的细分标签
  const sub = (t.subs || []).find((s) => (s.terms || []).some((w) => hitTerm(hay, w)))?.name || ''

  return {
    sim: Number(sim.toFixed(3)),
    qualified: all.length > 0 && groupHits === all.length,
    hits, sub, vetoed: false, catHit,
  }
}

const SPAM_RE = /劲爆|震惊|突发|速看|惊了|笑死|必看|不看后悔|全网|史上最|破防|泪目|干惨|炸了|凉了|最坏打算|做好准备/g
export function spamScore(title) {
  const s = String(title || '')
  const hits = (s.match(SPAM_RE) || []).length
  const bangs = (s.match(/[!！]/g) || []).length
  return Math.min(1, hits * 0.5 + Math.max(0, bangs - 1) * 0.25)
}

const daysAgo = (ts) => {
  const s = Number(ts)
  if (!Number.isFinite(s) || s <= 0) return 99
  return (Date.now() / 1000 - s) / 86400
}

const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0))

const fmtDur = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`

/** 互动率。满分刻度：点赞 8%、投币 3%、收藏 4%、弹幕 2% */
function ratesOf(it) {
  const play = Number(it.play) || 0
  const like = Number(it.like ?? it.raw?.like ?? 0)
  const coin = Number(it.coin ?? it.raw?.coin ?? 0)
  const fav = Number(it.favorites ?? it.raw?.favorites ?? 0)
  const dm = Number(it.danmaku ?? it.raw?.danmaku ?? 0)
  if (!play) return { likeRate: 0, coinRate: 0, favRate: 0, danmakuRate: 0, like: 0, coin: 0, fav: 0, dm: 0 }
  return {
    likeRate: Math.min(1, (like / play) / 0.08),
    coinRate: Math.min(1, (coin / play) / 0.03),
    favRate: Math.min(1, (fav / play) / 0.04),
    danmakuRate: Math.min(1, (dm / play) / 0.02),
    like, coin, fav, dm,
  }
}

function isGenericTags(tags) {
  const t = (tags || []).map((x) => String(x).trim()).filter(Boolean)
  if (!t.length) return true
  return t.filter((x) => !GENERIC_TAGS.has(x.toLowerCase())).length === 0
}

/**
 * 赞/踩带来的分数微调（单独拆出来是为了能直接测）。
 * 上限压得很死：它该是微调，不该盖过「贴不贴轴」。
 * @param {object} it 候选
 * @param {{ready:boolean, authors?:Map, dislikes?:Map, tags?:Map, tagDislikes?:Map}} aff
 * @returns {number} 分数增量（未 ready 时恒为 0）
 */
export function affinityDelta(it, aff) {
  if (!aff?.ready) return 0
  const up = String(it.mid || it.author || '')
  const upLikes = aff.authors?.get(up) || 0
  const upDislikes = aff.dislikes?.get(up) || 0
  let tagDelta = 0
  for (const tag of (it.tags || []).slice(0, 6)) {
    tagDelta += (aff.tags?.get(tag) || 0) * 0.004
    tagDelta -= (aff.tagDislikes?.get(tag) || 0) * 0.006
  }
  tagDelta = Math.max(-0.05, Math.min(0.03, tagDelta))
  return Math.max(-0.2, Math.min(0.12,
    Math.min(0.10, upLikes * 0.04) - Math.min(0.16, upDislikes * 0.07) + tagDelta))
}


/**
 * 小众 tag 分：这条视频的 tag 在池子里越罕见，分越高。
 * 目的是不让「必剪创作 / 高能」这类大标签把长尾内容挤掉。
 * 取「最罕见的 3 个 tag」的平均稀有度 —— 只要有几个具体标签就算数，
 * 不要求每条都小。
 * @param {object} it 候选
 * @param {Map<string,number>} [tagDf] 池内 tag 出现次数
 * @param {number} [total] 池子规模
 */
export function nicheScore(it, tagDf, total) {
  if (!tagDf || !total) return 0
  const tags = Array.from(new Set((it.tags || []).map((x) => String(x).toLowerCase().trim()).filter(Boolean)))
  if (!tags.length) return 0
  const rarity = tags
    .map((t) => 1 - Math.min(1, (tagDf.get(t) || 0) / total))
    .sort((a, b) => b - a)
    .slice(0, 3)
  return Number((rarity.reduce((a, b) => a + b, 0) / rarity.length).toFixed(4))
}

/**
 * 两套打分权重，各自合计 1.00（tools/score-freshness-check.mjs 有断言）。
 * evergreen 把时效的 0.08 差额匀给了播放（+0.03）和小众 tag（+0.05）：
 * 常青轴不靠新鲜度区分好坏，靠的是长尾品质 —— 小众 tag 和播放积累才是它的信号。
 */
export const WEIGHTS = {
  news: { sim: 0.30, like: 0.15, coin: 0.12, fav: 0.12, fresh: 0.10, sub: 0.06, play: 0.05, multi: 0.04, niche: 0.06 },
  evergreen: { sim: 0.30, like: 0.15, coin: 0.12, fav: 0.12, fresh: 0.02, sub: 0.06, play: 0.08, multi: 0.04, niche: 0.11 },
}

/** 池子上限：超过就按 lastSeen 从旧到新删（见 capPool） */
export const POOL_CAP = 400

/** 重复出现的扣分：进过 main 一次 +0.03，封顶 0.15 —— 是抑制不是判死 */
export function repeatPenalty(shownTimes) {
  return Math.min(0.15, 0.03 * (Number(shownTimes) || 0))
}

/** 给整批已打分的条目扣重复分（buildPool 在 gem 加成之后、终排序之前调用） */
export function applyRepeatPenalty(items) {
  for (const it of items || []) {
    const pen = repeatPenalty(it?.shownTimes)
    if (pen > 0 && Number.isFinite(Number(it?.score))) {
      it.score = Number(Math.max(0, Number(it.score) - pen).toFixed(4))
    }
  }
  return items
}

/**
 * 池子上限：超过 cap 时，lastSeen 最旧的先走；同 lastSeen 的优先删 shownTimes 高的
 * （露脸多还没人看的，最没有留下来的价值）。
 */
export function capPool(entries, cap = POOL_CAP) {
  const list = (entries || []).filter((e) => e?.bvid)
  if (list.length <= cap) return list
  const doomed = [...list]
    .sort((a, b) =>
      (Number(a.lastSeen) || 0) - (Number(b.lastSeen) || 0) ||
      (Number(b.shownTimes) || 0) - (Number(a.shownTimes) || 0))
    .slice(0, list.length - cap)
  const drop = new Set(doomed)
  return list.filter((e) => !drop.has(e))
}

/** 给一条候选算分（详情回来之后要重算一次）。导出仅为测试与 tools/why.mjs 复用。 */
export function scoreItem(it, axes, aff, ctx) {
  const sims = {}
  let best = { axis: '', sim: 0, hits: [], sub: '' }
  let vetoed = false
  for (const axis of axes) {
    const s = axisSim(it, axis)
    if (s.vetoed) vetoed = true
    sims[axis] = s.qualified ? s.sim : 0
    if (s.qualified && s.sim > best.sim) best = { axis, sim: s.sim, hits: s.hits, sub: s.sub }
  }
  it.sims = sims
  it.bestAxis = best.axis
  it.axesHit = axes.filter((a) => sims[a] >= 0.85)
  it.vetoed = vetoed
  if (!best.axis) return false

  const r = ratesOf(it)
  // 时效按轴走：兑现 freshness.mjs 承诺的两套权重 ——
  //   news      用全局 maxDays 归一，权重 0.10（超过窗口的老条目直接归零）
  //   evergreen 用 365 天软衰减，权重 0.02（100 天的老片仍有分，不再一律清零）
  const fresh = freshnessOf(best.axis)
  const w = WEIGHTS[fresh] || WEIGHTS.news
  const window = fresh === 'evergreen' ? 365 : Math.max(1, Number(ctx?.maxDays) || 14)
  const freshN = clamp01(1 - daysAgo(it.pubdate) / window)
  const niche = nicheScore(it, ctx?.tagDf, ctx?.tagTotal)
  const subFlag = it.subtitle ? 1 : 0
  const playBoost = Math.min(1, Math.log10((it.play || 0) + 10) / 7)
  const spam = spamScore(it.title)
  const generic = isGenericTags(it.tags) ? 1 : 0

  const base =
    best.sim * w.sim +
    r.likeRate * w.like +
    r.coinRate * w.coin +
    r.favRate * w.fav +
    freshN * w.fresh +
    subFlag * w.sub +
    playBoost * w.play +
    Math.min(1, it.axesHit.length) * w.multi +
    niche * w.niche

  it.axis = best.axis
  it.sub = best.sub || ''
  it.rates = r
  it.freshN = Number(freshN.toFixed(4))
  let score = base * (1 - 0.45 * spam) * (1 - 0.12 * generic)

  /* 赞/踩带来的偏好（只在攒够阈值后启用，见 index.js 的 FEEDBACK_MIN）：
   * 同一个 UP 被你赞过就加分、被踩过就减分；tag 命中也小幅加减。
   * 上限压得很死 —— 它该是微调，不该盖过「贴不贴轴」。 */
  const affDelta = affinityDelta(it, aff)
  score += affDelta
  it.affinity = Number(affDelta.toFixed(4))
  it.score = Number(Math.max(0, Math.min(1.2, score)).toFixed(4))
  it.reasons = []
  it.reasons.push(`贴近「${best.axis}${best.sub ? ' · ' + best.sub : ''}」${best.hits.length ? '：' + best.hits.slice(0, 3).join('、') : ''}`)
  if (it.axesHit.length > 1) it.reasons.push(`同时像 ${it.axesHit.filter((a) => a !== best.axis).join('、')}`)
  if (r.favRate >= 0.5) it.reasons.push('收藏率高')
  else if (r.coinRate >= 0.5) it.reasons.push('投币率高')
  else if (r.likeRate >= 0.5) it.reasons.push('点赞率高')
  if (freshN > 0.7 && window <= 30) it.reasons.push('这两天发的')
  if (niche >= 0.75) it.reasons.push('tag 很小众（加成）')
  if (subFlag) it.reasons.push('有字幕')
  if (spam >= 0.3) it.reasons.push('标题党倾向（降权）')
  if (generic) it.reasons.push('tag 很泛（降权）')
  if (it.affinity >= 0.02) it.reasons.push('你赞过这个 UP 或这类 tag（加权）')
  else if (it.affinity <= -0.02) it.reasons.push('你踩过这个 UP 或这类 tag（降权）')
  return true
}

/**
 * 建池（累积）
 */

/** B站 搜索的时长带：1=<10分, 2=10–30, 3=30–60, 4=>60分。取覆盖区间中点的那个带。 */
export function bandOf(minMinutes, maxMinutes) {
  const lo = Number(minMinutes) || 0
  const hi = Number(maxMinutes) || 0
  const mid = (lo + Math.max(lo, hi)) / 2
  if (!hi) return 0
  if (mid < 10) return 1
  if (mid < 30) return 2
  if (mid < 60) return 3
  return 4
}

/** 把搜索结果统一成池子里的条目形状（合并段和补货段共用） */
function toCandidate(it, now, old = null) {
  return {
    bvid: it.bvid,
    title: it.title,
    author: it.author,
    mid: it.mid,
    duration: Number(it.duration) || old?.duration || 0,
    pubdate: it.pubdate || old?.pubdate || 0,
    play: Math.max(Number(it.play) || 0, Number(old?.play) || 0),
    like: Number(it.like ?? old?.like ?? 0),
    coin: Number(it.coin ?? old?.coin ?? 0),
    danmaku: Number(it.danmaku ?? old?.danmaku ?? 0),
    favorites: Number(it.favorites ?? old?.favorites ?? 0),
    tags: (it.tags?.length ? it.tags : old?.tags) || [],
    typeName: it.typeName || old?.typeName || '',
    subtitle: Boolean(it.subtitle ?? old?.subtitle),
    isCharge: Boolean(it.isCharge ?? old?.isCharge),
    pic: it.pic || old?.pic || '',
    firstSeen: old?.firstSeen || now,
    lastSeen: now,
    shownTimes: Number(old?.shownTimes) || 0,
  }
}

export async function buildPool(cfg, log = () => {}, prev = []) {
  const axes = (cfg.axes || []).map((s) => String(s).trim()).filter(Boolean)
  const minSec = (Number(cfg.minMinutes) || 0) * 60
  const maxSec = (Number(cfg.maxMinutes) || 0) * 60
  const minPlay = Number(cfg.minPlay) || 0
  const detailCount = Number(cfg.detailCount) || 12
  const showCharging = cfg.showCharging === true
  /** 只看最近多少天；0 = 不限 */
  const maxDays = cfg.maxDays === undefined ? 14 : Number(cfg.maxDays)
  /** 赞/踩带来的偏好（可能还没攒够，ready=false 时完全不参与） */
  const aff = cfg.affinity || null
  const allowReplay = cfg.allowReplay === true
  const stats = { searches: 0, raw: 0, noBvid: 0, dur: 0, charge: 0, old: 0, replay: 0, lowPlay: 0, noAxis: 0, vetoed: 0, details: 0, expanded: 0, byOrder: { totalrank: 0, pubdate: 0 }, perAxis: {} }

  // ---- 1. 搜（主词 + 按小时轮换的子簇词；第 3 个词走「最新发布」）----
  const hour = Math.floor(Date.now() / 3600000)
  const fresh = new Map()
  for (const axis of axes) {
    const terms = termsOf(axis, hour)
    for (let i = 0; i < terms.length; i += 1) {
      const order = ORDER_BY_SLOT[i] || 'totalrank'
      stats.searches += 1
      stats.byOrder[order] = (stats.byOrder[order] || 0) + 1
      let r
      try { r = await searchVideos(terms[i], 1, order) } catch (e) { log(`搜「${terms[i]}」失败：${e?.message ?? e}`); continue }
      stats.raw += r.items.length
      for (const it of r.items) {
        if (!it.bvid) { stats.noBvid += 1; continue }
        fresh.set(it.bvid, it)
      }
      await sleep(400)
    }
  }

  // ---- 2. 合并（新覆盖旧）----
  const merged = new Map()
  for (const p of (prev || [])) {
    if (!p?.bvid) continue
    merged.set(p.bvid, { ...p })
  }
  const now = Date.now()
  for (const it of fresh.values()) {
    const old = merged.get(it.bvid)
    merged.set(it.bvid, toCandidate(it, now, old))
  }

  // ---- 2b. 池子上限：只进不出的池子会让老条目永远在场。
  //     重现过的条目 lastSeen 被刷成 now，自然排在删除序的最后；一直不重现的先走。 ----
  if (merged.size > POOL_CAP) {
    const kept = capPool(Array.from(merged.values()))
    merged.clear()
    for (const it of kept) merged.set(it.bvid, it)
    log(`池子超限，裁到 ${merged.size} 条（删 lastSeen 最旧的）`)
  }

  // ---- 3. 硬过滤（日期按轴走：news 用全局窗口，evergreen 不限） ----
  const passesHard = (it) => {
    if (minSec && it.duration < minSec) return 'dur'
    if (maxSec && it.duration > maxSec) return 'dur'
    if (!showCharging && it.isCharge) return 'charge'
    if (!allowReplay && (REPLAY_RE.test(it.title || '') || REPLAY_RE.test(it.author || ''))) return 'replay'
    if (minPlay && (it.play || 0) < minPlay) return 'lowPlay'
    return ''
  }

  /**
   * 本轮实际生效的 freshness：先按配置，必要时在同一轮里就地改判。
   * （判定要等有数才知道，所以允许本轮改、下一轮沿用。）
   */
  const effective = new Map(axes.map((ax) => [ax, freshnessOf(ax)]))
  const windowFor = (axis) => (effective.get(axis) === 'evergreen' ? 0 : maxDays)

  /** 按当前 effective 分组：每根轴有哪些条目、各自多老 */
  const collect = () => {
    const out = new Map(axes.map((ax) => [ax, []]))
    const anyAge = new Map(axes.map((ax) => [ax, []]))
    for (const it of merged.values()) {
      if (passesHard(it)) continue
      const age = daysAgo(it.pubdate)
      for (const axis of axes) {
        if (!axisSim(it, axis).qualified) continue
        anyAge.get(axis).push(age)          // 不看日期，用于判断这根轴有多老
        const w = windowFor(axis)
        if (w > 0 && age > w) continue
        out.get(axis).push(it)
        break
      }
    }
    return { byAxis: out, agesAll: anyAge }
  }

  const median = (list) => {
    const a = list.filter((n) => Number.isFinite(n)).sort((x, y) => x - y)
    return a.length ? a[Math.floor(a.length / 2)] : 0
  }

  let { byAxis, agesAll } = collect()

  // ---- 3b. 冷门轴补货：凑不够 3 条时换检索通道（时长带 + 种子扩散） ----
  const thinNow = () => axes.filter((a) => byAxis.get(a).length < 3)
  let thin = thinNow()
  if (thin.length && cfg.expand !== false) {
    for (const axis of thin) {
      const have = new Set(merged.keys())
      // 种子不要求合格：内容对的邻域就够了（实测拿 718 分钟的攻略当种子也能捞到 30 分的好片）
      const mine = Array.from(merged.values())
        .filter((it) => axisSim(it, axis).qualified)
        .sort((a, b) => (b.play || 0) - (a.play || 0))
      // ① 时长带重搜：B站 的 duration 参数能把整页结果限制在想要的时长里。
      //    排序跟轴走：news 轴要的是新内容，走「最新发布」；evergreen 轴要的是老神作，走综合。
      const band = bandOf(cfg.minMinutes, cfg.maxMinutes)
      if (band) {
        stats.searches += 1
        const bandOrder = freshnessOf(axis) === 'evergreen' ? 'totalrank' : 'pubdate'
        stats.byOrder[bandOrder] = (stats.byOrder[bandOrder] || 0) + 1
        try {
          const r = await searchVideos((nodeFor(axis).search || [axis])[0], 1, bandOrder, band)
          for (const it of r.items) if (it.bvid && !have.has(it.bvid)) { merged.set(it.bvid, toCandidate(it, now)); have.add(it.bvid); stats.expanded += 1 }
        } catch (e) { log(`时长带搜「${axis}」失败：${e?.message ?? e}`) }
        await sleep(300)
      }
      // ② 种子扩散：搜索会被新内容挤满，related 不会
      for (const seed of mine.slice(0, 3)) {
        if (!seed?.bvid) continue
        stats.searches += 1
        try {
          const r = await relatedVideos(seed.bvid)
          for (const it of r.items) if (it.bvid && !have.has(it.bvid)) { merged.set(it.bvid, toCandidate(it, now)); have.add(it.bvid); stats.expanded += 1 }
        } catch (e) { log(`相关推荐「${seed.bvid}」失败：${e?.message ?? e}`) }
        await sleep(250)
      }
    }
    ;({ byAxis, agesAll } = collect())
  }

  // ---- 3c. 就地改判：news 轴凑不够 3 条，但它的内容普遍很老 → 本轮按 evergreen 再收一次 ----
  let switched = []
  for (const axis of thinNow()) {
    if (effective.get(axis) === 'evergreen') continue
    const mid = median(agesAll.get(axis) || [])
    if (mid > EVERGREEN_AFTER_DAYS) {
      effective.set(axis, 'evergreen')
      switched.push(`${axis}（中位 ${Math.round(mid)} 天）`)
    }
  }
  if (switched.length) {
    ;({ byAxis, agesAll } = collect())
    log(`时效改判：${switched.join('、')} → 不过期`)
  }

  const candidates = []
  for (const it of merged.values()) {
    if (passesHard(it)) continue
    const age = daysAgo(it.pubdate)
    for (const axis of axes) {
      const w = windowFor(axis)
      if (w > 0 && age > w) continue
      if (axisSim(it, axis).qualified) { candidates.push(it); break }
    }
  }

  // 池内 tag 频次：用来算「小众 tag」分（tag 越罕见越加分）
  const tagDf = new Map()
  for (const it of candidates) {
    for (const t of new Set((it.tags || []).map((x) => String(x).toLowerCase().trim()).filter(Boolean))) {
      tagDf.set(t, (tagDf.get(t) || 0) + 1)
    }
  }
  const scoreCtx = { maxDays, tagDf, tagTotal: candidates.length }

  // ---- 4. 初评 ----
  const qualified = []
  for (const it of candidates) {
    if (scoreItem(it, axes, aff, scoreCtx)) qualified.push(it)
    else if (it.vetoed) stats.vetoed += 1
    else stats.noAxis += 1
  }
  qualified.sort((a, b) => b.score - a.score)

  // ---- 4b. 每轴统计：合格数 + 年龄中位（决定这根轴该 news 还是 evergreen） ----
  for (const axis of axes) {
    const mine = qualified.filter((it) => it.bestAxis === axis)
    const ages = mine.map((it) => daysAgo(it.pubdate))
    const d = decideFreshness(ages)
    stats.perAxis[axis] = { ok: mine.length, medianAge: Math.round(d.medianAge), suggest: d.freshness, reason: d.reason }
  }

  // ---- 5. 决赛圈查详情：补投币 ----
  const top = qualified.slice(0, detailCount)
  for (const it of top) {
    try {
      const d = await videoDetail(it.bvid)
      if (d.ok && d.data?.stat) {
        const s = d.data.stat
        if (Number(s.view) > 0) it.play = Number(s.view)
        if (Number(s.like) > 0) it.like = Number(s.like)
        if (Number(s.coin) > 0) it.coin = Number(s.coin)
        if (Number(s.favorite) > 0) it.favorites = Number(s.favorite)
        if (Number(s.danmaku) > 0) it.danmaku = Number(s.danmaku)
        it.detail = true
        stats.details += 1
      }
    } catch (e) { log(`查详情失败 ${it.bvid}：${e?.message ?? e}`) }
    await sleep(300)
  }
  for (const it of top) scoreItem(it, axes, aff, scoreCtx)
  qualified.sort((a, b) => b.score - a.score)

  // ---- 5.5 宝藏：收藏率 + 投币率双双进前 20% ----
  const pctile = (arr, p) => {
    const a = arr.filter((n) => Number.isFinite(n)).sort((x, y) => x - y)
    if (!a.length) return 0
    return a[Math.min(a.length - 1, Math.floor(a.length * p))]
  }
  const favCut = Math.max(0.25, pctile(qualified.map((c) => c.rates?.favRate ?? 0), 0.8))
  const coinCut = Math.max(0.18, pctile(qualified.map((c) => c.rates?.coinRate ?? 0), 0.8))
  for (const c of qualified) {
    if ((c.rates?.favRate ?? 0) >= favCut && (c.rates?.coinRate ?? 0) >= coinCut) {
      c.gem = true
      c.score = Number((c.score + 0.04).toFixed(4))
      c.reasons.unshift('💎 宝藏：收藏 + 投币双高')
    }
  }
  qualified.sort((a, b) => b.score - a.score)

  // ---- 5.6 重复惩罚：进过 main 的条目逐轮扣分（封顶 0.15），把位置让给新面孔 ----
  applyRepeatPenalty(qualified)
  qualified.sort((a, b) => b.score - a.score)

  // ---- 6. 粉丝区间 ----
  const fanMin = Number(cfg.fanMin) || 0
  const fanMax = Number(cfg.fanMax) || 0
  if (fanMin || fanMax) {
    const mids = Array.from(new Set(qualified.map((c) => String(c.mid))))
    const fans = new Map()
    for (const mid of mids.slice(0, 10)) {
      try {
        const r = await userInfo(mid)
        if (r.ok) fans.set(mid, r.data.fans)
      } catch (e) { log(`查粉丝失败 mid=${mid}：${e?.message ?? e}`) }
      await sleep(400)
    }
    for (let i = qualified.length - 1; i >= 0; i -= 1) {
      const f = fans.get(String(qualified[i].mid))
      if (f == null) continue
      if ((fanMin && f < fanMin) || (fanMax && f > fanMax)) qualified.splice(i, 1)
      else qualified[i].fans = f
    }
  }

  // ---- 7. 按轴轮转 + 同 UP 限一格 ----
  const mainCount = Number(cfg.mainCount) || 5
  const picked = []
  const taken = new Set()
  const perAxisCount = new Map()
  const perUpCount = new Map()
  const exclude = new Set(cfg.exclude || [])

  const tryPick = (c, why) => {
    if (picked.length >= mainCount) return false
    if (taken.has(c.bvid)) return false
    if (exclude.has(c.bvid)) return false
    const up = String(c.mid || c.author)
    if ((perUpCount.get(up) || 0) >= 1) return false
    c.pickedFor = why
    picked.push(c)
    taken.add(c.bvid)
    perUpCount.set(up, (perUpCount.get(up) || 0) + 1)
    perAxisCount.set(c.axis, (perAxisCount.get(c.axis) || 0) + 1)
    return true
  }

  for (const axis of axes) {
    if (picked.length >= mainCount) break
    const best = qualified.find((c) => !taken.has(c.bvid) && (c.sims?.[axis] || 0) >= 0.85)
    if (best) tryPick(best, axis)
  }
  for (const c of qualified) {
    if (picked.length >= mainCount) break
    if ((perAxisCount.get(c.axis) || 0) >= 2) continue
    tryPick(c, c.axis)
  }

  // 进过 main 的计数 +1，随池子落盘，下一轮按 repeatPenalty 扣分。
  // （/more 追加的条目不算 —— 那条路不走建池，没有 picked。）
  for (const p of picked) p.shownTimes = (Number(p.shownTimes) || 0) + 1

  const covered = new Set(picked.flatMap((p) => p.axesHit || []))

  // ---- 8. 固定 UP ----
  const upItems = []
  const upResolved = []
  for (const entry of (cfg.ups || [])) {
    const raw = String(entry || '').trim()
    if (!raw) continue
    let mid = /^\d+$/.test(raw) ? raw : ''
    let name = ''
    try {
      if (!mid) {
        const s = await searchUsers(raw)
        const hit = s.items[0]
        if (hit) { mid = String(hit.mid); name = hit.name }
        await sleep(400)
      }
      if (!mid) { log(`找不到 UP：${raw}`); continue }
      const r = await userVideos(mid, Number(cfg.upCount) || 6)
      if (!r.ok) { log(`拉投稿失败 ${name || mid}：${r.message}`); continue }
      const kept = r.items.filter((v) => v.bvid && (showCharging || !v.isCharge))
      upResolved.push({ mid, name: name || kept[0]?.author || mid, count: kept.length })
      for (const v of kept) upItems.push({ ...v, fromUp: true, reasons: ['固定关注'] })
      await sleep(500)
    } catch (e) { log(`固定 UP 失败 ${raw}：${e?.message ?? e}`) }
  }
  upItems.sort((a, b) => (b.pubdate || 0) - (a.pubdate || 0))

  const poolOut = candidates.map((c) => ({
    bvid: c.bvid, title: c.title, author: c.author, mid: c.mid,
    duration: c.duration, pubdate: c.pubdate, play: c.play,
    like: c.like, coin: c.coin, danmaku: c.danmaku, favorites: c.favorites,
    tags: c.tags, typeName: c.typeName, subtitle: c.subtitle, isCharge: c.isCharge, pic: c.pic,
    firstSeen: c.firstSeen, lastSeen: c.lastSeen,
    shownTimes: c.shownTimes || 0,
  }))

  return {
    ok: true,
    ts: Date.now(),
    axes,
    terms: Object.fromEntries(axes.map((a) => [a, termsOf(a, hour)])),
    stats: {
      ...stats,
      pool: poolOut.length, qualified: qualified.length, picked: picked.length, up: upItems.length,
      /** 池子里最近 7 天内发布的条目数：看新内容有没有真的进池 */
      fresh: poolOut.filter((c) => daysAgo(c.pubdate) <= 7).length,
    },
    coverage: { axes, covered: Array.from(covered), missing: axes.filter((a) => !covered.has(a)) },
    main: picked.map(toCard),
    /**
     * 决赛圈（给 LLM 策展人看的候选，比 main 多）。
     * ⚠️ 这里也要剔掉 exclude：换一批时模型一样不该再挑刚推过的，
     *    之前只挡了规则挑选，模型路径照样把老条目挑回来。
     */
    shortlist: qualified.filter((c) => !exclude.has(c.bvid)).slice(0, 24).map(toCard),
    up: upItems.slice(0, 12).map(toCard),
    upResolved,
    pool: poolOut,
  }
}

export function toCard(it) {
  const d = Number(it.duration) || 0
  const r = it.rates || ratesOf(it)
  const play = Number(it.play) || 0
  const pct = (n) => (play > 0 ? Number(((Number(n) || 0) / play * 100).toFixed(2)) : 0)
  return {
    bvid: it.bvid,
    title: it.title,
    author: it.author,
    mid: it.mid,
    duration: d,
    durationText: fmtDur(d),
    pubdate: it.pubdate,
    play: it.play,
    like: r.like || 0,
    coin: r.coin || 0,
    fav: r.fav || 0,
    pct: { like: pct(r.like), coin: pct(r.coin), fav: pct(r.fav) },
    tags: (it.tags || []).slice(0, 6),
    isCharge: Boolean(it.isCharge),
    subtitle: Boolean(it.subtitle),
    typeName: it.typeName || '',
    fans: it.fans ?? null,
    axis: it.axis || '',
    sub: it.sub || '',
    axesHit: it.axesHit || [],
    pickedFor: it.pickedFor || it.axis || '',
    score: it.score ?? 0,
    reasons: it.reasons || [],
    fromUp: Boolean(it.fromUp),
    gem: Boolean(it.gem),
    shownTimes: Number(it.shownTimes) || 0,
    url: `https://www.bilibili.com/video/${it.bvid}`,
    pic: it.pic,
  }
}
