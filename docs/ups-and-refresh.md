# 熟人名单 + 三档刷新（0.3.0 规格）

> 定于 2026-10-28。根因与性能账见 [`open-issues.md`](open-issues.md)。
> 这份文档是**实现契约**：模块签名、字段名、判定规则都按这里来，别自己改。

---

## 0. 这一版要解决的四件事

1. **重开 DSH 空白** → `/feed` 先给磁盘上的旧片单，后台重建（SWR）
2. **重建 43 秒** → 决赛圈详情并发、字幕理由并发
3. **每 30 分钟就全量重建（还花钱）** → 三档：0–3h 不动 / 3h–24h 轻量探测 / >24h 全量
4. **认识你自己喜欢的人** → 熟人名单，他们的新片按“预测优秀”处理

顺带修：`userVideos` 的 `-352`（不加 `dm_img_*` 拉不到投稿）、`history.json` 不存 `mid`、`feedback.jsonl` 重复计票。

---

## 1. 熟人名单 `lib/ups.mjs`

**纯逻辑，不联网、不读文件。** 所有输入由调用方传进来。

### 1.1 输入

```js
buildUpList({
  feedback,  // [{bvid, action:'like'|'dislike', ts}]
  history,   // [{bvid, mid, author, watchedAt}]
  later,     // [{bvid, mid, author, addedAt}]
  pool,      // [{bvid, mid, author}]  —— 用来补全老数据缺失的 mid/author
  now,       // 毫秒时间戳
})
```

**必须先按 bvid 去重再计数**：同一条视频点赞三次仍然算 1 次互动（现在 `feedback.jsonl` 里就有
小约翰可汗 3 行、过拟合青年 2 行，全是重复）。

- 同一个 `bvid` 的 `like` 只算 1 次；`dislike` 同理；`open` 同理。
- 同一个 `bvid` 的 `like` 和 `open` 是**两次**互动（点开 + 点赞）。
- 时间窗：只统计最近 **180 天**。

### 1.2 计算

```
positive = 去重后 open 数 + like 数 + later 数
negative = 去重后 dislike 数
net      = positive - 2 * negative
```

### 1.3 分档（用户定的）

| net | 档位 | 含义 |
|---|---|---|
| `>= 3` | `regular` | 熟人，预测优秀 |
| `1..2` | `observing` | 观察中 |
| `<= 0` | `black` | 拉黑，永不再探测 |

### 1.4 输出

```js
{
  ups: [{
    mid: '23947287', name: '小约翰可汗',
    open: 4, like: 1, later: 0, dislike: 0,
    net: 5, tier: 'regular',
    firstAt: 1790000000000, lastAt: 1793000000000,
    bvids: ['BV1..','BV2..'],   // 参与计数的那几条，调试用
  }],
  byTier: { regular: [...], observing: [...], black: [...] },
  midOf: Map<string,string>,   // bvid → mid，给 history 回填用
}
```

- 没有 `mid` 的条目：靠 `author` 在 `pool` 里反查；还查不到就跳过（不按名字瞎猜）。
- `regular` 最多保留 20 个（按 `lastAt` 倒序），`observing` 最多 30 个。

### 1.5 导出

```js
export function buildUpList({ feedback, history, later, pool, now })
export function tierOf(net)                  // 'regular' | 'observing' | 'black'
export const UP_OBSERVE_AT = 3
export const UP_WINDOW_MS = 180 * 86400e3
export const UP_REGULAR_CAP = 20
```

---

## 2. 三档刷新 `lib/refresh.mjs`

**纯逻辑。** 用户原话：“打开 > 三小时，以及 6 小时自动探测，触发同时清零”。

```js
export const OPEN_AFTER_MS  = 3 * 3600e3    // 打开面板，距上次探测 ≥3h 才探
export const AUTO_AFTER_MS  = 6 * 3600e3    // 不管开不开，≥6h 自动探
export const FULL_AFTER_MS  = 24 * 3600e3   // ≥24h 直接全量重建

/**
 * @param {{now:number, probedAt:number, fullAt:number, opened:boolean}} s
 * @returns {'full'|'probe'|'none'}
 */
export function decideRefresh(s)
```

判定顺序：

1. `!fullAt` 或 `now - fullAt >= FULL_AFTER_MS` → `'full'`
2. `opened && now - probedAt >= OPEN_AFTER_MS` → `'probe'`
3. `now - probedAt >= AUTO_AFTER_MS` → `'probe'`
4. 否则 `'none'`

