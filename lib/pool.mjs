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
import { searchVideos, userVideos, searchUsers, userInfo, videoDetail } from './bili.mjs'

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
export const AXIS_TREE = {
  deepseek: {
    search: ['deepseek', 'dsh', '深度求索'],
    groups: [['deepseek', 'dsh', '深度求索']],
    subs: [],
    cats: ['科技数码', '知识'],
    none: [],
  },

  时政: {
    // ⚠️ 搜「时政」出来的是考公内容（见 docs/tag-tree.md），所以主词只留一个，
    //    真正管用的是轮换出来的实体词。
    search: ['时政', '国际局势'],
    groups: [[
      '时政', '国际', '局势', '时事', '外交', '地缘', '大选', '关税', '制裁', '冲突', '战争', '军事',
      '台海', '中美', '时评', '政治', '选举', '国会', '白宫', '政府', '首相', '总统', '联合国',
      '特朗普', '川普', '拜登', '普京', '泽连斯基', '内塔尼亚胡', '哈马斯', '以色列', '巴勒斯坦',
      '伊朗', '乌克兰', '俄罗斯', '欧盟', '北约', '中东',
    ]],
    subs: [
      { name: '中东', terms: ['以色列', '哈马斯', '伊朗', '中东', '加沙'] },
      { name: '美国', terms: ['特朗普', '川普', '拜登', '白宫', '美国大选'] },
      { name: '俄乌', terms: ['俄乌', '普京', '泽连斯基', '乌克兰', '俄罗斯'] },
      { name: '台海', terms: ['台海', '两岸', '台湾'] },
      { name: '欧洲', terms: ['欧盟', '北约', '欧洲', '德国', '法国', '英国'] },
    ],
    cats: ['资讯', '知识'],
    none: [],
  },

  科技测评: {
    search: ['科技测评', '数码'],
    groups: [
      ['科技', '数码', '手机', '电脑', 'ai', '相机', '耳机', '显卡', '外设', '软件', '硬件', '芯片', '平板', '笔记本'],
      ['测评', '评测', '实测', '上手', '开箱', '横评', '对比'],
    ],
    subs: [
      { name: '电脑硬件', terms: ['显卡', 'cpu', '装机', '硬件', '主板', '散热', '内存'] },
      { name: '耳机', terms: ['耳机', '降噪', 'hifi', '音频'] },
      { name: '手机', terms: ['手机', '红米', '小米', 'iphone', '华为', '荣耀'] },
      { name: '笔记本', terms: ['笔记本', '轻薄本', '游戏本'] },
    ],
    cats: ['科技数码'],
    none: ['英雄联盟', 'lpl', '赛事', '电竞', '比赛集锦'],
  },

  健身教程: {
    search: ['健身教程', '健身跟练'],
    groups: [
      ['健身', '训练', '减脂', '增肌', '瑜伽', '拉伸', '有氧', '力量', '塑形'],
      ['教程', '跟练', '计划', '动作', '入门', '新手'],
    ],
    subs: [
      { name: '增肌', terms: ['增肌', '肌肉', '力量', '哑铃', '卧推', '手臂'] },
      { name: '减脂', terms: ['减脂', '减肥', '燃脂', '有氧', '体脂'] },
      { name: '跟练', terms: ['跟练', '健身操', '瑜伽', '拉伸', '普拉提'] },
    ],
    cats: ['健身', '运动', '体育'],
    none: ['机器人', '编程', '开发', '算法', '强化学习', '代码', '运控'],
  },
}

/** 没在树里定义的轴：退回「轴词 + 同义词」当一组 */
export const SYNONYMS = {
  deepseek: ['deepseek', 'dsh', '深度求索', 'deepseek harness'],
  时政: ['时政', '国际', '局势', '时事', '观察', '解读', '新闻'],
  科技测评: ['测评', '评测', '实测', '上手', '横评', '开箱', '体验'],
  健身教程: ['健身', '训练', '动作', '增肌', '减脂', '拉伸', '教程'],
}

/** 直播回放 / 录播 */
const REPLAY_RE = /直播回放|回放|录播|直播录像|直播切片|直播实录/
/** 泛 tag：一条内容只有这些 tag，说明 UP 没认真分类 */
const GENERIC_TAGS = new Set(['必剪创作', '直播', '高能', '生活记录', 'vlog', '原创', '日常', '记录', '自制', '剪辑'])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function nodeOf(axis) {
  const key = String(axis || '').trim()
  const t = AXIS_TREE[key]
  if (t) return t
  return {
    search: [key, ...(SYNONYMS[key] || [])],
    groups: [[key, ...(SYNONYMS[key] || [])].filter(Boolean)],
    subs: [], cats: [], none: [],
  }
}

/**
 * 这根轴这一轮用哪几个检索词：前两个固定，第三个从子簇里按小时轮换。
 * ⇒ 每天搜到的东西不一样，池子才会长。
 */
