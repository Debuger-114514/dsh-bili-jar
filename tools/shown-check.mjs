/**
 * tools/shown-check.mjs —— T4：shown.json 新旧格式的单测
 * 跑法：node --test tools/shown-check.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseShown, pushRound, flattenShown, SHOWN_ROUNDS } from '../lib/shown.mjs'

test('旧格式（纯数组）能被读成 1 轮', () => {
  const s = parseShown(['BV1', 'BV2'])
  assert.deepEqual(s.rounds, [['BV1', 'BV2']])
  assert.equal(flattenShown(s).join(','), 'BV1,BV2')
})

test('新格式写出去再读回来一致', () => {
  const s0 = { rounds: [['BV1'], ['BV2', 'BV3']] }
  const s1 = parseShown(JSON.parse(JSON.stringify(s0)))
  assert.deepEqual(s1, s0)
})

test('垃圾输入一律回空，不炸', () => {
  assert.deepEqual(parseShown(null), { rounds: [] })
  assert.deepEqual(parseShown(42), { rounds: [] })
  assert.deepEqual(parseShown({ rounds: 'nope' }), { rounds: [] })
  assert.deepEqual(parseShown({ rounds: [['BV1'], null, [42, 'BV2']] }), { rounds: [['BV1'], ['BV2']] })
})

test(`最多记 ${SHOWN_ROUNDS} 轮，新的在最后，超了丢最旧`, () => {
  assert.equal(SHOWN_ROUNDS, 5)
  let s = { rounds: [] }
  for (let i = 1; i <= 7; i += 1) s = pushRound(s, ['BV' + i])
  assert.equal(s.rounds.length, 5)
  assert.deepEqual(s.rounds[0], ['BV3'], '第 1、2 轮被丢')
  assert.deepEqual(s.rounds.at(-1), ['BV7'])
})

test('旧格式升级路径：先读到一轮，再追加新轮', () => {
  let s = parseShown(['BV1old', 'BV2old'])   // 老用户磁盘上的旧格式
  s = pushRound(s, ['BV1new'])
  assert.equal(s.rounds.length, 2)
  assert.deepEqual(flattenShown(s), ['BV1old', 'BV2old', 'BV1new'], '拍平后全部参与排除')
})

test('拍平跨轮去重；空轮被丢弃', () => {
  const s = pushRound(pushRound({ rounds: [] }, ['BV1', 'BV2']), ['BV2', 'BV3', ''])
  assert.deepEqual(flattenShown(s), ['BV1', 'BV2', 'BV3'])
  assert.equal(s.rounds.length, 2)
})
