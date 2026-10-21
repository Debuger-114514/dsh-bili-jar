/**
 * tools/tree-suggest.mjs —— 从池子里挖子簇建议（不自动采纳，只打印）
 *
 * 跑法：ELECTRON_RUN_AS_NODE=1 "D:\HARNESS\DeepSeek Harness.exe" tools/tree-suggest.mjs [轴名...]
 *      不给轴名就看配置里那几根轴。
 *
 * 原理：命中这根轴的条目 → tag 的 DF + 两两共现的 PMI → 以高 DF 词为种子，
 * 把跟它 PMI > 0.2 的词拉进同一簇。挖出来只是建议，要不要写进树由人决定。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { axisSim } from '../lib/pool.mjs'
import { suggestSubs, nodeFor } from '../lib/tree.mjs'

const DIR = join(homedir(), '.dsh', 'bili-jar')
const read = (n, d) => { try { return JSON.parse(readFileSync(join(DIR, n), 'utf8')) } catch { return d } }
const pool = read('pool.json', [])
const cfg = read('config.json', {})

const axes = process.argv.slice(2).filter(Boolean)
const list = axes.length ? axes : (cfg.axes && cfg.axes.length ? cfg.axes : ['时政', '科技测评', '健身教程', 'deepseek'])

if (!pool.length) {
  console.log('池子是空的，先跑一轮「换一批」')
  process.exit(0)
}

console.log(`池子 ${pool.length} 条\n`)
for (const axis of list) {
  const n = nodeFor(axis)
  const sg = suggestSubs(pool, axis, axisSim, { maxClusters: 4, minDf: 3 })
  console.log(`【${axis}】命中 ${sg.sampled} 条 · 现有子簇 ${(n.subs || []).length} 个 · PMI 阈值 ${sg.threshold}`)
  if (!sg.clusters.length) {
    console.log('  没有够格的建议（tag 太少或太散）\n')
    continue
  }
  for (const c of sg.clusters) {
    console.log(`  · ${c.name}（${c.df} 条，特异度 ${c.spec}）← ${c.terms.join(' / ')}`)
  }
  if (sg.loose.length) console.log(`  零散：${sg.loose.map((x) => `${x.tag}(${x.df})`).join('  ')}`)
  console.log('')
}
