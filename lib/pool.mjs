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
import { freshnessOf, decideFreshness } from './freshness.mjs'

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

/**
 * 条目的「多少天前」；没有可靠 pubdate 时返回 null。
 * daysAgo 对缺失日期按 99 天算（当「很老」处理），适合日期窗口过滤；
 * 打分和统计要知道「未知」和「很老」是两回事，用这个。
 */
export function ageOf(it) {
  const s = Number(it?.pubdate)
  if (!Number.isFinite(s) || s <= 0) return null
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

/** 32 位可复现随机（mulberry32）：给了种子，结果就是确定的 —— 出了问题能重放 */
export function mulberry32(seed) {
  let a = Number(seed) >>> 0
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Gumbel 噪声：给分数加它再排序，等价于「按 softmax(score/tau) 加权抽样」，但只需排序一次 */
const gumbel = (rng) => -Math.log(-Math.log(Math.max(1e-9, Math.min(1 - 1e-9, rng()))))

/**
 * 多样性：分数排序太确定 —— 同一个池子每次都推出同一批，用户会觉得「老是这几条」。
 * 做法是**前 keepTop 名固定**（好内容不能因为随机变差），其余名额按分数加权打乱。
 *
 * @param {object[]} items 已按分数降序排好的候选
 * @param {{tau?:number, keepTop?:number, seed?:number}} opts
 *   tau     噪声幅度；0 = 完全确定（老行为）。建议 0.02–0.10，越大越随机
 *   keepTop 前几名不参与抽签
 *   seed    随机种子；相同种子 → 相同结果
 * @returns {object[]} 重排后的新数组（不改原数组）
 */
export function applyDiversity(items, opts = {}) {
  const list = Array.isArray(items) ? items : []
  const tau = Number(opts.tau) || 0
  const keepTop = Math.max(0, Number(opts.keepTop) || 0)
  if (tau <= 0 || list.length <= keepTop) return list.slice()
  const rng = mulberry32(opts.seed ?? 1)
  const head = list.slice(0, keepTop)
  const rest = list.slice(keepTop)
    .map((it) => ({ it, key: (Number(it.score) || 0) + tau * gumbel(rng) }))
    .sort((a, b) => b.key - a.key)
  return [...head, ...rest.map((x) => x.it)]
}

/** 把 0–1 的 diversity 换成噪声幅度：0 → 0（确定），1 → 0.10 */
export const diversityToTau = (d) => {
  const v = Math.max(0, Math.min(1, Number(d) || 0))
  return Number((0.10 * v).toFixed(3))
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

/** 冷启动补偿的参数：三档金额 + 播放门槛。上限就是 day2=0.05，不许调大 —— 它只有时效权重的 5% */
export const COLD_START = { day2: 0.05, day4: 0.03, day7: 0.01, minPlayFloor: 50000 }

/**
 * 冷启动补偿：条目还没补到互动数据时，按年龄给一点点分，
 * 让它有机会进入决赛圈；一旦补过详情（statsAt > 0）就不再给 —— 补贴是临时的，不是永久的。
 * 补偿的是「数据缺失」，不是「年龄小」：所以有播放门槛和标题党否决，
 * 否则一条 18k 播放、没人看的片子会被平加顶进决赛圈。
 */
export function coldStartBonus(it, opts = {}) {
  if (!it || it.statsAt) return 0
  if (Number(it.coin) > 0 || Number(it.favorites) > 0) return 0
  const age = ageOf(it)
  if (age === null) return 0
  const floor = Math.max(COLD_START.minPlayFloor, (Number(opts.minPlay) || 0) * 2)
  if ((Number(it.play) || 0) < floor) return 0
  if (spamScore(it.title) > 0.2) return 0
  const base = age <= 2 ? COLD_START.day2 : age <= 4 ? COLD_START.day4 : age <= 7 ? COLD_START.day7 : 0
  if (!base) return 0
  // 播放增速 ≥5 万/天（T11）：说明正在被传播，+0.01 微调；总分封顶仍是 day2 的 0.05
  const growthBonus = (Number(it.playGrowth) || 0) >= 50000 ? 0.01 : 0
  return Math.min(COLD_START.day2, base + growthBonus)
}

/** 互动数据的保质期：补过的数据是快照，过了这几天播放可能已经翻了几倍 */
export const REFRESH_AFTER_MS = 7 * 86400000

/**
 * 选出互动数据已过期（>7 天）的条目（T10），播放高的先刷，最多 limit 条。
 * 刷新失败的条目 statsAt 保持旧值，下一轮还会被选出来再试。
 */
export function pickStale(entries, now = Date.now(), limit = 3) {
  return (entries || [])
    .filter((it) => it?.statsAt && now - it.statsAt > REFRESH_AFTER_MS)
    .sort((a, b) => (Number(b.play) || 0) - (Number(a.play) || 0))
    .slice(0, Number(limit) || 3)
}

/**
 * 新鲜度配额（T9）：main 里至少一条「≤3 天 + 播放达标 + 贴轴 + 非标题党」。
 * 分数层面（T8）怎么调都可能被更强的老片整体压住，配额是确定性兜底。
 *
 * 替换规则： victim 必须是「自己那根轴还有 ≥2 条」里分数最低的 —— 保证不把任何轴清空。
 * 找不到够格的新条目就不换，绝不放宽条件硬凑；总数不超过 mainCount（先腾一格再放）。
 * 直接改写 picked / taken / perAxisCount / perUpCount，和 tryPick 的记账方式一致。
 * @returns {{needed:boolean, replaced:number, victim?:object, freshCand?:object}}
 */
export function freshQuotaReplace({ picked, qualified, taken, exclude, perAxisCount, perUpCount, minPlay, maxCount }) {
  const freshOk = (c) => {
    const age = ageOf(c)
    return age !== null && age <= 3 &&
      (Number(c.play) || 0) >= Math.max(COLD_START.minPlayFloor, (Number(minPlay) || 0) * 2) &&
      Boolean(c.axis) && spamScore(c.title) <= 0.2
  }
  const hasFresh = picked.some(freshOk)
  // 替换是「一换一」，不会改变 picked 的长度，所以**满员时更应该换**。
  // （之前这里写了 picked.length >= maxCount 就返回，导致 main 装满 5 条时配额永远不触发。）
  if (hasFresh || picked.length < 3) {
    return { needed: !hasFresh, replaced: 0 }
  }
  const freshCand = (qualified || [])
    .filter((c) => freshOk(c) && !taken.has(c.bvid) && !(exclude || new Set()).has(c.bvid))
    .sort((a, b) => b.score - a.score)[0]
  if (!freshCand) return { needed: true, replaced: 0 }
  const victim = picked
    .filter((c) => (perAxisCount.get(c.axis) || 0) > 1)
    .sort((a, b) => a.score - b.score)[0]
  if (!victim) return { needed: true, replaced: 0 }

  // 腾格子：victim 的轴 / UP 计数回退
  picked.splice(picked.indexOf(victim), 1)
  taken.delete(victim.bvid)
  perAxisCount.set(victim.axis, (perAxisCount.get(victim.axis) || 1) - 1)
  const upOut = String(victim.mid || victim.author)
  perUpCount.set(upOut, Math.max(0, (perUpCount.get(upOut) || 1) - 1))
  // 放新的（记账照抄 tryPick）
  freshCand.pickedFor = freshCand.axis
  picked.push(freshCand)
  taken.add(freshCand.bvid)
  perAxisCount.set(freshCand.axis, (perAxisCount.get(freshCand.axis) || 0) + 1)
  const upIn = String(freshCand.mid || freshCand.author)
  perUpCount.set(upIn, (perUpCount.get(upIn) || 0) + 1)
  return { needed: true, replaced: 1, victim, freshCand }
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
  // 缺日期拿 0.5 中性值：daysAgo 对缺失返回 99，之前直接按「很老」判死（freshN=0），
  // 而同样缺日期的老视频其实不受影响 —— 是隐性惩罚。别给满分也别给 0。
  const age = ageOf(it)
  const freshN = age === null ? 0.5 : clamp01(1 - age / window)
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
  // 冷启动补偿（T8b）：只在还没补到互动数据时给，临时补贴，上限 0.05
  const cold = coldStartBonus(it, { minPlay: ctx?.minPlay })
  it.coldBonus = Number(cold.toFixed(4))
  score += cold
  it.score = Number(Math.max(0, Math.min(1.2, score)).toFixed(4))
  it.reasons = []
  if (it.coldBonus > 0) it.reasons.push('缺互动数据，按冷启动补偿')
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

/**
 * 播放增速（T11）：每天涨多少播放。「涨得快」是新条目唯一现成的质量信号。
 * 没有可靠的上次记录（首次见到 / 间隔不到 6 小时 / 上次播放为 0）返回 null —— 绝不编数；
 * 播放倒退（数据回退、被清）夹到 0，不惩罚。
 */
export function playGrowthOf(prevPlay, prevAt, playNow, now) {
  const gapDays = (Number(now) - Number(prevAt)) / 86400000
  if (!Number(prevAt) || gapDays < 0.25 || !(Number(prevPlay) > 0)) return null
  return Math.max(0, (Number(playNow) - Number(prevPlay)) / gapDays)
}

/**
 * 算出这一轮该记的增速，以及下一轮要用的基准。
 * 关键：**测不出来的时候不要重置基准** —— 否则每次建池都把 playAt 刷成 now，
 * 间隔永远攒不到 6 小时，增速会成为永远算不出来的死代码。
 * @returns {{playGrowth:number|null, playPrev:number, playAt:number}}
 */
export function nextPlayBase(old, playNow, now) {
  const basePlay = Number(old?.playPrev) || Number(old?.play) || 0
  const baseAt = Number(old?.playAt) || 0
  const gapDays = baseAt ? (Number(now) - baseAt) / 86400000 : 0
  const measurable = baseAt > 0 && gapDays >= 0.25 && basePlay > 0
  if (!measurable) {
    // 基准保持不动（首次见到时用当前值起算），等攒够 6 小时再比
    return { playGrowth: null, playPrev: basePlay || Number(playNow) || 0, playAt: baseAt || Number(now) }
  }
  return {
    playGrowth: Math.max(0, (Number(playNow) - basePlay) / gapDays),
    playPrev: Number(playNow) || 0,
    playAt: Number(now),
  }
}

/**
 * 历史条目的 statsAt 补齐（T12）：statsAt 是 T8 才加的字段，之前补过互动数据
 * （coin/fav 非 0）的老条目没有这个标记，T10 的 7 天刷新（pickStale 只认 statsAt > 0）
 * 永远选不中它们 —— 补成「上次见到的时间」当作数据快照时间。
 * 真没有数据的（coin=0 且 fav=0）不能标：coldStartBonus 第一关就是 statsAt，
 * 乱标会把还没补数据的条目的冷启动补贴掐掉。
 */
export function statsAtOf(old, now) {
  const known = Number(old?.statsAt) || 0
  if (known) return known
  const hasStats = Number(old?.coin) > 0 || Number(old?.favorites) > 0
  return hasStats ? (Number(old?.lastSeen) || Number(now) || 0) : 0
}

/** 把搜索结果统一成池子里的条目形状（合并段和补货段共用） */
function toCandidate(it, now, old = null) {
  const prevPlay = Number(old?.play) || 0
  const playNow = Math.max(Number(it.play) || 0, prevPlay)
  // 增速与基准：测不出来时不重置基准（见 nextPlayBase 的注释）
  const base = nextPlayBase(old, playNow, now)
  const playGrowth = base.playGrowth
  return {
    bvid: it.bvid,
    title: it.title,
    author: it.author,
    mid: it.mid,
    duration: Number(it.duration) || old?.duration || 0,
    pubdate: it.pubdate || old?.pubdate || 0,
    play: playNow,
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
    // 互动数据的快照：搜索接口不给 coin/fav，只有详情接口有；0 = 从未补过。
    // 历史条目（T8 之前补过数据的）在这里被补上 statsAt，T10 的刷新才能覆盖到它们
    statsAt: statsAtOf(old, now),
    statsTries: Number(old?.statsTries) || 0,
    // 播放增速的对比基准：playPrev/playAt 是「上一次能测量的值」，不是「上一轮的值」
    playPrev: base.playPrev,
    playAt: base.playAt,
    playGrowth,
  }
}

/**
 * 防回音室（0.3.0，硬要求）—— 片单里「熟人来源」最多 cap 条。
 * 超出的就地从 ranking 里找一个非熟人顶上（位置不变，不打乱已排好的顺序）。
 * 抽成纯函数是为了能单测：这条红线不能只靠肉眼验。
 * @returns {number} 被裁掉的条数
 */
export function enforceEchoCap(picked, ranking, { cap = 1, taken = new Set(), exclude = new Set() } = {}) {
  // 自己算一份「已经在片单里」的集合：不能只指望调用方把 taken 填对，
  // 否则替补可能选中片单里已有的条目，换出重复项。
  const inPicked = new Set(picked.map((p) => p?.bvid).filter(Boolean))
  let echoNow = picked.filter((p) => p?.fromUpList).length
  let trimmed = 0
  for (let i = picked.length - 1; i >= 0 && echoNow > cap; i -= 1) {
    if (!picked[i]?.fromUpList) continue
    const alt = ranking.find((c) => c && !c.fromUpList && !taken.has(c.bvid) && !inPicked.has(c.bvid) && !exclude.has(c.bvid))
    if (!alt) break
    taken.delete(picked[i].bvid)
    inPicked.delete(picked[i].bvid)
    alt.pickedFor = alt.axis
    picked[i] = alt
    taken.add(alt.bvid)
    inPicked.add(alt.bvid)
    echoNow -= 1
    trimmed += 1
  }
  return trimmed
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
  const stats = { searches: 0, raw: 0, noBvid: 0, dur: 0, charge: 0, old: 0, replay: 0, lowPlay: 0, noAxis: 0, vetoed: 0, details: 0, expanded: 0, detailCold: 0, detailColdFailed: 0, detailRefresh: 0, detailRefreshFailed: 0, byOrder: { totalrank: 0, pubdate: 0 }, perAxis: {} }

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

  // ---- 1b. 熟人投稿（0.3.0）----
  // 「你自己点赞/点开过的人」的新片不该靠搜索撞运气。这里把他们的最新投稿并进候选，
  // 跟搜索到的走同一条 toCandidate 路径；加多少分在初评那段统一算。
  // ⚠️ 这只是候选来源之一 —— 能不能进 main 还要过全部硬门槛 + 回音室上限。
  const upListBvids = new Set()
  const upBonus = new Map((cfg.upsList || []).map((u) => [String(u.mid), u.tier === 'regular' ? 0.08 : 0.04]))
  const upListed = (cfg.upsList || []).filter((u) => u?.mid).slice(0, 6)
  for (let i = 0; i < upListed.length; i += 3) {
    await Promise.all(upListed.slice(i, i + 3).map(async (u) => {
      try {
        const r = await userVideos(u.mid, 10)
        stats.upListChecked = (stats.upListChecked || 0) + 1
        if (!r.ok) { log(`熟人投稿失败 ${u.name || u.mid}：${r.message}`); return }
        for (const v of r.items) {
          if (!v?.bvid) continue
          upListBvids.add(v.bvid)
          if (!fresh.has(v.bvid)) fresh.set(v.bvid, v)
        }
      } catch (e) { log(`熟人投稿异常 ${u.name || u.mid}：${e?.message ?? e}`) }
    }))
    if (i + 3 < upListed.length) await sleep(300)
  }
  stats.upList = { people: upListed.length, items: upListBvids.size }

  // ---- 2. 合并（新覆盖旧）----
  const merged = new Map()
  const now = Date.now()
  for (const p of (prev || [])) {
    if (!p?.bvid) continue
    // 上一轮原样带过来的条目也要过一遍 statsAt 补齐（T12）：
    // 它们这一轮没被搜到，不会走 toCandidate，不在这里补就永远补不上，
    // T10 的 7 天刷新也就永远选不中它们。
    merged.set(p.bvid, { ...p, statsAt: statsAtOf(p, now) })
  }
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

  let { byAxis, agesAll } = collect()

  // ---- 3b. 冷门轴补货：凑不够 3 条时换检索通道（时长带 + 种子扩散） ----
  const thinNow = () => axes.filter((a) => byAxis.get(a).length < 3)
  let thin = thinNow()
  if (thin.length && cfg.expand !== false) {
    for (const axis of thin) {
      const have = new Set(merged.keys())
      // 种子不要求合格：内容对的邻域就够了（实测拿 718 分钟的攻略当种子也能捞到 30 分的好片）。
      // 排序：30 天内发布的优先当种子 —— related 是按内容相似度给的，拿新种子捞回来的才是新邻域；
      // 之前纯按播放量挑，等于「用老爆款找老片」。
      const seedScore = (it) => (daysAgo(it.pubdate) <= 30 ? 1 : 0) * 1e9 + (it.play || 0)
      const mine = Array.from(merged.values())
        .filter((it) => axisSim(it, axis).qualified)
        .sort((a, b) => seedScore(b) - seedScore(a))
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

  // ---- 3c. 就地改判：news 轴凑不够 3 条，但它的内容普遍很老 → 本轮按 evergreen 再收一次。
  //     防护：近两周还有 ≥2 条新内容的不许改判（decideFreshness 里做）——
  //     进料偏老会把年龄中位数抬高，不防护的话「还有新内容的轴」会被误判成常青，日期窗从此拆掉。
  let switched = []
  for (const axis of thinNow()) {
    if (effective.get(axis) === 'evergreen') continue
    const ages = agesAll.get(axis) || []
    const d = decideFreshness(ages, { freshCount: ages.filter((a) => a <= 14).length })
    if (d.freshness === 'evergreen') {
      effective.set(axis, 'evergreen')
      switched.push(`${axis}（${d.reason}）`)
    } else if (d.reason.includes('不判常青')) {
      log(`时效不改判：${axis} —— ${d.reason}`)
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

  // ---- 3d. 冷启动补数据（T8a）----
  // 搜索接口不给 coin/fav，只有详情接口有 ⇒ 新条目进池时币/藏=0，互动分（最多 0.39）拿不到，
  // 初评落后 → 只有「初评前 12 名」才补详情 → 新条目永远挤不进前 12 → 永远没数据：一个闭环。
  // 这里在初评之前先给还没补过数据的候选补一小批（新进池优先），把闭环剪开。
  const COLD_LIMIT = 8
  const coldNeed = candidates
    .filter((it) => !it.statsAt && !(Number(it.coin) > 0) && !(Number(it.favorites) > 0) && (Number(it.statsTries) || 0) < 3)
    // 增速高的先补（T11）：涨得快说明正在被传播，先拿到数据收益最大；没算过增速的排最后
    .sort((a, b) => (b.playGrowth ?? -1) - (a.playGrowth ?? -1) || (b.firstSeen || 0) - (a.firstSeen || 0))
    .slice(0, COLD_LIMIT)

  /** 拉一批详情回填互动数据（并发 4，分批走）；成功才写 statsAt，失败只记 tries，不动旧数据 */
  const backfillStats = async (batch, okKey, failKey) => {
    let ok = 0
    let fail = 0
    for (let i = 0; i < batch.length; i += 4) {
      await Promise.all(batch.slice(i, i + 4).map(async (it) => {
        it.statsTries = (Number(it.statsTries) || 0) + 1
        try {
          const d = await videoDetail(it.bvid)
          const st = d?.data?.stat
          if (st) {
            it.like = Number(st.like) || it.like || 0
            it.coin = Number(st.coin) || it.coin || 0
            it.favorites = Number(st.favorite) || it.favorites || 0
            it.danmaku = Number(st.danmaku) || it.danmaku || 0
            it.play = Math.max(Number(st.view) || 0, it.play || 0)
            it.statsAt = Date.now()
            ok += 1
          } else { fail += 1 }
        } catch { fail += 1 }
      }))
      if (i + 4 < batch.length) await sleep(300)
    }
    if (okKey) stats[okKey] = (stats[okKey] || 0) + ok
    if (failKey) stats[failKey] = (stats[failKey] || 0) + fail
    return { ok, fail }
  }

  if (coldNeed.length) {
    await backfillStats(coldNeed, 'detailCold', 'detailColdFailed')
    log(`冷启动补数据：成功 ${stats.detailCold} / 失败 ${stats.detailColdFailed}`)
  }
  stats.coldStart = { need: coldNeed.length, applied: stats.detailCold, failed: stats.detailColdFailed }

  // ---- 3e. 过期刷新（T10）：补过的数据是快照，7 天后的播放可能翻了几倍，播放高的先刷 ----
  const staleNeed = pickStale(candidates, Date.now(), 3)
  if (staleNeed.length) {
    const r = await backfillStats(staleNeed, 'detailRefresh', 'detailRefreshFailed')
    log(`数据刷新：${r.ok} 条`)
  }
  // T11：本轮有多少条目算出了播放增速（首次见到的没有对比，算不出来）
  stats.growthSeen = Array.from(merged.values()).filter((it) => it.playGrowth != null).length

  // 池内 tag 频次：用来算「小众 tag」分（tag 越罕见越加分）
  const tagDf = new Map()
  for (const it of candidates) {
    for (const t of new Set((it.tags || []).map((x) => String(x).toLowerCase().trim()).filter(Boolean))) {
      tagDf.set(t, (tagDf.get(t) || 0) + 1)
    }
  }
  const scoreCtx = { maxDays, minPlay, tagDf, tagTotal: candidates.length }

  // ---- 4. 初评 ----
  const qualified = []
  for (const it of candidates) {
    it.fromUpList = upListBvids.has(it.bvid)
    if (scoreItem(it, axes, aff, scoreCtx)) {
      // 熟人加权（0.3.0）：只给「三天内的新片」—— 老片按时间窗自然筛，不靠人情加分。
      // 这是「预测优秀」的前一半：互动数据还没成熟，先把人放进来。
      const ub = it.fromUpList && daysAgo(it.pubdate) <= 3 ? (upBonus.get(String(it.mid)) || 0) : 0
      if (ub > 0) {
        it.upBonus = ub
        it.score = Number(Math.min(1.2, it.score + ub).toFixed(4))
        it.reasons.unshift('🧡 熟人新片：你赞过或点开过的 UP')
      }
      qualified.push(it)
    }
    else if (it.vetoed) stats.vetoed += 1
    else stats.noAxis += 1
  }
  qualified.sort((a, b) => b.score - a.score)

  // ---- 4b. 每轴统计：合格数 + 年龄中位（决定这根轴该 news 还是 evergreen） ----
  for (const axis of axes) {
    const mine = qualified.filter((it) => it.bestAxis === axis)
    const ages = mine.map((it) => ageOf(it)).filter((a) => a !== null)
    const d = decideFreshness(ages)
    stats.perAxis[axis] = { ok: mine.length, medianAge: Math.round(d.medianAge), suggest: d.freshness, reason: d.reason }
  }

  // ---- 5. 决赛圈查详情：补投币 ----
  // 12 条串行要 8 秒以上（0.4s 网络 + 0.3s sleep 各 12 次），而彼此完全独立。
  // 改成 4 并发 + 批间 sleep：实测耗时砍到 1/3，请求总数不变。
  const top = qualified.slice(0, detailCount)
  for (let i = 0; i < top.length; i += 4) {
    await Promise.all(top.slice(i, i + 4).map(async (it) => {
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
    }))
    if (i + 4 < top.length) await sleep(300)
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

  // ---- 6.9 多样性：前 5 名固定，其余按分数加权打乱 ----
  // 只打乱一次，选片和决赛圈都用同一个顺序 —— 否则模型看到的 24 条还是固定的，
  // 打乱就白做了。种子记进 stats，出问题能重放。
  const diversity = Math.max(0, Math.min(1, Number(cfg.diversity) ?? 0.5))
  const tau = diversityToTau(diversity)
  const pickSeed = Number.isFinite(Number(cfg.seed)) ? Number(cfg.seed) : (Date.now() % 4294967296)
  const ranking = applyDiversity(qualified, { tau, keepTop: 5, seed: pickSeed })
  stats.diversity = { value: diversity, tau, seed: pickSeed }

  // ---- 7. 按轴轮转 + 同 UP 限一格 ----
  const mainCount = Number(cfg.mainCount) || 5
  /** 熟人来源的硬上限：5 条时是 2 条（40%），至少留 1 格给「发现」 */
  const echoCap = Math.max(1, Math.ceil(mainCount * 0.4))
  const picked = []
  const taken = new Set()
  const perAxisCount = new Map()
  const perUpCount = new Map()
  const exclude = new Set(cfg.exclude || [])

  const tryPick = (c, why) => {
    if (picked.length >= mainCount) return false
    if (taken.has(c.bvid)) return false
    if (exclude.has(c.bvid)) return false
    // 防回音室（硬要求）：熟人来源不能把片单占满，否则越用越窄
    if (c.fromUpList && picked.filter((p) => p.fromUpList).length >= echoCap) {
      stats.echoTrimmed = (stats.echoTrimmed || 0) + 1
      return false
    }
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
    const best = ranking.find((c) => !taken.has(c.bvid) && (c.sims?.[axis] || 0) >= 0.85)
    if (best) tryPick(best, axis)
  }
  for (const c of ranking) {
    if (picked.length >= mainCount) break
    if ((perAxisCount.get(c.axis) || 0) >= 2) continue
    tryPick(c, c.axis)
  }

  // ---- 7b. 新鲜度配额（T9）：分数再怎么调都可能被更强的老片整体压住，这里兜底保证至少一条新的 ----
  const fq = freshQuotaReplace({ picked, qualified, taken, exclude, perAxisCount, perUpCount, minPlay, maxCount: mainCount })
  if (fq.replaced) {
    log(`新鲜度配额：用「${fq.freshCand.title.slice(0, 24)}」换掉「${fq.victim.title.slice(0, 24)}」`)
  }
  stats.freshQuota = { needed: fq.needed, replaced: fq.replaced }

  // ---- 7c. 防回音室兜底（硬要求）----
  // 新鲜度配额是硬塞的，可能塞进来一条熟人把上限顶破；超了就用非熟人的替补换掉。
  stats.echoTrimmed = (stats.echoTrimmed || 0) + enforceEchoCap(picked, ranking, { cap: echoCap, taken, exclude })
  stats.echoGuard = { cap: echoCap, picked: picked.filter((p) => p.fromUpList).length, trimmed: stats.echoTrimmed }
  if (stats.echoTrimmed) log(`防回音室：熟人来源上限 ${echoCap} 条，本轮裁掉 ${stats.echoTrimmed} 条`)

  // 进过 main 的计数 +1，随池子落盘，下一轮按 repeatPenalty 扣分。
  // （/more 追加的条目不算 —— 那条路不走建池，没有 picked。）
  for (const p of picked) p.shownTimes = (Number(p.shownTimes) || 0) + 1

  const covered = new Set(picked.flatMap((p) => p.axesHit || []))

  // ---- 8. 固定 UP ----
  const upItems = []
  const upResolved = []
  /** 拉投稿失败的原因 —— 写进 feed，让「关注」页能说一句人话而不是干瞪眼 */
  const upErrors = []
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
      if (!r.ok) {
        log(`拉投稿失败 ${name || raw}：${r.message}`)
        upErrors.push({ name: name || raw, message: String(r.message || `code ${r.code}`) })
        continue
      }
      const kept = r.items.filter((v) => v.bvid && (showCharging || !v.isCharge))
      upResolved.push({ mid, name: name || kept[0]?.author || mid, count: kept.length })
      for (const v of kept) upItems.push({ ...v, fromUp: true, reasons: ['固定关注'] })
      await sleep(500)
    } catch (e) {
      log(`固定 UP 失败 ${raw}：${e?.message ?? e}`)
      upErrors.push({ name: raw, message: String(e?.message ?? e) })
    }
  }
  upItems.sort((a, b) => (b.pubdate || 0) - (a.pubdate || 0))

  const poolOut = candidates.map((c) => ({
    bvid: c.bvid, title: c.title, author: c.author, mid: c.mid,
    duration: c.duration, pubdate: c.pubdate, play: c.play,
    like: c.like, coin: c.coin, danmaku: c.danmaku, favorites: c.favorites,
    tags: c.tags, typeName: c.typeName, subtitle: c.subtitle, isCharge: c.isCharge, pic: c.pic,
    firstSeen: c.firstSeen, lastSeen: c.lastSeen,
    shownTimes: c.shownTimes || 0,
    statsAt: c.statsAt || 0, statsTries: c.statsTries || 0,
    playPrev: c.playPrev || 0, playAt: c.playAt || 0, playGrowth: c.playGrowth ?? null,
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
    shortlist: ranking.filter((c) => !exclude.has(c.bvid)).slice(0, 24).map(toCard),
    up: upItems.slice(0, 12).map(toCard),
    upResolved,
    upErrors,
    pool: poolOut,
  }
}

/**
 * 轻量探测（0.3.0）—— 三档刷新里「距上次全量 3–24 小时」那一档。
 * ============================================================================
 * 只回答一个问题：**有没有值得提前装进来的新片**。
 * 不建池、不算分、不调模型；命中 ≥1 条就由调用方排队一次完整重建。
 *
 * 判据要比主流程**松**：刚发两小时的视频，点赞率/投币率根本还没成形，
 * 拿主流程那套互动分去卡它，结果永远是 0 条 —— 等于白跑。
 * 所以只卡「够新 + 够多人看 + 命中某根轴」这三件事。
 * ============================================================================
 * @param {object} cfg 同 buildPool 的配置（axes / minPlay / minMinutes / maxMinutes / exclude …）
 * @param {{ups?: Array<{mid:string,name:string}>, log?: Function}} opts ups = 熟人名单（regular 档）
 * @returns {Promise<{hit:Array, checkedUp:number, searched:number, tookMs:number}>}
 */
export async function lightProbe(cfg, { ups = [], log = () => {} } = {}) {
  const t0 = Date.now()
  const axes = (cfg.axes || []).map((s) => String(s).trim()).filter(Boolean)
  const minSec = (Number(cfg.minMinutes) || 0) * 60
  const maxSec = (Number(cfg.maxMinutes) || 0) * 60
  const showCharging = cfg.showCharging === true
  const allowReplay = cfg.allowReplay === true
  /** 新片播放天然低：门槛按 30% 放，但保底 3000，免得捞一堆没人看的 */
  const minPlay = Math.max(3000, (Number(cfg.minPlay) || 0) * 0.3)
  const seen = new Set(cfg.exclude || [])
  const hit = []
  let checkedUp = 0
  let searched = 0

  const keep = (it, why) => {
    if (!it?.bvid || seen.has(it.bvid)) return
    seen.add(it.bvid)
    if (!(daysAgo(it.pubdate) <= 2)) return
    if (minSec && (Number(it.duration) || 0) < minSec) return
    if (maxSec && (Number(it.duration) || 0) > maxSec) return
    if (!showCharging && it.isCharge) return
    if (!allowReplay && (REPLAY_RE.test(it.title || '') || REPLAY_RE.test(it.author || ''))) return
    if (minPlay && (Number(it.play) || 0) < minPlay) return
    if (!axes.some((ax) => axisSim(it, ax).qualified)) return
    hit.push({ ...it, probeWhy: why })
  }

  // 1) 熟人投稿：先看「你自己选出来的人」，比轴的最新页准得多
  //    ⚠️ 最多 6 个：space 接口有全局节流（bili.mjs 里 750ms 一个），查太多这轮会拖很久
  const listed = (ups || []).filter((u) => u?.mid).slice(0, 6)
  for (let i = 0; i < listed.length; i += 3) {
    await Promise.all(listed.slice(i, i + 3).map(async (u) => {
      try {
        const r = await userVideos(u.mid, 5)
        checkedUp += 1
        if (!r.ok) { log(`探测熟人失败 ${u.name || u.mid}：${r.message}`); return }
        for (const v of r.items) keep(v, '熟人新片')
      } catch (e) { log(`探测熟人异常 ${u.name || u.mid}：${e?.message ?? e}`) }
    }))
    if (i + 3 < listed.length) await sleep(300 + Math.random() * 200)
  }

  // 2) 每根轴的最新一页（一个轴一次就够，这只是探路不是建池）
  const hour = Math.floor(Date.now() / 3600000)
  for (const axis of axes) {
    const term = termsOf(axis, hour)[0]
    if (!term) continue
    searched += 1
    try {
      const r = await searchVideos(term, 1, 'pubdate')
      if (!r.ok) { log(`探测搜索失败「${term}」：${r.message}`); continue }
      for (const it of r.items) keep(it, `${axis} 最新`)
    } catch (e) { log(`探测搜索异常「${term}」：${e?.message ?? e}`) }
    await sleep(200 + Math.random() * 200)
  }

  return { hit, checkedUp, searched, tookMs: Date.now() - t0 }
}

/**
 * 防回音室 · 策展路径（0.3.0 补漏）。
 * 上面那个 enforceEchoCap 只管规则挑选那 5 条；但模型是从 shortlist 里自己挑的，
 * 熟人条目因为加了权，很容易被它一口气挑好几个 —— 实测就出现过 5 条里 3 条熟人。
 * 这里把最终结果再收一次：超了就换成 shortlist 里排名最高的非熟人。
 * @returns {{main:Array, trimmed:number, echo:number}}
 */
export function capCuratedEcho(main, shortlist, cap) {
  const have = new Set(main.map((x) => x?.bvid))
  const spare = (shortlist || []).filter((x) => x && !x.fromUpList && !have.has(x.bvid))
  const out = main.slice()
  let echo = out.filter((x) => x?.fromUpList).length
  let trimmed = 0
  for (let i = out.length - 1; i >= 0 && echo > cap; i -= 1) {
    if (!out[i]?.fromUpList) continue
    const alt = spare.shift()
    if (!alt) break
    // 换上来这条没有模型写的理由，靠规则 reasons 顶上（客户端会自动降级显示）
    out[i] = { ...alt, why: alt.why || '' }
    echo -= 1
    trimmed += 1
  }
  return { main: out, trimmed, echo }
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
    // 熟人来源（0.3.0）：前端据此打标，日志/自检据此核对回音室上限
    fromUpList: Boolean(it.fromUpList),
    upBonus: Number(it.upBonus) || 0,
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
    statsAt: Number(it.statsAt) || 0,
    coldBonus: Number(it.coldBonus) || 0,
    url: `https://www.bilibili.com/video/${it.bvid}`,
    pic: it.pic,
  }
}
