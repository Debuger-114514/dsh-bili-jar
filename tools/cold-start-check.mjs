/**
 * tools/cold-start-check.mjs —— T8：冷启动补偿的单测
 * 跑法：node --test tools/cold-start-check.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { coldStartBonus, COLD_START } from '../lib/pool.mjs'

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
