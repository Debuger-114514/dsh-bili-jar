# 最小可用 DSH Web 插件骨架 · 规格书

> 证据源：**A** = `C:\Users\21415\.dsh\profiles\desktop\node_modules\dsh-whale-widget\`（v0.4.2，无设置页）· **B** = `D:\电子榨菜罐\.ref\dsh-bili-scroll\`（v0.1.18，有设置页+工具）· **C** = `C:\Users\21415\.dsh\profiles\desktop\node_modules\dsh-our-free-model\`（v2.1.0，ModuleLoader 客户端）· **P** = profile 自己的 `package.json` / `cordis.patch.yml` / `cordis.yml`。
> 标记：**[证据]** 有行号 · **[推断]** 由证据推出但无宿主源码 · **[未找到证据]** 不编。宿主打包在 `D:\HARNESS\resources\app.asar`（不可读），凡涉宿主内部实现一律标推断。

## 0. 一句话结论

**能跑的最小插件 = 4 个文件**：`package.json` 里一个 `dsh.bundle.patch`、`cordis.patch.yml` 里一条 `insert`、`index.js` 默认/命名导出 `apply(ctx)`、客户端脚本由插件**自己的 HTTP 路由**下发并靠 `webServer.tapIndex`（Web）+ `webserver/index-inject`（桌面）插进页面。设置页是**可选的第二条路线**（`dsh.client` + `window.__ModuleLoader__` + `slots.inject('settings.section')`）。

## 1. package.json：必需字段与两个 dsh 子字段

| 字段 | 是否必需 | 作用 | 证据 |
|---|---|---|---|
| `name` | 必需 | 包名；`cordis.patch.yml` 的 `name` 要写它；ModuleLoader 的 `id` 也要写它 | `B/package.json:2`、`B/cordis.patch.yml:17`、`B/client.js:6-7,29` |
| `type: "module"` | 必需 | 插件以 ESM 加载，`import.meta.url` 算包根 | `A/package.json:12`、`A/lib/index.js:20`、`B/package.json:17` |
| `main` | 必需 | host 半端入口 | `A/package.json:13`（`"lib/index.js"`）、`B/package.json:18`（`"index.js"`） |
| `exports["."]` | 建议 | 显式入口；子路径 `./client` 供客户端半端 | `B/package.json:19-23`、`C/package.json:9-13` |
| `dsh.bundle.patch` | 必需 | 指向插件**自带的 mount 声明**；profile 只要列出包名即生效 | `A/package.json:31-35`、`B/package.json:57-60` |
| `dsh.client` | 可选 | 有浏览器半端（ModuleLoader）时才需要；A 完全没有这个字段 | `B/package.json:61-66`、`A/package.json:1-37` |

**Q1 结论**

1. **`main` 指向 host 半端入口**：`A` 用 `lib/index.js`（`A/package.json:13`），`B` 用根 `index.js`（`B/package.json:18`）。没有强制目录约定，`lib/` 只是习惯。
2. **`dsh.bundle.patch`** = "本包自带的挂载声明文件"。注释原文：*"这就是'标准 DSH 插件'的样子：包自己声明要往 profile 的配置树里插什么。装上之后，profile 只要在 `dsh.profile.bundles` 里列出本包名即生效，不用再手改 profile 自己的 cordis.patch.yml"*（`B/cordis.patch.yml:4-9`）。组装顺序：*"每个 bundle 的 patch 按 `dsh.profile.bundles` 顺序叠 → 再叠 profile 自己那一层的 cordis.patch.yml（**只有那层是热重载**）"*（`B/cordis.patch.yml:11-12`）。profile 侧的清单在 `P/package.json:8-25`（`dsh.profile.bundles` 数组，含 `dsh-whale-widget`、`dsh-our-free-model`）。
3. **`dsh.client.platform` / `dsh.client.inject`**：
   - `platform: "web"` 出现在两个有客户端半端的插件里（`B/package.json:62`、`C/package.json:61`），A 无此字段。
   - `inject` 是**包名数组**：`B` 列 `@deepseek-ai/dsh-client-runtime`、`dsh-client-ui-settings`、`dsh-client-ui-settings-plugins`（`B/package.json:63-66`）；`C` 是空数组并额外带 `immediately: true`（`C/package.json:60-63`）。
   - **[推断]** `inject` 声明"客户端半端启动前必须先就位的客户端包"，与 ModuleLoader factory 返回的 `inject: ['slots','locale']`（`C/client.js:35`、`B/client.js:579`）**不是一回事**（后者是服务名）。依据：`C` 的 dsh.client.inject 为空而 factory inject 非空，二者语义必然不同。
   - **绑定关系**：客户端半端绑在 `name` 为**裸包名**的那一行上 —— *"一行 insert 即挂载 Host 半身；浏览器半身由 package.json 的 dsh.client 声明，并绑定在 name 为裸包名的这一行上（子路径行不会携带半身）"*（`C/cordis.patch.yml:3-4`）。

**A vs B 差异对比**

| 项 | A (whale) | B (bili-scroll) |
|---|---|---|
| main | `lib/index.js` | `index.js` |
| exports | 无 | `.` / `./client` / `./package.json`（`19-23`） |
| dsh.client | 无 | `platform:web` + 3 个 inject（`61-66`） |
| peerDeps | 无 | `dsh-tools`、`schemastery` 都 optional（`42-56`） |
| 依赖/engines | 无 | `schemastery` 正式依赖（`46-48`）；engines `dsh>=0.1.7-rc.1`、`node>=22`（`38-41`） |
| patch | `id: dsh-whale-widget` / `name: dsh-whale-widget`（`13-16`） | `id: bili-scroll` / `name: dsh-bili-scroll` / `config`（`15-20`） |

## 2. cordis.patch.yml：确切语法

```yaml
- insert:
    - id: dsh-whale-widget      # 条目 id（loader entry id）
      name: dsh-whale-widget    # 模块说明符 = 包名
