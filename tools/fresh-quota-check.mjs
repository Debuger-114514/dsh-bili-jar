/**
 * tools/fresh-quota-check.mjs —— T9：新鲜度配额的单测
 * 跑法：node --test tools/fresh-quota-check.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { freshQuotaReplace } from '../lib/pool.mjs'

const now = Date.now() / 1000
/** 老片：10 天前，分数 0.5 */
const old = (bvid, axis, score = 0.5, play = 600000) => ({
  bvid, axis, score, play,
  title: `普通的${axis}长测视频`,
  pubdate: now - 10 * 86400,
  mid: 100 + score * 1000,
})
/** 够格的新片：1 天前 + 播放达标 + 非标题党 */
const fresh = (bvid, axis, score = 0.45, play = 80000) => ({
  bvid, axis, score, play,
  title: `${axis}新品上手：实测三天`,
  pubdate: now - 1 * 86400,
  mid: 999,
})

/** 搭一个 picked=3 的场景：A 轴两条（0.6/0.55），B 轴一条（0.7） */
function scene() {
  const picked = [old('BVa1', '游戏', 0.6), old('BVa2', '游戏', 0.55), old('BVb1', '音乐', 0.7)]
  const taken = new Set(picked.map((c) => c.bvid))
  const perAxisCount = new Map([['游戏', 2], ['音乐', 1]])
  const perUpCount = new Map()
  return { picked, taken, perAxisCount, perUpCount }
}

test('全是老片但有一条够格的新片 → 换进 1 条新的（替换轴上还有队友的最低分）', () => {
  const s = scene()
  const qualified = [...s.picked, fresh('BVnew', '数码', 0.45)]
  const r = freshQuotaReplace({ ...s, qualified, exclude: new Set(), minPlay: 10000, maxCount: 5 })
  assert.equal(r.replaced, 1)
  assert.ok(s.picked.some((c) => c.bvid === 'BVnew'), '新片进来了')
  assert.ok(!s.picked.some((c) => c.bvid === 'BVa2'), '被换掉的是 A 轴最低分的 BVa2')
  assert.ok(s.picked.some((c) => c.bvid === 'BVa1'), 'A 轴还剩一条，没被清空')
  assert.equal(s.picked.length, 3, '总数不变，没有塞爆 mainCount')
  assert.equal(s.perAxisCount.get('游戏'), 1)
  assert.equal(s.perAxisCount.get('数码'), 1)
})

test('够格的新片不存在 → 不替换，replaced = 0', () => {
  const s = scene()
  const qualified = [...s.picked, { ...fresh('BVold2', '数码'), pubdate: now - 20 * 86400 }]
  const r = freshQuotaReplace({ ...s, qualified, exclude: new Set(), minPlay: 10000, maxCount: 5 })
  assert.equal(r.needed, true)
  assert.equal(r.replaced, 0)
  assert.equal(s.picked.length, 3)
  assert.deepEqual(s.picked.map((c) => c.bvid).sort(), ['BVa1', 'BVa2', 'BVb1'])
})

test('新片播放不达标（18k 那种）→ 等于不存在，不硬凑', () => {
  const s = scene()
  const qualified = [...s.picked, fresh('BVweak', '数码', 0.45, 18000)]
  const r = freshQuotaReplace({ ...s, qualified, exclude: new Set(), minPlay: 10000, maxCount: 5 })
  assert.equal(r.replaced, 0)
})

test('每根轴都只有一条（没有可替换的 victim）→ 不替换', () => {
  const picked = [old('BVx', '游戏', 0.6), old('BVy', '音乐', 0.55), old('BVz', '数码', 0.5)]
  const taken = new Set(picked.map((c) => c.bvid))
  const perAxisCount = new Map([['游戏', 1], ['音乐', 1], ['数码', 1]])
  const qualified = [...picked, fresh('BVnew', '影视')]
  const r = freshQuotaReplace({ picked, qualified, taken, exclude: new Set(), perAxisCount, perUpCount: new Map(), minPlay: 10000, maxCount: 5 })
  assert.equal(r.needed, true)
  assert.equal(r.replaced, 0, '替换会把某根轴整个挤掉，宁可不动')
})

test('picked 不足 3 条不触发；已有新片时 needed=false', () => {
  const picked = [old('BVa1', '游戏', 0.6), old('BVa2', '游戏', 0.55)]
  const taken = new Set(picked.map((c) => c.bvid))
  const perAxisCount = new Map([['游戏', 2]])
  const qualified = [...picked, fresh('BVnew', '数码')]
  const r = freshQuotaReplace({ picked, qualified, taken, exclude: new Set(), perAxisCount, perUpCount: new Map(), minPlay: 10000, maxCount: 5 })
  assert.equal(r.replaced, 0, 'picked.length < 3 不强凑')

  const s2 = scene()
  s2.picked.push({ ...fresh('BVfresh', '数码'), score: 0.8 })
  const r2 = freshQuotaReplace({ ...s2, qualified: [...s2.picked], exclude: new Set(), minPlay: 10000, maxCount: 5 })
  assert.equal(r2.needed, false, 'main 里已经有够格的新片')
  assert.equal(r2.replaced, 0)
})

test('新片在排除集里 → 不选它', () => {
  const s = scene()
  const qualified = [...s.picked, fresh('BVex', '数码')]
  const r = freshQuotaReplace({ ...s, qualified, exclude: new Set(['BVex']), minPlay: 10000, maxCount: 5 })
  assert.equal(r.replaced, 0)
})
