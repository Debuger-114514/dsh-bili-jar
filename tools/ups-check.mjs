/**
 * tools/ups-check.mjs —— 熟人名单（lib/ups.mjs）的单测
 * 跑法：node --test tools/ups-check.mjs
 * 验的是 docs/ups-and-refresh.md §1 的契约：
 * 去重、时间窗、三档、上限、无 mid 跳过、空输入。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildUpList,
  tierOf,
  UP_OBSERVE_AT,
  UP_WINDOW_MS,
  UP_REGULAR_CAP,
} from '../lib/ups.mjs'

const NOW = 1793000000000
const DAY = 86400e3

/** 写 pool 的小助手：[bvid, mid, author] → 对象 */
const makePool = (...rows) => rows.map(([bvid, mid, author]) => ({ bvid, mid, author }))

test('常量与契约一致：观察线 3、窗口 180 天、regular 上限 20', () => {
  assert.equal(UP_OBSERVE_AT, 3)
  assert.equal(UP_WINDOW_MS, 180 * 86400e3)
  assert.equal(UP_REGULAR_CAP, 20)
})

test('空输入不炸：返回空名单、空三档和空 Map', () => {
  const out = buildUpList({ feedback: [], history: [], later: [], pool: [], now: NOW })
  assert.deepEqual(out.ups, [])
  assert.deepEqual(out.byTier, { regular: [], observing: [], black: [] })
  assert.ok(out.midOf instanceof Map)
  assert.equal(out.midOf.size, 0)
  // 连参数都不传也不炸
  assert.doesNotThrow(() => buildUpList())
  assert.deepEqual(buildUpList().ups, [])
})

test('tierOf：>=3 regular / 1..2 observing / <=0 black', () => {
  assert.equal(tierOf(3), 'regular')
  assert.equal(tierOf(99), 'regular')
  assert.equal(tierOf(2), 'observing')
  assert.equal(tierOf(1), 'observing')
  assert.equal(tierOf(0), 'black')
  assert.equal(tierOf(-1), 'black')
  assert.equal(tierOf(undefined), 'black')
})

test('同一条 bvid 点赞 3 行 → 只算 1 次互动（真实脏数据的形状）', () => {
  const bvid = 'BV1Vbnn6iEfG'
  const out = buildUpList({
    feedback: [
      { bvid, action: 'like', ts: NOW - 3 * DAY },
      { bvid, action: 'like', ts: NOW - 2 * DAY },
      { bvid, action: 'like', ts: NOW - DAY },
    ],
    history: [],
    later: [],
    pool: makePool([bvid, '23947287', '小约翰可汗']),
    now: NOW,
  })
  assert.equal(out.ups.length, 1)
  const up = out.ups[0]
  assert.equal(up.mid, '23947287')
  assert.equal(up.name, '小约翰可汗')
  assert.equal(up.like, 1)
  assert.equal(up.net, 1)
  assert.equal(up.tier, 'observing')
  assert.deepEqual(up.bvids, [bvid])
  assert.equal(up.firstAt, NOW - 3 * DAY)
  assert.equal(up.lastAt, NOW - DAY)
})

test('同一条 bvid 既点开又点赞 → 算 2 次互动', () => {
  const bvid = 'BV1qgnA6REyU'
  const out = buildUpList({
    history: [{ bvid, author: '过拟合青年', watchedAt: NOW - 2 * DAY }],
    feedback: [{ bvid, action: 'like', ts: NOW - DAY }],
    later: [],
    pool: makePool(['BV9xx0', '555', '过拟合青年']),
    now: NOW,
  })
  assert.equal(out.ups.length, 1)
  const up = out.ups[0]
  assert.equal(up.mid, '555')
  assert.equal(up.open, 1)
  assert.equal(up.like, 1)
  assert.equal(up.net, 2)
  assert.equal(up.tier, 'observing')
  assert.deepEqual(up.bvids, [bvid], '同一条 bvid 在 bvids 里只出现一次')
})

