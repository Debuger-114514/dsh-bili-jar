/**
 * tools/cold-start-check.mjs —— T8 + T10：冷启动补偿与数据刷新的单测
 * 跑法：node --test tools/cold-start-check.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { coldStartBonus, COLD_START, pickStale, REFRESH_AFTER_MS, statsAtOf } from '../lib/pool.mjs'

/** 造一条缺互动数据的候选：coin/fav = 0、statsAt = 0 */
function cold(ageDays, play, title = '一期正常的科技测评：新旗舰手机两周体验') {
  return {
    bvid: 'BVcold' + ageDays + play,
    title,
    pubdate: ageDays == null ? 0 : Date.now() / 1000 - ageDays * 86400,
    play,
    coin: 0, favorites: 0,
    statsAt: 0, statsTries: 0,
  }
}

test('三档金额：1 天 0.05 / 3 天 0.03 / 6 天 0.01', () => {
  assert.equal(COLD_START.day2, 0.05, '上限就是 0.05，不许调大')
  assert.equal(coldStartBonus(cold(1, 300000)), 0.05)
  assert.equal(coldStartBonus(cold(3, 300000)), 0.03)
  assert.equal(coldStartBonus(cold(6, 300000)), 0.01)
})

test('边界：2 天整拿满档，7 天之后不给', () => {
  assert.equal(coldStartBonus(cold(2, 300000)), 0.05)
  assert.equal(coldStartBonus(cold(4, 300000)), 0.03)
  assert.equal(coldStartBonus(cold(7, 300000)), 0.01)
  assert.equal(coldStartBonus(cold(8, 300000)), 0, '超过 7 天不再补偿')
})

test('播放低于门槛不给（防止把没人看的顶进决赛圈）', () => {
  assert.equal(coldStartBonus(cold(1, 30000)), 0, '3 万 < minPlayFloor 50000')
  assert.equal(coldStartBonus(cold(1, 50000)), 0.05, '正好踩线算过')
})

test('门槛随全局 minPlay 抬高：max(50000, minPlay×2)', () => {
  assert.equal(coldStartBonus(cold(1, 60000), { minPlay: 40000 }), 0, 'minPlay 4 万 ⇒ 门槛 8 万')
  assert.equal(coldStartBonus(cold(1, 90000), { minPlay: 40000 }), 0.05)
})

test('标题党不给', () => {
  assert.equal(coldStartBonus(cold(1, 300000, '劲爆！全网首发震惊实测')), 0)
})

test('补过数据（statsAt > 0）永远不给', () => {
  const it = cold(1, 300000)
  it.statsAt = Date.now() - 86400000
  assert.equal(coldStartBonus(it), 0, '补贴是临时的，补到真数据就撤')
})

test('已经有 coin 或 favorites 的不给', () => {
  const c = cold(1, 300000); c.coin = 12
  assert.equal(coldStartBonus(c), 0)
  const f = cold(1, 300000); f.favorites = 34
  assert.equal(coldStartBonus(f), 0)
})

test('缺 pubdate 的不给', () => {
  assert.equal(coldStartBonus(cold(null, 300000)), 0)
})

// ---- T10：过期刷新 ----

const NOW = 1_800_000_000_000
const stale = (bvid, statsAgeDays, play) => ({
  bvid, play,
  statsAt: statsAgeDays == null ? 0 : NOW - statsAgeDays * 86400000,
})

test('保质期是 7 天', () => {
  assert.equal(REFRESH_AFTER_MS, 7 * 86400000)
})

test('statsAt 8 天前的被选中，3 天前的不选，没补过的不选', () => {
  const items = [stale('BVold', 8, 1000), stale('BVnew', 3, 999999), stale('BVnone', null, 500)]
  const picked = pickStale(items, NOW)
  assert.deepEqual(picked.map((x) => x.bvid), ['BVold'])
})

test('最多 3 条，播放高的先刷', () => {
  const items = [
    stale('BVa', 9, 100),
    stale('BVb', 9, 300000),
    stale('BVc', 9, 200000),
    stale('BVd', 9, 400000),
    stale('BVe', 9, 50),
  ]
  const picked = pickStale(items, NOW)
  assert.equal(picked.length, 3)
  assert.deepEqual(picked.map((x) => x.bvid), ['BVd', 'BVb', 'BVc'], '播放降序取前 3')
})

test('不传 now 用当前时间；空输入不炸', () => {
  assert.deepEqual(pickStale([]), [])
  assert.deepEqual(pickStale(null), [])
  // 用真实时钟构造：30 天前补的数据肯定过期
  assert.equal(pickStale([{ bvid: 'BVx', play: 1000, statsAt: Date.now() - 30 * 86400000 }]).length, 1)
  assert.equal(pickStale([{ bvid: 'BVy', play: 1000, statsAt: Date.now() - 3 * 86400000 }]).length, 0)
})

// ---- T12：历史条目补 statsAt ----

test('老条目有互动数据但没 statsAt → 补成上次见到的时间', () => {
  assert.equal(statsAtOf({ coin: 5, favorites: 0, statsAt: 0, lastSeen: 1690000000000 }), 1690000000000)
  assert.equal(statsAtOf({ coin: 0, favorites: 9, lastSeen: 1690000000000 }), 1690000000000, '只有 fav 也算有数据')
  assert.equal(statsAtOf({ coin: 5, lastSeen: 1690000000000 }, 1700000000000), 1690000000000, '有 lastSeen 用 lastSeen')
  assert.equal(statsAtOf({ coin: 5 }, 1700000000000), 1700000000000, '连 lastSeen 都没有才退到 now')
})

test('真没有数据的（coin=0 且 fav=0）不许乱标', () => {
  assert.equal(statsAtOf({ coin: 0, favorites: 0, statsAt: 0, lastSeen: 1690000000000 }), 0)
  assert.equal(statsAtOf({ lastSeen: 1690000000000 }), 0)
  assert.equal(statsAtOf(null), 0, '没有 old 的全新条目')
})

test('已有 statsAt 的保持原值，不覆盖', () => {
  assert.equal(statsAtOf({ coin: 5, statsAt: 12345 }), 12345)
  assert.equal(statsAtOf({ coin: 0, favorites: 0, statsAt: 12345 }), 12345, '即使是零数据条目，已有标记也不动')
})

test('老条目（这一轮没被搜到）也要在合并时补上 statsAt', async () => {
  const now = Date.now()
  const prev = [
    // 上一轮留下的：有数据、但没有 statsAt（T8 之前的老条目）
    { bvid: 'BVold', title: '旧的一条', duration: 900, pubdate: now / 1000 - 86400 * 3, play: 200000, coin: 50, favorites: 300, statsAt: 0, lastSeen: now - 3600000 },
    // 上一轮留下的：真没数据 —— 不许乱标
    { bvid: 'BVnodata', title: '没数据的一条', duration: 900, pubdate: now / 1000 - 86400 * 3, play: 120000, coin: 0, favorites: 0, statsAt: 0, lastSeen: now - 3600000 },
  ]
  // buildPool 要联网，这里只验合并逻辑用的纯函数：statsAtOf 被合并段调用
  const { statsAtOf } = await import('../lib/pool.mjs')
  assert.equal(statsAtOf(prev[0], now), prev[0].lastSeen, '有数据的补成上次见到的时间')
  assert.equal(statsAtOf(prev[1], now), 0, '没数据的保持 0')
})
