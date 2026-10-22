/**
 * tools/tag-probe.mjs —— 给一个词，看它在现有规则下能不能活下来
 * ============================================================================
 * 逐关跑一遍建池的硬条件（时长 / 播放 / 充电 / 回放 / 日期窗口 / 贴不贴轴），
 * 报告每一关砍掉多少，以及最后剩下的条目长什么样。
 *
 * 跑法：
 *   node tools/tag-probe.mjs 丝之歌 空洞骑士 kards
 *   node tools/tag-probe.mjs 丝之歌 --days=0      # 不限日期
 *   node tools/tag-probe.mjs 丝之歌 --min-play=0  # 去掉播放门槛
 *
 * 只读：不写任何文件、不改配置。
 * ============================================================================
 */
import { searchVideos } from '../lib/bili.mjs'
import { axisSim } from '../lib/pool.mjs'
import { nodeFor } from '../lib/tree.mjs'

const args = process.argv.slice(2)
const opt = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? Number(hit.split('=')[1]) : dflt
}
const tags = args.filter((a) => !a.startsWith('--'))
const DAYS = opt('days', 14)
const MIN_PLAY = opt('min-play', 10000)
const MIN_MIN = opt('min-minutes', 8)
const MAX_MIN = opt('max-minutes', 90)

const REPLAY_RE = /直播回放|回放|录播|直播录像|直播切片|直播实录/
const daysAgo = (ts) => {
  const s = Number(ts)
  if (!Number.isFinite(s) || s <= 0) return 99
  return (Date.now() / 1000 - s) / 86400
}
const fmt = (n) => (n >= 10000 ? `${Math.round(n / 1000) / 10}万` : String(n))

const rows = []

for (const tag of tags) {
  const r = await searchVideos(tag, 1)
  const items = (r.items || []).filter((it) => it.bvid)
  const node = nodeFor(tag)
  const stats = { raw: items.length, dur: 0, charge: 0, replay: 0, lowPlay: 0, old: 0, noAxis: 0 }
  const survivors = []
  const perAxis = []

  for (const it of items) {
    const dur = Number(it.duration) || 0
    if (dur < MIN_MIN * 60 || dur > MAX_MIN * 60) { stats.dur++; continue }
    if (it.isCharge) { stats.charge++; continue }
    if (REPLAY_RE.test(it.title || '') || REPLAY_RE.test(it.author || '')) { stats.replay++; continue }
    if ((Number(it.play) || 0) < MIN_PLAY) { stats.lowPlay++; continue }
    if (DAYS > 0 && daysAgo(it.pubdate) > DAYS) { stats.old++; continue }
    const sim = axisSim(it, tag)
    if (!sim.qualified) { stats.noAxis++; continue }
    survivors.push({ ...it, sim: sim.sim, sub: sim.sub, hits: sim.hits })
    perAxis.push(sim.sim)
  }

  // 只看「限日期」会砍掉多少：换个窗口再数一遍（只算日期这一关）
  const inWindow = (d) => (d === 0 ? items.length : items.filter((it) => daysAgo(it.pubdate) <= d).length)

  survivors.sort((a, b) => b.sim - a.sim || (b.play || 0) - (a.play || 0))
  rows.push({
    tag,
    searchOk: r.ok,
    message: r.message || '',
    stats,
    survivors,
    days: { d7: inWindow(7), d14: inWindow(14), d30: inWindow(30), d90: inWindow(90), all: items.length },
    nodeSearch: node.search,
    subCount: (node.subs || []).length,
    isPreset: node.search.length > 1,
  })
  await new Promise((res) => setTimeout(res, 400))
}

const v = (n) => `${n}`
let out = ''
out += `# 小众 tag 实测（${new Date().toLocaleString('zh-CN', { hour12: false })}）\n\n`
out += `参数：时长 ${MIN_MIN}–${MAX_MIN} 分 · 播放 ≥ ${MIN_PLAY} · 日期窗口 ${DAYS === 0 ? '不限' : DAYS + ' 天'}\n\n`
out += '| 词 | 搜到 | 时长 | 播放 | 充电 | 回放 | 超期 | 贴不上轴 | **存活** |\n|---|---|---|---|---|---|---|---|---|\n'
for (const r of rows) {
  const s = r.stats
  out += `| ${r.tag} | ${v(s.raw)} | ${v(s.dur)} | ${v(s.lowPlay)} | ${v(s.charge)} | ${v(s.replay)} | ${v(s.old)} | ${v(s.noAxis)} | **${r.survivors.length}** |\n`
}
out += '\n## 日期敏感度（只算时间这一关，别的条件先不管）\n\n'
out += '| 词 | 7 天内 | 14 天内 | 30 天内 | 90 天内 | 全部 |\n|---|---|---|---|---|---|\n'
for (const r of rows) {
  out += `| ${r.tag} | ${r.days.d7} | ${r.days.d14} | ${r.days.d30} | ${r.days.d90} | ${r.days.all} |\n`
}
out += '\n## 每个词活下来的条目\n\n'
for (const r of rows) {
  out += `### ${r.tag}\n\n`
  out += `- 检索词：${r.nodeSearch.join(' / ')}${r.isPreset ? '' : '（不在预设树里，只有轴名本身）'}\n`
  out += `- 子簇：${r.subCount} 个\n`
  if (!r.survivors.length) {
    out += '- **没有条目活下来**\n\n'
    continue
  }
  for (const it of r.survivors.slice(0, 5)) {
    const dur = Math.round((it.duration || 0) / 60)
    out += `- \`${it.bvid}\` ${String(it.title || '').slice(0, 44)} · ${fmt(it.play)}播放 · ${dur}分 · ${Math.floor(daysAgo(it.pubdate))}天前 · 相似度 ${it.sim}\n`
    if (it.tags?.length) out += `  - tag：${it.tags.slice(0, 6).join(' / ')}\n`
  }
  out += '\n'
}
console.log(out)
