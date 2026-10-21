import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

// 运行真实客户端脚本，以最小 DOM 替身验证点击与异步请求，不调用模型。
class Element {
  constructor(tag) {
    this.tag = tag
    this.children = []
    this.listeners = {}
    this.style = {}
    this.dataset = {}
    this.classList = { add() {}, remove() {}, toggle() {} }
    this.ownText = ''
  }
  set textContent(value) { this.ownText = String(value); this.children = [] }
  get textContent() { return this.ownText + this.children.map((it) => it.textContent).join('') }
  appendChild(child) { this.children.push(child); child.parent = this; return child }
  append(...children) { for (const child of children) this.appendChild(child) }
  setAttribute() {}
  attachShadow() { this.shadowRoot = new Element('shadow'); return this.shadowRoot }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn) }
  removeEventListener() {}
  async click() {
    if (this.disabled) return
    if (this.onclick) await this.onclick({ target: this })
    for (const fn of this.listeners.click || []) await fn({ target: this })
  }
}
const settle = () => new Promise((resolve) => setImmediate(resolve))
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function mount(overrides = {}) {
  const body = new Element('body')
  const document = { body, createElement: (tag) => new Element(tag), addEventListener() {}, removeEventListener() {} }
  const state = {
    suggestion: async () => ({ ok: true, reviewed: true, clusters: [{ name: '电脑', df: 3, terms: ['电脑'] }], dropped: [{ seed: '泛词', why: '太泛' }] }),
    tree: async () => ({ ok: true, nodes: { 科技: { subs: [] }, 游戏: { subs: [] } } }),
    edit: async () => ({ ok: true }),
  }
  Object.assign(state, overrides)
  let plugin
  const context = {
    document, console, setTimeout, clearTimeout,
    localStorage: { getItem: () => null, setItem() {} },
    window: { innerWidth: 1200, innerHeight: 900, addEventListener() {}, removeEventListener() {},
      __ModuleLoader__: { load: ({ factory }) => { plugin = factory() } } },
    fetch: async (url, options = {}) => {
      let data
      if (url.endsWith('/state')) data = { config: { axes: ['科技', '游戏'] } }
      else if (url.includes('/tree/suggest?')) data = await state.suggestion(url)
      else if (url.endsWith('/tree')) data = options.method === 'POST'
        ? await state.edit(JSON.parse(options.body)) : await state.tree()
      else data = { ok: true }
      return { ok: true, json: async () => data }
    },
  }
  vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), context)
  plugin.apply()
  function all(node = body) {
    return [node, ...node.children.flatMap(all), ...(node.shadowRoot ? all(node.shadowRoot) : [])]
  }
  const buttons = (text) => all().filter((it) => it.tag === 'button' && it.textContent === text)
  await buttons('设置')[0].click()
  await settle()
  await buttons('轴的细分（子簇）')[0].click()
  await settle()
  return { state, all, buttons }
}

test('重复看建议替换结果和否决说明，空结果及请求失败清除旧建议', async () => {
  const ui = await mount()
  const button = ui.buttons('看建议')[0]
  for (let i = 0; i < 4; i++) {
    await button.click()
    assert.equal(ui.buttons('＋ 电脑（3 条）').length, 1)
    assert.equal(ui.all().filter((it) => it.className === 'tip' && it.textContent === '模型否掉的：泛词（太泛）').length, 1)
  }
  await ui.buttons('看建议')[1].click()
  assert.equal(ui.buttons('＋ 电脑（3 条）').length, 2, '各兴趣轴拥有独立结果')
  ui.state.suggestion = async () => ({ ok: true, clusters: [], dropped: [] })
  await button.click()
  assert.equal(ui.buttons('＋ 电脑（3 条）').length, 1, '空结果只清除当前轴')
  ui.state.suggestion = async () => { throw new Error('network') }
  await ui.buttons('看建议')[1].click()
  assert.equal(ui.buttons('＋ 电脑（3 条）').length, 0)
  assert.equal(ui.buttons('看建议').length, 2, '失败后可以重试')
})

test('请求进行中重复点击不会发出第二次模型请求', async () => {
  const ui = await mount()
  const pending = deferred()
  let requests = 0
  ui.state.suggestion = () => { requests++; return pending.promise }
  const button = ui.buttons('看建议')[0]
  const running = button.click()
  assert.equal(button.textContent, '挖…')
  assert.equal(button.disabled, true)
  await button.click()
  assert.equal(requests, 1)
  pending.resolve({ ok: true, clusters: [] })
  await running
  assert.equal(button.disabled, false)
})

