/**
 * tools/sim-freshness.mjs —— 干跑「freshness 自动判定 + 日期放宽」这套规则
 * ============================================================================
 * 不改配置、不写文件。对每个词：
 *   ① 按 news（14 天）数合格条目 n_ok
 *   ② n_ok < 3 就按阶梯放宽日期（30 → 90 → 不限），数每一步
 *   ③ 给出结论：会保持 news / 会切成 evergreen / 还是没货
 *   ④ 对「被救回来」的轴，列出新放进来的是哪些条目（判断质量）
 *
 * 跑法：node tools/sim-freshness.mjs 丝之歌 空洞骑士 kards 深蓝 vtuber 术力口
 * ============================================================================
 */
import { searchVideos } from '../lib/bili.mjs'
import { axisSim } from '../lib/pool.mjs'

const MIN_OK = 3
const MIN_MIN = 8
const MAX_MIN = 90
const MIN_PLAY = 10000
const LADDER = [14, 30, 90, 0]      // 0 = 不限
const REPLAY_RE = /直播回放|回放|录播|直播录像|直播切片|直播实录/
const daysAgo = (ts) => {
  const s = Number(ts)
  if (!Number.isFinite(s) || s <= 0) return 99
  return (Date.now() / 1000 - s) / 86400
}
const fmt = (n) => (n >= 10000 ? `${Math.round(n / 1000) / 10}万` : String(n))

const tags = process.argv.slice(2)
const results = []

for (const tag of tags) {
  const r = await searchVideos(tag, 1)
  const items = (r.items || []).filter((it) => it.bvid)

  // 每个窗口下合格的条目
  const byWindow = new Map()
  for (const win of LADDER) {
    const ok = []
    for (const it of items) {
      const dur = Number(it.duration) || 0
      if (dur < MIN_MIN * 60 || dur > MAX_MIN * 60) continue
      if (it.isCharge) continue
      if (REPLAY_RE.test(it.title || '') || REPLAY_RE.test(it.author || '')) continue
      if ((Number(it.play) || 0) < MIN_PLAY) continue
      if (win > 0 && daysAgo(it.pubdate) > win) continue
      if (!axisSim(it, tag).qualified) continue
      ok.push(it)
    }
    byWindow.set(win, ok)
  }

  const count = (w) => byWindow.get(w).length
  const at14 = count(14)

  // 判定分两层：① 轴属性要不要变 ② 本轮日期窗口放多宽
  let verdict = 'kept-news'
  let finalState = 'news'
  let window = 14
  let note = ''
  if (at14 >= MIN_OK) {
    verdict = 'ok-news'
    note = `14 天内就有 ${at14} 条，保持 news`
  } else {
    // 判据换成「内容有多老」，不再数条数：
    //   合格条目（不限日期）的年龄中位数 > 90 天 → 这根轴就是常青的。
    //   实测七个词分得很干净：丝之歌 361 天 / 空洞骑士 2052 / vtuber 2385，
    //   另一堆是 kards 5 / 深蓝 26 / 术力口 5 / 时政 13。
    //   用中位数而不是「够不够 3 条」，是因为条数会被搜索波动带着跳（丝之歌 2↔4）。
    const all = byWindow.get(0)
    const ages = all.map((it) => daysAgo(it.pubdate)).sort((x, y) => x - y)
    const medianAge = ages.length ? ages[Math.floor(ages.length / 2)] : 0
    if (!all.length) {
      verdict = 'empty'
      finalState = 'news'
      note = '一条合格条目都没有 → 标「没货」，等扩词'
    } else if (medianAge > 90) {
      verdict = 'switch-evergreen'
      finalState = 'evergreen'
      window = 0
      note = `合格 ${all.length} 条的年龄中位数 ${Math.round(medianAge)} 天 → 内容是常青的，切 evergreen`
    } else if (count(30) >= MIN_OK) {
      verdict = 'relax-only'
      window = 30
      note = `年龄中位 ${Math.round(medianAge)} 天，但 14 天只有 ${at14} 条、30 天有 ${count(30)} 条 → 保持 news，本轮窗口放宽到 30 天`
    } else {
      verdict = 'ok-news'
      note = `年龄中位 ${Math.round(medianAge)} 天、14 天 ${at14} 条（不到 ${MIN_OK}）→ 保持 news，本轮就这些`
    }
  }

  // 被新放进来的是哪些（跟 14 天比）
  const fresh = byWindow.get(14)
  const rescued = byWindow.get(0).filter((it) => !fresh.some((f) => f.bvid === it.bvid))

  results.push({ tag, at14, counts: LADDER.map((w) => count(w)), verdict, finalState, window, note, rescued })

  await new Promise((res) => setTimeout(res, 400))
}

let out = ''
out += `# freshness 规则干跑（${new Date().toLocaleString('zh-CN', { hour12: false })}）\n\n`
out += `MIN_OK=${MIN_OK} · 时长 ${MIN_MIN}–${MAX_MIN} 分 · 播放 ≥ ${MIN_PLAY.toLocaleString()} · 阶梯 14→30→90→不限\n\n`
out += '| 词 | 14 天 | 30 天 | 90 天 | 不限 | freshness | 本轮窗口 |\n|---|---|---|---|---|---|---|\n'
const stateOf = (r) => (r.verdict === 'ok-news' ? '✅ news（够数）'
  : r.verdict === 'relax-only' ? '⏸ news（临时放宽）'
  : r.verdict === 'switch-evergreen' ? '↩️ evergreen'
  : '❌ news（没货）')
for (const r of results) {
  out += `| ${r.tag} | ${r.counts[0]} | ${r.counts[1]} | ${r.counts[2]} | ${r.counts[3]} | ${stateOf(r)} | ${r.window === 0 ? '不限' : r.window + ' 天'} |\n`
}
out += '\n## 逐条结论\n\n'
for (const r of results) {
  out += `### ${r.tag} — ${stateOf(r)}\n\n${r.note}\n\n`
  if (r.rescued.length) {
    out += '放宽后新放进来：\n\n'
    for (const it of r.rescued.slice(0, 6)) {
      const dur = Math.round((it.duration || 0) / 60)
      out += `- ${String(it.title || '').slice(0, 46)} · ${fmt(it.play)}播放 · ${dur}分 · ${Math.floor(daysAgo(it.pubdate))}天前\n`
    }
    out += '\n'
  }
}
console.log(out)
