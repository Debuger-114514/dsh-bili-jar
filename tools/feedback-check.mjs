/**
 * tools/feedback-check.mjs —— 赞 / 踩 / 无感 / 撤销 的单测（0.4.0）
 * 跑法：node --test tools/feedback-check.mjs
 *
 * 覆盖两层：
 *   ① lib/feedback.mjs 的纯逻辑（折算、无感窗口、计票）
 *   ② 路由层：GET/POST /feedback 的实际行为（改主意、撤销、重复点击）
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import {
  foldFeedback, stateOf, upsRows, bvidsWith, recentSkips, countVotes, CHOICES, ALL_ACTIONS,
} from '../lib/feedback.mjs'
import { apply } from '../index.js'

const T = (ts, bvid, action) => ({ ts, bvid, action })
const DAY = 86400e3

test('折算：同一条按时间顺序，最后一条说了算', () => {
  const st = foldFeedback([
    T(1, 'BV1', 'like'),
    T(2, 'BV1', 'dislike'),
    T(3, 'BV2', 'skip'),
  ])
  assert.equal(st.get('BV1').action, 'dislike')
  assert.equal(st.get('BV2').action, 'skip')
  assert.deepEqual(stateOf(st), { BV1: 'dislike', BV2: 'skip' })
})

test('折算：乱序写入也按 ts 排，不是按文件顺序', () => {
  const st = foldFeedback([T(30, 'BV1', 'like'), T(10, 'BV1', 'dislike')])
  assert.equal(st.get('BV1').action, 'like', 'ts=30 的那条更新')
})

test('撤销（none）把这条从状态里删掉', () => {
  const st = foldFeedback([T(1, 'BV1', 'like'), T(2, 'BV1', 'none')])
  assert.equal(st.has('BV1'), false)
  assert.deepEqual(stateOf(st), {})
})

test('垃圾行、非法动作、坏 bvid 一律忽略，不炸', () => {
  const st = foldFeedback([
    null, 42, {}, T(1, 'not-a-bv', 'like'), T(2, 'BV1', 'whatever'), T(3, 'BV1', 'like'),
  ])
  assert.deepEqual([...st.keys()], ['BV1'])
})

test('upsRows 只留赞/踩 —— 无感不算互动', () => {
  const st = foldFeedback([T(1, 'BV1', 'like'), T(2, 'BV2', 'skip'), T(3, 'BV3', 'dislike')])
  const rows = upsRows(st)
  assert.deepEqual(rows.map((r) => r.action).sort(), ['dislike', 'like'])
  assert.equal(bvidsWith(st, 'skip').join(','), 'BV2')
})

test('无感 14 天后自动失效', () => {
  const now = 100 * DAY
  const st = foldFeedback([T(now - 13 * DAY, 'BVnear', 'skip'), T(now - 15 * DAY, 'BVold', 'skip')])
  assert.deepEqual(recentSkips(st, { now, days: 14 }), ['BVnear'])
  assert.equal(recentSkips(st, { now, days: 0 }).length, 2, 'days=0 = 不限期')
})

test('countVotes 只数赞/踩的当前条数', () => {
  const st = foldFeedback([
    T(1, 'BV1', 'like'), T(2, 'BV1', 'like'), T(3, 'BV2', 'like'),
    T(4, 'BV3', 'dislike'), T(5, 'BV4', 'skip'),
  ])
  assert.deepEqual(countVotes(st), { like: 2, dislike: 1, total: 3 })
})

test('动作白名单：无感在、撤销在、瞎写的不在', () => {
  assert.deepEqual(CHOICES, ['like', 'dislike', 'skip'])
  assert.ok(ALL_ACTIONS.includes('none'))
  assert.equal(ALL_ACTIONS.includes('meh'), false)
})

// ── 路由层 ────────────────────────────────────────────────────────────────
function mount(dir) {
  let handler
  apply({
    get: (name) => (name === 'dshHomePath' ? () => dir : undefined),
    settings: { describe: () => [{ value: { ups: [] } }] },
    effect: (fn) => fn(),
    webServer: { register: (route) => { handler = route.handler } },
  }, {})
  return async (method, path, body) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    Object.assign(req, { method, url: `/api/bili-jar${path}`, headers: {} })
    let status, response
    await handler(req, {
      writeHead: (code) => { status = code },
      end: (text) => { response = JSON.parse(text) },
    })
    return { status, body: response }
  }
}

test('路由：赞 → 重复赞不变 → 换踩 → 撤销', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-jar-fb-'))
  t.after(() => import('node:fs').then((fs) => fs.rmSync(dir, { recursive: true, force: true })))
  const req = mount(dir)

  const a = await req('POST', '/feedback', { bvid: 'BV1aaaaaaaaa', action: 'like' })
  assert.equal(a.body.ok, true)
  assert.equal(a.body.previous, '')

  assert.equal((await req('GET', '/feedback')).body.state.BV1aaaaaaaaa, 'like')

  // 同一个动作再点一次：走「撤销」前先看 unchanged（前端会传 none，这里测直接重发 like 的情况）
  const again = await req('POST', '/feedback', { bvid: 'BV1aaaaaaaaa', action: 'like' })
  assert.equal(again.body.unchanged, true)

  const b = await req('POST', '/feedback', { bvid: 'BV1aaaaaaaaa', action: 'dislike' })
  assert.equal(b.body.previous, 'like')
  assert.equal((await req('GET', '/feedback')).body.state.BV1aaaaaaaaa, 'dislike')

  const c = await req('POST', '/feedback', { bvid: 'BV1aaaaaaaaa', action: 'none' })
  assert.equal(c.body.ok, true)
  assert.equal((await req('GET', '/feedback')).body.state.BV1aaaaaaaaa, undefined)

  // 日志确实落盘了（追加，不覆盖）
  const lines = readFileSync(join(dir, 'feedback.jsonl'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 3, 'like / dislike / none 各一行')
})

test('路由：无感写进去、进排除集，但不进熟人计票', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-jar-fb2-'))
  t.after(() => import('node:fs').then((fs) => fs.rmSync(dir, { recursive: true, force: true })))
  const req = mount(dir)
  await req('POST', '/feedback', { bvid: 'BV2aaaaaaaaa', action: 'skip' })
  const g = await req('GET', '/feedback')
  assert.equal(g.body.state.BV2aaaaaaaaa, 'skip')
  assert.equal(g.body.skips, 1)
  assert.deepEqual(g.body.counts, { like: 0, dislike: 0, total: 0 }, '无感不计入赞踩票数')
})

test('路由：非法动作被挡', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-jar-fb3-'))
  t.after(() => import('node:fs').then((fs) => fs.rmSync(dir, { recursive: true, force: true })))
  const req = mount(dir)
  const r = await req('POST', '/feedback', { bvid: 'BV3aaaaaaaaa', action: 'meh' })
  assert.equal(r.body.ok, false)
})

test('路由：历史可以一键清空', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-jar-fb4-'))
  t.after(() => import('node:fs').then((fs) => fs.rmSync(dir, { recursive: true, force: true })))
  writeFileSync(join(dir, 'history.json'), JSON.stringify([{ bvid: 'BV4aaaaaaaaa', watchedAt: 1 }]))
  const req = mount(dir)
  assert.equal((await req('GET', '/history')).body.items.length, 1)
  const cleared = await req('POST', '/history', { clear: true })
  assert.equal(cleared.body.ok, true)
  assert.deepEqual(cleared.body.items, [])
  assert.equal((await req('GET', '/history')).body.items.length, 0)
  assert.equal(JSON.parse(readFileSync(join(dir, 'history.json'), 'utf8')).length, 0)
})
