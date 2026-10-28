/**
 * dsh-bili-jar —— host 半端
 * ============================================================================
 * 规则（pool.mjs）负责把 200 多条压到 20 多条「技术上够格」的候选；
 * LLM（curator.mjs）负责**挑出 5 条并写理由** —— 也就是"帮你找好看视频"这件事本身。
 *
 * ⚠️ `apply(ctx, config)` 里拿到的 `config` 不是解析后的值（每个字段都是 `{}`），
 *    真实值必须走 `ctx.settings.describe()` 的 `value` 层。
 * ⚠️ 桌面版的 DSH 原生设置页不显示本插件的字段 ⇒ 配置面板做在罐子里，
 *    写到 `~/.dsh/bili-jar/config.json`，优先级最高。
 * ============================================================================
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, appendFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { inspect } from 'node:util'
import { loadHostDeps } from './lib/hostdeps.mjs'
import { buildPool, toCard, axisSim, lightProbe, capCuratedEcho } from './lib/pool.mjs'
import { buildUpList } from './lib/ups.mjs'
import { decideRefresh, OPEN_AFTER_MS, AUTO_AFTER_MS, FULL_AFTER_MS } from './lib/refresh.mjs'
import { AXIS_TREE, AXIS_BASE, setUserTree, getUserTree, nodeFor, suggestSubs } from './lib/tree.mjs'
import { reviewClusters } from './lib/tree-review.mjs'
import { writeReason, writeReasonCore, loadReasonCache, saveReasonCache, setUsageFile, lastError as llmError } from './lib/reasons.mjs'
import { todayUsage, migrateUsage } from './lib/usage.mjs'
import { writeStateDoc } from './lib/statefile.mjs'
import { curate } from './lib/curator.mjs'
import { freshnessOf, isFreshness } from './lib/freshness.mjs'
import { parseShown, pushRound, flattenShown } from './lib/shown.mjs'
import { adoptCookies, videoSubtitle, videoComments, loginStart, loginPoll, hasLogin } from './lib/bili.mjs'
import { qrDataUrl } from './lib/qr.mjs'
import { setLogFile, info as logInfo, warn as logWarn, tail as logTail } from './lib/log.mjs'

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))

/** 可选头像：都是 assets/ 里的方图（从插画上裁的脸） */
const AVATAR_PRESETS = {
  sleep: { file: 'av-sleep.png', label: '睡觉' },
  tv: { file: 'av-tv.png', label: '看电视' },
  explore: { file: 'av-explore.png', label: '探险' },
  other: { file: 'av-other.png', label: '哦鲸鲸' },
  walk: { file: 'av-walk.gif', label: '走路' },
}
const DEFAULT_AVATAR_PRESET = 'sleep'

/** 下载就带的语气预设。用户可以覆盖同名（自己的优先），但不能删 */
const BUILTIN_STYLES = {
  '鲸鱼女仆': [
    '像蓝发鲸鱼女仆在推荐：语气软、句子短、带一点俏皮，但不说废话，不堆感叹号。',
    '称呼用户为 老大',
    '知道自己是 deepseek 鲸鱼娘',
    '语句不要太僵硬，能开玩笑最好',
    '自称 本鱼🐟',
  ].join('\n'),
  '正经简报': '像同事给你递一页摘要：先结论后细节，不用语气词，不评价好坏，只说这期讲了什么、值不值得花这个时间。',
  '损友吐槽': '像一个嘴毒但靠谱的朋友：先说一句损的，再老实讲值不值得看。可以有情绪，但别为了刻薄而刻薄。',
}
const { z, notes: hostNotes } = await loadHostDeps()

export const name = 'dsh-bili-jar'
export const inject = ['webServer', 'settings']

const DEFAULTS = {
  axes: ['deepseek', '时政', '科技测评', '健身教程'],
  ups: [],
  fanMin: 0,
  fanMax: 0,
  minMinutes: 8,
  maxMinutes: 90,
  /** 只看最近 N 天；0 = 不限日期 */
  maxDays: 14,
  /** 推荐多样性 0–1：0 = 完全确定（老行为），越大越随机 */
  diversity: 0.5,
  minPlay: 10000,
  mainCount: 5,
  showCharging: false,
  curatorOn: true,
  explainOn: true,
  reasonStyle: '像蓝发鲸鱼女仆在推荐：语气软、句子短、带一点俏皮，但不说废话，不堆感叹号。',
  apiBase: 'https://api.deepseek.com',
  apiKey: '',
  apiModel: 'deepseek-chat',
  /** self=只用我们搜的 / scroll=额外读 bili-scroll 的报告 / both=都读 */
  contentSource: 'self',
  /** 复用 bili-scroll 的 B站 登录（用于取 AI 字幕）。默认关，且不勾选绝不读那个文件 */
  useScrollLogin: false,
  /** 头像预设：sleep / tv / explore / other（custom = 自己上传的） */
  avatarPreset: 'sleep',
}

/**
 * ⚠️ 每个字段都要 `.extra('volatile', true)`，否则 DSH 的 settings.update() 会抛错。
 * ⚠️ 不要加会抛错的校验（.max/.min）：schema 不过 ⇒ entry 被拒收 ⇒ 整条插件不激活。
 */
export const Config = !z ? undefined : z.object({
  axes: z.array(z.string()).default(DEFAULTS.axes).extra('volatile', true),
  ups: z.array(z.string()).default([]).extra('volatile', true),
  fanMin: z.natural().default(0).extra('volatile', true),
  fanMax: z.natural().default(0).extra('volatile', true),
  minMinutes: z.natural().default(8).extra('volatile', true),
  maxMinutes: z.natural().default(90).extra('volatile', true),
  minPlay: z.natural().default(10000).extra('volatile', true),
  mainCount: z.natural().default(5).extra('volatile', true),
  showCharging: z.boolean().default(false).extra('volatile', true),
  /** 让模型当策展人：从候选里挑 5 条 + 写理由 */
  curatorOn: z.boolean().default(true).extra('volatile', true),
  /** 单独为某条写理由（不开启策展人时也能用） */
  explainOn: z.boolean().default(true).extra('volatile', true),
  /** 推荐理由的语气与风格 */
  reasonStyle: z.string().default('').extra('volatile', true),
})

/**
 * 片单多久算「旧」。
 * 0.3.0 之前是 30 分钟的硬 TTL —— 超过就阻塞重建，所以重开 DSH 要空白 40 秒。
 * 现在它只用来判断「要不要在角标上说明后台正在更新」：
 * 真正的重建时机交给 lib/refresh.mjs 的三档（3h 打开 / 6h 自动 / 24h 全量）。
 */
const FEED_TTL = 3 * 3600 * 1000

const unwrap = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v)

function toArr(v) {
  const x = unwrap(v)
  if (Array.isArray(x)) return x.map((s) => String(s).trim()).filter(Boolean)
  if (typeof x === 'string') return x.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean)
  return []
}

function toNum(v, d) {
  const n = Number(unwrap(v))
  return Number.isFinite(n) ? n : d
}

function toBool(v) {
  return unwrap(v) === true
}

function toStr(v) {
  const x = unwrap(v)
  return typeof x === 'string' ? x : ''
}

function maskKey(key) {
  const value = String(key || '')
  if (!value) return ''
  // 短密钥不显示首尾，避免掩码暴露完整密钥。
  if (value.length <= 10) return '••••••••••'
  return `${value.slice(0, 5)}••••${value.slice(-5)}`
}

function stateDirOf(ctx) {
  let dir = ''
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') {
      const v = p('bili-jar')
      if (v) dir = String(v)
    } else if (typeof p === 'string' && p) {
      dir = join(p, 'bili-jar')
    }
  } catch { /* 兜底 */ }
  if (!dir) dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'bili-jar')
  mkdirSync(dir, { recursive: true })
  return dir
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

