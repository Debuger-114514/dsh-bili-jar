/**
 * tools/diversity-check.mjs —— T13：多样性抽样的单测
 * 跑法：node --test tools/diversity-check.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyDiversity, diversityToTau, mulberry32 } from '../lib/pool.mjs'

const many = (n) => Array.from({ length: n }, (_, i) => ({
  bvid: `BV${i}`, score: Number((1 - i / n).toFixed(4)), title: `第${i}条`,
}))

test('tau=0 → 顺序完全不变（默认行为可回退）', () => {
  const items = many(50)
  const out = applyDiversity(items, { tau: 0, keepTop: 5, seed: 42 })
  assert.deepEqual(out.map((x) => x.bvid), items.map((x) => x.bvid))
})

test('前 keepTop 名永远留在前面', () => {
  const items = many(50)
  const out = applyDiversity(items, { tau: 0.08, keepTop: 5, seed: 7 })
  assert.deepEqual(out.slice(0, 5).map((x) => x.bvid), items.slice(0, 5).map((x) => x.bvid))
})

test('同一个种子 → 结果完全一样（可重放）', () => {
  const a = applyDiversity(many(60), { tau: 0.08, keepTop: 5, seed: 12345 })
  const b = applyDiversity(many(60), { tau: 0.08, keepTop: 5, seed: 12345 })
  assert.deepEqual(a.map((x) => x.bvid), b.map((x) => x.bvid))
})

test('不同种子 → 顺序会变（真的打乱了）', () => {
  const base = many(60)
  const a = applyDiversity(base, { tau: 0.08, keepTop: 5, seed: 1 }).map((x) => x.bvid)
  const b = applyDiversity(base, { tau: 0.08, keepTop: 5, seed: 2 }).map((x) => x.bvid)
  assert.notDeepEqual(a, b, '两个种子应该给出不同顺序')
  assert.deepEqual(a.slice(0, 5), b.slice(0, 5), '但前 5 名都是固定的')
})

test('不丢条目、不重复、长度不变', () => {
  const items = many(40)
  const out = applyDiversity(items, { tau: 0.05, keepTop: 5, seed: 9 })
  assert.equal(out.length, items.length)
  assert.equal(new Set(out.map((x) => x.bvid)).size, items.length)
  assert.deepEqual(out.map((x) => x.bvid).sort(), items.map((x) => x.bvid).sort())
})

test('条目比 keepTop 少时原样返回', () => {
  const items = many(3)
  const out = applyDiversity(items, { tau: 0.5, keepTop: 5, seed: 1 })
  assert.deepEqual(out.map((x) => x.bvid), items.map((x) => x.bvid))
})

test('高分更容易排在前面（概率性，不是纯随机）', () => {
  // 100 条、分数递减；打乱后前 20 名的平均分应该明显高于全体的平均分
  const items = many(100)
  const out = applyDiversity(items, { tau: 0.05, keepTop: 5, seed: 3 })
  const avg = (list) => list.reduce((s, x) => s + x.score, 0) / list.length
  assert.ok(avg(out.slice(5, 25)) > avg(items), '抽出来的应该比平均好')
})

test('diversity 映射到 tau：0 → 0，1 → 0.10，越界夹紧', () => {
  assert.equal(diversityToTau(0), 0)
  assert.equal(diversityToTau(1), 0.1)
  assert.equal(diversityToTau(0.5), 0.05)
  assert.equal(diversityToTau(-3), 0)
  assert.equal(diversityToTau(99), 0.1)
  assert.equal(diversityToTau(undefined), 0)
})

test('mulberry32 可复现，且落在 [0,1)', () => {
  const a = mulberry32(99)
  const b = mulberry32(99)
  for (let i = 0; i < 20; i++) {
    const x = a()
    assert.equal(x, b())
    assert.ok(x >= 0 && x < 1)
  }
})