test('180 天窗口外的互动不计入', () => {
  const out = buildUpList({
    feedback: [
      { bvid: 'BVold1', action: 'like', ts: NOW - UP_WINDOW_MS - 1 },
      { bvid: 'BVold2', action: 'like', ts: NOW - 2 * UP_WINDOW_MS },
    ],
    history: [],
    later: [],
    pool: makePool(['BVold1', '1', '老熟人'], ['BVold2', '1', '老熟人']),
    now: NOW,
  })
  assert.deepEqual(out.ups, [])
  assert.equal(out.midOf.get('BVold1'), '1', '窗口外也能回填 mid，只是不计票')
})

test('正好 180 天边界仍计入，180 天 + 1ms 不计', () => {
  const inside = buildUpList({
    feedback: [{ bvid: 'BV1', action: 'like', ts: NOW - UP_WINDOW_MS }],
    history: [],
    later: [],
    pool: makePool(['BV1', 'm1', 'A']),
    now: NOW,
  })
  assert.equal(inside.ups.length, 1)

  const outside = buildUpList({
    feedback: [{ bvid: 'BV1', action: 'like', ts: NOW - UP_WINDOW_MS - 1 }],
    history: [],
    later: [],
    pool: makePool(['BV1', 'm1', 'A']),
    now: NOW,
  })
  assert.equal(outside.ups.length, 0)
})

test('窗口外的 3 条旧赞不算：3 旧 + 1 新只按 1 计', () => {
  const feedback = [0, 1, 2].map((i) => ({
    bvid: `BVold${i}`,
    action: 'like',
    ts: NOW - UP_WINDOW_MS - (i + 1) * DAY,
  }))
  feedback.push({ bvid: 'BVnew', action: 'like', ts: NOW - DAY })
  const out = buildUpList({
    feedback,
    history: [],
    later: [],
    pool: makePool(
      ['BVold0', 'm1', 'A'],
      ['BVold1', 'm1', 'A'],
      ['BVold2', 'm1', 'A'],
      ['BVnew', 'm1', 'A'],
    ),
    now: NOW,
  })
  assert.equal(out.ups.length, 1)
  assert.equal(out.ups[0].like, 1)
  assert.equal(out.ups[0].net, 1)
  assert.equal(out.ups[0].tier, 'observing')
})

test('1 次 dislike 扣 2 分：5 赞 + 1 踩 = net 3（仍是 regular）', () => {
  const feedback = [0, 1, 2, 3, 4].map((i) => ({
    bvid: `BVlike${i}`,
    action: 'like',
    ts: NOW - (i + 1) * DAY,
  }))
  feedback.push({ bvid: 'BVdis', action: 'dislike', ts: NOW - DAY })
  const out = buildUpList({
    feedback,
    history: [],
    later: [],
    pool: makePool(
      ['BVlike0', 'm1', 'A'],
      ['BVlike1', 'm1', 'A'],
      ['BVlike2', 'm1', 'A'],
      ['BVlike3', 'm1', 'A'],
      ['BVlike4', 'm1', 'A'],
      ['BVdis', 'm1', 'A'],
    ),
    now: NOW,
  })
  assert.equal(out.ups.length, 1)
  assert.equal(out.ups[0].like, 5)
  assert.equal(out.ups[0].dislike, 1)
  assert.equal(out.ups[0].net, 3)
  assert.equal(out.ups[0].tier, 'regular')
})

test('赞踩相抵到 <=0 → black（1 赞 + 1 踩 = -1）', () => {
  const out = buildUpList({
    feedback: [
      { bvid: 'BV1', action: 'like', ts: NOW - DAY },
      { bvid: 'BV2', action: 'dislike', ts: NOW - 2 * DAY },
      { bvid: 'BV2', action: 'dislike', ts: NOW - DAY },  // 同一 bvid 的重复踩
    ],
    history: [],
    later: [],
    pool: makePool(['BV1', 'm1', '拉黑我'], ['BV2', 'm1', '拉黑我']),
    now: NOW,
  })
  assert.equal(out.ups.length, 1)
  assert.equal(out.ups[0].dislike, 1)
  assert.equal(out.ups[0].net, -1)
  assert.equal(out.ups[0].tier, 'black')
  assert.deepEqual(out.byTier.black.map((u) => u.mid), ['m1'])
})

test('同一条 bvid 点开两次只算 1 次 open', () => {
  const out = buildUpList({
    history: [
      { bvid: 'BV1', mid: 'm1', author: 'A', watchedAt: NOW - 2 * DAY },
      { bvid: 'BV1', mid: 'm1', author: 'A', watchedAt: NOW - DAY },
    ],
    feedback: [],
    later: [],
    pool: [],
    now: NOW,
  })
  assert.equal(out.ups[0].open, 1)
  assert.equal(out.ups[0].net, 1)
})