```
（`A/cordis.patch.yml:13-16`，全文仅此一个数组元素）

- 文件是**顶层 YAML 数组**，元素是 patch 条目；`insert` 下是"要加进配置树的条目列表"。profile 层 patch 的注释把它说全了：*"a top-level YAML array of loader patch entries (id-targeted config overrides, disables, and insert lists; `!!js` expressions allowed)"*（`P/cordis.patch.yml:1-3`），同文件还能看到 `disabled: true`（`P/cordis.patch.yml:29-30`）与 `!!js '!ctx.get(''profileContext'')'` 这类表达式（`P/cordis.yml:6,11`）。
- **`id`**：条目 id，同时是**设置命名空间**。B 的注释把这条钉死：*"**loader entry 的 id 必须等于命名空间名**（我们 patch 里就是 `bili-scroll`）+ 本模块导出 Config"*（`B/index.js:43`）；`ctx.settings.describe()` 返回行的 `ns` *"**等于 loader 条目的 id**"*（`B/index.js:265`）。
- **`name`**：模块说明符，**不是**插件导出的 `name`。它等于包名（`A` 与包名相同；`B` 是 `dsh-bili-scroll`，包名也是它，`B/package.json:2` vs `B/cordis.patch.yml:17`）。对照 profile 里系统插件同样写包名（`P/cordis.yml:5,8,10` 等）。
- **"插件被加载时 name 是否等于包名？"** → **patch 里的 `name` 是包名；插件模块自己导出的 `name` 不是包名，也不要求相等**。反例就在 A：`export default { name: 'whale-balance-widget' }`（`A/lib/index.js:724`）而包名是 `dsh-whale-widget`（`A/package.json:2`）。这也解释了 A 为什么没有设置页（命名空间对不上，见 §6）。
- `insert` 条目可带 `config:` 放默认值（`B/cordis.patch.yml:18-20`；`C/cordis.patch.yml:8`）。

## 3. 服务端插件：导出形状

**两种都合法（各有一个真实插件）**：

| 形状 | 证据 |
|---|---|
| `export default { name, apply(ctx) }` | `A/lib/index.js:723-731` |
| `export const name` / `export const inject` / `export function apply(ctx, config)` / `export const Config` | `B/index.js:36-37,104,47` |

- **A 的形状**：`export default {` (723) → `name: 'whale-balance-widget',` (724) → `apply(root) {` (731)。A **没有** `export const inject`，是**故意**的：*"v758：**有意去掉对象级 `inject: [...]`**（issue #154 的隐患面）。对象级 inject 会把整个 apply() 推迟到三个服务就绪之后；而桌面端的注入表是**宿主启动时一次性收集**的 ⇒ 订阅一旦晚于那次收集，这一行就永远进不了表"*（`A/lib/index.js:725-730`）。
- **A 的代替写法**：`apply()` 先注册注入行，再 `root.inject([...], cb)` 局部等待：
  - `root.effect(() => () => {...})`（733）
  - `rowDisposers.push(root.on('webserver/index-inject', (table) => {...}))`（735-746）
  - `root.inject(['webServer', 'credentials', 'connection'], (ctx) => {`（749）→ 收尾注释 `}) // ← 结束 root.inject([...])`（4924）
- **`ctx.get` 用法**：读**可选服务**一律 `ctx.get`，绝不写进 inject —— `ctx.get('connection') || ctx.connection`（805）；`ctx.get('sessionTitle')`（1007）；`ctx.get('deepseekAccount')`（1189），其上方注释：*"必须用 `ctx.get('deepseekAccount')` 读**可选服务**，**绝不能写进 inject** —— 老宿主根本没有这个服务，一旦进 inject，整个插件会**永远等不到服务而完全不 apply**"*（`A/lib/index.js:1181-1182`）。
- **`ctx.on` 事件订阅**（返回 disposer，推进 `disposers`）：`ctx.on('subagent/start')`、`('subagent/end')`（`A:1124-1125`）、`ctx.on('session/event')`（1128）、`ctx.on('session/disposed')`（1134）。
- **`apply` 的第二个参数**就是 `fiber.config`：*"`apply(ctx, config)` 收到的 config 就是 fiber.config 本体，volatile 字段一改宿主**就地**改它 ⇒ 启动时快照的 cfg 永远看不到设置页的改动，用之前得 refreshCfg()"*（`B/index.js:267-269`）。

## 4. HTTP 路由：用哪个服务、怎么注册

**服务**：`ctx.webServer`（注入名 `'webServer'`）。**没有任何 `ctx.router` / `ctx.server` 之类的用法出现在 A/B 里**（A 全文 22 条路由全部走 `ctx.webServer.register`）。

注册入口（`A/lib/index.js:876-885`）：
```js
function registerRoute(route) {
  const inner = route && route.handler
  const wrapped = Object.assign({}, route, {
    handler: async (req, res) => { if (rejected(req, res)) return; return inner(req, res) },
  })
  return ctx.webServer.register(wrapped)   // ← 返回 disposer
}
```

- **`kind`** 观察到两种：`'exact'`（`A:3549` 等，A 的全部 22 条）与 `'prefix'`（`B/index.js:1677`，前缀匹配）。
- **返回值是 disposer**：A 推进 `disposers`（895 声明，3548/3586/… 推入），最后 `ctx.effect(() => () => { for (const d of disposers) try { d() } catch {} })`（4919-4923）。
- **`handler(req, res)` 是原生 Node http**：`res.writeHead(code, headers)` + `res.end(...)`（`A:3554-3559`、`B:1680-1682` 的 `sendJson`）。
- **`webServer.tapIndex(fn)`**：给 Web 形态的 index.html 做字符串变换，返回 disposer（`A:4903-4908`）。
- 统一 JSON 头（`A:678-682`）：`{ 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }`。

**可直接复制的两种路由**

```js
// ① JSON
disposers.push(ctx.webServer.register({
  kind: 'exact',
  path: '/dsh-jar/ping',
  handler: (req, res) => {
    res.writeHead(200, JSON_HEADERS)
    res.end(JSON.stringify({ ok: true }))
  },
}))

// ② 静态文件下发（照 A 的 widget.js / image.png 写法，含 404 兜底）
disposers.push(ctx.webServer.register({
  kind: 'exact',
  path: '/dsh-jar/client.js',
  handler: (req, res) => {
    try {
      const bytes = fs.readFileSync(CLIENT_FILE)          // A 用 mtime 缓存，见 687-704
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': String(bytes.length),
      })
      res.end(bytes)
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('client.js unavailable')
    }
  },
}))
```
（②的头部形状见 `A/lib/index.js:4895-4899`（js）与 `3548-3565`（png，含 `Content-Length`）；404 兜底见 `3560-3563`。）

**注意**：A 给**每条**路由都套了信任栅栏（`selfRejection` + `writeRejection` + `connection.requestRejection`，`A:750-874`）。最小骨架只做 GET，可以不套；一旦加 POST/PUT，必须自己校验回环 Host / Origin（`A:816-847` 的注释说明为什么：任意拿到 Web 会话的请求方都能改配置）。

## 5. 客户端脚本怎么到浏览器（两条互斥的路线）

### 路线 A（A 插件用的）：自己 serve + 自己插 `<script>`

完整链路：

1. **host 路由** `/dsh-whale/widget.js` → 读盘返回 `assets/whale-widget.js`（`A/lib/index.js:4891-4901`）。
2. **读盘带 mtime 缓存**：`WIDGET_FILE_CANDIDATES` 三处候选 + `loadWidgetJs()`，注释：*"每次请求按 mtime 判断是否需要重读，避免常驻缓存导致改了不生效"*，"改 widget 后硬刷新页面即生效(无需重启 DSH)"（`A:684-704`；另见 685）。
3. **Web 形态插标签**：`ctx.webServer.tapIndex((html) => …)` 把 `<script defer src="/dsh-whale/widget.js"></script>` 塞在 `</body>` 前并先查重（`A:4903-4908`）。
4. **桌面（Electron）形态**：tapIndex **永远不生效**——*"桌面壳的 index.html 是**从安装包静态 dist 直接读盘**的（`dsh-app://app/`），永远不经过宿主的 renderIndex()"*（`A:4910-4912`、`706-708`）。唯一通道是 `webserver/index-inject` 结构化行（宿主启动时 `collectIndexInjections()` → IPC → 渲染层逐行应用，`A:706-708`、`4912-4914`）。
5. **该行必须是内联 `script` 行，不能是 `script-src` 行**：*"case `script`: createElement + textContent + append —— 没有 await，**不可能「加载失败」**；case `script-src`: await loadScript(src) —— 失败即 reject，而那个 reject 会 reject 掉 `__DSH_BOOT_READY__` ⇒ **应用起不来**"*（`A:709-712`）。内联文本自己建 `<script src>` 并**吞掉 onerror**（`A:716-721` 的 `DESKTOP_WIDGET_ROW_TEXT`）。
6. 行形状：`table.push({ kind: 'script', placement: 'body', text: DESKTOP_WIDGET_ROW_TEXT })`（`A:744`）；去重时同时兼容旧的 `kind:'script-src'` 行（`A:740-743`）。

### 路线 B（B/C 用的）：ModuleLoader 自注册脚本

`client.js` 不是 ESM，而是自注册脚本（`B/client.js:1-30`，注释里写明"从官方包里挖到的约定"）：

```js
window.__ModuleLoader__.load({
  id: '<包名>',                                  // 必须等于 package.json 的 name（B/client.js:6-7）
  factory: (require) => {
    const React = require('react')
    return { inject: ['slots'], apply(ctx) { /* 注册 settings.section */ } }
  },
})
```

- 落地为：`B/client.js:28-30`（load 开头）、`578-596`（返回 `{ inject, apply }`）、`C/client.js:5812`（`function apply(ctx)`）、`C/client.js:5934`（`ctx.slots.inject('settings.section', …)`）。
- **谁 serve、谁插进页面**：**[未找到证据]**（宿主源码在 asar 内，无法读；本机 GUI `http://127.0.0.1:52077/` 返回 401，探不到注入后的 HTML）。只能确认插件侧契约：`package.json` 声明 `dsh.client`（`B/package.json:61-66`）+ `exports["./client"]`（`B/package.json:19-23`），客户端半端绑在 `name` 为裸包名的那一行（`C/cordis.patch.yml:3-4`）。**这条链路的确切 URL 与注入点未找到证据，不要凭空写。**

**两条路线怎么选**：要"右下角挂件/纯 DOM 注入"走 A（自控、无需构建、改完硬刷新即生效）；要"设置页 React UI"走 B（必须有 `slots` 服务与 `dsh.client`）。两者可并存（A 的挂件 + B 的设置页）。

## 6. 设置页：有没有插件侧机制？有。

**有。三层都要齐**：

1. **host 导出 `Config`（schemastery）**，每个字段 `.extra('volatile', true)`：
   *"🔴 每个字段都要 `.extra('volatile', true)`：DSH 的 settings.update() 只认 volatile 字段（`volatileForm(schema)`，见 dsh-settings），没有这个标记写设置时会抛 "Plugin entry … has no volatile fields"。另外两个条件是：**loader entry 的 id 必须等于命名空间名** + **本模块导出 Config**"*（`B/index.js:39-44`）。实现：`export const Config = !z ? undefined : z.object({ … })`（`B/index.js:47-89`）。
2. **不需要、也不存在 `ctx.settings.register`**：*"DSH 自带的「插件设置」页**不需要注册** —— 老代码那句 `ctx.settings.register(...)` 是个不存在的方法，每次都抛 TypeError、被 catch 吞掉… `describe()` 自己扫 profile 里**带 volatile 字段**的条目列出来"*（`B/index.js:260-266`）。
3. **客户端注册 slot**：`slots.inject('settings.section', () => slots.register({ name:'settings.section', id:'bili-scroll', order:30, label:'刷B站' }, () => h(Panel)))`（`B/client.js:588-593`；`C/client.js:5934-5941` 同法，另有 `settings.onboarding`，`C/client.js:5942`）。`label` 就是左侧导航那一项（`B/client.js:15-17`）。

**读写通路**（重要，别自己发明）：`ctx.settings.describe()` 返回行 `{ ns, value, base, user, revision }`（`B/index.js:272-282`、`270` 注释："describe() 每行给三层：value（生效值）/ base（继承层）/ user（用户在设置页显式设过的那层）"），写入 `await ctx.settings.update(row.ns, patch, row.revision)`（`B/index.js:341-362`，含"必须回读 user 层确认真的生效"）。**B 的结论是设置页 UI 自己渲染 React 面板、数据走自己的 `/api/...` 路由**，`Config` 只用来让原生设置页/描述表认识这些字段。

**A 没有设置页的证据**：A 的 `package.json` 无 `dsh.client`（`A/package.json:1-37`）；A 的客户端 bundle 里搜不到 `settings.section` 与 `__ModuleLoader__`（`A/assets/whale-widget.js` 全文 grep：0 命中）；A 的 patch `id` 与导出 `name` 不一致（`A/cordis.patch.yml:14` vs `A/lib/index.js:724`）。⇒ A 用**自己的 overlay/快捷编辑**，不是设置页。

## 7. 工具注册（B 的 MCP → DSH 工具）

- 声明服务：`export const inject = ['webServer', 'tools', 'settings']`（`B/index.js:37`）。
- 注册：`const tool = (spec) => ctx.tools.register(defineTool({ ...spec, output: textOutput, async execute(args, exec) { return safe(await spec.execute(args, exec)) } }))`（`B/index.js:448-452`），然后逐个 `tool({ name, description, parameters, async execute(args) {...} })`（`B/index.js:454-465` 起，共 11 个）。
- `parameters` 写成 **属性名→JSON Schema 片段的映射**（`B/index.js:471-475`），`defineTool` 负责 spec→JSONSchema（`B/lib/hostdeps.mjs:98-100`）。
- `output` 要**标准 schema 且 object 必须写 `additionalProperties`**（`B/index.js:431-437`；`B/lib/hostdeps.mjs:103-111` 会校验）。
- **返回值必须是无损 JSON**：*"宿主只吃「无损 JSON」，塞进去任何函数/循环引用/类实例都会报 `value is not lossless JSON`"*（`B/index.js:439-446`）。
- `defineTool` 从宿主树取，取不到用本地等价实现（`B/index.js:19-24`、`B/lib/hostdeps.mjs:119-140`）。

## 8. 最小可运行骨架（4 个文件，可复制落地）

功能：`GET /dsh-jar/ping → {"ok":true}`；页面右下角一个可点方块，点一下 `alert`。

### 8.1 `package.json`

```json
{
  "name": "dsh-jar",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js"
  },
  "files": [
    "index.js",
    "client.js",
    "cordis.patch.yml"
  ],
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

> 以后要加设置页：补 `"exports": { ".": "./index.js", "./client": "./client.js" }` 和 `"dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-settings"] } }`（照 `B/package.json:19-23,61-66`），并把 `client.js` 改写成 ModuleLoader 形状（§5 路线 B）。

### 8.2 `cordis.patch.yml`

```yaml
# dsh-jar 的挂载声明。id = 条目 id（将来当设置命名空间用），name = 包名。
- insert:
    - id: dsh-jar
      name: dsh-jar
      config: {}
