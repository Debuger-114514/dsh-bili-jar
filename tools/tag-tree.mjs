/**
 * tools/tag-tree.mjs —— 从语料里长出「tag 树」
 * ============================================================================
 * 三件事：
 *   ① 泛 tag 发现：DF 特别高的 tag（必剪创作/高能…）自动浮出来，替代手写黑名单
 *   ② 子标签候选：对每根轴的种子词算 PMI，共现强但又不烂大街的词排前面
 *   ③ 聚类：PMI 图上跑标签传播（LPA），得到「中东」「俄乌」「数码」这类簇
 *
 * 用法：node tools/tag-tree.mjs
 * ============================================================================
 */
import { readFileSync } from 'node:fs'

const corpus = JSON.parse(readFileSync(new URL('../data/corpus.json', import.meta.url), 'utf8'))
const N = corpus.length

const SEEDS = {
  时政: ['时政', '国际', '特朗普', '美国', '俄乌', '中东', '以色列', '中美'],
  科技测评: ['数码', '手机', '电脑', '评测', 'ai', '耳机', '显卡'],
  健身教程: ['健身', '训练', '减脂', '增肌', '跟练'],
  deepseek: ['deepseek', '大模型', 'ai'],
}

// ---- 统计 ----
const df = new Map()          // tag → 出现次数
const co = new Map()          // "a\u0000b" → 共现次数
const orig = new Map()        // 小写 → 原始写法（保留展示形态）

for (const v of corpus) {
  const set = new Set()
  for (const raw of v.tags || []) {
    const t = String(raw).trim()
    if (!t) continue
    const k = t.toLowerCase()
    orig.set(k, orig.get(k) || t)
    set.add(k)
  }
  for (const t of set) df.set(t, (df.get(t) || 0) + 1)
  const arr = [...set]
  for (let i = 0; i < arr.length; i += 1) {
    for (let j = i + 1; j < arr.length; j += 1) {
      const key = arr[i] < arr[j] ? arr[i] + '\u0000' + arr[j] : arr[j] + '\u0000' + arr[i]
      co.set(key, (co.get(key) || 0) + 1)
    }
  }
}

const coOf = (a, b) => {
  const x = String(a).toLowerCase()
  const y = String(b).toLowerCase()
  return co.get(x < y ? x + '\u0000' + y : y + '\u0000' + x) || 0
}

/** 点互信息：把「到处都出现」的词压下去 */
const pmi = (a, b) => {
  const c = coOf(a, b)
  if (!c) return 0
  const pa = (df.get(String(a).toLowerCase()) || 0) / N
  const pb = (df.get(String(b).toLowerCase()) || 0) / N
  const pab = c / N
  return Math.log2(pab / (pa * pb))
}

const nameOf = (t) => orig.get(t) || t

// ---- ① 泛 tag ----
const topDF = [...df.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
console.log(`语料：${N} 条视频，${df.size} 个不同 tag\n`)
console.log('【泛 tag 榜】出现次数 / 占比 —— 这些就是该被压权的"到处都有"')
for (const [t, c] of topDF) console.log(`  ${String(c).padStart(5)}  ${(c / N * 100).toFixed(1).padStart(5)}%  ${nameOf(t)}`)

// ---- ② 子标签候选 ----
console.log('\n【子标签候选】按 PMI 排序（共现 ≥ 3）')
for (const [axis, seeds] of Object.entries(SEEDS)) {
  const cand = new Map()
  for (const s of seeds) {
    const seedKey = s.toLowerCase()
    if (!df.has(seedKey)) continue
    for (const [key] of df) {
      if (key === seedKey) continue
      const c = coOf(seedKey, key)
      if (c < 3) continue
      const score = pmi(seedKey, key)
      if (score <= 0) continue
      const prev = cand.get(key)
      if (!prev || score > prev.score) cand.set(key, { score, c, via: s })
    }
  }
  const top = [...cand.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 12)
  console.log(`\n  ${axis}：` + (top.length ? '' : '（没候选）'))
  for (const [key, v] of top) {
    console.log(`    ${v.score.toFixed(2).padStart(6)}  共现${String(v.c).padStart(3)}  ${nameOf(key)}   (经「${v.via}」)`)
  }
}

// ---- ③ 聚类 ----
// 只留 DF≥3 的 tag，边要求 共现≥3 且 PMI≥2
const nodes = [...df.entries()].filter(([, c]) => c >= 3).map(([t]) => t)
const nodeSet = new Set(nodes)
const adj = new Map(nodes.map((t) => [t, []]))
for (const [key, c] of co) {
  if (c < 3) continue
  const [a, b] = key.split('\u0000')
  if (!nodeSet.has(a) || !nodeSet.has(b)) continue
  const s = pmi(a, b)
  if (s < 2) continue
  adj.get(a).push([b, s])
  adj.get(b).push([a, s])
}

const label = new Map(nodes.map((t) => [t, t]))
const order = [...nodes]
for (let iter = 0; iter < 12; iter += 1) {
  let changed = 0
  for (let i = order.length - 1; i > 0; i -= 1) { // 洗牌
    const j = Math.floor(Math.random() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  for (const t of order) {
    const score = new Map()
    for (const [nb, w] of adj.get(t)) {
      const l = label.get(nb)
      score.set(l, (score.get(l) || 0) + w)
    }
    if (!score.size) continue
    let best = label.get(t)
    let bestW = score.get(best) || 0
    for (const [l, w] of score) if (w > bestW) { best = l; bestW = w }
    if (label.get(t) !== best) { label.set(t, best); changed += 1 }
  }
  if (!changed) break
}

const clusters = new Map()
for (const t of nodes) {
  const l = label.get(t)
  if (!clusters.has(l)) clusters.set(l, [])
  clusters.get(l).push(t)
}
const sizes = [...clusters.values()].map((m) => m.sort((a, b) => (df.get(b) || 0) - (df.get(a) || 0)))
sizes.sort((a, b) => b.length - a.length)

console.log(`\n【聚类】${nodes.length} 个 tag 连成 ${sizes.length} 个簇，前 12 个：`)
for (const members of sizes.slice(0, 12)) {
  if (members.length < 3) continue
  console.log(`  ${String(members.length).padStart(3)} 个 · ${members.slice(0, 8).map(nameOf).join(' / ')}`)
}
const singles = sizes.filter((m) => m.length < 3).length
console.log(`  （另有 ${singles} 个孤立 tag）`)
