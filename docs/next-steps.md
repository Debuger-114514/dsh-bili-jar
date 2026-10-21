# 下一批改动（定稿，待实现）

> 2026-10-21 定。当前已上线：`8af51e1`（v0.1.0 + 轴树 + 策展 + 记账 + 头像）。
> 以下按依赖顺序排，建议一次改完、重启一次。

## 1. 日志（先做，其他都靠它排错）

- 新增 `lib/log.mjs`：追加 JSONL 到 `~/.dsh/bili-jar/bili-jar.log`
  - 字段：`{ts, level, event, detail}`
  - 保留最近 2000 行（超过就截断）
  - 导出 `log(level, event, detail)`、`tail(n)`
- `index.js` 接入点：apply 成功、建池开始/结束（含统计）、策展成功/失败（含原因）、字幕命中/未命中、记账、配置变更
- 路由：`GET /api/bili-jar/log?n=100` → `{ok, lines:[...]}`
- 设置页底部：折叠的「最近日志」，显示最后 20 行

**验收**：跑一次换一批，`/log` 里能看到「搜索 11 次 → 候选 24 → 策展成功 5 条」。

## 2. 内容源选项（设置里三选一）

字段 `contentSource`: `'self' | 'scroll' | 'both'`（默认 `self`）

- `self`：只用我们自己的搜索（现状）
- `scroll`：额外读取 bili-scroll 的产物
  - `~/.dsh/bili-duty/out/*.md`（日报，`### BV号` 开头那些行）
  - `~/.dsh/bili-duty/digest/*.md`（归档）
  - 正则 `BV[0-9A-Za-z]{10}` → 去重 → 作为**额外候选**（`source: 'scroll'`）
  - 这些条目**只读标题/分区**（本地文件里就有），仍需过一遍硬过滤
  - ⚠️ 是"它挑过的"，不是"它没挑的"⇒ 适合当补充信号，不能当主力
- `both`：两者合并

**验收**：选 `scroll` 时，`/feed` 的 stats 里出现 `fromScroll: N`；报告不存在时静默跳过（不报错）。

## 3. 直接兼容（设置里开关，默认关）

字段 `useScrollLogin: false`

- 读 `~/.dsh/bili-duty/bili_credential.json`（四个字段：SESSDATA / bili_jct / DedeUserID / buvid3）
- 注入 `lib/bili.mjs` 的 cookie 罐（已有 `cookies` Map，加 `adoptCookies()`）
- 用途：**取 AI 字幕**（未登录时 `player/v2` 返回 0 条字幕轨，已实测）
- 🔴 设置页必须写清楚：「会读取 bili-scroll 的 B站 登录凭证；两个插件共享同一份登录态」
- 不勾选时绝不去读那个文件

**验收**：勾上后 `node tools/sub.mjs BV...` 能拿到正文字符数 > 0。

## 4. 内容理由（依赖 3）

- 策展挑完 5 条后：取字幕（或简介 + 热评作为降级）
- 一次调用重写 5 条理由：「只讲内容，不许出现任何数字」（提示词已加，见 `curator.mjs`）
- 字幕截断：前 1200 字 + 后 300 字（写理由不需要中段）
- 无字幕时降级：`description` + 前 20 条热评
- 成本：约 ¥0.01 / 次

## 5. 赞 / 踩

- `feedback.jsonl`：`{ts, bvid, action:'like'|'dislike', axis, sub, tags}`
- 路由 `POST /api/bili-jar/feedback`，卡片上加 👍 / 👎
- 学的地方：`scoreItem` 里给「同 tag / 同 sub」加减分（贝叶斯平滑，先只记不用，攒 20 条再启用）
- 红线：**只记本地，绝不落到 B站 账号**

## 6. 稍后看落库

- 现在存 localStorage，换浏览器就丢 ⇒ 改存 `~/.dsh/bili-jar/later.json`
- 路由 `GET /later`、`POST /later`（{bvid, action:'add'|'remove'}）
- 「待看」页签改读后端

## 7. NOTICE（法律风险，别忘了）

`assets/avatar.png` 来自 [dsh-whale-widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（MIT）。
README 加一节「Assets」，写明出处与许可；或在仓库放 `NOTICE`。

---

## 验收总清单

- [ ] 换一批后 `/log` 能看到完整链路
- [ ] `contentSource` 三档切换生效，`scroll` 模式下报告缺失不报错
- [ ] `useScrollLogin` 关闭时**不读**凭证文件
- [ ] 理由里不出现任何数字
- [ ] 赞/踩写入 `feedback.jsonl`，且不影响 B站 账号
- [ ] 稍后看在换浏览器后仍在
- [ ] README 有 Assets 归属
