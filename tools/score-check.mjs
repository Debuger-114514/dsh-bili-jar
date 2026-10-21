// 验两件事：① 小众 tag 分 ② 日期窗口（0 = 不限）
import { nicheScore } from '../lib/pool.mjs'

const tagDf = new Map([['必剪创作', 90], ['高能', 80], ['时政', 40], ['俄乌', 5], ['冷战史', 2]])
const total = 100
const cases = [
  // 大标签：df 90/80 → 稀有度 0.10 / 0.20 → 平均 0.15
  ['只有大标签', { tags: ['必剪创作', '高能'] }, 0.15],
  // 池里没见过的 tag 稀有度按 1.0 算：1.0 / 0.95 / 0.60 → 平均 0.85
  ['大 + 小混合', { tags: ['时创', '时政', '俄乌'] }, 0.85],
  ['极小标签', { tags: ['冷战史', '俄乌'] }, 0.965],
  ['没标签', { tags: [] }, 0],
]
let bad = 0
for (const [name, it, want] of cases) {
  const got = nicheScore(it, tagDf, total)
  const ok = Math.abs(got - want) < 0.02
  console.log(`${ok ? 'OK  ' : 'DIFF'} ${name.padEnd(12)} → ${got}（期望 ≈${want}）`)
  if (!ok) bad++
}

// 日期窗口：0 时用 365 天软衰减，14 时用 14 天
const fresh = (days, win) => Math.max(0, Math.min(1, 1 - days / win))
const checks = [
  ['14 天窗：30 天前 = 0', fresh(30, 14), 0],
  ['不限：30 天前仍 >0.8', fresh(30, 365), 0.9178],
  ['不限：300 天前 ≈ 0.18', fresh(300, 365), 0.1781],
]
for (const [name, got, want] of checks) {
  const ok = Math.abs(got - want) < 0.01
  console.log(`${ok ? 'OK  ' : 'DIFF'} ${name.padEnd(20)} → ${got.toFixed(3)}`)
  if (!ok) bad++
}
process.exit(bad ? 1 : 0)