test('history 没有 mid 时用 author 在 pool 里反查（含 mid: 0 的脏数据）', () => {
  const out = buildUpList({
    history: [
      { bvid: 'BV1', mid: 0, author: '小约翰可汗', watchedAt: NOW - 2 * DAY },
      { bvid: 'BV2', author: '小约翰可汗', watchedAt: NOW - DAY },
    ],
    feedback: [],
    later: [],
    pool: makePool(['BV0', '23947287', '小约翰可汗']),
    now: NOW,
  })
  assert.equal(out.ups.length, 1)
  assert.equal(out.ups[0].mid, '23947287')
  assert.equal(out.ups[0].name, '小约翰可汗')
  assert.equal(out.ups[0].open, 2)
  assert.equal(out.midOf.get('BV1'), '23947287')
  assert.equal(out.midOf.get('BV2'), '23947287')
})

test('history 没有 mid 且 author 查不到 → 跳过，不按名字瞎猜', () => {
  const out = buildUpList({
    history: [
      { bvid: 'BV1', author: '查无此人', watchedAt: NOW - DAY },
      { bvid: 'BV2', mid: 'm1', author: '熟人', watchedAt: NOW - DAY },
    ],
    feedback: [],
    later: [],
    pool: makePool(['BV0', 'm1', '熟人']),
    now: NOW,
  })
  assert.equal(out.ups.length, 1)
  assert.equal(out.ups[0].mid, 'm1')
  assert.equal(out.ups[0].open, 1)
})

test('同名 author 对应多个 mid → 视为查不到，不猜', () => {
  const out = buildUpList({
    history: [{ bvid: 'BV1', author: '重名', watchedAt: NOW - DAY }],
    feedback: [],
    later: [],
    pool: makePool(['BVa', 'm1', '重名'], ['BVb', 'm2', '重名']),
    now: NOW,
  })
  assert.deepEqual(out.ups, [])
})

test('later 计入 positive，没有 mid 时也走 author 反查', () => {
  const out = buildUpList({
    history: [],
    feedback: [],
    later: [{ bvid: 'BV1xkJv6FE1A', author: '伊万不是大氢弹', addedAt: NOW - DAY }],
    pool: makePool(['BV0', '777', '伊万不是大氢弹']),
    now: NOW,
  })
  assert.equal(out.ups.length, 1)
  const up = out.ups[0]
  assert.equal(up.mid, '777')
  assert.equal(up.later, 1)
  assert.equal(up.net, 1)
  assert.equal(up.tier, 'observing')
})

test('byTier 分组正确，ups 按 regular → observing → black 拼接', () => {
  const out = buildUpList({
    history: [
      { bvid: 'BVa1', mid: 'mr', author: '熟人', watchedAt: NOW - 3 * DAY },
      { bvid: 'BVa2', mid: 'mr', author: '熟人', watchedAt: NOW - 2 * DAY },
      { bvid: 'BVa3', mid: 'mr', author: '熟人', watchedAt: NOW - DAY },
      { bvid: 'BVb1', mid: 'mo', author: '观察', watchedAt: NOW - DAY },
    ],
    feedback: [{ bvid: 'BVc1', action: 'dislike', ts: NOW - DAY }],
    later: [],
    pool: makePool(['BVc1', 'mb', '拉黑']),
    now: NOW,
  })
  assert.deepEqual(out.byTier.regular.map((u) => u.mid), ['mr'])
  assert.deepEqual(out.byTier.observing.map((u) => u.mid), ['mo'])
  assert.deepEqual(out.byTier.black.map((u) => u.mid), ['mb'])
  assert.deepEqual(out.ups.map((u) => u.mid), ['mr', 'mo', 'mb'])
})