export function termsOf(axis, hour = new Date().getHours()) {
  const t = nodeOf(axis)
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
  const t = nodeOf(axis)
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

/** 给一条候选算分（详情回来之后要重算一次） */
function scoreItem(it, axes) {
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
  it.axesHit = axes.filter((a) => sims[a] >= 0.85)
  it.vetoed = vetoed
  if (!best.axis) return false

  const r = ratesOf(it)
  const freshN = Math.max(0, 1 - daysAgo(it.pubdate) / 14)
  const subFlag = it.subtitle ? 1 : 0
  const playBoost = Math.min(1, Math.log10((it.play || 0) + 10) / 7)
  const spam = spamScore(it.title)
  const generic = isGenericTags(it.tags) ? 1 : 0

  const base =
    best.sim * 0.34 +
    r.likeRate * 0.15 +
    r.coinRate * 0.12 +
    r.favRate * 0.12 +
    freshN * 0.12 +
    subFlag * 0.06 +
    playBoost * 0.05 +
    Math.min(1, it.axesHit.length) * 0.04

  it.axis = best.axis
  it.sub = best.sub || ''
  it.rates = r
  it.score = Number((base * (1 - 0.45 * spam) * (1 - 0.12 * generic)).toFixed(4))
  it.reasons = []
  it.reasons.push(`贴近「${best.axis}${best.sub ? ' · ' + best.sub : ''}」${best.hits.length ? '：' + best.hits.slice(0, 3).join('、') : ''}`)
  if (it.axesHit.length > 1) it.reasons.push(`同时像 ${it.axesHit.filter((a) => a !== best.axis).join('、')}`)
  if (r.favRate >= 0.5) it.reasons.push('收藏率高')
  else if (r.coinRate >= 0.5) it.reasons.push('投币率高')
  else if (r.likeRate >= 0.5) it.reasons.push('点赞率高')
  if (freshN > 0.7) it.reasons.push('近两天发布')
  if (subFlag) it.reasons.push('有字幕')
  if (spam >= 0.3) it.reasons.push('标题党倾向（降权）')
  if (generic) it.reasons.push('tag 很泛（降权）')
  return true
}

/**
 * 建池（累积）
 */
export async function buildPool(cfg, log = () => {}, prev = []) {
  const axes = (cfg.axes || []).map((s) => String(s).trim()).filter(Boolean)
  const minSec = (Number(cfg.minMinutes) || 0) * 60
  const maxSec = (Number(cfg.maxMinutes) || 0) * 60
  const minPlay = Number(cfg.minPlay) || 0
  const detailCount = Number(cfg.detailCount) || 12
  const showCharging = cfg.showCharging === true
  const allowReplay = cfg.allowReplay === true
  const stats = { searches: 0, raw: 0, noBvid: 0, dur: 0, charge: 0, old: 0, replay: 0, lowPlay: 0, noAxis: 0, vetoed: 0, details: 0 }

  // ---- 1. 搜（主词 + 按小时轮换的子簇词）----
  const hour = Math.floor(Date.now() / 3600000)
  const fresh = new Map()
  for (const axis of axes) {
    for (const term of termsOf(axis, hour)) {
      stats.searches += 1
      let r
      try { r = await searchVideos(term, 1, 'totalrank') } catch (e) { log(`搜「${term}」失败：${e?.message ?? e}`); continue }
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
    merged.set(it.bvid, {
      bvid: it.bvid,
      title: it.title,
      author: it.author,
      mid: it.mid,
      duration: Number(it.duration) || old?.duration || 0,
      pubdate: it.pubdate || old?.pubdate || 0,
      play: Math.max(Number(it.play) || 0, Number(old?.play) || 0),
      like: Number(it.raw?.like ?? old?.like ?? 0),
      coin: Number(it.raw?.coin ?? old?.coin ?? 0),
      danmaku: Number(it.raw?.danmaku ?? old?.danmaku ?? 0),
      favorites: Number(it.raw?.favorites ?? old?.favorites ?? 0),
      tags: (it.tags?.length ? it.tags : old?.tags) || [],
      typeName: it.raw?.typename || old?.typeName || '',
      subtitle: Boolean(it.subtitle ?? old?.subtitle),
      isCharge: Boolean(it.isCharge ?? old?.isCharge),
      pic: it.pic || old?.pic || '',
      firstSeen: old?.firstSeen || now,
      lastSeen: now,
    })
  }

  // ---- 3. 硬过滤 ----
  const candidates = []
  for (const it of merged.values()) {
    if (minSec && it.duration < minSec) { stats.dur += 1; continue }
    if (maxSec && it.duration > maxSec) { stats.dur += 1; continue }
    if (!showCharging && it.isCharge) { stats.charge += 1; continue }
    if (!allowReplay && (REPLAY_RE.test(it.title || '') || REPLAY_RE.test(it.author || ''))) { stats.replay += 1; continue }
    if (minPlay && (it.play || 0) < minPlay) { stats.lowPlay += 1; continue }
    if (daysAgo(it.pubdate) > 14) { stats.old += 1; continue }
    candidates.push(it)
  }

  // ---- 4. 初评 ----
  const qualified = []
  for (const it of candidates) {
    if (scoreItem(it, axes)) qualified.push(it)
    else if (it.vetoed) stats.vetoed += 1
    else stats.noAxis += 1
  }
  qualified.sort((a, b) => b.score - a.score)

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
  for (const it of top) scoreItem(it, axes)
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
  }))

  return {
    ok: true,
    ts: Date.now(),
    axes,
    terms: Object.fromEntries(axes.map((a) => [a, termsOf(a, hour)])),
    stats: { ...stats, pool: poolOut.length, qualified: qualified.length, picked: picked.length, up: upItems.length },
    coverage: { axes, covered: Array.from(covered), missing: axes.filter((a) => !covered.has(a)) },
    main: picked.map(toCard),
    up: upItems.slice(0, 12).map(toCard),
    upResolved,
    pool: poolOut,
  }
}

function toCard(it) {
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
    url: `https://www.bilibili.com/video/${it.bvid}`,
    pic: it.pic,
  }
}
