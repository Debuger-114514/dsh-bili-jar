/**
 * dsh-bili-jar —— host 半端
 * ============================================================================
 * 阶段 0：挂上、开路由、读配置
 * 阶段 2：/feed —— 累积池 + 打分 + 片单 + 「换一批」
 *
 * ⚠️ `apply(ctx, config)` 里拿到的 `config` 不是解析后的值（每个字段都是 `{}`），
 *    真实值必须走 `ctx.settings.describe()` 的 `value` 层。
 * ============================================================================
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { inspect } from 'node:util'
import { loadHostDeps } from './lib/hostdeps.mjs'
import { buildPool } from './lib/pool.mjs'

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
}

/**
 * ⚠️ 每个字段都要 `.extra('volatile', true)`，否则 DSH 的 settings.update() 会抛
 *    "Plugin entry … has no volatile fields"。
 * ⚠️ 不要加会抛错的校验（.max/.min）：schema 不过 ⇒ entry 被拒收 ⇒ 整条插件不激活。
 */
export const Config = !z ? undefined : z.object({
  axes: z.array(z.string()).default(DEFAULTS.axes).extra('volatile', true),
  ups: z.array(z.string()).default([]).extra('volatile', true),
  fanMin: z.natural().default(0).extra('volatile', true),
  fanMax: z.natural().default(0).extra('volatile', true),
  minMinutes: z.natural().default(8).extra('volatile', true),
  maxMinutes: z.natural().default(90).extra('volatile', true),
  /** 播放量下限（0 = 不限） */
  minPlay: z.natural().default(10000).extra('volatile', true),
  mainCount: z.natural().default(5).extra('volatile', true),
  showCharging: z.boolean().default(false).extra('volatile', true),
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

export function apply(ctx, config) {
  const log = (...a) => { try { console.log('[bili-jar]', ...a) } catch { /* 无控制台 */ } }

  const stateDir = stateDirOf(ctx)
  const feedFile = join(stateDir, 'feed.json')
  const poolFile = join(stateDir, 'pool.json')
  const shownFile = join(stateDir, 'shown.json')
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
  /** 上一批给出去的 bvid —— "换一批"就是排除它们 */
  let lastShown = readJson(shownFile, [])
  let building = null

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
    const axes = toArr(c.axes)
    return {
      axes: axes.length ? axes : DEFAULTS.axes.slice(),
      ups: toArr(c.ups),
      fanMin: toNum(c.fanMin, 0),
      fanMax: toNum(c.fanMax, 0),
      minMinutes: toNum(c.minMinutes, 8),
      maxMinutes: toNum(c.maxMinutes, 90),
      minPlay: toNum(c.minPlay, 10000),
      mainCount: toNum(c.mainCount, 5),
      showCharging: toBool(c.showCharging),
    }
  }

  async function getFeed(force) {
    const fresh = feedCache && Date.now() - feedCache.ts < FEED_TTL
    if (!force && fresh) return { ...feedCache, cached: true }
    if (building) return building
    building = (async () => {
      try {
        const t0 = Date.now()
        // 「换一批」：排除上一批已经给过的
        const exclude = force ? lastShown : []
        const r = await buildPool({ ...cfgNow(), exclude }, (m) => log(m), prevPool)
        const out = { ...r, tookMs: Date.now() - t0, cached: false, excluded: exclude.length }
        feedCache = out
        lastShown = (r.main || []).map((c) => c.bvid)
        try { writeFileSync(shownFile, JSON.stringify(lastShown), 'utf8') } catch { /* 无所谓 */ }
        if (Array.isArray(r.pool)) {
          prevPool = r.pool
          try { writeFileSync(poolFile, JSON.stringify(prevPool), 'utf8') } catch (e) { log(`pool 落盘失败：${e?.message ?? e}`) }
        }
        try { writeFileSync(feedFile, JSON.stringify(out), 'utf8') } catch (e) { log(`feed 落盘失败：${e?.message ?? e}`) }
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

  const handle = async (req, res, url) => {
    const p = url.pathname.replace(/^\/api\/bili-jar/, '') || '/'

    if (req.method === 'GET' && p === '/ping') {
      hits += 1
      return sendJson(res, 200, {
        ok: true, plugin: name, version,
        uptimeMs: Date.now() - startedAt, hits,
        stateDir, hostNotes,
        poolSize: Array.isArray(prevPool) ? prevPool.length : 0,
        lastShown,
        feed: feedCache ? { ts: feedCache.ts, main: feedCache.main?.length ?? 0, up: feedCache.up?.length ?? 0 } : null,
      })
    }

    if (req.method === 'GET' && p === '/state') {
      return sendJson(res, 200, { ok: true, stateDir, config: cfgNow(), feedTs: feedCache?.ts ?? null, poolSize: prevPool.length, lastShown })
    }

    if (req.method === 'GET' && p === '/debug') {
      let rows = []
      try { rows = ctx.settings?.describe?.() || [] } catch (e) { rows = String(e?.message ?? e) }
      const row = settingsRow(true)
      return sendJson(res, 200, {
        ok: true,
        configDump: inspect(config, { depth: 2, breakLength: 120 }).slice(0, 1200),
        rowFound: Boolean(row),
        rowDump: inspect(row, { depth: 3, breakLength: 120 }).slice(0, 1600),
        rowsCount: Array.isArray(rows) ? rows.length : rows,
        cfg: cfgNow(),
        poolSize: prevPool.length,
      })
    }

    if (req.method === 'GET' && p === '/feed') {
      const force = url.searchParams.get('refresh') === '1'
      const r = await getFeed(force)
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

  log(`已挂载（家=${stateDir}，版本=${version}，池=${prevPool.length}，缓存=${feedCache ? '有' : '无'}）`)
}
