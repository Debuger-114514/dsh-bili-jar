/**
 * tools/why.mjs —— 「这条为什么（没）进罐子？」
 * 用法：node tools/why.mjs BV1xxx [BV1yyy ...]
 *
 * 读真实状态目录（~/.dsh/bili-jar/）里的 pool.json / config.json / axis-tree.json：
 *   · 在池里   → 重算整池打分，给你分数明细（贴轴/时效/小众 tag…）、shownTimes 和排名
 *   · 不在池里 → 拉详情逐关检查：时长 → 充电 → 回放 → 播放量 → 轴匹配 → 日期窗口
 * 池子是上一轮建池的快照，想看最新就先点一次「换一批」。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { videoDetail, videoTags } from '../lib/bili.mjs'
import { axisSim, scoreItem, spamScore, AXIS_TREE } from '../lib/pool.mjs'
import { freshnessOf, windowOf } from '../lib/freshness.mjs'
import { setUserTree } from '../lib/tree.mjs'

const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return d } }

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const dir = join(home, 'bili-jar')
const cfg = readJson(join(dir, 'config.json'), {})
// 默认值和 index.js 的 cfgNow 保持一致（config.json 里没写的字段用默认）
const minMinutes = cfg.minMinutes === undefined ? 8 : Number(cfg.minMinutes) || 0
const maxMinutes = cfg.maxMinutes === undefined ? 90 : Number(cfg.maxMinutes) || 0
const minPlay = cfg.minPlay === undefined ? 10000 : Number(cfg.minPlay) || 0
const maxDays = Number(cfg.maxDays) > 0 ? Number(cfg.maxDays) : 14
const axes = (Array.isArray(cfg.axes) && cfg.axes.length ? cfg.axes : Object.keys(AXIS_TREE)).map(String)

// 用户树里有手填的 freshness / 自定义轴，不读进来判定就会偏
setUserTree(readJson(join(dir, 'axis-tree.json'), {}))

const poolFile = join(dir, 'pool.json')
const pool = existsSync(poolFile) ? readJson(poolFile, []) : []

// 和 buildPool 第 4 步同一套打分：重建 tag 频次，整池重算，排名才可信
const tagDf = new Map()
for (const it of pool) {
  for (const t of new Set((it.tags || []).map((x) => String(x).toLowerCase().trim()).filter(Boolean))) {
    tagDf.set(t, (tagDf.get(t) || 0) + 1)
  }
}
const scoreCtx = { maxDays, tagDf, tagTotal: pool.length }
const scored = pool.filter((it) => scoreItem(it, axes, null, scoreCtx))
scored.sort((a, b) => b.score - a.score)

const fmtDate = (ts) => {
  const s = Number(ts)
  if (!Number.isFinite(s) || s <= 0) return '日期未知'
  const days = Math.round((Date.now() / 1000 - s) / 86400)
  return `发布${days}天前`
}

for (const bvid of process.argv.slice(2)) {
  console.log('='.repeat(70))
  const inPool = pool.find((it) => it.bvid === bvid)

  if (inPool && inPool.score != null) {
    const rank = scored.findIndex((it) => it.bvid === bvid) + 1
    console.log(`《${inPool.title}》`)
    console.log(`  UP: ${inPool.author}  ${fmtDate(inPool.pubdate)}  播放 ${inPool.play}  时长 ${Math.round((inPool.duration || 0) / 60)} 分钟`)
    console.log(`  在池子里（池 ${pool.length} 条 / 打分合格 ${scored.length} 条）`)
    console.log('--- 打分明细 ---')
    console.log(`  总分 ${inPool.score}  →  第 ${rank} 名（${scored.length} 条里）`)
    console.log(`  贴轴: ${inPool.axis || '?'}${inPool.sub ? ' · ' + inPool.sub : ''}  sim=${inPool.sims?.[inPool.axis] ?? '?'}  时效 freshN=${inPool.freshN}`)
    console.log(`  互动率: 赞${((inPool.rates?.likeRate ?? 0) * 100).toFixed(0)}% 币${((inPool.rates?.coinRate ?? 0) * 100).toFixed(0)}% 藏${((inPool.rates?.favRate ?? 0) * 100).toFixed(0)}%（满分刻度）`)
    console.log(`  互动数据: ${inPool.statsAt ? '已补（' + new Date(inPool.statsAt).toISOString().slice(0, 10) + ' 回查）' : '未补（币/藏还是搜索层的 0）'}  冷启动加分: ${inPool.coldBonus || 0}`)
    console.log(`  进过 main ${inPool.shownTimes || 0} 次（每轮重复出现扣 0.03，封顶 0.15）`)
    for (const r of inPool.reasons || []) console.log(`  · ${r}`)
    console.log('--- 各轴匹配 ---')
    for (const axis of axes) {
      const r = axisSim(inPool, axis)
      console.log(`  ${r.qualified ? '✅' : '❌'} ${axis}  sim=${r.sim}${r.vetoed ? '（命中否决词）' : ''}`)
    }
    console.log(`  提示：分数排名只代表规则层；最终推不推还看排除集（最近 5 轮 + 已看）和策展人。`)
    continue
  }

  // 不在池里（或池子太旧）→ 拉详情逐关查
  const d = await videoDetail(bvid)
  if (!d.ok) { console.log(`${bvid}: 详情拿不到 (${d.code} ${d.message})`); continue }
  const tags = await videoTags(bvid)
  const x = d.data
  const min = Math.round(x.duration / 60)
  console.log(`《${x.title}》  （${inPool ? '在池里但上轮没打上分' : '不在池子里'}）`)
  console.log(`  UP: ${x.author}  ${fmtDate(x.pubdate)}  时长: ${min} 分钟  播放: ${x.stat?.view ?? '?'}  分P: ${x.pages}`)
  console.log(`  tag: ${tags.join(' / ') || '（无）'}`)
  console.log(`  标题党分: ${spamScore(x.title)}`)

  console.log('--- 硬门槛 ---')
  const gate = (ok, why) => console.log(`  ${ok ? '✅' : '❌'} ${why}`)
  const days = Number(x.pubdate) > 0 ? (Date.now() / 1000 - Number(x.pubdate)) / 86400 : null
  gate(!minMinutes || x.duration >= minMinutes * 60, `时长 ≥ ${minMinutes} 分钟（实际 ${min}）`)
  gate(!maxMinutes || x.duration <= maxMinutes * 60, `时长 ≤ ${maxMinutes} 分钟（实际 ${min}）`)
  gate(!x.isUpowerExclusive, '不是充电专属')
  gate(!/直播回放|回放|录播|直播录像|直播切片|直播实录/.test(x.title || ''), '不是直播回放')
  const play = Number(x.stat?.view) || 0
  gate(!minPlay || play >= minPlay, `播放 ≥ ${minPlay}（实际 ${play}）`)

  console.log('--- 轴匹配 + 日期窗口 ---')
  const item = { title: x.title, tags, typeName: x.typeName || '' }
  const hay = String(x.title + ' ' + tags.join(' ')).toLowerCase()
  let anyPass = false
  for (const axis of axes) {
    const r = axisSim(item, axis)
    const node = AXIS_TREE[axis]
    const groups = node?.groups || []
    const w = windowOf(axis, maxDays)
    const dateOk = w === 0 || (days != null && days <= w)
    const ok = r.qualified && dateOk
    if (ok) anyPass = true
    if (r.qualified) {
      console.log(`  ${dateOk ? '✅' : '❌'} ${axis}（${freshnessOf(axis)}，窗口 ${w || '不限'} 天，${fmtDate(x.pubdate)}）  sim=${r.sim}${r.sub ? ' · ' + r.sub : ''}  命中: ${r.hits.join('、')}`)
    } else {
      const miss = groups
        .map((g, i) => (g.some((t) => hay.includes(String(t).toLowerCase())) ? null : i))
        .filter((i) => i !== null)
      console.log(`  ❌ ${axis}  sim=${r.sim}  命中: ${r.hits.join('、') || '无'}${miss.length ? `  缺第 ${miss.map((i) => i + 1).join('、')} 组` : ''}`)
    }
  }
  console.log(anyPass
    ? '  ⇒ 过了规则层，但没留在上一轮的池子里：可能是建池后新发的，或被排除集/补货轮换挤掉了'
    : '  ⇒ 没有任何轴能收它')
}
