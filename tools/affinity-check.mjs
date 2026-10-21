// 验一下赞/踩的加权逻辑：没攒够不动、同一个 UP 加分、踩过减分、上下限
import { affinityDelta } from '../lib/pool.mjs'

const aff = (ready = true) => ({
  ready,
  authors: new Map([['111', 2]]),
  dislikes: new Map([['222', 3]]),
  tags: new Map([['时政', 3]]),
  tagDislikes: new Map([['标题党', 2]]),
})
const item = (o = {}) => ({ mid: '999', tags: [], ...o })

const cases = [
  ['没攒够 → 0', item({ mid: '111' }), aff(false), 0],
  ['没踩过这个 UP → 0', item(), aff(), 0],
  ['赞过两次的 UP', item({ mid: '111' }), aff(), 0.08],
  ['踩过三次的 UP', item({ mid: '222' }), aff(), -0.16],
  ['tag 命中偏好', item({ tags: ['时政'] }), aff(), 0.012],
  ['tag 被踩', item({ tags: ['标题党'] }), aff(), -0.012],
  ['加分封顶 0.12', item({ mid: '111', tags: ['时政'] }), aff(), 0.092],
]

let bad = 0
for (const [name, it, a, want] of cases) {
  const got = Number(affinityDelta(it, a).toFixed(4))
  const ok = Math.abs(got - want) < 1e-9
  console.log(`${ok ? 'OK  ' : 'DIFF'} ${name.padEnd(20)} → ${got}（期望 ${want}）`)
  if (!ok) bad++
}
process.exit(bad ? 1 : 0)
