/**
 * tools/freshness-check.mjs —— 时效判定的单测
 * 跑法：node --test tools/freshness-check.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { bandOf } from '../lib/pool.mjs'
import { decideFreshness, freshnessOf, windowOf, isFreshness, EVERGREEN_AFTER_DAYS } from '../lib/freshness.mjs'
import { setUserTree } from '../lib/tree.mjs'

test('时长带：按区间中点落到 B站 的 1–4 档', () => {
  assert.equal(bandOf(0, 0), 0, '没设上限就不带参数')
  assert.equal(bandOf(8, 90), 3, '中点 49 → 30–60 分档')
  assert.equal(bandOf(0, 8), 1, '中点 4 → 10 分以内')
  assert.equal(bandOf(10, 30), 2)
  assert.equal(bandOf(60, 120), 4, '中点 90 → 60 分以上')
})

test('年龄中位数 > 90 天 → evergreen，否则 news', () => {
  assert.equal(EVERGREEN_AFTER_DAYS, 90)
  assert.equal(decideFreshness([1, 2, 3]).freshness, 'news')
  assert.equal(decideFreshness([13, 20, 26]).freshness, 'news')
  assert.equal(decideFreshness([361, 407, 208]).freshness, 'evergreen')
  assert.equal(decideFreshness([1775, 2052, 2883]).freshness, 'evergreen')
  // 边界：正好 90 天不算过期内容
  assert.equal(decideFreshness([10, 90, 200]).freshness, 'news')
  // 空列表不炸
  assert.equal(decideFreshness([]).freshness, 'news')
  assert.equal(decideFreshness(undefined).freshness, 'news')
})

test('预分配：内置轴按分类，新轴默认 news', () => {
  setUserTree({})
  assert.equal(freshnessOf('时政'), 'news')
  assert.equal(freshnessOf('游戏'), 'evergreen')
  assert.equal(freshnessOf('术力口'), 'evergreen')
  assert.equal(freshnessOf('从没听过的词'), 'news')
})

test('手填的 freshness 覆盖预分配', () => {
  setUserTree({ 时政: { freshness: 'evergreen' } })
  assert.equal(freshnessOf('时政'), 'evergreen')
  setUserTree({ 游戏: { freshness: 'news' } })
  assert.equal(freshnessOf('游戏'), 'news')
  setUserTree({})
  assert.equal(freshnessOf('时政'), 'news')
})

test('只有 news 轴受日期窗口约束', () => {
  setUserTree({})
  assert.equal(windowOf('时政', 14), 14)
  assert.equal(windowOf('游戏', 14), 0, 'evergreen 不设窗口')
  assert.equal(windowOf('时政', 0), 0, '全局设 0 时 news 也不限')
  assert.equal(isFreshness('news'), true)
  assert.equal(isFreshness('evergreen'), true)
  assert.equal(isFreshness('old'), false)
})