test('regular 最多 20 个，按 lastAt 倒序保留', () => {
  const history = []
  const feedback = []
  const poolRows = []
  for (let i = 0; i < 25; i++) {
    const t = NOW - i * 1000            // i 越小越新
    const a = `BVreg${i}a`
    const b = `BVreg${i}b`
    history.push({ bvid: a, mid: `mr${i}`, author: `UP${i}`, watchedAt: t })
    history.push({ bvid: b, mid: `mr${i}`, author: `UP${i}`, watchedAt: t })
    feedback.push({ bvid: a, action: 'like', ts: t })   // open 2 + like 1 = net 3
    poolRows.push({ bvid: a, mid: `mr${i}`, author: `UP${i}` })
    poolRows.push({ bvid: b, mid: `mr${i}`, author: `UP${i}` })
  }
  feedback.push({ bvid: 'BVbad', action: 'dislike', ts: NOW })
  poolRows.push({ bvid: 'BVbad', mid: 'mbad', author: '坏' })

  const out = buildUpList({ history, feedback, later: [], pool: poolRows, now: NOW })
  assert.equal(out.byTier.regular.length, 20)
  assert.deepEqual(
    out.byTier.regular.map((u) => u.mid),
    Array.from({ length: 20 }, (_, i) => `mr${i}`),
  )
  assert.equal(out.byTier.black.length, 1, '裁 regular 不连带裁 black')
  assert.equal(out.ups.length, 21)
})

test('observing 最多 30 个，按 lastAt 倒序保留', () => {
  const feedback = []
  const poolRows = []
  for (let i = 0; i < 35; i++) {
    const bvid = `BVobs${i}`
    const t = NOW - i * 1000            // i 越小越新
    feedback.push({ bvid, action: 'like', ts: t })
    poolRows.push({ bvid, mid: `mo${i}`, author: `UP${i}` })
  }
  const out = buildUpList({ history: [], feedback, later: [], pool: poolRows, now: NOW })
  assert.equal(out.byTier.observing.length, 30)
  assert.deepEqual(
    out.byTier.observing.map((u) => u.mid),
    Array.from({ length: 30 }, (_, i) => `mo${i}`),
  )
  assert.equal(out.ups.length, 30)
})

test('midOf 是 Map<bvid, mid>，可给 history 回填', () => {
  const out = buildUpList({
    history: [{ bvid: 'BV1', mid: '23947287', author: '小约翰可汗', watchedAt: NOW - DAY }],
    feedback: [],
    later: [],
    pool: makePool(['BV2', '23947287', '小约翰可汗'], ['BVpool', '999', '池子里的人']),
    now: NOW,
  })
  assert.ok(out.midOf instanceof Map)
  assert.equal(out.midOf.get('BV1'), '23947287')
  assert.equal(out.midOf.get('BV2'), '23947287')
  assert.equal(out.midOf.get('BVpool'), '999')
})

test('feedback 里的 open 也算点开，并与 history 按 bvid 合并去重', () => {
  const out = buildUpList({
    feedback: [{ bvid: 'BV1', action: 'open', ts: NOW - 2 * DAY }],
    history: [{ bvid: 'BV1', mid: 'm1', author: 'A', watchedAt: NOW - DAY }],
    later: [],
    pool: [],
    now: NOW,
  })
  assert.equal(out.ups.length, 1)
  assert.equal(out.ups[0].open, 1)
  assert.equal(out.ups[0].net, 1)
})

test('垃圾条目跳过，不影响正常条目', () => {
  const out = buildUpList({
    feedback: [
      null,
      { action: 'like', ts: NOW },                       // 没有 bvid
      { bvid: 'BV1', action: 'unknown', ts: NOW },       // 不认识的动作
      { bvid: 'BV2', action: 'like', ts: NOW - DAY },
    ],
    history: [
      undefined,
      { bvid: 'BV3', watchedAt: NaN },                   // 时间坏了
    ],
    later: [],
    pool: [null, { bvid: 'BV2', mid: 'm2', author: 'B' }],
    now: NOW,
  })
  assert.equal(out.ups.length, 1)
  assert.equal(out.ups[0].mid, 'm2')
})

test('不改调用方传进来的数组和对象', () => {
  const feedback = [{ bvid: 'BV1', action: 'like', ts: NOW - DAY }]
  const poolRows = makePool(['BV1', 'm1', 'A'])
  const snapshot = JSON.stringify({ feedback, pool: poolRows })
  buildUpList({ feedback, history: [], later: [], pool: poolRows, now: NOW })
  assert.equal(JSON.stringify({ feedback, pool: poolRows }), snapshot)
})
