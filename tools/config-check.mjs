import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { apply } from '../index.js'

function mount(dir, value = {}) {
  let handler
  apply({
    get: (name) => name === 'dshHomePath' ? () => dir : undefined,
    settings: { describe: () => [{ value: { ups: [], ...value } }] },
    effect: (fn) => fn(),
    webServer: { register: (route) => { handler = route.handler } },
  }, {})
  assert.equal(typeof handler, 'function', '插件应注册 HTTP 路由')
  return async (method, path, body) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    Object.assign(req, { method, url: `/api/bili-jar${path}`, headers: {} })
    let status, response
    await handler(req, {
      writeHead: (code) => { status = code },
      end: (text) => { response = JSON.parse(text) },
    })
    assert.equal(status, 200, JSON.stringify(response))
    return response
  }
}

test('删除最后一根兴趣轴后，保存、重新读取和重启均保留空列表', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-jar-config-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const request = mount(dir)
  const defaults = ['deepseek', '时政', '科技测评', '健身教程']
  assert.deepEqual((await request('GET', '/state')).config.axes, defaults)

  assert.deepEqual((await request('POST', '/config', { axes: ['编程'] })).config.axes, ['编程'])
  assert.deepEqual((await request('POST', '/config', { axes: [] })).config.axes, [])
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).axes, [])
  assert.deepEqual((await request('GET', '/state')).config.axes, [])

  const restarted = mount(dir, { axes: defaults })
  assert.deepEqual((await restarted('GET', '/state')).config.axes, [])
  assert.deepEqual((await restarted('POST', '/config', { axes: ['历史'] })).config.axes, ['历史'])
})

test('宿主设置中的空数组（包括 value 包装值）不会恢复默认兴趣轴', async (t) => {
  for (const axes of [[], { value: [] }]) {
    const dir = mkdtempSync(join(tmpdir(), 'bili-jar-config-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const request = mount(dir, { axes })
    assert.deepEqual((await request('GET', '/state')).config.axes, [])
  }
})

test('API 密钥保存后仅返回首尾五位，读取和调试接口保持一致', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-jar-config-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const request = mount(dir)
  const key = 'proxy-abcdefghijklmnopqrstuvwxyz'
  const masked = 'proxy••••vwxyz'
  assert.equal((await request('GET', '/state')).apiKeyMasked, '')
  const saved = await request('POST', '/config', { apiKey: key })
  assert.equal(saved.apiKeyMasked, masked)
  assert.equal(saved.config.apiKey, '')
  assert.equal(saved.overrides.apiKey, '')
  assert.equal(JSON.stringify(saved).includes(key), false)
  assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).apiKey, key)
  assert.equal((await request('GET', '/state')).apiKeyMasked, masked)
  const debug = await request('GET', '/debug')
  assert.equal(debug.cfg.apiKey, masked)
  assert.equal(debug.overrides.apiKey, masked)
  const unchanged = await request('POST', '/config', { axes: [] })
  assert.equal(unchanged.apiKeyMasked, masked)
  assert.equal(JSON.stringify(unchanged).includes(key), false)
  const restarted = mount(dir)
  assert.equal((await restarted('GET', '/state')).apiKeyMasked, masked)
})

test('短密钥全部遮挡，清除密钥后不再显示掩码', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-jar-config-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const request = mount(dir)
  for (const key of ['a', 'abcde', '1234567890']) {
    const saved = await request('POST', '/config', { apiKey: key })
    assert.equal(saved.apiKeyMasked, '••••••••••')
    assert.equal(saved.apiKeySet, true)
  }
  const cleared = await request('POST', '/config', { apiKey: '' })
  assert.equal(cleared.apiKeyMasked, '')
  assert.equal(cleared.apiKeySet, false)
})

