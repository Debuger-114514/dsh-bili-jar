/**
 * tools/sub-check.mjs —— 字幕串台自检的单测（0.4.1）
 * 跑法：node --test tools/sub-check.mjs
 *
 * 背景：B站的 AI 字幕接口偶尔会给回**别的视频**的稿子（2026-11-08 实测两条）。
 * 正文本身看不出来，但时间轴藏不住：16 分钟的视频，字幕不可能跑到 40 分钟。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { subtitleFitsVideo } from '../lib/bili.mjs'

const body = (lastTo, n = 3) => Array.from({ length: n }, (_, i) => ({
  from: (lastTo / n) * i, to: (lastTo / n) * (i + 1), content: '字',
}))

test('时间轴在视频长度内 → 通过', () => {
  const r = subtitleFitsVideo(body(980), 1003)
  assert.equal(r.ok, true)
  assert.equal(Math.round(r.maxTo), 980)
})

test('字幕比视频长很多 → 判定串台', () => {
  const r = subtitleFitsVideo(body(2400), 1003)
  assert.equal(r.ok, false)
  assert.match(r.why, /串台/)
})

test('片尾余量 120 秒：刚好超一点算正常，超太多才拒', () => {
  assert.equal(subtitleFitsVideo(body(1100), 1003).ok, true, '1003+120=1123 之内')
  assert.equal(subtitleFitsVideo(body(1200), 1003).ok, false, '超出余量')
})

test('时长未知（0）时不做判断，别误杀', () => {
  assert.equal(subtitleFitsVideo(body(5000), 0).ok, true)
})

test('残稿：只给前 34 秒 / 前 836 秒 → 判不完整', () => {
  assert.equal(subtitleFitsVideo(body(34), 1087).ok, false, '34s / 1087s')
  assert.equal(subtitleFitsVideo(body(836), 3435).ok, false, '836s / 3435s')
  assert.match(subtitleFitsVideo(body(34), 1087).why, /残稿/)
})

test('短视频不按比例卡（避免误杀片头短字幕）', () => {
  assert.equal(subtitleFitsVideo(body(40), 100).ok, true, '100 秒的视频，字幕到 40 秒也放行')
})

test('长视频里覆盖 60% 以上算完整', () => {
  assert.equal(subtitleFitsVideo(body(2100), 3435).ok, true, '2100/3435 = 61%')
  assert.equal(subtitleFitsVideo(body(1900), 3435).ok, false, '1900/3435 = 55%')
})

test('空字幕 / 没有 to 字段 → 不通过', () => {
  assert.equal(subtitleFitsVideo([], 100).ok, false)
  assert.equal(subtitleFitsVideo([{ content: '没有时间戳' }], 100).ok, false)
  assert.equal(subtitleFitsVideo(null, 100).ok, false)
})

test('时间戳是字符串也能用；负数/NaN 被忽略', () => {
  const r = subtitleFitsVideo([{ to: '900' }, { to: 'abc' }, { to: -5 }], 1000)
  assert.equal(r.ok, true)
  assert.equal(r.maxTo, 900)
})

test('真实形状：996 秒的视频拿到的正确字幕（约 3.4 万字/时）', () => {
  // 「中期选举」那条：时长 1003s，正确字幕 4559 字，最后一条 to≈1000
  const real = Array.from({ length: 400 }, (_, i) => ({ from: i * 2.5, to: (i + 1) * 2.5, content: '十个字的内容' }))
  assert.equal(subtitleFitsVideo(real, 1003).ok, true, '1000s 的字幕配 1003s 的视频')
  assert.equal(subtitleFitsVideo(real, 600).ok, false, '同一条拿到 600s 的短视频上 → 判串台')
})
