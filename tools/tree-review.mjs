/**
 * tools/tree-review.mjs —— 规则挖子簇 + 模型审核，人看结果（不写进树）
 *
 * 跑法：ELECTRON_RUN_AS_NODE=1 "D:\HARNESS\DeepSeek Harness.exe" tools/tree-review.mjs 历史 [更多轴...]
 *   加 --apply 才会真的写进 ~/.dsh/bili-jar/axis-tree.json
 *
 * 一次调用约 ¥0.002（谷时）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { axisSim } from '../lib/pool.mjs'
import { suggestSubs, nodeFor, setUserTree } from '../lib/tree.mjs'
import { reviewClusters } from '../lib/tree-review.mjs'

const DIR = join(homedir(), '.dsh', 'bili-jar')
const read = (n, d) => { try { return JSON.parse(readFileSync(join(DIR, n), 'utf8')) } catch { return d } }

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const axes = args.filter((a) => !a.startsWith('--'))
if (!axes.length) { console.log('用法：tree-review.mjs <轴名> [--apply]'); process.exit(1) }

const pool = read('pool.json', [])
const cfg = read('config.json', {})
if (!pool.length) { console.log('池子是空的，先刷一轮'); process.exit(1) }
if (!cfg.apiKey) { console.log('config.json 里没有 apiKey，模型审核跑不了（可以先只看规则建议）'); }

let userTree = read('axis-tree.json', {})
setUserTree(userTree)

const ctx = {}
for (const axis of axes) {
  const sg = suggestSubs(pool, axis, axisSim, { maxClusters: 4, minDf: 3 })
  console.log(`\n【${axis}】命中 ${sg.sampled} 条 · 规则挖出 ${sg.clusters.length} 个候选 · 阈值 ${sg.threshold}`)
  for (const c of sg.clusters) console.log(`  · ${c.name}（${c.df} 条）← ${c.terms.join(' / ')}`)

  if (!cfg.apiKey) continue
  const r = await reviewClusters(ctx, {
    axis,
    node: nodeFor(axis),
    clusters: sg.clusters,
    api: { base: cfg.apiBase, key: cfg.apiKey, model: cfg.apiModel },
  })
  if (!r.ok) { console.log(`  模型审核没成：${r.note}`); continue }

  console.log('  模型筛完：')
  for (const k of r.kept) console.log(`    ✓ ${k.name}  ← ${k.terms.join(' / ')}　（${k.why || ''}）`)
  for (const d of r.dropped) console.log(`    ✗ ${d.seed}　（${d.why || ''}）`)

  if (apply && r.kept.length) {
    const node = { ...(userTree[axis] || {}) }
    node.subs = [...(node.subs || [])]
    for (const k of r.kept) {
      const i = node.subs.findIndex((x) => x.name === k.name)
      if (i >= 0) node.subs[i] = { name: k.name, terms: Array.from(new Set([...(node.subs[i].terms || []), ...k.terms])) }
      else node.subs.push({ name: k.name, terms: k.terms })
    }
    userTree = { ...userTree, [axis]: node }
  }
}

if (apply) {
  writeFileSync(join(DIR, 'axis-tree.json'), JSON.stringify(userTree, null, 2), 'utf8')
  console.log('\n已写入 axis-tree.json')
} else {
  console.log('\n（只打印，没写盘。确实要的话加 --apply）')
}
