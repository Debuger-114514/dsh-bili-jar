/**
 * tools/refresh-check.mjs —— 三档刷新判定的单测
 * 跑法：node --test tools/refresh-check.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decideRefresh,
  OPEN_AFTER_MS,
  AUTO_AFTER_MS,
  FULL_AFTER_MS,
} from '../lib/refresh.mjs'

const H = 3600e3
const T = 1_800_000_000_000 // 固定一个“现在”，避免测试里跨毫秒抖动

const state = (over = {}) => ({
  now: T,
  probedAt: T - 1 * H,
  fullAt: T - 1 * H,
  opened: false,
  ...over,
})

test('常量就是 3h / 6h / 24h', () => {
  assert.equal(OPEN_AFTER_MS, 3 * H)
  assert.equal(AUTO_AFTER_MS, 6 * H)
  assert.equal(FULL_AFTER_MS, 24 * H)
})

test('从没跑过（fullAt=0）→ full', () => {
  assert.equal(decideRefresh(state({ fullAt: 0, probedAt: 0 })), 'full')
})

test('刚跑完 1 小时 → none（0–3h 不动）', () => {
  assert.equal(decideRefresh(state({ probedAt: T - 1 * H, fullAt: T - 1 * H })), 'none')
  assert.equal(decideRefresh(state({ opened: true })), 'none')
})

test('打开面板且过了 3 小时 → probe', () => {
  assert.equal(decideRefresh(state({ opened: true, probedAt: T - 3 * H })), 'probe')
})

test('没打开且过了 3 小时 → none（还没到 6h 自动档）', () => {
  assert.equal(decideRefresh(state({ opened: false, probedAt: T - 3 * H })), 'none')
})

test('没打开但过了 6 小时 → probe', () => {
  assert.equal(decideRefresh(state({ opened: false, probedAt: T - 6 * H })), 'probe')
})

test('打开过、距探测 4 小时 → probe', () => {
  assert.equal(decideRefresh(state({ opened: true, probedAt: T - 4 * H })), 'probe')
})

test('过了 24 小时 → full 优先于 probe', () => {
  assert.equal(
    decideRefresh(state({ opened: true, probedAt: T - 25 * H, fullAt: T - 24 * H })),
    'full',
  )
  // 探测很久没跑但全量刚跑过 → 也不该被 full 抢走
  assert.equal(
    decideRefresh(state({ opened: true, probedAt: T - 25 * H, fullAt: T - 1 * H })),
    'probe',
  )
})

test('边界值：正好等于阈值算触发', () => {
  // 打开 + 正好 3h
  assert.equal(decideRefresh(state({ opened: true, probedAt: T - OPEN_AFTER_MS })), 'probe')
  // 没打开 + 正好 6h
  assert.equal(decideRefresh(state({ opened: false, probedAt: T - AUTO_AFTER_MS })), 'probe')
  // 正好 24h → full
  assert.equal(decideRefresh(state({ fullAt: T - FULL_AFTER_MS })), 'full')
  // 差 1ms → 不触发
  assert.equal(decideRefresh(state({ opened: true, probedAt: T - OPEN_AFTER_MS + 1 })), 'none')
  assert.equal(decideRefresh(state({ opened: false, probedAt: T - AUTO_AFTER_MS + 1 })), 'none')
  assert.equal(
    decideRefresh(state({ opened: true, probedAt: T - 5 * H, fullAt: T - FULL_AFTER_MS + 1 })),
    'probe',
  )
})

test('probedAt=0（从没探测过）也按时间差走，且不崩', () => {
  // fullAt 新鲜、从没探测过：远不止 6h → probe
  assert.equal(decideRefresh(state({ fullAt: T - 1 * H, probedAt: 0 })), 'probe')
  // fullAt=0 时前面已经全量优先
  assert.equal(decideRefresh({ now: T, probedAt: 0, fullAt: 0, opened: false }), 'full')
})

test('字段缺失 / undefined 的状态不崩，按“从没跑过”处理', () => {
  assert.equal(decideRefresh({}), 'full')
  assert.equal(decideRefresh({ now: T, fullAt: T - 1 * H }), 'probe') // probedAt 缺 → 0 → 超过 6h
  assert.equal(decideRefresh({ now: T, fullAt: T - 1 * H, probedAt: T - 1 * H }), 'none')
})

test('返回值只可能是 full / probe / none', () => {
  const cases = [
    { now: T, probedAt: 0, fullAt: 0, opened: false },
    { now: T, probedAt: T - 1 * H, fullAt: T - 1 * H, opened: true },
    { now: T, probedAt: T - 2 * H, fullAt: T - 2 * H, opened: true },
    { now: T, probedAt: T - 7 * H, fullAt: T - 2 * H, opened: false },
    { now: T, probedAt: T - 7 * H, fullAt: T - 30 * H, opened: true },
  ]
  for (const c of cases) assert.ok(['full', 'probe', 'none'].includes(decideRefresh(c)))
})