**“触发同时清零”**：调用方在真正启动探测/重建时把 `probedAt = now`；
全量重建时再额外 `fullAt = now`。写进 `~/.dsh/bili-jar/refresh.json`：`{probedAt, fullAt}`。

---

## 3. 轻量探测（`lib/pool.mjs` 里的 `lightProbe`）

网络部分，复用 `pool.mjs` 内部的门槛函数（`passesHard` / `axisSim` 不在导出面上，所以放在这里）。

```js
export async function lightProbe(cfg, { ups = [], log = () => {} } = {})
// → { hit: [item...], checkedUp: n, searched: n, tookMs }
```

做的事情：

1. **熟人投稿**：`regular` 档最多 10 个，逐个 `userVideos(mid, 5)`
2. **轴最新页**：每根轴 1 次 `searchVideos(axis, 1, 'pubdate')`
3. 粗过滤（**放宽**，因为 2 小时内互动率根本没成熟）：
   - 发布 ≤ 2 天
   - 时长/充电/重复/播放门槛同主流程，但 `minPlay` 降到 `max(3000, minPlay * 0.3)`
   - 命中至少一根轴（`axisSim(it, axis).qualified`）
4. `hit` 就是过完这些的条目。**不重算分数、不写池子** —— 命中 ≥1 条就由调用方排队全量重建。

并发 3，请求间隔 200–400ms 抖动（B站会封）。

---

## 4. 防回音室（硬要求）

1. `main` 里熟人来源（`fromUpList: true`）最多 **`Math.max(1, Math.ceil(mainCount * 0.4))`** 条 —— 5 条时是 2。
2. 熟人条目**必须过全部硬门槛 + 至少命中一根轴**，不许绕过硬过滤。
3. 同一个 UP 仍限 1 条（现有 `perUpCount` 规则不动）。
4. 熟人候选不够就少用，**不凑数**。
5. 记进 `stats.echoGuard = { cap, upPicked, trimmed }`，被裁时打日志 `echo:cap`。

---

## 5. SWR（`index.js`）

`GET /feed`（不带 `refresh=1`）：

- 有 `feedCache` → **立刻**返回 `{...feedCache, cached:true, stale: age > FEED_TTL}`；
  同时按 `decideRefresh` 决定要不要在后台起活（不阻塞响应）
- 没有 `feedCache` → 同步构建（首次装罐）

`GET /feed?refresh=1` → 照旧同步等（用户点了「换一批」，愿意等）。

新增 `GET /feed?peek=1` → 只读，返 `{ok, ts, curated}`，给客户端轮询用。

客户端：拿到 `stale:true` 就正常渲染 + 角标「03:51 装的 · 后台在更新」；
后台完成后**不自动替换**正在看的卡片，顶部弹一行「新的一批装好了 · 点此查看」，点了才换。

---

## 6. 顺手修的三个小坑

1. `lib/bili.mjs` 的 `userVideos`：补 `dm_img_list`/`dm_img_str`/`dm_img_inter`/`web_location`，
   失败重试 1 次；仍失败把原因写进 `feed.upError`，UI「固定关注」空时能显示一句人话。
2. `index.js:903` 的 history 字段白名单加 `mid`（现在 `history.json` 全是 `mid: 0`）。
3. `feedback` 写入前按 `(bvid, action)` 去重（现在一条视频能记 3 行）。

---

## 7. 日志（不给设置页加界面）

- `ups:list` —— 熟人 N / 观察 N / 拉黑 N，附名字
- `refresh:trigger` —— `full|probe` + 原因（`open`/`auto`/`age`）
- `probe:run` / `probe:hit` —— 查了几个 UP、几条搜索、命中几条
- `echo:cap` —— 熟人超限被裁

---

## 8. 验收

- [ ] `node tools/ups-check.mjs`：去重、时间窗、三档、上限、无 mid 跳过
- [ ] `node tools/refresh-check.mjs`：3h/6h/24h 三种触发 + 清零
- [ ] `node tools/probe-check.mjs`：离线假数据下命中判定
- [ ] 真机：重开 DSH 后面板立刻有卡片（不再空白）
- [ ] 真机：重建耗时 < 25s
- [ ] 真机：`/log` 能看到 `ups:list` 和 `refresh:trigger`
- [ ] 回音室：手工构造 10 个熟人，确认 `main` 里最多 2 条