```

### 8.3 `index.js`

```js
// dsh-jar —— host 半端（无声明式 inject：先注册注入行，再等 webServer，见 A/lib/index.js:725-730）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_FILE = path.join(HERE, 'client.js')
const CLIENT_SRC = '/dsh-jar/client.js'
const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

// 桌面端唯一通道：内联 script 行（不能是 script-src 行），自己建 <script> 并吞 onerror
const BOOT_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
  'if(document.querySelector("script[data-dsh-jar]"))return;' +
  'var s=document.createElement("script");s.src="' + CLIENT_SRC + '";s.setAttribute("data-dsh-jar","");' +
  's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

export const name = 'dsh-jar'

export function apply(ctx) {
  const disposers = []
  ctx.effect(() => () => { for (const d of disposers) { try { d() } catch (err) {} } })

  // ① 不依赖任何服务：桌面端注入表在宿主启动时一次性收集，必须尽早进表
  disposers.push(ctx.on('webserver/index-inject', (table) => {
    try {
      if (!Array.isArray(table)) return
      for (const row of table) {
        if (!row) continue
        if (row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf(CLIENT_SRC) >= 0) return
        if (row.kind === 'script-src' && row.src === CLIENT_SRC) return
      }
      table.push({ kind: 'script', placement: 'body', text: BOOT_ROW_TEXT })
    } catch (err) {}
  }))

  // ② 等 webServer 就绪再挂路由
  ctx.inject(['webServer'], (ctx) => {
    const webServer = ctx.webServer || (typeof ctx.get === 'function' ? ctx.get('webServer') : null)
    if (!webServer || typeof webServer.register !== 'function') {
      try { console.warn('[dsh-jar] 没有 webServer 服务，路由未挂载') } catch (err) {}
      return
    }

    // JSON
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/dsh-jar/ping',
      handler: (req, res) => {
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({ ok: true }))
      },
    }))

    // 静态文件：每次请求读盘（mtime 变了才重读），改 client.js 后硬刷新即生效
    let cache = null // { mtimeMs, bytes }
    disposers.push(webServer.register({
      kind: 'exact',
      path: CLIENT_SRC,
      handler: (req, res) => {
        try {
          const st = fs.statSync(CLIENT_FILE)
          if (!cache || cache.mtimeMs !== st.mtimeMs) cache = { mtimeMs: st.mtimeMs, bytes: fs.readFileSync(CLIENT_FILE) }
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Length': String(cache.bytes.length),
          })
          res.end(cache.bytes)
        } catch (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('client.js unavailable')
        }
      },
    }))

    // Web 形态：往 index.html 插 <script defer src>
    if (typeof webServer.tapIndex === 'function') {
      disposers.push(webServer.tapIndex((html) => {
        if (!html || html.indexOf(CLIENT_SRC) !== -1) return html
        const tag = '<script defer src="' + CLIENT_SRC + '"></script>'
        return html.indexOf('</body>') !== -1 ? html.replace('</body>', tag + '</body>') : html + tag
      }))
    }
  })
}
```

### 8.4 `client.js`（**普通浏览器脚本**，不是 ModuleLoader；由上面路由下发）

```js
// dsh-jar —— 浏览器半端：右下角方块，点一下 alert
(function () {
  if (window.__dshJarLoaded) return
  window.__dshJarLoaded = true

  function mount() {
    if (!document.body || document.querySelector('[data-dsh-jar-box]')) return
    var el = document.createElement('button')
    el.setAttribute('data-dsh-jar-box', '')
    el.type = 'button'
    el.textContent = '罐'
    el.style.cssText = [
      'position:fixed', 'right:18px', 'bottom:18px', 'z-index:2147483000',
      'width:52px', 'height:52px', 'border-radius:14px', 'border:0',
      'cursor:pointer', 'font-size:20px', 'line-height:1',
      'background:#3b82f6', 'color:#fff',
      'box-shadow:0 6px 18px rgba(0,0,0,.28)',
    ].join(';')
    el.addEventListener('click', function () {
      fetch('/dsh-jar/ping', { credentials: 'same-origin' })
        .then(function (r) { return r.json() })
        .then(function (j) { alert('电子榨菜罐 /dsh-jar/ping → ' + JSON.stringify(j)) })
        .catch(function (e) { alert('电子榨菜罐：ping 失败（' + e + '）') })
    })
    document.body.appendChild(el)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true })
  else mount()
})()
```

### 8.5 落地与验证

```bash
# 1) 装（本地开发用 link:）
dsh plugin --profile web add link:D:\电子榨菜罐
# 2) 确认 profile 的 dsh.profile.bundles 里出现了包名（P/package.json:8-25 那一段）
# 3) 重启 dsh（bundle 层要重启才组装；只有 profile 自己那层 patch 是热重载）
# 4) 打开页面 → 右下角"罐" → 点一下应 alert {"ok":true}；curl /dsh-jar/ping 也应 200
# 命令写法见 A/cordis.patch.yml:8-10、B/cordis.patch.yml:8-9；重启必要性见 B/cordis.patch.yml:12、B/README.md:55
```

## 9. 坑（全部来自注释）

1. **optional peer 会整条插件不激活**：*"它们俩在 package.json 里是 **optional peer** ⇒ 桌面版 profile（`autoInstallPeers: false`）**永远不装它们** ⇒ 插件整条不激活，DSH 只留一句 `warning: 1 entry did not activate … failed to import`"*（`B/lib/hostdeps.mjs:5-10`；web 上没事只是因为"别的插件恰好 hoist 上来"，`9`）。`dsh-tools` 自己还有 7 个顶层 import、4 个是 peer（`B/lib/hostdeps.mjs:10`）⇒ 光装它救不回来。对策：先查宿主树、再退自己依赖、最后本地等价实现（`B/lib/hostdeps.mjs:12-16`）。
2. **schema 校验不过 ⇒ entry 被 cordis 拒收 ⇒ 整条插件不激活**：*"这里故意**不加 `.max(20)`**：schema 校验不过 ⇒ cordis 拒收这条 entry ⇒ **整条插件不激活**"*（`B/index.js:65-67`）。`Config` 拿不到 schemastery 时就导出 `undefined`，"宁可少一个设置页"（`B/index.js:45-47`）。
3. **设置写入只认 volatile + id 必须等于命名空间**（`B/index.js:39-44`）。
4. **bundle 层组装顺序与热重载边界**：`B/cordis.patch.yml:11-12` —— 插件自带 patch 不是热重载，装完/改完**必须重启**（`B/README.md:129-130`、`B/AGENTS.md:19`）。
5. **桌面端注入表一次性收集，没有任何刷新路径**：*"外壳把这张表在**宿主启动时收集一次**后缓存，**没有任何刷新路径** ⇒ 插件在运行期被关掉时，表里仍留着这一行，而路由已注销 ⇒ 加载 404"*（`A/lib/index.js:713-717`）。⇒ 行要用内联 script + 吞 onerror；且**不能是 `script-src` 行**（会 reject 掉 `__DSH_BOOT_READY__`，`A:709-712`）。
6. **对象级 inject 会推迟 `apply()`，与上条冲突**（`A:725-730`）；**可选服务绝不进 inject、一律 `ctx.get`**（`A:1181-1182`）；**用户数据一律 `$DSH_HOME` 优先**，否则"网页端与桌面端各写各的"（`A/lib/index.js:33-38`）。
7. **客户端半端不是 ESM**，是 `window.__ModuleLoader__.load({id: 包名, factory})` 自注册脚本（`B/client.js:4-9`），`id` 必须等于 `package.json.name`（`B/client.js:6-7,29`）；且**别自己糊设置页**：*"别自己糊一个标题栏按钮 + 全屏 overlay ✗（使用者一眼看出跟别的插件不一样）"*（`B/client.js:19`）。
8. **客户端代码改了之后**：走路线 A 时硬刷新即可（`A:684-685`），走路线 B 需要宿主/构建侧重载；本机 profile 里 `@deepseek-ai/dsh-hmr` 是**有条件的**（`disabled: !!js '!ctx.get(''profileContext'')'`，`P/cordis.yml:9-11`）⇒ **"[未找到证据]"：插件客户端 bundle 的 HMR 前提在参考代码里没有说明**，只有 A 的"改完硬刷新"和 B 的"重启 dsh"两条经验。
9. **Windows 上替换正在运行的插件可能被文件占用挡住**（`B/index.js:677`）。

## 10. 五个关键决定（总结）

搭这个骨架真正要定的只有五件事：**① 用"自带 patch + 包名进 profile.bundles"挂载**（`dsh.bundle.patch` 一条 `insert`，`id` 当命名空间、`name` 写包名）；**② 服务端用命名导出 `export function apply(ctx)` 且不写声明式 inject**，把 `webserver/index-inject` 的订阅放在 apply 第一行，路由留到 `ctx.inject(['webServer'], …)` 里再挂——这是 A 用两次 issue 换来的顺序（`A:725-730`）；**③ 客户端走"自己 serve + tapIndex + index-inject"双通道**，而不是赌 ModuleLoader 的隐藏加载路径，因为前者每个环节都有可读代码，后者 serve 端在 asar 里查不到；**④ 注入行一律用内联 `script` 行 + 自建 `<script>` 吞错**，绝不用 `script-src` 行（它会把启动流程 reject 掉）；**⑤ 设置页与工具都是"第二层"，不是骨架必需**——要设置页时再加 `dsh.client` + `exports["./client"]` + ModuleLoader `id=包名` + `slots.inject('settings.section')` + host 端 `Config` 每字段 `.extra('volatile', true)`，四条缺一不可（`B/index.js:39-44`、`B/client.js:588-593`、`C/cordis.patch.yml:3-4`）。
