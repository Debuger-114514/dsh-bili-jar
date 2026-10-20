/**
 * tools/probe.mjs —— 阶段 1 的现场勘探
 * ============================================================================
 * 目的：一次跑完，直接回答三个事实问题，不用猜——
 *   ① 搜索结果里到底有没有 duration / tag / 充电字段
 *   ② 详情接口的 is_upower_exclusive 是不是真的在
 *   ③ UP 主的粉丝数怎么拿、拿不拿得到
 *
 * 用法：node tools/probe.mjs [关键词]
 * ============================================================================
 */
import { searchVideos, videoDetail, userInfo } from '../lib/bili.mjs'

const kw = process.argv[2] || 'deepseek'
const line = (s = '') => console.log(s)
const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n)

line(`关键词：${kw}`)
line('='.repeat(78))

const s = await searchVideos(kw)
line(`搜索 code=${s.code} msg=${s.message} 条数=${s.items.length}`)
if (!s.items.length) {
  line('没结果。可能是风控（-352）或网络。原始 code 见上。')
  process.exit(0)
}

line('')
line(`${pad('BV', 14)}${pad('时长', 8)}${pad('UP', 12)}${pad('粉丝', 8)}${pad('充电', 6)}标题`)
line('-'.repeat(78))

const first = s.items.slice(0, 8)
for (const it of first) {
  line(`${pad(it.bvid, 14)}${pad(it.durationText, 8)}${pad(it.author, 12)}${pad('?', 8)}${pad('?', 6)}${it.title.slice(0, 30)}`)
}

// 字段名盘点：搜索接口里带了什么
const keys = Object.keys(s.items[0].raw || {})
line('')
line(`搜索返回字段（${keys.length} 个）：${keys.join(', ')}`)
line(`搜索里有没有充电字段：${keys.filter((k) => /upower|charge/i.test(k)).join(', ') || '没有'}`)
line(`搜索里 tag 长什么样：${JSON.stringify(s.items[0].raw?.tag)?.slice(0, 160)}`)

// 详情：充电字段 + 分P
const d = await videoDetail(first[0].bvid)
line('')
line(`详情 ${first[0].bvid}: code=${d.code ?? 0} ${d.message || ''}`)
if (d.ok) {
  const x = d.data
  line(`  标题=${x.title}`)
  line(`  时长=${x.duration}s  分P=${x.pages}  充电专属=${x.isUpowerExclusive}  可看=${x.isUpowerPlay}`)
  line(`  详情里有 upower 字段：${Object.keys(x.raw || {}).filter((k) => /upower|charge/i.test(k)).join(', ') || '没有'}`)
}

// UP 信息：粉丝数
const u = await userInfo(s.items[0].mid)
line('')
line(`UP ${s.items[0].author} (mid=${s.items[0].mid}): code=${u.code ?? 0} ${u.message || ''}`)
line(u.ok ? `  粉丝=${u.data.fans}  等级=${u.data.level}` : '  拿不到（多半是 -352 风控或需要登录）')

line('')
line('='.repeat(78))
line('结论要写进 docs/ 才作数：搜索有没有 duration/tag、详情有没有 upower、粉丝数拿得到吗。')
