/**
 * tools/growth-check.mjs —— T11：播放增速的单测
 * 跑法：node --test tools/growth-check.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { playGrowthOf, nextPlayBase, coldStartBonus, COLD_START } from '../lib/pool.mjs'

const DAY = 86400000

test('两次见到、间隔 1 天、播放 10 万 → 20 万：增速 10 万/天', () => {
  const now = 1_800_000_000_000
  assert.equal(playGrowthOf(100000, now - DAY, 200000, now), 100000)
})

test('间隔不到 6 小时 → null（太短是噪声）', () => {
  const now = 1_800_000_000_000
  assert.equal(playGrowthOf(100000, now - 0.2 * DAY, 200000, now), null)
})

test('首次见到（没有 playAt）→ null，不参与任何判断', () => {
  const now = 1_800_000_000_000
  assert.equal(playGrowthOf(100000, 0, 200000, now), null)
})

test('播放倒退 → 夹到 0，不是负数', () => {
  const now = 1_800_000_000_000
  assert.equal(playGrowthOf(200000, now - DAY, 100000, now), 0)
})

test('上次播放为 0 → null（没有可信基准）', () => {
  const now = 1_800_000_000_000
  assert.equal(playGrowthOf(0, now - DAY, 50000, now), null)
})

test('增速 ≥5 万/天时冷启动 +0.01，但总分仍 ≤0.05', () => {
  const base = (ageDays, growth) => coldStartBonus({
    title: '一期正常的科技测评',
    pubdate: Date.now() / 1000 - ageDays * 86400,
    play: 300000, coin: 0, favorites: 0, statsAt: 0,
    playGrowth: growth,
  })
  assert.equal(base(3, 60000), 0.04, '3 天档 0.03 + 增速 0.01')
  assert.equal(base(1, 60000), 0.05, '1 天档 0.05 + 增速 0.01 → 封顶还是 0.05')
  assert.equal(base(1, 0), 0.05)
  assert.equal(base(1, 49000), 0.05, '差一点到 5 万不给')
  assert.equal(base(3, null), 0.03, '增速未知按原档')
  assert.equal(COLD_START.day2, 0.05, '上限没变')
})

test('测不出来时不重置基准 —— 否则频繁刷新会让增速永远算不出来', () => {
  const now = 1_800_000_000_000
  // 上一轮 1 小时前记的：间隔不到 6 小时，测不出
  const short = nextPlayBase({ play: 100000, playPrev: 100000, playAt: now - 3600_000 }, 120000, now)
  assert.equal(short.playGrowth, null)
  assert.equal(short.playAt, now - 3600_000, '基准时间不许被刷成 now')
  assert.equal(short.playPrev, 100000, '基准播放量也不许变')

  // 连续多次短间隔刷新，基准仍然停在最初那一刻 → 攒够 6 小时后能算出增速
  let st = { play: 100000, playPrev: 100000, playAt: now - 3600_000 }
  for (let i = 0; i < 6; i++) {
    const next = nextPlayBase(st, 100000 + i * 1000, now + i * 600_000)
    assert.equal(next.playGrowth, null)
    assert.equal(next.playAt, now - 3600_000)
    st = { play: 100000 + i * 1000, playPrev: next.playPrev, playAt: next.playAt }
  }
  // 6 小时后终于可测：100000 → 130000，间隔 7 小时
  const long = nextPlayBase({ play: 130000, playPrev: 100000, playAt: now - 3600_000 }, 130000, now + 6 * 3600_000)
  assert.ok(long.playGrowth > 0, '攒够时间就能算出增速')
  assert.equal(long.playAt, now + 6 * 3600_000, '可测时基准推进')
  assert.equal(long.playPrev, 130000)
})

test('首次见到：用当前值起算，增速为 null', () => {
  const now = 1_800_000_000_000
  const r = nextPlayBase(null, 50000, now)
  assert.equal(r.playGrowth, null)
  assert.equal(r.playPrev, 50000)
  assert.equal(r.playAt, now)
})
