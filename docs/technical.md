# 技术细节

> 这份文档写给想看内部实现的人。用户向的说明在 [README](../README.md)。
> 里面的数字都对应 `package.json` 里的版本，改代码时记得一起改。

目录

1. [结构](#结构)
2. [一轮完整流水线](#一轮完整流水线)
3. [打分](#打分)
4. [时效：每根轴自己决定](#时效每根轴自己决定)
5. [冷门轴补货](#冷门轴补货)
6. [多样性抽样](#多样性抽样)
7. [冷启动补偿与新鲜度配额](#冷启动补偿与新鲜度配额)
8. [熟人名单](#熟人名单)
9. [防回音室](#防回音室)
10. [三档刷新与首屏](#三档刷新与首屏)
11. [B 站接口与风控](#b-站接口与风控)
12. [记账](#记账)
13. [安全](#安全)
14. [数据结构](#数据结构)
15. [代码结构](#代码结构)
16. [工具与测试](#工具与测试)
17. [发版](#发版)
18. [已知技术债](#已知技术债)

---

## 结构

插件是 DSH 的 cordis 插件，分两半：

| 半边 | 文件 | 干什么 |
|---|---|---|
| host | `index.js` | 配置、HTTP 路由（前缀 `/api/bili-jar`）、池子落盘、策展接线、定时器 |
| client | `client.js` | 自注册脚本（`window.__ModuleLoader__.load`），画罐子和面板 |

`apply(ctx, config)` 里拿到的 `config` 每个字段都是 `{}`，真实值要读 `ctx.settings.describe()`
那一行的 `value`。读取优先级：**本地 `config.json` 的 overrides** > 设置页 > 内置 `DEFAULTS`。
桌面版的 DSH 原生设置页不显示本插件的字段，所以配置面板做在罐子里。

路由全部挂在 `/api/bili-jar` 下，只服务本机页面（见「安全」一节）。

---

## 一轮完整流水线

「换一批」= 跑一遍下面全部：

```
搜     每根轴 3 个词（第 3 个按小时轮换）：前两个走综合排序保相关，第 3 个走「最新发布」保新鲜
熟人   你赞过 / 点开过 / 加过稍后看的 UP（最多 6 个）直接拉最新投稿，3 天内的进候选并加权
补货   某根轴凑不够 3 条时，换两条通道再找：按时长带重搜 + 从种子扩散
并池   和上一轮的池子合并，同一个 BV 只更新数据；池子上限 400，一直没再露面的先淘汰
筛     时长、播放门槛、充电专属、直播回放、日期窗口、贴不上任何轴 —— 全砍
打分   两套权重各自合计 1.00（见下一节）
扣分   进过 main 的条目每轮 -0.03（封顶 0.15），把位置让给没见过的
打乱   前 5 名固定，其余按分数加权抽签（设置里「多样性」0–1）；种子记进 stats，能重放
补查   前 12 名回查真实投币数（搜索接口给的是旧的），重新打分
补漏   新条目缺互动数据时每轮补查 8 条（播放涨得快的优先）
配额   main 里至少一条「3 天内 + 播放达标 + 贴轴 + 非标题党」
回音室 熟人来源最多 2 条 —— 规则挑完收一次，模型策展完再收一次
策展   只把前 24 名交给模型，让它挑 5 条、写理由
```

几条约定：

- **为什么只给模型 24 条**：给整个池子也能挑，但一次调用会贵十倍，挑得还未必更好。
- **排除集**：「换一批」排除 —— 最近 N 轮推过的（N = `shownRounds`，默认 8，可配 3–20）+
  已观看的 + 待看的 + 14 天内点过 😐 的。之前只排除上一轮那 5 条，池子里的老面孔每轮都回来；
  窗口太短则一周左右就转回来（issue #3 的第 2、3 条）。
- **没有模型也能跑**：`curatorOn` 关掉或调用失败时退回纯规则挑片 —— 每根轴先挑一条相似度 ≥0.85 的，
  同轴最多 2 条、同 UP 最多 1 条。

---

## 打分

两套权重，各自合计 1.00（`lib/pool.mjs` 的 `WEIGHTS`）：

| 项 | 含义 | news | evergreen |
|---|---|---|---|
| `sim` | 和轴的相似度 | 0.30 | 0.30 |
| `like` | 点赞率 | 0.15 | 0.15 |
| `coin` | 投币率 | 0.12 | 0.12 |
| `fav` | 收藏率 | 0.12 | 0.12 |
| `fresh` | 时效 | 0.10 | **0.02** |
| `sub` | 有字幕 | 0.06 | 0.06 |
| `play` | 播放量（对数） | 0.05 | **0.08** |
| `multi` | 同时贴多根轴 | 0.04 | 0.04 |
| `niche` | 小众 tag | 0.06 | **0.11** |

差额就是从「时效」挪给「播放」和「小众 tag」的：老内容不靠新吃饭，得靠别的东西立足。

- 率 = 该指标 ÷ 播放，都是搜索/详情接口直接给的数。
- 额外乘两个降权因子：标题党 ×(1−0.45×spam)、tag 全是大标签 ×(1−0.12)。
- 赞踩偏好（`affinityDelta`）：赞过的 UP +0.04/次（封顶 +0.10），踩过的 −0.07/次（封顶 −0.16）；
  tag 命中 ±0.004~0.006；总增量夹在 [−0.2, +0.12]。**攒够 20 条才启用**。
- 冷启动补偿叠在最后，上限 0.05。

---

## 时效：每根轴自己决定

同一个窗口不可能同时适合「时政」和「空洞骑士攻略」—— 前者 14 天就过期，后者 2023 年的攻略今天照样有用。

所以每根轴有一个 `freshness`：

| | 日期窗口 | 时效分权重 |
|---|---|---|
| `news` | 14 天（全局可改，`maxDays`） | 0.10 |
| `evergreen` | 不限 | 0.02 |

**怎么定的**（`lib/freshness.mjs`）：不看条数，看**合格条目的年龄中位数**，超过 90 天（`EVERGREEN_AFTER_DAYS`）
就算常青内容。条数会跟着搜索结果抖（同一个词两次跑，命中数会变），中位数不会 —— 所以拿它当判据。

实测七个冷门词分得很干净：丝之歌 361 天、空洞骑士 2052 天、vtuber 2385 天（都判 evergreen）；
时政 13 天、深蓝 26 天、术力口 5 天、kards 5 天（都判 news）。中间几乎没有模糊地带。

两条防线：

- **近两周还有新内容的轴不许改判**（`decideFreshness` 的 `freshCount`）—— 否则一个正在更新的话题会被
  一堆老片拉成 evergreen。
- **手填优先**：设置页每根轴旁边那个两态开关点了就是手填，手填之后 `freshnessAuto` 为 false，不再被自动覆盖。

---

## 冷门轴补货

搜「空洞骑士」时，B 站的前 3 页被续作「丝之歌」的新内容占满，五年前的好视频排不进来 ——
有一条 33 分钟、108 万播放的攻略要翻到第 4 页才有。

所以某根轴凑不够 3 条时会走两条补充通道：

1. **按时长带重搜**：B 站搜索支持 `duration` 参数（1=<10 分 / 2=10–30 / 3=30–60 / 4=>60 分），
   一页 20 条全落在想要的时长里，比混着搜再筛掉强得多。时长带按 `minMinutes`/`maxMinutes` 的中位数取。
2. **种子扩散**：`/x/web-interface/archive/related?bvid=` 按内容相似度给，不受新内容淹没。
   从任意 3 条同主题视频出发（**不需要它们合格**），去重后能捞回几十条。

两条通道都是纯 HTTP，不花模型钱。

**小众 tag 分**（`nicheScore`）：一条视频的 tag 在池子里越罕见这一项越高（取最罕见的三个 tag 平均），
目的是别让「必剪创作 / 高能」这种大标签把长尾内容挤下去。

---

## 多样性抽样

分数排序太确定，同一个池子每次点开都差不多。`applyDiversity(items, { tau, keepTop, seed })`：

- 前 `keepTop`（5）名原样固定
- 其余的分数加上 Gumbel 噪声后重排 —— `tau` 越大越乱
- `tau = 0.10 × 设置里的多样性（0–1）`，默认 0.5 ⇒ tau 0.05
- 随机数用 `mulberry32(seed)`，种子记进 `stats.diversity`，出问题能原样重放

只打乱一次，规则选片和模型决赛圈共用同一个顺序 —— 否则模型看到的 24 条还是固定的，打乱就白做了。

---

## 冷启动补偿与新鲜度配额

**冷启动**（`coldStartBonus`）。搜索接口不给投币/收藏，只有详情接口有 ⇒ 新条目进池时币/藏 = 0，
互动分（最多 0.39）拿不到，初评落后 ⇒ 只有「初评前 12 名」才补详情 ⇒ 新条目永远挤不进前 12 ⇒
永远没数据。是个闭环，所以两头一起剪：

- 每轮先给还没补过数据的候选补一小批（8 条，播放涨得快的优先）
- 补到之前给临时补贴：`played ≥ max(50000, minPlay×2)` 且标题不党，按发布时间给
  0.05（≤2 天）/ 0.03（≤4 天）/ 0.01（≤7 天），增速 ≥ 5 万/天再加 0.01，总上限 0.05
- 只给「还没补过」的（`statsAt` 为空且 coin/fav 都是 0），补到真数据就撤

**数据过期**：补到的快照 7 天后（`REFRESH_AFTER_MS`）重刷，每轮 3 条，播放高的先刷。

**新鲜度配额**（`freshQuotaReplace`）：main 里至少一条「≤3 天 + 播放 ≥ max(50000, minPlay×2) + 贴轴 + 非标题党」，
没有就从合格候选里换一条进来，只换「那根轴上还有队友」的最低分。这条是兜底 —— 分数再怎么调都可能被更强的老片整体压住。

---

## 熟人名单

`lib/ups.mjs`，纯函数，不联网、不读文件。

**输入**：`feedback.jsonl` 折出来的**当前状态**（👍/👎；😐 不算）、`history.json`（点开过）、`later.json`（稍后看）、
上一轮池子（补全老数据缺失的 `mid`）。

**去重与折算**：`feedback.jsonl` 是追加日志（改主意、撤销都各写一行），所以先按 ts 折出
「每条最后一次的选择」（`lib/feedback.mjs` 的 `foldFeedback`），再计数。真实数据里一条视频
被记 3 行是常态，不折算的话熟人分数天生虚高。

**😐 无感不算互动**：`action=skip` 只让这条 14 天不再进推荐，不进 `net` 公式 ——
没态度不等于不喜欢，拿它扣 UP 的分是误伤。

**时间窗**：只统计最近 180 天（`UP_WINDOW_MS`）。

```
positive = 去重后 open 数 + like 数 + later 数
negative = 去重后 dislike 数
net      = positive - 2 × negative
```

| net | 档位 |
|---|---|
| ≥ 3（`UP_OBSERVE_AT`） | `regular` 熟人，预测优秀 |
| 1–2 | `observing` 观察中 |
| ≤ 0 | `black` 拉黑，不再拉投稿 |

上限：`regular` 20 个（按 `lastAt` 倒序），`observing` 30 个。

**怎么用**：`buildPool` 的 1b 节把这几个 UP 的最新投稿并进候选（最多 6 个）。
3 天内的新片按档位加权：熟人 +0.08、观察 +0.04。老片不加 —— 老片该按时间窗自然筛，不靠人情。

## 防回音室

硬要求：片单里熟人来源（`fromUpList`）最多 `ceil(mainCount × 0.4)` 条，5 条时是 2。

两条路径都要收：

1. `enforceEchoCap()` —— 规则挑选之后兜一遍（`tryPick` 里也有实时上限，`freshQuotaReplace` 可能硬塞进来）
2. `capCuratedEcho()` —— 模型策展之后再收一遍。模型是从 24 条 shortlist 里自己挑的，
   不受规则那边上限的约束；熟人加了权很容易被一口气挑好几个（实测出现过 3/5）

熟人候选不够就少用，不凑数。统计写进 `stats.echoGuard = { cap, picked, trimmed, final, curatedTrimmed }`。

---

## 三档刷新与首屏

`lib/refresh.mjs`，纯函数。两个时间戳：`probedAt`（上次轻量探测）、`fullAt`（上次完整重建），
存在 `refresh.json`。

| 距上次完整重建 | 动作 |
|---|---|
| ≥ 24 小时（`FULL_AFTER_MS`） | `full` |
| 打开面板 && 距上次探测 ≥ 3 小时（`OPEN_AFTER_MS`） | `probe` |
| 距上次探测 ≥ 6 小时（`AUTO_AFTER_MS`） | `probe` |
| 其余 | `none` |

**触发即清零**：真跑起来就把 `probedAt` 推到现在；全量重建再额外推 `fullAt`。

**轻量探测**（`lightProbe`）：最多 6 个熟人的最新投稿 + 每根轴一次 `order=pubdate` 搜索。
判据比主流程**松**（新片互动率还没成形）：发布 ≤2 天、`minPlay` 降到 `max(3000, minPlay×0.3)`、
贴轴、非充电/非回放。命中 ≥1 条才排队一次完整重建，否则什么都不做。不叫模型、不算分。

**首屏（stale-while-revalidate）**：`GET /feed` 不带 `refresh=1` 时，只要内存/磁盘上有片单
就**立刻返回**（`cached: true, stale: <超过 3 小时>, refreshing: <后台是否在跑>`），
重建在后台做。`GET /feed?peek=1` 只读，返回 `{ok, ts, curated, building}` 给客户端轮询。

客户端拿到 `stale` 就正常渲染旧卡片，然后每 3 秒轮询 `peek`（最多 40 次）；`ts` 变了就挂一条
「新的一批装好了」，点了才重新取 —— **不自动替换**你正在读的那批。

挂载 8 秒后预热一次 `decideRefresh`，之后每 60 秒心跳一次。定时器都挂 `ctx.effect` 清理。

---

## B 站接口与风控

走公开接口，不需要登录也能搜。WBI 签名是必须的：没有 `w_rid` 会被 `-403` 挡回来。

| 用途 | 接口 |
|---|---|
| 搜索 | `/x/web-interface/wbi/search/type`（`order=totalrank\|click\|stow\|pubdate\|dm`，`duration=1..4`） |
| 详情 | `/x/web-interface/wbi/view`（老的 `/x/web-interface/view` 会被 WAF 挡回 HTML） |
| 相关推荐 | `/x/web-interface/archive/related`（种子扩散，40 条） |
| 粉丝数 | `/x/relation/stat`（`acc/info` 已经不返回 fans） |
| UP 投稿 | `/x/space/wbi/arc/search` |
| 字幕 / 播放器 | `/x/player/v2` |
| 扫码登录 | `/x/passport-login/web/qrcode/*` |

**风控**（2026-10 实测，`lib/bili.mjs`）：

- `/x/space/wbi/arc/search` 对游客态除了 WBI 还要浏览器指纹参数
  （`dm_img_list` / `dm_img_str` / `dm_img_inter` / `web_location`），缺了稳定 `-352`，偶尔 `-412`。
  这些值一律交给 `URLSearchParams` 编码，别手拼（`dm_img_inter` 是 JSON）。
- 只给 `buvid3` 不够，`finger/spi` 的 `b_4` 也要存成 `buvid4`。
- **全局节流 750ms**（`spacePace()`）：3 并发连打 10 个 UP 会有一半被拦，串行就基本不炸。
  节流做在 `userVideos` 里，别让每个调用方自己 `sleep`。
- 失败两次会返回 `non-json: <!DOCTYPE html>` —— 那是 WAF 拦截页，不是接口变了。

**登录凭证**：`credential.json` 只在你自己扫码后写入；`adoptCookies()` 接管，POSIX 下 `0600`。

---

## 记账

三层：单次 / 今天 / 累计。按 DeepSeek 官方规则算钱 —— **北京时间工作日 09:00–12:00、14:00–18:00 是峰时**，
其余（含周末和法定节假日）半价。

| 元 / 百万 token | 缓存命中 | 未命中 | 输出 |
|---|---|---|---|
| 峰时 | 0.04 | 2 | 8 |
| 谷时 | 0.02 | 1 | 4 |

历史记录按每条自己的时间戳重算，改规则会把旧账一起修正（`migrateUsage`）。

---

## 安全

- **只监听 `127.0.0.1`**（DSH 的 webServer 本来就这么绑），局域网访问不到
- **跨站请求一律拒**：带 `Sec-Fetch-Site: cross-site`，或者 `Origin` 不是本机的，直接 403 ——
  避免你开着插件逛网页时，被某个页面偷偷改配置或触发付费调用
- **API Key 明文存在 `config.json`**，但所有 HTTP 接口只返回 `sk-••••后四位`，`/debug` 也一样
- **B 站 cookie 存在 `credential.json`**，只在你自己扫码后写入；POSIX 下 `0600`
- **不读别的插件的凭证**，除非你在设置里显式打开「复用刷B站的登录」（默认关，且不勾选绝不读那个文件）
- 响应带 `X-Content-Type-Options: nosniff`
- **不收集遥测**，不往作者的服务器发数据。出站只有两处：`bilibili.com` 和你配的模型 API
- **小窗播放**是 `player.bilibili.com` 的 iframe，等于在页面里跑 B 站的播放器

## 数据结构

`~/.dsh/bili-jar/`

| 文件 | 内容 |
|---|---|
| `config.json` | 面板设置 + 语气预设（**含明文 API Key**） |
| `feed.json` | 当前片单（main / shortlist / up / pool / stats） |
| `pool.json` | 累积候选池（上限 400） |
| `shown.json` | 最近 N 轮推过什么（排除集用，默认 8 轮） |
| `reasons.json` | 攒下来的推荐理由，关掉再开还能用 |
| `usage.json` | 每次调用的 token 和费用 |
| `feedback.jsonl` | 赞/踩/无感/撤销，追加写；状态由最后一条折算 |
| `later.json` | 待看 |
| `history.json` | 最近 30 条观看记录 |
| `credential.json` | B 站登录（扫码才有） |
| `ups.json` | 熟人名单 |
| `refresh.json` | `{probedAt, fullAt}` |
| `axis-tree.json` | 用户自己长的轴 / 子簇 |
| `backups/` | 配置备份 |
| `bili-jar.log` | JSONL 运行日志，2000 行滚动 |
| `STATE.md` | 人话摘要，每次启动和刷新后重写 |

## 代码结构

| 文件 | 干什么 |
|---|---|
| `index.js` | host 半端：配置、HTTP 路由、池子落盘、策展接线、刷新定时器 |
| `client.js` | 浏览器半端：罐子 + 面板 |
| `lib/bili.mjs` | B 站客户端：WBI 签名 / 搜索 / 详情 / 粉丝 / 投稿 / 字幕 / 二维码登录 |
| `lib/pool.mjs` | 候选池：轴匹配、硬过滤、打分、按轴轮转、轻量探测、防回音室 |
| `lib/ups.mjs` | 熟人名单（纯函数） |
| `lib/refresh.mjs` | 三档刷新决策（纯函数） |
| `lib/freshness.mjs` | 时效判定 |
| `lib/tree.mjs` | 轴树：内置 + 用户自己长的枝 |
| `lib/axis-presets.mjs` | 30 根预设轴（工具生成，别手改） |
| `lib/tree-review.mjs` | 让模型审子簇建议 |
| `lib/curator.mjs` | 让模型挑片并写理由 |
| `lib/reasons.mjs` | 写理由（API 直连 → 宿主模型兜底），带磁盘缓存 |
| `lib/usage.mjs` | token 记账 + 峰谷计价 |
| `lib/shown.mjs` | 「最近推过什么」的存取（轮数可配） |
| `lib/feedback.mjs` | 赞/踩/无感 的当前状态折算（纯函数） |
| `lib/statefile.mjs` | 生成 `STATE.md` |
| `lib/log.mjs` | JSONL 日志 |
| `lib/qr.mjs` | 零依赖 QR 编码器 |
| `lib/hostdeps.mjs` | 从宿主树里取 `@deepseek-ai/*` |

## 工具与测试

```bash
node tools/why.mjs BV1xxxxx        # 这条为什么（没）进罐子？在不在池 / 打分明细 / 排第几 / 卡哪一关
node tools/feed.mjs 10000 0        # 跑一次建池，打印片单
node tools/tree-suggest.mjs 历史    # 从池子里挖子簇建议
node tools/tree-review.mjs deepseek # 规则 + 模型审一遍（--apply 才写盘）
node tools/sim-freshness.mjs       # 离线模拟时效判定
node tools/pack-check.mjs          # 发版前自检
```

单测（`node:test`，`pnpm test` 跑前 13 个）：

```
config-check           配置读取与默认值
tree-suggestions-check 子簇建议
freshness-check        时效判定
score-freshness-check  时效权重
pool-decay-check       池子代谢
shown-check            排除集格式（含旧格式兼容、轮数可配）
feedback-check         赞/踩/无感折算 + 路由行为（改主意、撤销、清空历史）
search-check           每轴搜几个词 / 排序槽
cold-start-check       冷启动补偿
fresh-quota-check      新鲜度配额
growth-check           播放增速
diversity-check        多样性抽样
ups-check              熟人名单
refresh-check          三档刷新
echo-check             防回音室（规则 + 策展）
affinity-check         赞踩加权
qr-check               QR 编码器 vs Python qrcode 逐位比对
score-check            打分
```

另有几个诊断脚本：`tools/up-probe.mjs`（固定 UP 拉不到投稿时四种写法对照）、
`tools/rl-probe.mjs`（连打 space 接口看多少下被风控）、`tools/sub.mjs`、`tools/tag-probe.mjs`。

## 发版

```bash
pnpm check          # 自检
npm version patch   # 或 minor / major
git push --follow-tags
```

推 `v*` tag 会触发 `.github/workflows/publish.yml`：跑自检 → 校验 tag 和 `package.json` 版本一致 →
`npm publish --provenance`。细节在 [`publish.md`](publish.md)。

## 已知技术债

- 时政区很多视频没有 tag，只能靠标题里的实体词判断。「时政」这个词在 B 站被考公内容占着，
  真·国际时政得用实体词搜（见 [`tag-tree.md`](tag-tree.md)）。
- 赞踩 / 熟人的学习都很粗：只看 UP 和 tag，不看内容本身。
- evergreen 轴只有 1 条候选时，中位数判定失效，可能捞出 2000+ 天的单条老内容。
- 没有浏览器端的自动化测试，UI 改动得自己看一遍；`client.js` 的改动要重启 DSH 才生效。
- 预设树里有些子簇的词不干净（带 UP 名或活动名），个别大区（科技 / 音乐）只挖出 1–2 个。

历史问题与修复过程见 [`open-issues.md`](open-issues.md)，时效相关的推演见
[`recency-bias.md`](recency-bias.md)，冷门轴的实测数据见 [`niche-tags-test.md`](niche-tags-test.md)。
