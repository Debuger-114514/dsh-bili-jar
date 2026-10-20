/**
 * tools/feed.mjs —— 阶段 2 的现场验证
 * 用法：node tools/feed.mjs [minPlay]
 * 会把池子存在 .tools/pool.json，用来验证「累积池」：第二次跑不会丢掉上次的好东西。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { buildPool } from '../lib/pool.mjs'

const POOL = new URL('./pool.json', import.meta.url)
const prev = existsSync(POOL) ? JSON.parse(readFileSync(POOL, 'utf8')) : []

const cfg = {
  axes: ['deepseek', '时政', '科技测评', '健身教程'],
  ups: [],
  fanMin: 0,
  fanMax: 0,
  minMinutes: 8,
  maxMinutes: 90,
  minPlay: Number(process.argv[2] || 10000),
  showCharging: false,
  sampleRound: process.argv[3] != null ? Number(process.argv[3]) : undefined,
  exclude: (process.argv[4] || '').split(',').map((s) => s.trim()).filter(Boolean),
  mainCount: 5,
}

const t0 = Date.now()
const r = await buildPool(cfg, (m) => console.log('  · ' + m), prev)
const secs = ((Date.now() - t0) / 1000).toFixed(1)
writeFileSync(POOL, JSON.stringify(r.pool || []), 'utf8')

console.log('')
console.log(`建池 ${secs}s  轴=${r.axes.join(' / ')}  上次池=${prev.length} → 这次池=${(r.pool || []).length}`)
console.log(`统计 ${JSON.stringify(r.stats)}`)
console.log('')
for (const c of r.main) {
  console.log(`  [${String(c.score).padEnd(6)}] ${c.durationText.padEnd(7)} ${c.axis.padEnd(6)} ${c.title.slice(0, 32)}`)
  console.log(`           ${c.author} · ${c.bvid} · 赞${c.pct.like}% 币${c.pct.coin}% 藏${c.pct.fav}% · 播放${c.play}`)
  console.log(`           ${c.reasons.join(' / ')}`)
}
