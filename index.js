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
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { inspect } from 'node:util'
import { loadHostDeps } from './lib/hostdeps.mjs'
import { buildPool } from './lib/pool.mjs'
import { writeReason, writeReasonCore, loadReasonCache, saveReasonCache, setUsageFile, lastError as llmError } from './lib/reasons.mjs'
import { todayUsage } from './lib/usage.mjs'
import { curate } from './lib/curator.mjs'
import { adoptCookies, videoSubtitle, videoComments } from './lib/bili.mjs'
import { setLogFile, info as logInfo, warn as logWarn, tail as logTail } from './lib/log.mjs'

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
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

const FEED_TTL = 30 * 60 * 1000

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
  const usageFile = join(stateDir, 'usage.json')
  setUsageFile(usageFile)
  const version = (() => {
    try { return String(JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8')).version || '') } catch { return '' }
  })()
  const startedAt = Date.now()
  let hits = 0

  let feedCache = (() => {
    const j = readJson(feedFile, null)
    return j && j.ts ? j : null
  })()
  let prevPool = readJson(poolFile, [])
  let lastShown = readJson(shownFile, [])
  let reasons = loadReasonCache(reasonsFile)
  /** 罐子里那份配置：优先级最高（原生设置页看不见这些字段，只能自己存） */
  let overrides = readJson(overridesFile, {})
  let building = null
  let explaining = null

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
    return {
      axes: axes.length ? axes : DEFAULTS.axes.slice(),
      ups: toArr(merged.ups),
      fanMin: toNum(merged.fanMin, 0),
      fanMax: toNum(merged.fanMax, 0),
      minMinutes: toNum(merged.minMinutes, 8),
      maxMinutes: toNum(merged.maxMinutes, 90),
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
    }
  }

  /**
   * 如果需要，接管 bili-scroll 的 B站 登录（只为了取 AI 字幕）。
   * ⚠️ 不勾选时**绝不**去读那个文件。
   */
  let adoptedAt = 0
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
    const got = []
    for (const p of picks) {
      let content = ''
      const sub = await videoSubtitle(p.bvid)
      if (sub.ok) content = sub.text
      else {
        const cm = await videoComments(p.bvid, 20)
        if (cm.ok) content = cm.text
      }
      logInfo('content:fetch', `${p.bvid} ${content ? content.length + ' 字' : '无内容'}`)
      got.push({ ...p, content })
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

  async function getFeed(force) {
    const fresh = feedCache && Date.now() - feedCache.ts < FEED_TTL
    if (!force && fresh) return { ...feedCache, cached: true }
    if (building) return building
    building = (async () => {
      try {
        const t0 = Date.now()
        const cfg = cfgNow()
        maybeAdoptLogin(cfg)
        const exclude = force ? lastShown : []
        const r = await buildPool({ ...cfg, exclude }, (m) => log(m), prevPool)
        logInfo('feed:built', JSON.stringify(r.stats || {}))
        const out = { ...r, tookMs: Date.now() - t0, cached: false, excluded: exclude.length }
        feedCache = out
        lastShown = (r.main || []).map((c) => c.bvid)
        try { writeFileSync(shownFile, JSON.stringify(lastShown), 'utf8') } catch { /* 无所谓 */ }
        if (Array.isArray(r.pool)) {
          prevPool = r.pool
          try { writeFileSync(poolFile, JSON.stringify(prevPool), 'utf8') } catch (e) { log(`pool 落盘失败：${e?.message ?? e}`) }
        }
        try { writeFileSync(feedFile, JSON.stringify(out), 'utf8') } catch (e) { log(`feed 落盘失败：${e?.message ?? e}`) }

        // ⭐ 策展人：规则给候选，模型挑 5 条并写理由
        // ⭐ 内容源：额外把 bili-scroll 报告里挑过的视频并进候选
        let shortlist = r.shortlist || []
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
            feedCache = { ...out, main: enriched, curated: true, curatorMs: Date.now() - t1 }
            logInfo('curate:ok', `${curated.length} 条 / ${Date.now() - t1}ms`)
            for (const p of c.picks) reasons[p.bvid] = { text: p.why, at: Date.now() }
            saveReasonCache(reasonsFile, reasons)
            try { writeFileSync(feedFile, JSON.stringify(feedCache), 'utf8') } catch { /* 无所谓 */ }
            return feedCache
          }
          log(`策展失败，退回规则片单：${c.note}`)
          logWarn('curate:fail', String(c.note || '未知'))
          feedCache = { ...out, curated: false, curatorNote: c.note }
          return feedCache
        }
        return out
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
      const masked = key ? `sk-••••${key.slice(-4)}` : ''
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
      return sendJson(res, 200, { ok: true, config: cfgNow(), overrides })
    }

    if (req.method === 'GET' && p === '/debug') {
      const safe = (fn, dflt) => { try { return fn() } catch (e) { return `ERR: ${e?.message ?? e}` } }
      let rows = safe(() => ctx.settings?.describe?.() || [], [])
      return sendJson(res, 200, {
        ok: true,
        rowFound: Boolean(safe(() => settingsRow(true), null)),
        rowsCount: Array.isArray(rows) ? rows.length : String(rows).slice(0, 120),
        cfg: cfgNow(),
        overrides,
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

    if (req.method === 'GET' && p === '/feed') {
      const force = url.searchParams.get('refresh') === '1'
      const r = await getFeed(force)
      return sendJson(res, 200, r)
    }

    // 桌宠头像：默认是蓝发鲸鱼女仆（来自 dsh-whale-widget，MIT）
    if (req.method === 'GET' && p === '/avatar') {
      try {
        const buf = readFileSync(join(PLUGIN_DIR, 'assets', 'avatar.png'))
        res.writeHead(200, {
          'content-type': 'image/png',
          'cache-control': 'public, max-age=86400',
          'content-length': buf.length,
        })
        res.end(buf)
        return
      } catch {
        return sendJson(res, 404, { ok: false, error: '没有头像文件' })
      }
    }

    if (req.method === 'GET' && p === '/explain') {
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
        const dur = Math.round((item.duration || 0) / 60)
        const system = [
          '你在替一个人解释「为什么把这条视频挑给他」。',
          '写 100–160 字的一段话：它讲了什么、对你有什么价值、适合什么时候看、有什么坑要提醒。',
          '具体、不吹、不用感叹号；不要复述标题；不要用「这条视频」开头。',
          style ? `语气与风格：${style}` : '语气与风格：像一个了解他口味的朋友。',
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
          api: { base: cfg.apiBase, key: cfg.apiKey, model: cfg.apiModel },
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
        try { await handle(req, res, new URL(req.url, 'http://127.0.0.1')) } catch (e) {
          sendJson(res, 500, { ok: false, error: e?.message ?? String(e) })
        }
      },
    }), 'bili-jar: /api/bili-jar 路由')
  } catch (e) {
    log(`HTTP 路由没挂上：${e?.message ?? e}`)
  }

  log(`已挂载（家=${stateDir}，版本=${version}，池=${prevPool.length}）`)
}
