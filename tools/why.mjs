/**
 * tools/why.mjs —— 「这条为什么没进罐子？」
 * 用法：node tools/why.mjs BV1xxx BV1yyy
 *
 * 按真实流水线的顺序逐关检查：时长 → 充电 → 回放 → 播放量 → 轴匹配，
 * 每一关都告诉你是过了还是卡住、卡在哪个词上。
 */
import { videoDetail, videoTags } from '../lib/bili.mjs'
import { axisSim, AXIS_RULES, spamScore } from '../lib/pool.mjs'

const CFG = { minMinutes: 8, maxMinutes: 90, minPlay: 10000 }

const axes = ['时政', '科技测评', '健身教程', 'deepseek']

for (const bvid of process.argv.slice(2)) {
  console.log('='.repeat(70))
  const d = await videoDetail(bvid)
  if (!d.ok) { console.log(`${bvid}: 详情拿不到 (${d.code} ${d.message})`); continue }
  const tags = await videoTags(bvid)
  const x = d.data
  const min = Math.round(x.duration / 60)

  console.log(`${x.title}`)
  console.log(`  UP: ${x.author}  时长: ${min} 分钟  播放: ${x.stat?.view ?? '?'}  分P: ${x.pages}`)
  console.log(`  tag: ${tags.join(' / ') || '（无）'}`)
  console.log(`  标题党分: ${spamScore(x.title)}`)

  console.log('--- 硬门槛 ---')
  const gate = (ok, why) => console.log(`  ${ok ? '✅' : '❌'} ${why}`)
  gate(x.duration >= CFG.minMinutes * 60, `时长 ≥ ${CFG.minMinutes} 分钟（实际 ${min}）`)
  gate(x.duration <= CFG.maxMinutes * 60, `时长 ≤ ${CFG.maxMinutes} 分钟（实际 ${min}）`)
  gate(!x.isUpowerExclusive, '不是充电专属')
  gate(!/直播回放|回放|录播/.test(x.title || ''), '不是直播回放')
  const play = Number(x.stat?.view) || 0
  gate(play >= CFG.minPlay, `播放 ≥ ${CFG.minPlay}（实际 ${play}）`)

  console.log('--- 轴匹配 ---')
  const item = { title: x.title, tags }
  for (const axis of axes) {
    const r = axisSim(item, axis)
    const rule = AXIS_RULES[axis]
    if (r.qualified) {
      console.log(`  ✅ ${axis}  sim=${r.sim}  命中: ${r.hits.join('、')}`)
    } else {
      const miss = (rule?.all || []).map((g, i) => {
        const hit = g.find((t) => String(x.title + ' ' + tags.join(' ')).toLowerCase().includes(String(t).toLowerCase()))
        return hit ? null : i
      }).filter((i) => i !== null)
      console.log(`  ❌ ${axis}  sim=${r.sim}  命中: ${r.hits.join('、') || '无'}  缺第 ${miss.map((i) => i + 1).join('、')} 组`)
    }
  }
}
