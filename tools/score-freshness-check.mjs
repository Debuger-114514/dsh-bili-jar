/**
 * tools/score-freshness-check.mjs —— T2：两套时效权重的单测
 * 跑法：node --test tools/score-freshness-check.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { scoreItem, WEIGHTS } from '../lib/pool.mjs'
import { setUserTree } from '../lib/tree.mjs'

const sum = (w) => Object.values(w).reduce((a, b) => a + b, 0)

test('两套权重各自合计 1.00', () => {
  assert.ok(Math.abs(sum(WEIGHTS.news) - 1) < 1e-9, `news 合计 ${sum(WEIGHTS.news)}`)
  assert.ok(Math.abs(sum(WEIGHTS.evergreen) - 1) < 1e-9, `evergreen 合计 ${sum(WEIGHTS.evergreen)}`)
  assert.equal(WEIGHTS.news.fresh, 0.10)
  assert.equal(WEIGHTS.evergreen.fresh, 0.02, '兑现文档承诺的 0.02')
})

/** 造一条视频：贴轴（标题含轴词）、有播放、tag 在池子里很罕见 */
function video(ageDays, title) {
  return {
    bvid: `BV${ageDays}${title.slice(0, 4)}`,
    title,
    author: '某UP', mid: 42,
    duration: 1800,
    pubdate: ageDays == null ? 0 : Date.now() / 1000 - ageDays * 86400,
    play: 120000, like: 9000, coin: 3000, favorites: 5000, danmaku: 800,
    tags: ['冷门tag甲', '冷门tag乙', '冷门tag丙'],
    typeName: '', subtitle: false, isCharge: false,
  }
}

const CTX = { maxDays: 14, tagDf: new Map([['冷门tag甲', 1], ['冷门tag乙', 1], ['冷门tag丙', 1]]), tagTotal: 4 }

test('400 天前的视频：挂在 evergreen 轴比挂在 news 轴分高', () => {
  setUserTree({ 考古: { freshness: 'evergreen' } })
  const ev = video(400, '考古现场：三星堆新坑发掘实录')
  assert.equal(scoreItem(ev, ['考古'], null, CTX), true)
  setUserTree({})
  const nw = video(400, '时政观察：某国大选局势分析')
  assert.equal(scoreItem(nw, ['时政'], null, CTX), true)
  assert.ok(ev.score > nw.score, `evergreen ${ev.score} 应 > news ${nw.score}`)
})

test('evergreen 轴 100 天前的条目 freshN 仍然 > 0（365 天归一）', () => {
  setUserTree({ 考古: { freshness: 'evergreen' } })
  const a100 = video(100, '考古现场：海昏侯墓清理实录')
  const a400 = video(400, '考古现场：三星堆新坑发掘实录')
  scoreItem(a100, ['考古'], null, CTX)
  scoreItem(a400, ['考古'], null, CTX)
  assert.ok(a100.freshN > 0, `100 天 freshN=${a100.freshN} 应 > 0`)
  assert.ok(a400.freshN === 0, '400 天超出 365 天归一窗口，应为 0')
  assert.ok(a100.score > a400.score, '常青轴里 100 天的也应排在 400 天前面')
  setUserTree({})
})

test('news 轴 14 天窗口照旧：15 天前的归零，1 天前的接近满分', () => {
  const d15 = video(15, '时政观察：某国大选局势分析')
  const d1 = video(1, '时政快评：选举结果出炉')
  scoreItem(d15, ['时政'], null, CTX)
  scoreItem(d1, ['时政'], null, CTX)
  assert.equal(d15.freshN, 0)
  assert.ok(d1.freshN > 0.9, `1 天 freshN=${d1.freshN}`)
})