test('同一轮建议可连续添加多个子簇，已添加项禁用且其余建议保留', async () => {
  const ui = await mount()
  ui.state.suggestion = async () => ({ ok: true, clusters: [
    { name: '电脑', df: 3, terms: ['电脑'] },
    { name: '游戏手机', df: 4, terms: ['手机'] },
  ] })
  const edits = []
  ui.state.edit = async (body) => { edits.push(body); return { ok: true } }
  await ui.buttons('看建议')[0].click()
  await ui.buttons('＋ 电脑（3 条）')[0].click()
  assert.equal(ui.buttons('＋ 游戏手机（4 条）').length, 1)
  const added = ui.buttons('已添加 · 电脑')[0]
  assert.equal(added.disabled, true)
  await added.click()
  assert.equal(edits.length, 1)
  await ui.buttons('＋ 游戏手机（4 条）')[0].click()
  assert.equal(ui.buttons('已添加 · 电脑').length, 1)
  assert.equal(ui.buttons('已添加 · 游戏手机').length, 1)
  assert.deepEqual(edits.map((it) => it.name), ['电脑', '游戏手机'])
  const chips = ui.all().filter((it) => it.className === 'chip2')
  assert.ok(chips.some((it) => it.textContent === '电脑×'))
  assert.ok(chips.some((it) => it.textContent === '游戏手机×'))
})

test('添加失败后可重试，其他建议不消失', async () => {
  const ui = await mount()
  await ui.buttons('看建议')[0].click()
  ui.state.edit = async () => ({ ok: false, error: '保存失败' })
  const button = ui.buttons('＋ 电脑（3 条）')[0]
  await button.click()
  assert.equal(button.disabled, false)
  assert.equal(ui.buttons('＋ 电脑（3 条）').length, 1)
  ui.state.edit = async () => ({ ok: true })
  await button.click()
  assert.equal(ui.buttons('已添加 · 电脑').length, 1)
})

test('树重绘后丢弃旧建议响应，乱序树响应不能覆盖新树', async () => {
  const ui = await mount()
  const pendingSuggestion = deferred()
  ui.state.suggestion = () => pendingSuggestion.promise
  const running = ui.buttons('看建议')[0].click()
  const head = ui.buttons('轴的细分（子簇）')[0]
  await head.click()
  await head.click()
  await settle()
  pendingSuggestion.resolve({ ok: true, clusters: [{ name: '过期建议', df: 1 }] })
  await running
  assert.equal(ui.buttons('＋ 过期建议（1 条）').length, 0)

  const first = deferred(), second = deferred()
  let requests = 0
  ui.state.tree = () => (++requests === 1 ? first.promise : second.promise)
  await head.click()
  await head.click()
  await head.click()
  await head.click()
  second.resolve({ ok: true, presets: ['最新分区'], nodes: {} })
  await settle()
  first.resolve({ ok: true, presets: ['过期分区'], nodes: {} })
  await settle()
  assert.equal(ui.buttons('＋ 最新分区').length, 1)
  assert.equal(ui.buttons('＋ 过期分区').length, 0)
})

test('内置分区独立折叠，紧邻兴趣轴编辑器，不在子簇栏内', async () => {
  const ui = await mount({ tree: async () => ({ ok: true, presets: ['音乐'], nodes: {} }) })
  const head = ui.buttons('内置分区')[0]
  const wrap = head.parent
  const siblings = wrap.parent.children
  const index = siblings.indexOf(wrap)
  assert.ok(siblings[index - 1].textContent.startsWith('兴趣轴（回车加，× 删）'))
  assert.equal(wrap.children[1].hidden, true)
  await head.click()
  assert.equal(wrap.children[1].hidden, false)
  assert.equal(ui.buttons('＋ 音乐')[0].parent.parent.parent, wrap)
  const treeWrap = ui.buttons('轴的细分（子簇）')[0].parent
  assert.notEqual(wrap, treeWrap)
})

test('各轴反馈位于本轴内，另一轴的请求不会覆盖已有反馈', async () => {
  const ui = await mount({ suggestion: async () => ({ ok: true, clusters: [] }) })
  const buttons = ui.buttons('看建议')
  await buttons[0].click()
  const first = buttons[0].parent
  assert.ok(first.textContent.includes('科技：没有够格的建议'))
  assert.ok(!buttons[1].parent.textContent.includes('科技：没有够格的建议'))
  ui.state.suggestion = async () => ({ ok: false, error: '游戏轴失败' })
  await buttons[1].click()
  assert.ok(buttons[1].parent.textContent.includes('游戏轴失败'))
  assert.ok(first.textContent.includes('科技：没有够格的建议'))
})

test('删除刚添加的子簇后恢复原建议，无需再次筛选即可添加', async () => {
  let requests = 0
  const ui = await mount({ suggestion: async () => {
    requests++
    return { ok: true, clusters: [{ name: '电脑', df: 3, terms: ['电脑'] }] }
  } })
  await ui.buttons('看建议')[0].click()
  const option = ui.buttons('＋ 电脑（3 条）')[0]
  await option.click()
  const chip = ui.all().find((it) => it.className === 'chip2' && it.textContent === '电脑×')
  await chip.children[0].click()
  assert.equal(option.disabled, false)
  assert.equal(option.textContent, '＋ 电脑（3 条）')
  await option.click()
  assert.equal(option.disabled, true)
  assert.equal(ui.buttons('已添加 · 电脑').length, 1)
  assert.equal(requests, 1)
})
