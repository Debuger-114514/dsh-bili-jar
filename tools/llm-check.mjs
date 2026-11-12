/**
 * tools/llm-check.mjs —— LLM 调用层的单测（issue #4 的回归）
 * 跑法：node --test tools/llm-check.mjs
 *
 * 要盯住的行为：
 *   · 预算下限 1024，再小会被抬上来
 *   · 思考模型把 max_tokens 吃光（finish_reason=length、content 空）→ 抬预算重试
 *   · 短任务第一档就关思考（thinking:{type:'disabled'}）
 *   · 网关不认 thinking 字段 → 记住这家，同预算重发，后面不再发
 *   · 最后一档强制关思考：宁可少想，也要把结果交出来
 *   · 多次尝试的 token 用量要合并记账
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  chat, budgetLadder, normalizeBase, reasoningTokens, resetNoThinkMemo,
  MIN_BUDGET, BUDGET_CAP,
} from '../lib/llm.mjs'

/** 拦 fetch：handler(body, index) 返回 {status?, body}，记下每次请求体 */
function mockFetch(t, handler) {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body)
    calls.push(body)
    const r = handler(body, calls.length - 1) || {}
    const status = r.status || 200
    const payload = typeof r.body === 'string' ? r.body : JSON.stringify(r.body)
    return { ok: status < 400, status, text: async () => payload }
  })
  t.after(() => resetNoThinkMemo())
  return calls
}

const okBody = (content, usage = { prompt_tokens: 100, completion_tokens: 40 }, finish = 'stop') => ({
  body: { choices: [{ message: { content }, finish_reason: finish }], usage },
})

