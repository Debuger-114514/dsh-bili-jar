/**
 * tools/search-check.mjs —— 每轴搜几个词（searchPerAxis）与排序槽的单测（0.4.0）
 * 跑法：node --test tools/search-check.mjs
 *
 * 关键约束：不管搜几个词，**最后一个词永远走「最新发布」**——
 * 那是给新视频留的稳定入口，砍掉它池子就会偏老。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { termsOf, orderSlotsFor, AXIS_TREE } from '../lib/pool.mjs'

test('只搜 1 个词：没有「最新发布」槽（靠新鲜度配额兜底）', () => {
  assert.deepEqual(orderSlotsFor(1), ['totalrank'])
})

test('搜 2 个及以上：最后一个词走 pubdate，前面的走综合', () => {
  assert.deepEqual(orderSlotsFor(2), ['totalrank', 'pubdate'])
  assert.deepEqual(orderSlotsFor(3), ['totalrank', 'totalrank', 'pubdate'])
  assert.deepEqual(orderSlotsFor(5), ['totalrank', 'totalrank', 'totalrank', 'totalrank', 'pubdate'])
})

test('非法输入退回 1 个槽，不炸', () => {
  for (const bad of [0, -3, NaN, undefined, null, 'x']) {
    assert.equal(orderSlotsFor(bad).length, 1)
  }
})

test('termsOf 按 max 截断，且不超过 5', () => {
  const axis = Object.keys(AXIS_TREE)[0]
  for (const n of [1, 2, 3, 5]) {
    const t = termsOf(axis, 12, n)
    assert.ok(t.length >= 1 && t.length <= n, `n=${n} 得到 ${t.length} 个词`)
  }
  assert.ok(termsOf(axis, 12, 99).length <= 5, '上限 5')
})

test('termsOf 同一个小时稳定，换小时第三个词会轮换', () => {
  const axis = Object.keys(AXIS_TREE).find((a) => (AXIS_TREE[a].subs || []).length > 3) || Object.keys(AXIS_TREE)[0]
  const a = termsOf(axis, 3, 3)
  const b = termsOf(axis, 3, 3)
  assert.deepEqual(a, b, '同小时应完全一致（可复现）')
  const subs = (AXIS_TREE[axis].subs || []).length
  if (subs > 1) {
    const c = termsOf(axis, 4, 3)
    assert.notDeepEqual(a, c, '换一个小时，子簇词应该换一个')
  }
})
