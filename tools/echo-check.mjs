/**
 * tools/echo-check.mjs —— 防回音室（0.3.0 硬要求）的单测
 * 跑法：node --test tools/echo-check.mjs
 *
 * 规则：片单里「熟人来源」（fromUpList）条数不能超过 cap；
 * 超了就用 ranking 里第一个非熟人顶上，被换下来的熟人回到候选里。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { enforceEchoCap, capCuratedEcho } from '../lib/pool.mjs'

const mk = (n, fromUp = false) => Array.from({ length: n }, (_, i) => ({
  bvid: `BV${fromUp ? 'u' : 'd'}${i}`,
  axis: '时政',
  score: 1 - i / 100,
  fromUpList: fromUp,
}))

const pickedOf = (arr) => arr.map((x) => ({ ...x }))

test('没超上限 → 一条都不动', () => {
  const picked = pickedOf([...mk(1, true), ...mk(4, false)])
  const ranking = [...picked, ...mk(6, false)]
  const taken = new Set(picked.map((p) => p.bvid))
  const trimmed = enforceEchoCap(picked, ranking, { cap: 2, taken, exclude: new Set() })
  assert.equal(trimmed, 0)
  assert.equal(picked.filter((p) => p.fromUpList).length, 1)
})

test('超了 → 裁到 cap，且用非熟人顶上（总数不变）', () => {
  const picked = pickedOf([...mk(3, true), ...mk(2, false)])
  const spare = mk(5, false).map((x) => ({ ...x, bvid: `SP${x.bvid}` }))
  const ranking = [...picked, ...spare]
  const taken = new Set(picked.map((p) => p.bvid))
  const trimmed = enforceEchoCap(picked, ranking, { cap: 2, taken, exclude: new Set() })
  assert.equal(trimmed, 1, '3 条熟人、上限 2 ⇒ 裁 1 条')
  assert.equal(picked.length, 5, '总数不能变')
  assert.equal(picked.filter((p) => p.fromUpList).length, 2)
  assert.ok(picked.some((p) => p.bvid?.startsWith('SP')), '顶上来的必须是 ranking 里的非熟人')
})

test('cap=1 时也守得住（mainCount 很小的情况）', () => {
  const picked = pickedOf(mk(2, true))
  const spare = mk(3, false).map((x) => ({ ...x, bvid: `SP${x.bvid}` }))
  const trimmed = enforceEchoCap(picked, [...picked, ...spare], { cap: 1, taken: new Set(picked.map((p) => p.bvid)) })
  assert.equal(trimmed, 1)
  assert.equal(picked.filter((p) => p.fromUpList).length, 1)
})

test('候选里没有非熟人可换 → 宁可少裁，也不能把熟人的名额硬塞满', () => {
  // 极端情况：全是熟人。此时找不到替补，会留在原样（trimmed=0）——
  // 但真实流程里 picked 之前已经被 tryPick 限过一次，这条只是兜底。
  const picked = pickedOf(mk(5, true))
  const trimmed = enforceEchoCap(picked, picked, { cap: 2 })
  assert.equal(trimmed, 0)
  assert.equal(picked.length, 5)
})

test('exclude 里的不会被顶上来的替补选中', () => {
  const picked = pickedOf([...mk(2, true), ...mk(1, false)])
  const banned = { ...mk(1, false)[0], bvid: 'BAN' }
  const ok = { ...mk(1, false)[0], bvid: 'OK' }
  const ranking = [...picked, banned, ok]
  const trimmed = enforceEchoCap(picked, ranking, { cap: 1, exclude: new Set(['BAN']) })
  assert.equal(trimmed, 1)
  assert.ok(picked.some((p) => p.bvid === 'OK'), '应该选没被 exclude 的那条')
  assert.ok(!picked.some((p) => p.bvid === 'BAN'))
})

test('cap 默认值 1：不传参数也能守住', () => {
  const picked = pickedOf(mk(2, true))
  const spare = mk(2, false).map((x) => ({ ...x, bvid: `SP${x.bvid}` }))
  const trimmed = enforceEchoCap(picked, [...picked, ...spare], { taken: new Set(picked.map((p) => p.bvid)) })
  assert.equal(trimmed, 1)
  assert.equal(picked.filter((p) => p.fromUpList).length, 1)
})

// ── 策展路径（模型自己挑的那 5 条）────────────────────────────────────────────
// 真实事故：测试罐子里模型一口气挑了 3 条熟人，规则那边的上限管不到它。

const card = (bvid, fromUp = false, why = '') => ({ bvid, fromUpList: fromUp, why, reasons: ['贴近「时政」'] })

test('策展结果超上限 → 换成 shortlist 里的非熟人，顺序不乱', () => {
  const main = [card('A', true, '模型理由A'), card('B'), card('C', true, '模型理由C'), card('D', true, '模型理由D'), card('E')]
  const shortlist = [card('A', true), card('B'), card('C', true), card('D', true), card('E'), card('F'), card('G'), card('H')]
  const r = capCuratedEcho(main, shortlist, 2)
  assert.equal(r.trimmed, 1, '3 条熟人、上限 2 ⇒ 换 1 条')
  assert.equal(r.echo, 2)
  assert.equal(r.main.length, 5, '条数不能变')
  assert.equal(r.main[3].bvid, 'F', '从最后一条熟人开始换，取 shortlist 里第一个非熟人')
  assert.equal(r.main[0].bvid, 'A', '前面没超的不动，模型写的理由留着')
})

test('没超上限 → 一条都不动（连 why 都不碰）', () => {
  const main = [card('A', true, '模型理由'), card('B'), card('C')]
  const r = capCuratedEcho(main, [card('A', true), card('B'), card('C'), card('D')], 2)
  assert.equal(r.trimmed, 0)
  assert.equal(r.main[0].why, '模型理由')
})

test('shortlist 里没有非熟人可换 → 宁可少换也不重复', () => {
  const main = [card('A', true), card('B', true), card('C', true)]
  const r = capCuratedEcho(main, main, 1)
  assert.equal(r.trimmed, 0, '没有替补就只能保持原样')
  assert.equal(r.main.length, 3)
})

test('换上来那条用规则 reasons 兜底，why 为空也不会炸', () => {
  const main = [card('A', true), card('B', true)]
  const alt = { bvid: 'Z', fromUpList: false, reasons: ['贴近「时政」'] }
  const r = capCuratedEcho(main, [card('A', true), card('B', true), alt], 1)
  assert.equal(r.trimmed, 1)
  const swapped = r.main.find((x) => x.bvid === 'Z')
  assert.ok(swapped, '替补应该进片单')
  assert.equal(swapped.why, '')
  assert.deepEqual(swapped.reasons, ['贴近「时政」'])
})

test('cap=0 也能全清干净（极端参数不炸）', () => {
  const main = [card('A', true), card('B', true)]
  const r = capCuratedEcho(main, [card('A', true), card('B', true), card('X'), card('Y')], 0)
  assert.equal(r.echo, 0)
  assert.equal(r.main.filter((x) => x.fromUpList).length, 0)
})