/**
 * 读 bili-scroll 的产物（纯只读）：日报里的 `### BV号` + 下一行的标题
 * 返回 [{bvid, title, source:'scroll'}]，最多 limit 条
 */
function readScrollSeeds(limit = 20) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dirs = [join(home, 'bili-duty', 'out'), join(home, 'bili-duty', 'digest')]
  const out = []
  for (const dir of dirs) {
    let files = []
    try { files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort().reverse().slice(0, 6) } catch { continue }
    for (const f of files) {
      let txt = ''
      try { txt = readFileSync(join(dir, f), 'utf8') } catch { continue }
      const lines = txt.split('\n')
      for (let i = 0; i < lines.length; i += 1) {
        const m = /^###\s*(BV[0-9A-Za-z]{10})/.exec(lines[i])
        if (!m) continue
        const next = String(lines[i + 1] || '').replace(/^[\s>*-]+/, '').split('|')[0].split('/')[0].trim()
        out.push({ bvid: m[1], title: next.slice(0, 80) || `（${m[1]}）`, source: 'scroll' })
        if (out.length >= limit) return out
      }
    }
  }
  return out
}

function readBody(req, limit = 64 * 1024) {  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { resolve(''); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

export function apply(ctx, config) {
  const stateDir = stateDirOf(ctx)
  const logFile = join(stateDir, 'bili-jar.log')
  setLogFile(logFile)
  const log = (...a) => {
    try { console.log('[bili-jar]', ...a) } catch { /* 无控制台 */ }
    try { logInfo('console', a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')) } catch { /* 无所谓 */ }
  }

  const feedFile = join(stateDir, 'feed.json')
  const poolFile = join(stateDir, 'pool.json')
  const shownFile = join(stateDir, 'shown.json')
  const reasonsFile = join(stateDir, 'reasons.json')
  const overridesFile = join(stateDir, 'config.json')
  const feedbackFile = join(stateDir, 'feedback.jsonl')
  const laterFile = join(stateDir, 'later.json')
  const historyFile = join(stateDir, 'history.json')
  const upsFile = join(stateDir, 'ups.json')
  const refreshFile = join(stateDir, 'refresh.json')
  // 重启会清掉内存里的池子/片单，磁盘上的 json 又没人愿意翻 —— 所以每次启动
  // 和每轮刷新之后，顺手写一份人眼能看的 STATE.md
  const refreshStateDoc = () => { try { writeStateDoc(stateDir) } catch { /* 写不出来不影响主流程 */ } }
  const treeFile = join(stateDir, 'axis-tree.json')
  const usageFile = join(stateDir, 'usage.json')
  setUsageFile(usageFile)
  try {
    const m = migrateUsage(usageFile)
    if (m?.dropped) logInfo('usage:migrate', `去掉 ${m.dropped} 条重复的旧汇总，保留 ${m.kept} 条真实记录（备份 ${m.backup}）`)
    else if (m?.error) logWarn('usage:migrate-fail', m.error)
  } catch (e) { logWarn('usage:migrate-fail', String(e?.message ?? e)) }
  const version = (() => {
    try { return String(JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8')).version || '') } catch { return '' }
  })()
  const startedAt = Date.now()
  let hits = 0

  let feedCache = (() => {
    const j = readJson(feedFile, null)
    return j && j.ts ? j : null
  })()
  let history = readJson(historyFile, [])
  history = Array.isArray(history) ? history.filter((it) => it?.bvid).slice(0, 10) : []
  function withoutWatched(next) {
    if (!next) return next
    const watched = new Set([
      ...history.map((it) => it.bvid),
      ...(next.watchedBvids || []),
      ...(feedCache?.ts === next.ts ? (feedCache?.watchedBvids || []) : []),
    ])
    const out = { ...next, watchedBvids: [...watched] }
    for (const key of ['main', 'up', 'shortlist', 'pool']) {
      if (Array.isArray(out[key])) out[key] = out[key].filter((it) => !watched.has(it.bvid))
    }
    return out
  }
  feedCache = withoutWatched(feedCache)
  let prevPool = readJson(poolFile, [])
  /**
   * 三档刷新（0.3.0）：probedAt = 上次轻量探测，fullAt = 上次完整重建。
   * 「触发同时清零」—— 真跑起来了就把两个计时都推到现在，打开面板和定时器别重复触发。
   */
  let refreshAt = (() => {
    const j = readJson(refreshFile, null)
    return {
      probedAt: Number(j?.probedAt) || 0,
      fullAt: Number(j?.fullAt) || Number(feedCache?.ts) || 0,
    }
  })()
  function saveRefreshAt() {
    try { writeFileSync(refreshFile, JSON.stringify(refreshAt), 'utf8') } catch { /* 无所谓 */ }
  }
  /** 熟人名单（lib/ups.mjs 算的；内存留一份给 buildPool 和探测用） */
  let upsList = []
  let upsTiers = { regular: [], observing: [], black: [] }
  // 最近推过什么：{ rounds: [[...] ...] }，最近 5 轮最多 25 条 —— 排除集用。
  // 旧格式（纯数组）也能读，升级不炸。
  let recentShown = parseShown(readJson(shownFile, null))
  let reasons = loadReasonCache(reasonsFile)
  /** 罐子里那份配置：优先级最高（原生设置页看不见这些字段，只能自己存） */
  let overrides = readJson(overridesFile, {})
  let building = null
  let probing = null
  let explaining = null

  /** 用户自己长出来的枝：启动时读进来，之后每次改动都落盘 */
  let userTree = (() => {
    try { return JSON.parse(readFileSync(treeFile, 'utf8')) } catch { return {} }
  })()
  setUserTree(userTree)
  const saveUserTree = () => {
    try { writeFileSync(treeFile, JSON.stringify(userTree, null, 2), 'utf8') } catch (e) { logWarn('tree:save', String(e?.message ?? e)) }
  }

  let rowCache = { at: 0, row: null }
  function settingsRow(fresh = false) {
    const t = Date.now()
    if (!fresh && t - rowCache.at < 3000) return rowCache.row
    let row = null
    try {
      const rows = ctx.settings?.describe?.() || []
      row = rows.find((r) => r?.value && 'axes' in r.value && 'ups' in r.value) || null
    } catch (e) { log(`读设置表单失败：${e?.message ?? e}`) }
    rowCache = { at: t, row }
    return row
  }

  function cfgNow() {
    const row = settingsRow()
    const src = row?.value && typeof row.value === 'object' ? row.value : config
    const c = (src && typeof src === 'object') ? src : {}
    const merged = { ...c, ...overrides }
    const axes = toArr(merged.axes)
    // 空数组表示用户主动清空；只有未配置或无效值才回退默认兴趣轴。
    const hasAxes = Array.isArray(unwrap(merged.axes)) || axes.length > 0
    return {
      axes: hasAxes ? axes : DEFAULTS.axes.slice(),
      ups: toArr(merged.ups),
      fanMin: toNum(merged.fanMin, 0),
      fanMax: toNum(merged.fanMax, 0),
      minMinutes: toNum(merged.minMinutes, 8),
      maxMinutes: toNum(merged.maxMinutes, 90),
      maxDays: merged.maxDays === undefined ? 14 : toNum(merged.maxDays, 14),
      diversity: Math.max(0, Math.min(1, merged.diversity === undefined ? 0.5 : toNum(merged.diversity, 0.5))),
      minPlay: toNum(merged.minPlay, 10000),
      mainCount: toNum(merged.mainCount, 5),
      showCharging: toBool(merged.showCharging),
      curatorOn: merged.curatorOn === undefined ? true : toBool(merged.curatorOn),
      explainOn: merged.explainOn === undefined ? true : toBool(merged.explainOn),
      reasonStyle: toStr(merged.reasonStyle) || DEFAULTS.reasonStyle,
      apiBase: toStr(merged.apiBase) || DEFAULTS.apiBase,
      apiKey: toStr(merged.apiKey),
      apiModel: toStr(merged.apiModel) || DEFAULTS.apiModel,
      contentSource: toStr(merged.contentSource) || DEFAULTS.contentSource,
      useScrollLogin: merged.useScrollLogin === true,
      avatarPreset: toStr(merged.avatarPreset) || DEFAULTS.avatarPreset,
    }
  }

  /** 攒够这么多条赞/踩，才允许它们参与打分（太少会过拟合） */
  const FEEDBACK_MIN = 20

  /**
   * 把 feedback.jsonl 折成「UP → 次数」「tag → 次数」，喂给 pool 做微调。
   * bvid → UP/tag 的映射从池子和当前片单里找（都是刚落过盘的）。
   */
  /**
   * 从本地行为里认出「熟人」（0.3.0）。
   * 输入全是已有的本地文件：点赞/踩、点开过、稍后看、上一轮池子（补 mid）。
   * 结果写 ~/.dsh/bili-jar/ups.json，同时在日志里报一行，**不占设置页界面**。
   */
  function refreshUps() {
    try {
      let feedback = []
      try {
        feedback = readFileSync(feedbackFile, 'utf8').split(/\r?\n/).filter(Boolean)
          .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
      } catch { feedback = [] }
      const list = buildUpList({
        feedback,
        history,
        later: readJson(laterFile, []),
        pool: [...(prevPool || []), ...((feedCache && feedCache.main) || [])],
        now: Date.now(),
      })
      upsList = list.ups
      upsTiers = list.byTier
      try { writeFileSync(upsFile, JSON.stringify(list, 'utf8')) } catch { /* 无所谓 */ }
      const names = (arr) => arr.slice(0, 8).map((u) => u.name || u.mid).join('、') || '无'
      logInfo('ups:list', `熟人 ${list.byTier.regular.length} / 观察 ${list.byTier.observing.length} / 拉黑 ${list.byTier.black.length}｜熟人：${names(list.byTier.regular)}`)
    } catch (e) { logWarn('ups:fail', String(e?.message ?? e)) }
  }

  function affinityOf() {
    let rows = []
    try {
      rows = readFileSync(feedbackFile, 'utf8').split(/\r?\n/).filter(Boolean)
        .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    } catch { rows = [] }
    const meta = new Map()
    for (const it of [...(prevPool || []), ...((feedCache && feedCache.main) || [])]) {
      if (it?.bvid) meta.set(it.bvid, it)
    }
    const authors = new Map()
    const dislikes = new Map()
    const tags = new Map()
    const tagDislikes = new Map()
    const bump = (m, k) => { if (k) m.set(k, (m.get(k) || 0) + 1) }
    for (const r of rows) {
      const m = meta.get(r.bvid)
      if (!m) continue
      const up = String(m.mid || m.author || '')
      if (r.action === 'like') {
        bump(authors, up)
        for (const t of (m.tags || []).slice(0, 6)) bump(tags, t)
      } else if (r.action === 'dislike') {
        bump(dislikes, up)
        for (const t of (m.tags || []).slice(0, 6)) bump(tagDislikes, t)
      }
    }
    const ready = rows.length >= FEEDBACK_MIN
    return { ready, total: rows.length, authors, dislikes, tags, tagDislikes }
  }

  /**
   * 如果需要，接管 bili-scroll 的 B站 登录（只为了取 AI 字幕）。
   * ⚠️ 不勾选时**绝不**去读那个文件。
   */
  let adoptedAt = 0
  // 启动时优先用插件自己的凭证（扫码登录存下来的那份）
  try {
    const own = join(stateDir, 'credential.json')
    if (existsSync(own)) {
      const n = adoptCookies(JSON.parse(readFileSync(own, 'utf8')))
      if (n) logInfo('login:own', `${n} 个字段（插件自己的凭证）`)
    }
  } catch { /* 没有就算了 */ }

  function maybeAdoptLogin(cfg) {
    if (!cfg.useScrollLogin) return false
    if (Date.now() - adoptedAt < 10 * 60 * 1000) return true
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    const f = join(home, 'bili-duty', 'bili_credential.json')
    if (!existsSync(f)) { logWarn('login:missing', f); return false }
    try {
      const cred = JSON.parse(readFileSync(f, 'utf8'))
      const n = adoptCookies(cred)
      adoptedAt = Date.now()
      logInfo('login:adopted', `${n} 个 cookie 字段（来自 bili-scroll）`)
      return n > 0
    } catch (e) { logWarn('login:fail', String(e?.message ?? e)); return false }
  }

  /**
   * 用真实内容重写推荐语：先取字幕，没有就退到热评。
   * 一次调用写 5 条，不逐条问。
   */
  async function enrichReasons(picks, cfg) {
    // 每条的「字幕→热评」是一次独立请求，5 条串行白等 5 秒。3 并发走批。
    const got = []
    for (let i = 0; i < picks.length; i += 3) {
      const rows = await Promise.all(picks.slice(i, i + 3).map(async (p) => {
        let content = ''
        const sub = await videoSubtitle(p.bvid)
        if (sub.ok) content = sub.text
        else {
          const cm = await videoComments(p.bvid, 20)
          if (cm.ok) content = cm.text
        }
        logInfo('content:fetch', `${p.bvid} ${content ? content.length + ' 字' : '无内容'}`)
        return { ...p, content }
      }))
      got.push(...rows)
    }
    const usable = got.filter((x) => x.content)
    if (!usable.length) return picks

    const system = [
      '你在替一个人写「这条视频为什么值得看」的一句话推荐语。',
      '下面给了你视频的真实内容（字幕或评论摘录），**依据内容写**，不要依据任何数据。',
      '🔴 不许出现任何数字（播放量、点赞率、收藏率、投币率都不行）。',
      '40–70 字，口语，具体：讲了什么、怎么讲的、适合什么时候看。不要用「这条视频」开头。',
      cfg.reasonStyle ? `语气与风格：${cfg.reasonStyle}` : '',
      '只输出 JSON 数组：[{"bvid":"BV...","why":"..."}]，不要代码块。',
    ].filter(Boolean).join('\n')
    const user = usable.map((x, i) => `${i + 1}. ${x.bvid} 《${x.title}》\n内容：${x.content.slice(0, 900)}`).join('\n\n')

    const text = await writeReasonCore(ctx, {
      system, user, maxTokens: 900, timeoutMs: 60000,
      api: { base: cfg.apiBase, key: cfg.apiKey, model: cfg.apiModel },
    })
    if (!text) { logWarn('content:llm-fail', llmError.msg || '空'); return picks }
    let arr = null
    try { const m = text.match(/\[[\s\S]*\]/); arr = JSON.parse(m ? m[0] : text) } catch { arr = null }
    if (!Array.isArray(arr)) { logWarn('content:parse-fail', text.slice(0, 80)); return picks }
    const byBvid = new Map(arr.map((x) => [String(x?.bvid || ''), String(x?.why || '').trim()]))
    return picks.map((p) => (byBvid.get(p.bvid) ? { ...p, why: byBvid.get(p.bvid).slice(0, 160) } : p))
  }

  /** 排除集：最近 5 轮推过的 + 看过的 —— 建池和探测共用 */
  function excludesNow() {
    return [...new Set([...flattenShown(recentShown), ...history.map((it) => it.bvid)])]
  }

  /**
   * A1：stale-while-revalidate —— 磁盘上有旧片单就**立刻**给，重建挪到后台。
   * 之前超过 30 分钟就阻塞重建，重开 DSH 后面板要空白 40 多秒。
   */
  async function getFeed(force) {
    const hasCache = Boolean(feedCache && feedCache.ts)
    if (!force && hasCache) {
      const age = Date.now() - feedCache.ts
      const action = decideRefresh({ now: Date.now(), probedAt: refreshAt.probedAt, fullAt: refreshAt.fullAt, opened: true })
      if (action === 'full') kickBuild('打开面板：片单过期')
      else if (action === 'probe') kickProbe('打开面板')
      return { ...feedCache, cached: true, stale: age > FEED_TTL, refreshing: action !== 'none' }
    }
    if (building) return building
    return kickBuild(force ? '换一批' : '首次装罐')
  }

  /** 后台完整重建（不阻塞调用方；已经在建就复用同一个 Promise） */
  function kickBuild(reason) {
    if (building) return building
    refreshAt.probedAt = Date.now()
    refreshAt.fullAt = Date.now()
    saveRefreshAt()
    logInfo('refresh:trigger', `full（${reason || ''}）`)
    building = (async () => {
      try {
        const t0 = Date.now()
        const cfg = cfgNow()
        maybeAdoptLogin(cfg)
        const exclude = excludesNow()
        const aff = affinityOf()
        if (aff.ready) logInfo('affinity:on', `${aff.total} 条赞踩参与打分`)
        refreshUps()
        const r = await buildPool(
          { ...cfg, exclude, affinity: aff, upsList: [...upsTiers.regular, ...upsTiers.observing] },
          (m) => log(m),
          prevPool,
        )
        logInfo('feed:built', JSON.stringify(r.stats || {}))
        // 自动判定 freshness：只看年龄中位，不数条数。
        // 手填过的轴（freshnessAuto === false 且已有值）不覆盖。
        try {
          const per = r.stats?.perAxis || {}
          let dirty = false
          const next = { ...(getUserTree() || {}) }
          for (const [axis, st] of Object.entries(per)) {
            const cur = next[axis] || {}
            const pinned = Boolean(cur.freshness) && cur.freshnessAuto === false
            if (pinned) continue
            if (!st?.suggest || cur.freshness === st.suggest) continue
            next[axis] = { ...cur, freshness: st.suggest, freshnessAuto: true }
            dirty = true
            logInfo('freshness', `${axis} → ${st.suggest}（${st.reason}）`)
          }
          if (dirty) { userTree = next; setUserTree(next); saveUserTree() }
        } catch (e) { log(`freshness 判定失败：${e?.message ?? e}`) }
        const out = { ...r, tookMs: Date.now() - t0, cached: false, excluded: exclude.length }
        feedCache = withoutWatched(out)
        recentShown = pushRound(recentShown, (r.main || []).map((c) => c.bvid))
        try { writeFileSync(shownFile, JSON.stringify(recentShown), 'utf8') } catch { /* 无所谓 */ }
        if (Array.isArray(r.pool)) {
          prevPool = r.pool
          try { writeFileSync(poolFile, JSON.stringify(prevPool), 'utf8') } catch (e) { log(`pool 落盘失败：${e?.message ?? e}`) }
        }
        try { writeFileSync(feedFile, JSON.stringify(feedCache), 'utf8') } catch (e) { log(`feed 落盘失败：${e?.message ?? e}`) }
        refreshStateDoc()

        // ⭐ 策展人：规则给候选，模型挑 5 条并写理由
        // ⭐ 内容源：额外把 bili-scroll 报告里挑过的视频并进候选
        let shortlist = feedCache.shortlist || []
        let seeded = 0
        if (cfg.contentSource === 'scroll' || cfg.contentSource === 'both') {
          const seeds = readScrollSeeds()
          const have = new Set(shortlist.map((x) => x.bvid))
          const add = seeds.filter((s) => !have.has(s.bvid)).map((s) => ({
            bvid: s.bvid, title: s.title, author: '', duration: 0, pubdate: Math.floor(Date.now() / 1000),
            play: 0, tags: [], typeName: '', pct: {}, source: 'scroll',
            reasons: ['来自 bili-scroll 的报告'],
          }))
          seeded = add.length
          shortlist = cfg.contentSource === 'both' ? [...shortlist, ...add] : add.length ? add : shortlist
          if (seeded) logInfo('seed:scroll', `${seeded} 条 / 模式=${cfg.contentSource}`)
        }
        shortlist = withoutWatched({ ts: out.ts, shortlist }).shortlist

        if (cfg.curatorOn && shortlist.length) {
          const t1 = Date.now()
          const c = await curate(ctx, shortlist, cfg.reasonStyle, {
            pick: cfg.mainCount,
            api: { base: cfg.apiBase, key: cfg.apiKey, model: cfg.apiModel },
          })
          if (c.ok) {
            const byBvid = new Map(shortlist.map((x) => [x.bvid, x]))
            const curated = c.picks.map((p, i) => ({ ...byBvid.get(p.bvid), why: p.why, rank: i + 1 }))
            const enriched = await enrichReasons(curated, cfg)
            // 防回音室（策展路径）：模型自己挑的时候不受规则那边 2 条上限的约束，
            // 熟人加权后很容易被一口气挑 3 个 —— 这里把最终 5 条再收一次。
            const echoCapNow = Math.max(1, Math.ceil((Number(cfg.mainCount) || 5) * 0.4))
            const ec = capCuratedEcho(enriched, shortlist, echoCapNow)
            if (ec.trimmed) logInfo('echo:cap', `策展结果里有 ${ec.echo} 条熟人来源，换掉 ${ec.trimmed} 条（上限 ${echoCapNow}）`)
            if (out.stats) out.stats.echoGuard = { ...(out.stats.echoGuard || {}), cap: echoCapNow, final: ec.echo, curatedTrimmed: ec.trimmed }
            feedCache = withoutWatched({ ...out, main: ec.main, curated: true, curatorMs: Date.now() - t1 })
            logInfo('curate:ok', `${curated.length} 条 / ${Date.now() - t1}ms`)
            for (const p of c.picks) reasons[p.bvid] = { text: p.why, at: Date.now() }
            saveReasonCache(reasonsFile, reasons)
            try { writeFileSync(feedFile, JSON.stringify(feedCache), 'utf8') } catch { /* 无所谓 */ }
            refreshStateDoc()
            return feedCache
          }
          log(`策展失败，退回规则片单：${c.note}`)
          logWarn('curate:fail', String(c.note || '未知'))
          feedCache = withoutWatched({ ...out, curated: false, curatorNote: c.note })
          refreshStateDoc()
          return feedCache
        }
        return feedCache
      } catch (e) {
        log(`建池失败：${e?.message ?? e}`)
        if (feedCache) return { ...feedCache, cached: true, error: String(e?.message ?? e) }
        return { ok: false, error: String(e?.message ?? e), main: [], up: [], stats: {} }
      } finally {
        building = null
      }
    })()
    return building
  }

  /**
   * 轻量探测（0.3.0）：3–24 小时那一档。
   * 只问一句「有没有值得提前装进来的新片」，命中就排队一次完整重建。
   * 探测本身不调模型、不算分，所以很便宜；跑完把 probedAt 推到现在（触发即清零）。
   */
  function kickProbe(reason) {
    if (probing) return probing
    probing = (async () => {
      try {
        const cfg = cfgNow()
        refreshAt.probedAt = Date.now()
        saveRefreshAt()
        logInfo('refresh:trigger', `probe（${reason || ''}）`)
        const t0 = Date.now()
        const r = await lightProbe(
          { ...cfg, exclude: excludesNow() },
          { ups: upsTiers.regular, log },
        )
        logInfo('probe:run', `${r.checkedUp} 个熟人 / ${r.searched} 次搜索 / ${r.tookMs}ms`)
        if (r.hit.length) {
          logInfo('probe:hit', `${r.hit.length} 条 → 排队完整重建｜${r.hit.slice(0, 3).map((x) => x.title.slice(0, 18)).join(' / ')}`)
          // 命中说明真有新鲜事：这时候值得花一次完整重建
          await kickBuild(`探测命中 ${r.hit.length} 条`)
        } else {
          logInfo('probe:hit', `0 条（${Date.now() - t0}ms）`)
        }
      } catch (e) {
        logWarn('probe:fail', String(e?.message ?? e))
      } finally {
        probing = null
      }
    })()
    return probing
  }

  /** 给当前这批补理由（没走策展人时用） */
  async function getReasons(force) {
    if (explaining) return explaining
    explaining = (async () => {
      const cfg = cfgNow()
      const items = feedCache?.main || []
      const out = {}
      let generated = 0
      for (const it of items) {
        if (it.why) { out[it.bvid] = it.why; continue }
        const hit = reasons[it.bvid]
        if (hit?.text && !force) { out[it.bvid] = hit.text; continue }
        if (generated >= 6) break
        const text = await writeReason(ctx, it, cfg.reasonStyle, {
          api: { base: cfg.apiBase, key: cfg.apiKey, model: cfg.apiModel },
        })
        if (text) {
          reasons[it.bvid] = { text, at: Date.now() }
          out[it.bvid] = text
          generated += 1
        }
      }
      if (generated) saveReasonCache(reasonsFile, reasons)
      return { ok: true, reasons: out, generated, style: cfg.reasonStyle }
    })().finally(() => { explaining = null })
    return explaining
  }

  const handle = async (req, res, url) => {
    const p = url.pathname.replace(/^\/api\/bili-jar/, '') || '/'

    if (req.method === 'GET' && p === '/ping') {
      hits += 1
      return sendJson(res, 200, {
        ok: true, plugin: name, version,
        uptimeMs: Date.now() - startedAt, hits,
        stateDir, hostNotes,
        poolSize: Array.isArray(prevPool) ? prevPool.length : 0,
        feed: feedCache ? { ts: feedCache.ts, main: feedCache.main?.length ?? 0, curated: Boolean(feedCache.curated) } : null,
      })
    }

    if (req.method === 'GET' && p === '/state') {
      const c = cfgNow()
      const key = c.apiKey || ''
      // 🔒 永远不把完整 key 递到浏览器：只给掩码
      const masked = maskKey(key)
      return sendJson(res, 200, {
        ok: true,
        stateDir,
        config: { ...c, apiKey: '' },
        apiKeySet: Boolean(key),
        apiKeyMasked: masked,
        feedTs: feedCache?.ts ?? null,
        poolSize: prevPool.length,
        usage: todayUsage(usageFile),
      })
    }

    if (req.method === 'POST' && p === '/config') {
      const body = await readBody(req)
      if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: 'body 不是 JSON' })
      const allow = Object.keys(DEFAULTS)
      for (const [k, v] of Object.entries(body)) if (allow.includes(k)) overrides[k] = v
      try { writeFileSync(overridesFile, JSON.stringify(overrides), 'utf8') } catch (e) { log(`配置落盘失败：${e?.message ?? e}`) }
      const c = cfgNow()
      return sendJson(res, 200, {
        ok: true,
        config: { ...c, apiKey: '' },
        overrides: { ...overrides, apiKey: '' },
        apiKeySet: Boolean(c.apiKey),
        apiKeyMasked: maskKey(c.apiKey),
      })
    }

    /* ── 轴树：内置的那棵 + 你自己长出来的枝 ──────────────────────────── */
    if (req.method === 'GET' && p === '/tree') {
      const axes = Array.from(new Set([
        ...Object.keys(AXIS_TREE), ...Object.keys(getUserTree() || {}), ...cfgNow().axes,
      ]))
      const nodes = {}
      for (const ax of axes) {
        const n = nodeFor(ax)
        const mine = new Set(((getUserTree()[ax] || {}).subs || []).map((s) => s.name))
        nodes[ax] = {
          builtin: Object.hasOwn(AXIS_BASE, ax),
          freshness: freshnessOf(ax),
          freshnessAuto: Boolean((userTree[ax] || {}).freshnessAuto),
          search: n.search || [],
          subs: (n.subs || []).map((s) => ({ name: s.name, terms: s.terms || [], mine: mine.has(s.name) })),
        }
      }
      return sendJson(res, 200, { ok: true, nodes, presets: Object.keys(AXIS_BASE) })
    }

    if (req.method === 'POST' && p === '/tree') {
      const body = await readBody(req)
      const axis = String(body?.axis || '').trim()
      if (!axis) return sendJson(res, 400, { ok: false, error: '缺 axis' })
      const action = String(body?.action || 'addSub')
      const node = { ...((getUserTree() || {})[axis] || {}) }
      node.subs = [...(node.subs || [])]

      if (action === 'addSub') {
        const name = String(body?.name || '').trim().slice(0, 24)
        const terms = (Array.isArray(body?.terms) ? body.terms : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 8)
        if (!name || !terms.length) return sendJson(res, 400, { ok: false, error: '子簇要名字和词' })
        const i = node.subs.findIndex((x) => x.name === name)
        if (i >= 0) node.subs[i] = { name, terms: Array.from(new Set([...(node.subs[i].terms || []), ...terms])) }
        else node.subs.push({ name, terms })
      } else if (action === 'delSub') {
        const name = String(body?.name || '').trim()
        node.subs = node.subs.filter((x) => x.name !== name)
      } else if (action === 'addSearch') {
        const word = String(body?.word || '').trim()
        if (!word) return sendJson(res, 400, { ok: false, error: '缺 word' })
        node.search = Array.from(new Set([...(node.search || []), word]))
      } else if (action === 'setFreshness') {
        const value = String(body?.value || '').trim()
        if (!isFreshness(value)) return sendJson(res, 400, { ok: false, error: 'freshness 只能是 news 或 evergreen' })
        node.freshness = value
        node.freshnessAuto = false   // 手填的，之后自动判定不再覆盖它
      } else {
        return sendJson(res, 400, { ok: false, error: `不认识的动作：${action}` })
      }

      userTree = { ...userTree, [axis]: node }
      setUserTree(userTree)
      saveUserTree()
      logInfo('tree:edit', `${axis} ${action} ${body?.name || body?.word || ''}`)
      return sendJson(res, 200, { ok: true, nodes: { [axis]: { search: nodeFor(axis).search || [], subs: nodeFor(axis).subs || [] } } })
    }

    /**
     * 从现有池子里挖子簇建议（tag 的 DF + 两两共现 PMI）。
     * `review=1` 时再让模型过一遍：判要不要、起个能当标签用的名字、说一句为什么。
     * 挖出来**不会自动写进树**，要不要由人点。
     */
    if (req.method === 'GET' && p === '/tree/suggest') {
      const axis = String(url.searchParams.get('axis') || '').trim()
      if (!axis) return sendJson(res, 400, { ok: false, error: '缺 axis' })
      const items = (prevPool && prevPool.length) ? prevPool : (feedCache?.pool || [])
      if (!items.length) return sendJson(res, 200, { ok: false, error: '池子是空的，先刷一轮' })

      const sg = suggestSubs(items, axis, axisSim, { maxClusters: 4, minDf: 3 })
      const wantReview = url.searchParams.get('review') === '1'
      if (!wantReview || !sg.clusters.length) return sendJson(res, 200, { ok: true, ...sg })

      const cur = cfgNow()
      const r = await reviewClusters(ctx, {
        axis,
        node: nodeFor(axis),
        clusters: sg.clusters,
        api: { base: cur.apiBase, key: cur.apiKey, model: cur.apiModel },
      })
      if (!r.ok) {
        logWarn('tree:review-fail', r.note || '')
        return sendJson(res, 200, { ok: true, ...sg, reviewed: false, reviewNote: r.note || '模型没筛成，这是原始建议' })
      }
      logInfo('tree:review', `${axis} 留 ${r.kept.length} / 丢 ${r.dropped.length}`)
      return sendJson(res, 200, {
        ok: true,
        axis: sg.axis,
        sampled: sg.sampled,
        threshold: sg.threshold,
        loose: sg.loose,
        reviewed: true,
        clusters: r.kept,
        dropped: r.dropped,
      })
    }

    /* ── 语气预设：存的是"说话什么样"，不是整套配置 ──────────────────
     * 存在 config.json 的 `stylePresets`（名字 → 风格正文）。
     * 前端「导入 .md」读出来的文字也走这里，一键落成预设。 */
    if (req.method === 'GET' && p === '/style') {
      return sendJson(res, 200, {
        ok: true,
        presets: { ...BUILTIN_STYLES, ...(overrides.stylePresets || {}) },
        builtin: Object.keys(BUILTIN_STYLES),
        current: String(cfgNow().reasonStyle || ''),
      })
    }

    if (req.method === 'POST' && p === '/style') {
      const body = await readBody(req)
      const action = String(body?.action || 'save')
      const name = String(body?.name || '').trim().slice(0, 40)
      const presets = { ...BUILTIN_STYLES, ...(overrides.stylePresets || {}) }

      if (action === 'save' || action === 'import') {
        if (!name) return sendJson(res, 400, { ok: false, error: '预设得有个名字' })
        const text = String(body?.text || '').trim()
        if (!text) return sendJson(res, 400, { ok: false, error: '内容不能为空' })
        if (text.length > 8000) return sendJson(res, 400, { ok: false, error: '太长了（上限 8000 字）' })
        const own = { ...(overrides.stylePresets || {}), [name]: text }
        overrides = { ...overrides, stylePresets: own }
        try { writeFileSync(overridesFile, JSON.stringify(overrides), 'utf8') } catch { /* 下一句会报 */ }
        logInfo(action === 'import' ? 'style:import' : 'style:save', `${name}（${text.length} 字）`)
        return sendJson(res, 200, { ok: true, presets: { ...BUILTIN_STYLES, ...own } })
      }

      if (action === 'apply') {
        if (!presets[name]) return sendJson(res, 404, { ok: false, error: `没有这个预设：${name}` })
        overrides = { ...overrides, reasonStyle: presets[name] }
        try { writeFileSync(overridesFile, JSON.stringify(overrides), 'utf8') } catch { /* 同上 */ }
        logInfo('style:apply', name)
        return sendJson(res, 200, { ok: true, presets, text: presets[name] })
      }

      if (action === 'delete') {
        if (BUILTIN_STYLES[name]) return sendJson(res, 400, { ok: false, error: `「${name}」是自带的，删不掉；想改就另存一个名字` })
        const own = { ...(overrides.stylePresets || {}) }
        delete own[name]
        overrides = { ...overrides, stylePresets: own }
        try { writeFileSync(overridesFile, JSON.stringify(overrides), 'utf8') } catch { /* 同上 */ }
        return sendJson(res, 200, { ok: true, presets: { ...BUILTIN_STYLES, ...own } })
      }

      return sendJson(res, 400, { ok: false, error: `不认识的动作：${action}` })
    }

    /* ── 插画（豆包画的那三张）───────────────────────────────────────── */
    if (req.method === 'GET' && p === '/art') {
      const f = String(url.searchParams.get('f') || 'closed')
      const map = {
        closed: 'jar-closed.png', active: 'jar-active.png', face: 'face.png',
        'walk-a': 'walk-a.png', 'walk-b': 'walk-b.png',
        'anim-out': 'anim-out.png', 'anim-back': 'anim-back.png',
      }
      const file = map[f]
      if (!file) return sendJson(res, 404, { ok: false, error: '没有这张图' })
      try {
        const buf = readFileSync(join(PLUGIN_DIR, 'assets', file))
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' })
        return res.end(buf)
      } catch (e) { return sendJson(res, 404, { ok: false, error: String(e?.message ?? e) }) }
    }

    /* ── 头像：换成自己的 ──────────────────────────────────────────────── */
    /** 选一个内置头像。选完把上传过的那张删掉，否则它永远盖住预设。 */
    if (req.method === 'POST' && p === '/avatar/preset') {
      const body = await readBody(req)
      const name = String(body?.name || '')
      if (!AVATAR_PRESETS[name]) return sendJson(res, 400, { ok: false, error: `没有这个预设：${name}` })
      overrides = { ...overrides, avatarPreset: name }
      try { writeFileSync(overridesFile, JSON.stringify(overrides), 'utf8') } catch { /* 落盘失败不影响本次 */ }
      try { if (existsSync(join(stateDir, 'avatar.png'))) rmSync(join(stateDir, 'avatar.png')) } catch { /* 删不掉算了 */ }
      logInfo('avatar:preset', `${name}（${AVATAR_PRESETS[name].label}）`)
      return sendJson(res, 200, { ok: true, preset: name })
    }

    if (req.method === 'POST' && p === '/avatar') {
      // 默认 64KB 装不下一张 base64 图，之前这里必挂（表现是"只认 png/jpeg"，很误导）
      const body = await readBody(req, 6 * 1024 * 1024)
      const dataUrl = String(body?.dataUrl || '')
      const m = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
      if (!m) return sendJson(res, 400, { ok: false, error: '只认 png / jpeg / webp 的 base64' })
      let buf
      try { buf = Buffer.from(m[2], 'base64') } catch { return sendJson(res, 400, { ok: false, error: 'base64 解不开' }) }
      if (buf.length > 3 * 1024 * 1024) return sendJson(res, 400, { ok: false, error: '图太大了（上限 3 MB）' })
      try {
        mkdirSync(stateDir, { recursive: true })
        writeFileSync(join(stateDir, 'avatar.png'), buf)
        overrides = { ...overrides, avatarPreset: 'custom' }
        logInfo('avatar:set', `${Math.round(buf.length / 1024)} KB`)
        return sendJson(res, 200, { ok: true, uploadAt: Date.now() })
      } catch (e) { return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }) }
    }

    if (req.method === 'DELETE' && p === '/avatar') {
      try { if (existsSync(join(stateDir, 'avatar.png'))) rmSync(join(stateDir, 'avatar.png')) } catch (e) {
        return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) })
      }
      logInfo('avatar:reset', '恢复默认头像')
      return sendJson(res, 200, { ok: true })
    }

    if (req.method === 'GET' && p === '/debug') {
      const safe = (fn, dflt) => { try { return fn() } catch (e) { return `ERR: ${e?.message ?? e}` } }
      let rows = safe(() => ctx.settings?.describe?.() || [], [])
      // 🔒 调试接口也不许把完整 key 递出去
      const dcfg = cfgNow()
      const dOver = { ...overrides }
      if (dOver.apiKey !== undefined) dOver.apiKey = maskKey(dOver.apiKey)
      return sendJson(res, 200, {
        ok: true,
        rowFound: Boolean(safe(() => settingsRow(true), null)),
        rowsCount: Array.isArray(rows) ? rows.length : String(rows).slice(0, 120),
        cfg: { ...dcfg, apiKey: maskKey(dcfg.apiKey) },
        overrides: dOver,
        poolSize: prevPool.length,
        llm: Boolean(safe(() => ctx.llm || ctx.get?.('llm'), null)),
        llmError: llmError.msg,
        usage: todayUsage(usageFile),
      })
    }

    if (req.method === 'GET' && p === '/log') {
      const n = Math.min(300, Number(url.searchParams.get('n')) || 100)
      return sendJson(res, 200, { ok: true, file: logFile, lines: logTail(n) })
    }

    // B站 扫码登录（插件自己的，不依赖 bili-scroll）
    if (req.method === 'GET' && p === '/login/start') {
      const r = await loginStart()
      if (r.ok) {
        // 自己画码（见 lib/qr.mjs）：SVG 内联成 data URL，前端一个 <img> 就够
        try { r.qr = qrDataUrl(r.url) } catch (e) { r.qrError = String(e?.message ?? e) }
        logInfo('login:start', r.qr ? '已生成二维码（SVG）' : `出码但没画出来：${r.qrError || ''}`)
      } else logWarn('login:start-fail', r.error || '')
      return sendJson(res, 200, r)
    }

    if (req.method === 'GET' && p === '/login/poll') {
      const key = url.searchParams.get('key') || ''
      if (!key) return sendJson(res, 400, { ok: false, error: '缺 key' })
      const r = await loginPoll(key)
      if (r.state === 'ok' && r.credential) {
        try {
          const credFile = join(stateDir, 'credential.json')
          writeFileSync(credFile, JSON.stringify(r.credential), { encoding: 'utf8', mode: 0o600 })
          adoptCookies(r.credential)
          adoptedAt = Date.now()
          logInfo('login:ok', '凭证已保存到插件家目录')
        } catch (e) { logWarn('login:save-fail', String(e?.message ?? e)) }
      }
      return sendJson(res, 200, { ok: r.ok, state: r.state, message: r.message || '', hasCredential: Boolean(r.credential) })
    }

    if (req.method === 'GET' && p === '/login/status') {
      return sendJson(res, 200, { ok: true, loggedIn: hasLogin(), ownCredential: existsSync(join(stateDir, 'credential.json')) })
    }

    // 赞 / 踩：只记本地，绝不落到 B站 账号
    if (req.method === 'POST' && p === '/feedback') {
      const body = await readBody(req)
      const bvid = String(body?.bvid || '').trim()
      const action = String(body?.action || '').trim()
      if (!bvid || !['like', 'dislike'].includes(action)) {
        return sendJson(res, 400, { ok: false, error: '要 {bvid, action: like|dislike}' })
      }
      const item = [...(feedCache?.main || []), ...(feedCache?.up || [])].find((x) => x.bvid === bvid) || {}
      // 去重（0.3.0）：同一条 bvid + 同一个动作只记一次。
      // 之前一条视频能被记 3 行（前端重复触发），熟人分数跟着虚高。
      let dup = false
      try {
        const lines = readFileSync(feedbackFile, 'utf8').split(/\r?\n/).filter(Boolean)
        for (const l of lines) {
          try {
            const r = JSON.parse(l)
            if (r?.bvid === bvid && r?.action === action) { dup = true; break }
          } catch { /* 坏行跳过 */ }
        }
      } catch { dup = false }
      if (dup) return sendJson(res, 200, { ok: true, duplicate: true })

      const row = { ts: Date.now(), bvid, action, mid: item.mid || 0, axis: item.axis || '', sub: item.sub || '', tags: (item.tags || []).slice(0, 6) }
      try { appendFileSync(feedbackFile, JSON.stringify(row) + '\n', 'utf8') } catch (e) { logWarn('feedback:write', String(e?.message ?? e)) }
      logInfo('feedback', `${action} ${bvid}`)
      return sendJson(res, 200, { ok: true, row })
    }

    // 打开视频即记为已观看；历史只保留最近 10 条，同一视频再次打开时移到最前。
    if (req.method === 'GET' && p === '/history') {
      return sendJson(res, 200, { ok: true, items: history })
    }
    if (req.method === 'POST' && p === '/history') {
      const body = await readBody(req)
      const bvid = String(body?.bvid || '').trim()
      if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return sendJson(res, 400, { ok: false, error: '无效的 bvid' })
      const savedLater = readJson(laterFile, [])
      const item = [...(feedCache?.main || []), ...(feedCache?.up || []), ...savedLater, ...history]
        .find((it) => it.bvid === bvid) || body.item || {}
      const entry = { bvid, mid: Number(item.mid) || 0, watchedAt: Date.now(), url: `https://www.bilibili.com/video/${bvid}` }
      for (const key of ['title', 'author', 'durationText', 'play', 'pubdate', 'pct', 'why', 'reasons', 'tags', 'mid']) {
        if (item[key] !== undefined) entry[key] = item[key]
      }
      const nextHistory = [entry, ...history.filter((it) => it.bvid !== bvid)].slice(0, 10)
      writeFileSync(historyFile, JSON.stringify(nextHistory), 'utf8')
      history = nextHistory
      feedCache = withoutWatched(feedCache)
      if (feedCache) writeFileSync(feedFile, JSON.stringify(feedCache), 'utf8')
      const later = savedLater.filter((it) => it.bvid !== bvid)
      writeFileSync(laterFile, JSON.stringify(later), 'utf8')
      refreshStateDoc()
      return sendJson(res, 200, {
        ok: true, items: history, main: feedCache?.main || [], up: feedCache?.up || [], later,
        unreadCount: feedCache?.main?.length || 0,
      })
    }

    // 稍后看：落盘，不再只存在浏览器
    if (req.method === 'GET' && p === '/later') {
      return sendJson(res, 200, { ok: true, items: readJson(laterFile, []) })
    }
    if (req.method === 'POST' && p === '/later') {
      const body = await readBody(req)
      const bvid = String(body?.bvid || '').trim()
      if (!bvid) return sendJson(res, 400, { ok: false, error: '要 bvid' })
      let list = readJson(laterFile, [])
      if (body.action === 'remove') list = list.filter((x) => x.bvid !== bvid)
      else if (!list.some((x) => x.bvid === bvid)) {
        const item = [...(feedCache?.main || []), ...(feedCache?.up || [])].find((x) => x.bvid === bvid) || body.item || { bvid }
        list = [{ bvid, title: item.title || '', author: item.author || '', durationText: item.durationText || '', url: item.url || `https://www.bilibili.com/video/${bvid}`, addedAt: Date.now() }, ...list].slice(0, 100)
      }
      try { writeFileSync(laterFile, JSON.stringify(list), 'utf8') } catch (e) { logWarn('later:write', String(e?.message ?? e)) }
      return sendJson(res, 200, { ok: true, items: list })
    }

    if (req.method === 'GET' && p === '/feed') {
      // peek=1：只读当前内存里的片单状态，给客户端轮询「后台重建好了没」用
      if (url.searchParams.get('peek') === '1') {
        return sendJson(res, 200, {
          ok: true,
          ts: feedCache?.ts || 0,
          curated: Boolean(feedCache?.curated),
          building: Boolean(building || probing),
        })
      }
      const force = url.searchParams.get('refresh') === '1'
      const r = await getFeed(force)
      return sendJson(res, 200, r)
    }

    /**
     * 「更多电子榨菜」：**不重新搜**，直接从上一轮留下的池子里再捞几条。
     * 理由先查磁盘缓存（reasons.json），查不到才叫模型 —— 所以关掉再打开、
     * 点这个按钮，上次写过的推荐语还能接着用，不用重花钱。
     */
    if (req.method === 'POST' && p === '/more') {
      const body = await readBody(req)
      const n = Math.min(5, Math.max(1, Number(body?.n) || 3))
      const f = feedCache
      if (!f || !Array.isArray(f.main)) return sendJson(res, 200, { ok: false, error: '还没有片单，先刷一批' })
      if (f.main.length >= 30) return sendJson(res, 200, { ok: false, error: '已经 30 条了，先看一阵子吧；想换就点「换一批」' })

      const have = new Set([...f.main.map((x) => x.bvid), ...(f.watchedBvids || []), ...history.map((it) => it.bvid)])
      // 先决赛圈（本来就是按分数排好的），再整个池子 —— 池子没分数，按互动率排
      const rateOf = (x) => (x.pct?.coin || 0) * 2 + (x.pct?.fav || 0) * 2 + (x.pct?.like || 0)
      const seen = new Set()
      const take = (x) => {
        if (!x?.bvid || have.has(x.bvid) || seen.has(x.bvid)) return false
        seen.add(x.bvid)
        return true
      }
      const queue = [
        ...(f.shortlist || []).filter(take),
        ...(f.pool || []).map((x) => toCard(x)).sort((a, b) => rateOf(b) - rateOf(a)).filter(take),
      ]
      if (!queue.length) return sendJson(res, 200, { ok: false, error: '池子掏空了 —— 点「换一批」才会去搜新的' })

      const cur = cfgNow()
      const batch = queue.slice(0, n)
      const whyOf = new Map()
      const need = []
      for (const it of batch) {
        const cached = reasons[it.bvid]?.text
        if (cached) whyOf.set(it.bvid, cached)
        else need.push(it)
      }

      let note = ''
      if (need.length && cur.curatorOn) {
        const c = await curate(ctx, need, cur.reasonStyle, {
          pick: need.length,
          api: { base: cur.apiBase, key: cur.apiKey, model: cur.apiModel },
          kind: 'more',
        })
        if (c.ok) {
          for (const pk of c.picks) { whyOf.set(pk.bvid, pk.why); reasons[pk.bvid] = { text: pk.why, at: Date.now() } }
          saveReasonCache(reasonsFile, reasons)
        } else note = String(c.note || '模型没写成')
      }

      const candidates = batch.filter((it) => whyOf.has(it.bvid))
        .map((it) => ({ ...it, why: whyOf.get(it.bvid), more: true }))
      const added = withoutWatched({ ts: f.ts, main: candidates }).main
      if (!added.length) return sendJson(res, 200, { ok: false, error: note || '这几位都没写出理由，先不塞给你' })

      feedCache = withoutWatched({ ...f, main: [...f.main, ...added], moreCount: (f.moreCount || 0) + added.length })
      const main = feedCache.main
      try { writeFileSync(feedFile, JSON.stringify(feedCache), 'utf8') } catch { /* 无所谓 */ }
      refreshStateDoc()
      logInfo('more:add', `${added.length} 条 / 池里还剩 ${queue.length - added.length}`)
      return sendJson(res, 200, { ok: true, main, added, left: queue.length - added.length, note })
    }

    // 桌宠头像：默认是蓝发鲸鱼女仆（来自 dsh-whale-widget，MIT）
    if (req.method === 'GET' && p === '/avatar') {
      try {
        const want = String(url.searchParams.get('p') || '')
        const chosen = AVATAR_PRESETS[want] ? want : (AVATAR_PRESETS[overrides.avatarPreset] ? overrides.avatarPreset : DEFAULT_AVATAR_PRESET)
        const own = join(stateDir, 'avatar.png')
        // ?p= 只看某个预设；不带参数时：自己上传过的优先，其次预设
        const file = want && AVATAR_PRESETS[want]
          ? join(PLUGIN_DIR, 'assets', AVATAR_PRESETS[want].file)
          : (existsSync(own) ? own : join(PLUGIN_DIR, 'assets', AVATAR_PRESETS[chosen].file))
        const buf = readFileSync(file)
        // 走路的头像是 GIF（两帧来回），别的还是 PNG
        const isGif = /\.gif$/i.test(file)
        res.writeHead(200, {
          'content-type': isGif ? 'image/gif' : 'image/png',
          ...(isGif ? { 'cache-control': 'public, max-age=86400' } : {}),
          // 换头像要立刻看到，别让浏览器缓存挡住
          'cache-control': 'no-cache',
          'content-length': buf.length,
        })
        res.end(buf)
        return
      } catch {
        return sendJson(res, 404, { ok: false, error: '没有头像文件' })
      }
    }

    if (req.method === 'GET' && p === '/explain') {
      if (cfgNow().explainOn === false) {
        return sendJson(res, 200, { ok: false, error: '设置里关掉了「点开时展开更长的理由」' })
      }
      const force = url.searchParams.get('force') === '1'
      const bvid = url.searchParams.get('bvid')
      if (bvid) {
        // 单条展开：写一段「为什么推荐」的话（比一句话长）
        const all = [...(feedCache?.main || []), ...(feedCache?.shortlist || []), ...(feedCache?.up || [])]
        const item = all.find((x) => x.bvid === bvid)
        if (!item) return sendJson(res, 404, { ok: false, error: '这条不在当前片单里' })
        const hit = reasons[bvid]
        if (hit?.long && !force) return sendJson(res, 200, { ok: true, bvid, long: hit.long, cached: true })
        const style = cfgNow().reasonStyle
        const c = cfgNow()
        const dur = Math.round((item.duration || 0) / 60)
        const system = [
          '你在替一个人解释「为什么把这条视频挑给他」。',
          '写 100–160 字的一段话：它讲了什么、对你有什么价值、适合什么时候看、有什么坑要提醒。',
          '具体、不吹、不用感叹号；不要复述标题；不要用「这条视频」开头。',
          style ? `语气与风格：${String(style).slice(0, 1500)}` : '语气与风格：像一个了解他口味的朋友。',
        ].join('\n')
        const user = [
          `标题：${item.title}`,
          `UP：${item.author}`,
          `时长：${dur} 分钟`,
          `分区：${item.typeName || '未知'}`,
          `tag：${(item.tags || []).join('、') || '（无）'}`,
          `数据：播放 ${item.play}，赞率 ${item.pct?.like ?? '?'}%，币率 ${item.pct?.coin ?? '?'}%，藏率 ${item.pct?.fav ?? '?'}%`,
          `命中的轴：${item.axis || ''}${item.sub ? ' · ' + item.sub : ''}`,
          item.why ? `一句话理由：${item.why}` : '',
        ].filter(Boolean).join('\n')
        const long = await writeReasonCore(ctx, {
          system, user, maxTokens: 400, timeoutMs: 45000,
          api: { base: c.apiBase, key: c.apiKey, model: c.apiModel },
        })
        if (long) {
          reasons[bvid] = { ...(reasons[bvid] || {}), long, at: Date.now() }
          saveReasonCache(reasonsFile, reasons)
        }
        return sendJson(res, 200, { ok: Boolean(long), bvid, long, cached: false })
      }
      const r = await getReasons(force)
      return sendJson(res, 200, r)
    }

    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${p}` })
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/bili-jar',
      handler: async (req, res) => {
        // 只服务本机页面：别的站点发来的请求一律拒掉。
        // （不发 Origin 的老工具/curl 仍然能用；浏览器跨站请求一定会带这俩头之一。）
        const site = String(req.headers['sec-fetch-site'] || '')
        const origin = String(req.headers.origin || '')
        if (site === 'cross-site' || (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin))) {
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
          return res.end(JSON.stringify({ ok: false, error: 'cross-origin request refused' }))
        }
        try { await handle(req, res, new URL(req.url, 'http://127.0.0.1')) } catch (e) {
          sendJson(res, 500, { ok: false, error: e?.message ?? String(e) })
        }
      },
    }), 'bili-jar: /api/bili-jar 路由')
  } catch (e) {
    log(`HTTP 路由没挂上：${e?.message ?? e}`)
  }

  log(`已挂载（家=${stateDir}，版本=${version}，池=${prevPool.length}）`)
  refreshStateDoc()

  /**
   * 三档刷新的心跳（0.3.0）。
   * 每 60 秒问一次 decideRefresh：该全量就全量、该探测就探测 —— 都是后台跑，
   * 不阻塞任何请求。挂载 8 秒后先补一次（A3 预热），这样重开 DSH 之后
   * 你点开罐子时后台已经在干活了。
   */
  const tick = (why) => {
    try {
      const action = decideRefresh({ now: Date.now(), probedAt: refreshAt.probedAt, fullAt: refreshAt.fullAt, opened: false })
      if (action === 'full') kickBuild(`定时（${why}）`)
      else if (action === 'probe') kickProbe(`定时（${why}）`)
    } catch (e) { logWarn('refresh:tick-fail', String(e?.message ?? e)) }
  }
  try {
    const warm = setTimeout(() => tick('预热'), 8000)
    if (warm.unref) warm.unref()
    const timer = setInterval(() => tick('心跳'), 60_000)
    if (timer.unref) timer.unref()
    ctx.effect(() => () => { clearTimeout(warm); clearInterval(timer) })
  } catch (e) {
    log(`刷新定时器没挂上：${e?.message ?? e}`)
  }
}