/** 思考模型：思维链吃光预算，正文是空的 */
const truncatedBody = () => ({
  body: {
    choices: [{ message: { content: '', reasoning_content: '想了很久…' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 900, completion_tokens: 893, completion_tokens_details: { reasoning_tokens: 684 } },
  },
})

test('预算下限与上限', () => {
  assert.equal(MIN_BUDGET, 1024)
  assert.equal(BUDGET_CAP, 8192)
  assert.deepEqual(budgetLadder(220), [
    { budget: 1024, noThink: true },
    { budget: 2048, noThink: true },
    { budget: 8192, noThink: true },
  ])
})

test('阶梯：翻倍到上限，最后一档一定关思考', () => {
  const rungs = budgetLadder(4000, false)
  assert.deepEqual(rungs.map((r) => r.budget), [4000, 8000, 8192])
  assert.deepEqual(rungs.map((r) => r.noThink), [false, false, true])
  // 已经到上限就没有阶梯了（也不会强改调用方「要思考」的意愿）
  assert.deepEqual(budgetLadder(99999), [{ budget: 8192, noThink: true }])
  assert.deepEqual(budgetLadder(99999, false), [{ budget: 8192, noThink: false }])
  // 1000 会被抬到 1024，然后 2048 → 8192
  assert.deepEqual(budgetLadder(1000).map((r) => r.budget), [1024, 2048, 8192])
})

test('normalizeBase 补 /v1，空值走官方', () => {
  assert.equal(normalizeBase(''), 'https://api.deepseek.com')
  assert.equal(normalizeBase('https://api.deepseek.com/'), 'https://api.deepseek.com/v1')
  assert.equal(normalizeBase('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1')
  assert.equal(normalizeBase('https://x.invalid/v1/'), 'https://x.invalid/v1')
})

test('reasoningTokens 认两种写法', () => {
  assert.equal(reasoningTokens({ completion_tokens_details: { reasoning_tokens: 684 } }), 684)
  assert.equal(reasoningTokens({ reasoning_tokens: 5 }), 5)
  assert.equal(reasoningTokens(null), 0)
})

test('思考吃光预算 → 抬预算重试，拿到正文', async (t) => {
  const calls = mockFetch(t, (_b, i) => (i === 0 ? truncatedBody() : okBody('[{"bvid":"BV1"}]')))
  const r = await chat({ key: 'k', base: 'https://api.deepseek.com', user: '挑几条' })
  assert.equal(r.ok, true)
  assert.equal(r.text, '[{"bvid":"BV1"}]')
  assert.equal(calls.length, 2, '第一次超限，第二次成功')
  assert.deepEqual(calls.map((c) => c.max_tokens), [1024, 2048])
  // 短任务第一档就关思考
  assert.deepEqual(calls[0].thinking, { type: 'disabled' })
  assert.equal(r.truncated, true)
  // 两次的用量合并：893 + 40
  assert.equal(r.usage.completion_tokens, 933)
  assert.equal(r.usage.reasoning_tokens, 684)
})

test('预算小到离谱也会被抬到下限', async (t) => {
  const calls = mockFetch(t, () => okBody('一句话推荐'))
  const r = await chat({ key: 'k', user: '写一句话', maxTokens: 220 })
  assert.equal(r.ok, true)
  assert.equal(calls[0].max_tokens, 1024)
})

test('一直超限：阶梯走完，最后一档强制关思考，然后放弃', async (t) => {
  const calls = mockFetch(t, () => truncatedBody())
  const r = await chat({ key: 'k', user: '挑几条', maxTokens: 4000, noThink: false })
  assert.equal(r.ok, false)
  assert.equal(calls.length, 3)
  assert.deepEqual(calls.map((c) => c.max_tokens), [4000, 8000, 8192])
  assert.equal(calls[0].thinking, undefined, '第一档按调用方要求保留思考（不传字段 = 默认开着）')
  assert.deepEqual(calls[2].thinking, { type: 'disabled' }, '最后一档必须关思考')
  assert.match(r.error, /预算试到 8192/)
  assert.match(r.error, /思考 684/)
})

test('网关不认 thinking：同预算重发，之后记住不再发', async (t) => {
  let n = 0
  const calls = mockFetch(t, () => {
    n++
    if (n === 1) {
      return { status: 400, body: { error: { message: 'Unrecognized request argument supplied: thinking' } } }
    }
    return okBody('好了')
  })
  const api = { key: 'k', base: 'https://gateway.invalid', model: 'some-model' }
  const r = await chat({ ...api, user: 'x' })
  assert.equal(r.ok, true)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].thinking, { type: 'disabled' })
  assert.equal(calls[1].thinking, undefined, '去掉字段重发')
  assert.deepEqual(calls.map((c) => c.max_tokens), [1024, 1024], '不浪费预算阶梯')

  // 同一家第二次调用：压根不发 thinking
  const again = await chat({ ...api, user: 'y' })
  assert.equal(again.ok, true)
  assert.equal(calls.length, 3)
  assert.equal(calls[2].thinking, undefined)
})

test('空正文但不是超限：不重试，错误里写清 finish_reason', async (t) => {
  const calls = mockFetch(t, () => okBody('', { prompt_tokens: 10, completion_tokens: 0 }))
  const r = await chat({ key: 'k', user: 'x' })
  assert.equal(r.ok, false)
  assert.equal(calls.length, 1)
  assert.match(r.error, /空响应/)
  assert.match(r.error, /finish_reason=stop/)
})

test('鉴权失败直接失败，不做重试', async (t) => {
  const calls = mockFetch(t, () => ({ status: 401, body: { error: { message: 'Authentication Fails' } } }))
  const r = await chat({ key: 'bad', user: 'x' })
  assert.equal(r.ok, false)
  assert.equal(calls.length, 1)
  assert.match(r.error, /HTTP 401/)
})

test('没有 API key 不发请求', async (t) => {
  const calls = mockFetch(t, () => okBody('不该发生'))
  const r = await chat({ key: '', user: 'x' })
  assert.equal(r.ok, false)
  assert.match(r.error, /没有 API key/)
  assert.equal(calls.length, 0)
})
