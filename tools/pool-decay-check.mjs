/**
 * tools/pool-decay-check.mjs —— T3：池子新陈代谢的单测
 * 跑法：node --test tools/pool-decay-check.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { repeatPenalty, applyRepeatPenalty, capPool, POOL_CAP } from '../lib/pool.mjs'

test('重复惩罚：3 次扣 0.09，10 次也只扣封顶 0.15', () => {
  assert.equal(repeatPenalty(0), 0)
  assert.equal(repeatPenalty(1), 0.03)
  assert.equal(repeatPenalty(3), 0.09)
  assert.equal(repeatPenalty(10), 0.15, '封顶 0.15，不能把一条好视频直接判死')
  assert.equal(repeatPenalty(undefined), 0)
})

test('应用惩罚后：shownTimes=3 比 shownTimes=0 低 0.09 分', () => {
  const mk = (shownTimes) => ({ bvid: 'BV' + shownTimes, score: 0.8, shownTimes })
  const items = [mk(0), mk(3), mk(10)]
  applyRepeatPenalty(items)
  assert.equal(items[0].score, 0.8)
  assert.equal(items[1].score, 0.71, '0.8 - 0.09')
  assert.equal(items[2].score, 0.65, '0.8 - 0.15（封顶）')
  assert.ok(Number.isFinite(items[1].score))
})

test('没有分数的条目不炸', () => {
  const items = [{ bvid: 'BVx', shownTimes: 5 }]
  applyRepeatPenalty(items)
  assert.equal(items[0].score, undefined)
  applyRepeatPenalty(null)
  applyRepeatPenalty([])
})

test(`池子上限 ${POOL_CAP}：500 进 400 出，被删的是 lastSeen 最旧的`, () => {
  assert.equal(POOL_CAP, 400)
  const entries = Array.from({ length: 500 }, (_, i) => ({
    bvid: 'BV' + i,
    lastSeen: 1000 + i,           // 越往后越新
    shownTimes: 0,
  }))
  const kept = capPool(entries)
  assert.equal(kept.length, 400)
  const lastSeenList = kept.map((e) => e.lastSeen).sort((a, b) => a - b)
  assert.equal(lastSeenList[0], 1100, '最旧的 100 条（lastSeen 1000–1099）被删')
  assert.equal(lastSeenList.at(-1), 1499, '最新的都留下来了')
})

test('lastSeen 相同的优先删 shownTimes 高的', () => {
  // 删 2 条：lastSeen=1 的最旧先走；lastSeen=2 的两条平级，shownTimes 高的（BV2）先走
  const entries = [
    { bvid: 'BV1', lastSeen: 1, shownTimes: 9 },
    { bvid: 'BV2', lastSeen: 2, shownTimes: 3 },
    { bvid: 'BV3', lastSeen: 2, shownTimes: 0 },
    { bvid: 'BV4', lastSeen: 3, shownTimes: 0 },
  ]
  const kept = capPool(entries, 2)
  assert.deepEqual(kept.map((e) => e.bvid).sort(), ['BV3', 'BV4'], 'BV2 和 BV3 同 lastSeen，先删露脸多的 BV2')
})

test('不足上限原样返回；脏条目被忽略', () => {
  const entries = [{ bvid: 'BV1', lastSeen: 1 }, { bvid: 'BV2', lastSeen: 2 }, null]
  assert.equal(capPool(entries, 400).length, 2)
})