test('观看后移出原列表、递减计数，历史去重且仅保留最近十条，重启后仍生效', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-jar-history-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const videos = Array.from({ length: 13 }, (_, i) => ({
    bvid: `BV${String(i).padStart(10, '0')}`, title: `视频 ${i}`,
    url: `https://www.bilibili.com/video/BV${String(i).padStart(10, '0')}`,
  }))
  writeFileSync(join(dir, 'feed.json'), JSON.stringify({
    ok: true, ts: Date.now(), main: videos.slice(0, 12), up: [videos[0]],
    shortlist: videos, pool: [],
  }))
  writeFileSync(join(dir, 'later.json'), JSON.stringify([videos[0]]))
  writeFileSync(join(dir, 'reasons.json'), JSON.stringify({ [videos[12].bvid]: { text: '未观看候选' } }))
  const request = mount(dir)
  assert.deepEqual((await request('GET', '/history')).items, [])
  for (let i = 0; i < 12; i++) {
    const result = await request('POST', '/history', { bvid: videos[i].bvid })
    assert.equal(result.unreadCount, 11 - i)
    assert.equal(result.main.length, 11 - i)
    assert.equal(result.up.length, 0)
    assert.equal(result.later.length, 0)
    assert.equal(result.items[0].bvid, videos[i].bvid)
    assert.equal(result.items[0].title, videos[i].title)
    assert.ok(result.items[0].watchedAt > 0)
    assert.equal(result.items.length, Math.min(i + 1, 10))
  }
  const history = (await request('GET', '/history')).items
  assert.deepEqual(history.map((it) => it.bvid), videos.slice(2, 12).reverse().map((it) => it.bvid))
  assert.equal(JSON.parse(readFileSync(join(dir, 'history.json'), 'utf8')).length, 10)
  assert.equal((await request('GET', '/feed')).main.length, 0)
  const repeated = await request('POST', '/history', { bvid: videos[5].bvid })
  assert.equal(repeated.items.length, 10)
  assert.equal(repeated.items[0].bvid, videos[5].bvid)
  assert.equal(new Set(repeated.items.map((it) => it.bvid)).size, 10)
  assert.equal(repeated.unreadCount, 0)

  const restarted = mount(dir)
  assert.equal((await restarted('GET', '/history')).items[0].bvid, videos[5].bvid)
  assert.equal((await restarted('GET', '/feed')).main.length, 0)
  const more = await restarted('POST', '/more', { n: 3 })
  assert.equal(more.ok, true, '推荐全部看完后仍可继续从池中补充')
  assert.deepEqual(more.main.map((it) => it.bvid), [videos[12].bvid])
})

test('没有本地子簇候选时不请求模型，有候选时每次筛选各请求一次', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-jar-suggest-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++
    assert.equal(JSON.parse(options.body).max_tokens, 700)
    return { ok: true, text: async () => JSON.stringify({
      choices: [{ message: { content: '[{"i":1,"keep":false,"why":"不合适"}]' } }],
      usage: { prompt_tokens: 120, completion_tokens: 30 },
    }) }
  })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ apiKey: 'test-only', apiBase: 'https://model.invalid' }))
  writeFileSync(join(dir, 'pool.json'), JSON.stringify([{ title: '测试方向', tags: [] }]))
  const empty = await mount(dir)('GET', '/tree/suggest?axis=测试方向&review=1')
  assert.equal(empty.clusters.length, 0)
  assert.equal(calls, 0)
  const pool = Array.from({ length: 8 }, (_, i) => ({
    title: '测试方向', tags: i < 3 ? ['独特子类甲', '独特子类乙'] : [`样本${i}`],
  }))
  writeFileSync(join(dir, 'pool.json'), JSON.stringify(pool))
  const request = mount(dir)
  const reviewed = await request('GET', '/tree/suggest?axis=测试方向&review=1')
  assert.ok(reviewed.clusters.length > 0)
  assert.equal(calls, 1)
  assert.equal(reviewed.reviewNote, '模型一条都没留')
  await request('GET', '/tree/suggest?axis=测试方向&review=1')
  assert.equal(calls, 2, '重复点击没有候选审核缓存')
})


test('内置预设游戏轴应标记为内置，手动创建的轴仍标记为自建', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-jar-builtin-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const request = mount(dir, { axes: ['游戏', '我的自定义方向'] })
  const tree = await request('GET', '/tree')
  assert.ok(tree.presets.includes('游戏'))
  assert.equal(tree.nodes['游戏'].builtin, true)
  assert.equal(tree.nodes['deepseek'].builtin, true)
  assert.equal(tree.nodes['我的自定义方向'].builtin, false)
})
