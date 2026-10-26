# 「总在推旧内容」—— 诊断审核 + 施工指令

> 2026-10-26 · 诊断原文由 GLM 写，DeepSeek 审核并改写成施工单。
> **给执行者（GLM）**：按 §4 的任务表从上往下做，一次只做一个任务，做完自测再进下一个。

---

## 1. 审核结论

诊断的六条根因**全部成立**，代码位置对得上，权重算得也对。采纳。

### 两处要修正

| 原文说法 | 实际情况 |
|---|---|
| `node tools/why.mjs BV1xxxx` 可以逐关看 | **这个文件不存在**。需要先用 `tools/feed.mjs`，或在 T6 里顺手新建 `tools/why.mjs` |
| 预设轴「20+ 根是 evergreen」 | 实际 **14 根**（游戏/音乐/动画/影视/生活/美食/纪录片/学习/手工/摄影/历史/编程/数学/物理），新闻类 7 根，其余走默认 news |

### 一处补充

原文引用的行号（`pool.mjs:315` 等）会随改动漂移。**执行时按函数名定位**，不要按行号跳转：

| 要改的位置 | 函数 / 段落 |
|---|---|
| 搜索循环 | `buildPool()` 的「1. 搜」段 |
| 打分 | `scoreItem()` 的 `base` 计算 |
| 池子合并 | `buildPool()` 的「2. 合并」段 |
| 补货 | 「3b. 冷门轴补货」段 |
| 改判 | 「3c. 就地改判」段 |
| 排除集 | `index.js` 的 `openFeed()` 里 `const exclude =` |
| 策展行 | `lib/curator.mjs` 的 `lineOf()` |

---

## 2. 目标（可量化）

改完之后，用 `node tools/feed.mjs 10000 0` 跑一轮，看：

| 指标 | 现状 | 目标 |
|---|---|---|
| `main` 里 14 天内发布的占比 | 未测，估计 <20% | **≥ 40%** |
| 连续两轮 `main` 的 BV 重叠 | 4–5 条 | **≤ 1 条** |
| 池子里 `stats.fresh`（近 7 天新增） | 没有这个字段 | **> 0，且能看见** |
| 池子总量 | 无上限，只增不减 | **≤ 400** |
| **近 4 天进前 24**（T8 之后新增） | **0**（实测） | **≥ 3** |
| **`main` 里 ≤3 天条数**（T9 配额） | 0 | **≥ 1** |

这些是**方向性目标**，不是硬性 KPI。达不到不许硬凑（比如不许为了指标降 `minPlay`）。

---

## 3. 约束（违反任何一条都算失败）

1. **不加依赖**。新写的必须是纯函数 + Node 内置。
2. **现有 20 个测试全绿**：`node --test tools/config-check.mjs tools/tree-suggestions-check.mjs tools/freshness-check.mjs`
3. **权重表必须各自合计 1.00**（news 一套、evergreen 一套），改动要在注释里写清差额去哪了。
4. **不改公开路由**（`/feed`、`/tree`、`/more`、`/state` 的字段只增不删）。
5. **不重构无关代码**。一个任务只碰它该碰的文件。
6. **不降质量门槛**：`minPlay`、时长窗口、贴轴条件都不许为了「让新视频进来」而放宽。
7. 注释与提交信息用中文。提交粒度：**一个任务一个 commit**，消息格式 `fix(recency): T1 检索混血 —— 每个轴第三个词走 pubdate`。

---

## 4. 任务表

按顺序做。T1/T2 是主干，T3/T4 是防重复，T5 是防误判，T6 是最后一道闸。

---

### T1 · 检索混血：让新视频有入口

**为什么**：`buildPool()` 的全部搜索都写死 `'totalrank'`，B 站 综合排序天然把老爆款排前面。候选池进料就偏老，后面怎么调都是巧妇难为无米之炊。

**改哪**：`lib/pool.mjs` 的「1. 搜」段、`bandOf` 附近。

**怎么改**：

1. `termsOf(axis, hour)` 现在返回 3 个词。改成**按次序给不同的排序**：

```js
// 第 1 个词是主词，走综合（保住相关性）；第 3 个是轮换词，走最新（拿到新内容）
const ORDER_BY_SLOT = ['totalrank', 'totalrank', 'pubdate']
```

2. `searchVideos(term, 1, order)` 用这个 order；`stats` 新增 `byOrder: { totalrank: n, pubdate: n }`。

3. **补货的时长带重搜**（「3b」段）也要按轴选排序：

```js
const order = freshnessOf(axis) === 'evergreen' ? 'totalrank' : 'pubdate'
```

4. 并发度不要提高，保持现在的串行 + `sleep`。**B 站 会限流，别为了快导致失败率上升。**

**验收**：

- `node tools/feed.mjs 10000 0` 输出里能看到 `byOrder.pubdate > 0`
- 同一组轴跑前后对比：池子里 `14 天内` 的条目数**必须增加**（把两次数字写进 §6 的表格）
- `npm test` 绿

**风险**：pubdate 结果里标题党、低质内容更多。**不要为此加新过滤器** —— 现有 `spamScore` + 互动率打分 + 贴轴已经在挡，先看效果。

---

### T2 · 兑现 evergreen 的 0.02 时效权重

**为什么**：README 和 `freshness.mjs` 都写「evergreen 时效分 0.02」，但 `scoreItem()` 里权重写死 0.10，归一窗口也用的是**全局** `maxDays`。结果是：evergreen 轴超过 14 天的条目 `freshN` 一律为 0，文档承诺没实现。

**改哪**：`lib/pool.mjs` 的 `scoreItem()`。

**怎么改**：

1. 用 `best.axis` 查 freshness（`freshnessOf` 已经 import 了）：

```js
const fresh = freshnessOf(best.axis)
const window = fresh === 'evergreen' ? 365 : Math.max(1, Number(ctx?.maxDays) || 14)
const freshN = clamp01(1 - daysAgo(it.pubdate) / window)
```

2. 两套权重，**各自合计 1.00**：

| 项 | news | evergreen | 说明 |
|---|---|---|---|
| 贴轴 sim | 0.30 | 0.30 | 不变 |
| 赞率 | 0.15 | 0.15 | 不变 |
| 币率 | 0.12 | 0.12 | 不变 |
| 藏率 | 0.12 | 0.12 | 不变 |
| **时效** | **0.10** | **0.02** | 差额 **−0.08** |
| 字幕 | 0.06 | 0.06 | 不变 |
| **播放** | **0.05** | **0.08** | +0.03 |
| 多轴 | 0.04 | 0.04 | 不变 |
| **小众 tag** | **0.06** | **0.11** | +0.05 |
| 合计 | 1.00 | 1.00 | |

3. 在 `scoreItem` 上方写一段注释，说明「差额给了播放和小众 tag，因为 evergreen 轴不靠新鲜度区分，靠长尾品质」。

**验收**：

- 新增 `tools/score-freshness-check.mjs`：
  - 同一条 400 天前的视频，挂在 evergreen 轴时分数比挂在 news 轴时**高**（因为 news 的 freshN 为 0、权重还大）
  - evergreen 轴 100 天前的条目 `freshN` 仍然 > 0（365 天归一）
  - 两套权重表相加都是 1.00（用常量导出后断言）
- `npm test` 绿

---

### T3 · 池子新陈代谢

**为什么**：池子只进不出。`firstSeen` / `lastSeen` 记了但**全工程没人读**。一个视频一旦高分就永远高分，每轮都排前面。

**改哪**：`lib/pool.mjs` 的合并段、打分后、以及 `toCard()`。

**怎么改**：

1. 每条记录加 `shownTimes: number`（进过 main 几次，默认 0）。
2. `index.js` 里选完 main 之后，给这 5 条 `shownTimes += 1`，随池子落盘。
   - 注意：`/more` 追加的条目不算（那是用户主动要的）。
3. **重复惩罚**（在 gem 加成之后、排序之前）：

```js
c.score = Number((c.score - Math.min(0.15, 0.03 * (c.shownTimes || 0))).toFixed(4))
```

封顶 0.15，不能把一条好视频直接判死。

4. **池子上限 400**：合并后如果超了，按 `lastSeen` 从旧到新删，删到 400 为止；同分时优先删 `shownTimes` 高的。

**验收**：

- 新增 `tools/pool-decay-check.mjs`：
  - `shownTimes = 3` 的条目比同条件 `shownTimes = 0` 的低 0.09 分
  - 惩罚封顶 0.15（`shownTimes = 10` 时也只减 0.15）
  - 500 条进池后出来 ≤ 400 条，且被删的是 `lastSeen` 最旧的
- `npm test` 绿

---

### T4 · 排除集扩容

**为什么**：`exclude` 只有上轮 5 条 + 历史 10 条。池子里 24 条决赛圈，排除 5–10 条后还是同一批老面孔。

**改哪**：`index.js` 的 `openFeed()`。

**怎么改**：

1. `lastShown`（存最近一轮 5 个 BV）改成 `recentShown`（**最近 5 轮，最多 25 个**）。
2. 持久化文件仍用 `shown.json`，但格式改成 `{ rounds: [[...], ...] }`；**读的时候要兼容旧格式（纯数组）**，否则老用户升级会崩。
3. `exclude` 用 `recentShown` 拍平 + 历史。

**验收**：

- 单测：旧格式 `["BV1","BV2"]` 能被读成 1 轮；新格式写出去再读回来一致
- 手动：连点两次「换一批」，两轮 main 的 BV 集合**不重叠**
- `npm test` 绿

---

### T5 · 补货与改判加防护

**为什么**：补货只在「凑不够 3 条」时触发，不看新不新；种子按播放量取前 3，等于「用老爆款找老片」。更严重的是 3c：因为池子进料偏老 → 算出年龄中位数偏大 → 判定这根轴 evergreen → 彻底拆掉日期窗。**这是系统里最强的正反馈回路。**

**改哪**：`lib/pool.mjs` 的「3b」「3c」段，`lib/freshness.mjs` 的 `decideFreshness()`。

**怎么改**：

1. **种子换排序**：不再只按播放量。改成先按「近」再按播放：

```js
// 30 天内发布的优先当种子，同期再比播放量
const seedScore = (it) => (daysAgo(it.pubdate) <= 30 ? 1 : 0) * 1e9 + (it.play || 0)
```

2. **补货顺序**：先跑 `pubdate` 时长带重搜（拿新内容），仍不够再走 related。

3. **改判加防护**：`decideFreshness` 增加第二个参数 `freshCount`（近 14 天合格条目数）。**`freshCount >= 2` 时不允许判 evergreen**，理由写进 `reason`：「近两周有 N 条新内容，不判常青」。

4. 3c 调用处把 `freshCount` 算出来传进去。

**验收**：

- 单测：`decideFreshness(ages, { freshCount: 3 })` → `news`；`freshCount: 0` 且中位 300 天 → `evergreen`
- 现有 `tools/freshness-check.mjs` 5 个用例改造后仍绿
- `node tools/feed.mjs 10000 0` 跑一轮，日志里不再出现「时政这类 news 轴被改判成 evergreen」

---

### T6 · 让策展人看见日期

**为什么**：`lineOf()` 拼的行里没有发布日期，模型判断依据还是「数据是不是真被喜欢」——这按构造就是老视频赢。

**改哪**：`lib/curator.mjs`。

**怎么改**：

1. `lineOf()` 追加一列：`发布${Math.round(days)}天前`（缺 pubdate 时写 `日期未知`）。
2. system prompt 加两句：

```
- 候选行里带「发布X天前」。同等条件下优先较新的。
- 教程、音乐、历史这类常青内容，老一点不是缺点；新闻、时事、数码新品这类，旧的就是过期。
```

3. **不要**让模型把日期写进理由（现有的「理由里不许出现数字」规则保留）。

**验收**：

- `npm test` 绿
- 用 `node tools/feed.mjs` 跑出的候选手工调一次 `curate()`，确认解析不炸（可以只跑 3 条候选）
- prompt 增量 < 150 token（自己数一下）

**顺手做**：新建 `tools/why.mjs`，给一个 BV，逐关打印：在不在池里 / 过没过硬过滤 / 贴哪根轴 / 分数明细 / 排第几。原诊断提到它但文件不存在。

---

### T7 · 缺日期不再按 99 天判死

**为什么**：`daysAgo()` 对缺失 pubdate 返回 99，直接拿 0 时效分，而老视频不受影响 —— 这是隐性惩罚。

**改哪**：`lib/pool.mjs` 的 `daysAgo()`、`scoreItem()`。

**怎么改**：

- 新增 `ageOf(it)`：有日期返回天数，没有返回 `null`。
- `scoreItem` 里 `freshN = age === null ? 0.5 : clamp01(...)`（中性值），别给满分也别给 0。
- 统计（`perAxis.medianAge`）里跳过 null。

**验收**：单测：缺日期条目得分介于「今天发的」和「一年前的」之间。

---

### T8 · 冷启动补偿（第二轮的根因，优先级最高）

> 2026-10-27 追加。T1–T7 上线后实测仍然「推的都是几天前的」，查出更深一层的原因。

#### 实测证据（`~/.dsh/bili-jar-test`，197 条池子，8 根轴）

按发布时间分组：

| 年龄 | 条数 | 分数中位 | 有互动数据 | 进前 24 |
|---|---|---|---|---|
| 0–1 天 | 7 | 0.490 | **0** | **0** |
| 1–2 天 | 12 | 0.499 | **0** | **0** |
| 2–3 天 | 28 | 0.487 | **0** | **0** |
| 3–4 天 | 19 | 0.423 | **0** | **0** |
| 4–7 天 | 74 | 0.485 | 52 | 15 |
| 7 天以上 | 57 | 0.536 | 47 | 9 |

按「有没有互动数据」分组：

| 组 | 条数 | 分数中位 | 平均年龄 | 进前 24 |
|---|---|---|---|---|
| 有数据（补查过） | 99 | **0.545** | 7.4 天 | **24 / 24** |
| 没有数据 | 98 | **0.478** | 3.7 天 | **0** |

**门槛 0.605，近 4 天最高分 0.516，差距 0.089。**

#### 机制：补查闭环

```
搜索接口不返回投币/收藏
  → 新条目进池时 币=0 藏=0，互动分（最多 0.39）拿不到
  → 初评落后
  → 只有「初评前 12 名」才补详情（coin/fav）
  → 新条目永远挤不进前 12 → 永远没数据 → 永远落后
```

老条目一旦被补过数据，就带着这 0.09 的优势稳定占据前 24。

#### 模拟（同一份池子，197 条）

| 方案 | 近 4 天进前 24 |
|---|---|
| 现状 | 0 |
| 只给新片平加 +0.09 | 1 |
| 只补数据（不加分） | 1 |
| 补数据 + 新片 +0.03（≤3 天） | 6 |
| 补数据 + 衰减 0.05 / 0.03 / 0.01 | **8** |

结论：**加分只是放大镜，补数据才是杠杆**。而且「无条件平加」会把 18k 播放的片子顶进前 24，所以 bonus 必须带门槛。

---

#### T8a · 给新条目补互动数据

**字段**：池子条目新增 `statsAt`（互动数据抓取时间戳；0 = 从未补过）与 `statsTries`（尝试次数）。

**改哪**：`lib/pool.mjs` 的合并段（`toCandidate`）、硬过滤之后、初评之前；`lib/bili.mjs` 的 `videoDetail` 已有。

**怎么改**：

1. `toCandidate()` 保留 `statsAt: old?.statsAt || 0`、`statsTries: old?.statsTries || 0`。
2. 在「3. 硬过滤」之后、`collect()` 之前插一段「3a. 冷启动补数据」：

```js
// 缺互动数据的候选：搜索接口不给 coin/fav，只有详情接口有。
// 每轮只补一小批（新进池优先），避免请求量失控。
const COLD_LIMIT = 8
const coldNeed = candidates.filter((it) =>
  !it.statsAt && !(Number(it.coin) > 0) && !(Number(it.favorites) > 0) && (it.statsTries || 0) < 3
).sort((a, b) => (b.firstSeen || 0) - (a.firstSeen || 0) || (b.play || 0) - (a.play || 0)).slice(0, COLD_LIMIT)
```

3. 对这批并发补详情（**并发 4**，照抄现有前 12 名补查的写法）：

```js
await Promise.all(coldNeed.map(async (it) => {
  it.statsTries = (Number(it.statsTries) || 0) + 1
  try {
    const d = await videoDetail(it.bvid)
    const st = d?.data?.stat
    if (st) {
      it.like = Number(st.like) || it.like || 0
      it.coin = Number(st.coin) || it.coin || 0
      it.favorites = Number(st.favorite) || it.favorites || 0
      it.danmaku = Number(st.danmaku) || it.danmaku || 0
      it.play = Math.max(Number(st.view) || 0, it.play || 0)
      it.statsAt = Date.now()
      stats.detailCold += 1
    }
  } catch (e) { stats.detailColdFailed += 1 }
}))
```

4. `stats` 新增 `detailCold`、`detailColdFailed`；日志一行 `冷启动补数据：成功 N / 失败 M`。

**注意**：

- `videoDetail` 的返回值字段名先核对（`stat.view` / `stat.like` / `stat.coin` / `stat.favorite` / `stat.danmaku`），不要凭记忆写。
- 失败的条目**不要**写 `statsAt`，但要 `statsTries += 1`，到 3 次放弃。
- 这 8 条是**额外**于原有「前 12 名补查」的，两段互不影响。

---

#### T8b · 冷启动加分（只在缺数据时给）

**为什么不能无条件给**：模拟里平加会放进 18k 播放的片子。加分要补偿的是「数据缺失」，不是「年龄小」。

**新增导出**（`lib/pool.mjs`）：

```js
export const COLD_START = { day2: 0.05, day4: 0.03, day7: 0.01, minPlayFloor: 50000 }

/**
 * 冷启动补偿：条目还没补到互动数据时，按年龄给一点点分，
 * 让它有机会进入决赛圈；一旦补过详情（statsAt > 0）就不再给 —— 补贴是临时的，不是永久的。
 */
export function coldStartBonus(it, opts = {}) {
  if (!it || it.statsAt) return 0
  if (Number(it.coin) > 0 || Number(it.favorites) > 0) return 0
  const age = ageOf(it)
  if (age === null) return 0
  const floor = Math.max(COLD_START.minPlayFloor, (Number(opts.minPlay) || 0) * 2)
  if ((Number(it.play) || 0) < floor) return 0
  if (spamScore(it.title) > 0.2) return 0
  if (age <= 2) return COLD_START.day2
  if (age <= 4) return COLD_START.day4
  if (age <= 7) return COLD_START.day7
  return 0
}
```

**接到打分里**：`scoreItem()` 中，`affinityDelta` 之后：

```js
const cold = coldStartBonus(it, { minPlay: ctx?.minPlay })
it.coldBonus = Number(cold.toFixed(4))
score += cold
if (cold > 0) it.reasons.push('缺互动数据，按冷启动补偿')
```

`scoreItem` 的 `ctx` 需要新增 `minPlay`（`buildPool` 里传进去）。

**必须遵守**：

- 上限就是 0.05，**不许调大**（它只有时效权重的 5%，盖不过贴轴 0.30）
- **不许改动 `WEIGHTS` 表** —— bonus 是增量，不是权重，权重合计仍必须各为 1.00
- 补过数据的条目（`statsAt > 0`）**永远不给**

---

#### T8c · 告诉模型「数据未补」

**问题**：即使加了分，模型看到的还是「赞 0% 币 0% 藏 0%」，会误判成没人看。

**改哪**：`lib/curator.mjs` 的 `lineOf()` 与 system prompt。

1. `lineOf` 加一列：`c.statsAt ? '数据:全' : '数据:未补'`
2. system prompt 加一句：

```
- 标了「数据:未补」的候选，率值偏低是因为还没回查，不代表没人喜欢；不要用数据否定它们。
```

**验收**：候选中同时出现「数据:全」「数据:未补」两种；prompt 增量 < 80 token。

---

#### T8d · 观测

`stats` 新增：

```js
coldStart: { need: coldNeed.length, applied: stats.detailCold, failed: stats.detailColdFailed }
```

片单里保留 `it.coldBonus`，`toCard()` 带出去（前端暂不显示，方便 `tools/why.mjs` 打印）。

---

#### T8 验收（必须逐条做到）

1. 新增 `tools/cold-start-check.mjs`，至少 8 个用例：

| 场景 | 期望 |
|---|---|
| 缺数据 + 1 天 + 30 万播放 | 0.05 |
| 缺数据 + 3 天 + 30 万播放 | 0.03 |
| 缺数据 + 6 天 + 30 万播放 | 0.01 |
| 缺数据 + 1 天 + 3 万播放 | 0（低于门槛） |
| 缺数据 + 1 天 + 30 万播放，但标题党 | 0 |
| 有 `statsAt` | 0 |
| 有 coin 或 favorites | 0 |
| 缺 pubdate | 0 |

2. `node --test tools/*.mjs` 全绿（原 38 个 + 新增）
3. `node tools/feed.mjs 10000 0` 输出：
   - `stats.detailCold > 0`
   - `stats.coldStart.applied > 0`
   - `main` 里「≤4 天」**至少 1 条**（现状 0）
4. 用真实配置（8 根轴）跑一轮，把「近 4 天进前 24」的条数填进 §6（模拟值 8，实际 ≥3 就算通过）
5. `node tools/pack-check.mjs` 过

#### T8 风险与边界

- 每轮多 8 次详情请求，约 +4 秒；**不许为了快提高并发到 8 以上**（B 站 会限流）
- 不许把 `COLD_LIMIT` 调到 20 以上（会变成全池补数据）
- 不许把 bonus 加到 `freshN` 权重里去（那样等于改权重表）
- 如果 `videoDetail` 拿不到 coin（接口变了），**先停下来报告**，不要用别的接口硬凑

---

### T9 · 新鲜度配额（确定性兜底）

> 2026-10-27 追加，与 T8 一起做。T8 靠分数，T9 靠规则 —— 分数分布再怎么调，都可能被更强的老片整体压住；配额保证「至少一条新的」。

**规则**：

> `mainCount` 条里，**至少 1 条**满足：`≤3 天` 且 `播放 ≥ max(50000, 全局 minPlay × 2)` 且 `贴轴` 且 `非标题党`。

**改哪**：`lib/pool.mjs` 的选片段（`tryPick` 循环之后、固定 UP 之前）。

**怎么改**：

1. 选完 `picked` 后检查：

```js
const freshOk = (c) => {
  const age = ageOf(c)
  return age !== null && age <= 3 &&
    (c.play || 0) >= Math.max(50000, minPlay * 2) &&
    c.axis && spamScore(c.title) <= 0.2
}
const hasFresh = picked.some(freshOk)
```

2. 若 `!hasFresh` 且 `picked.length >= 3`（少于 3 条时不强凑）：

```js
// 从合格候选里挑一个够格的新的（分数最高的那个）
const freshCand = qualified
  .filter((c) => freshOk(c) && !taken.has(c.bvid) && !exclude.has(c.bvid))
  .sort((a, b) => b.score - a.score)[0]

if (freshCand) {
  // 替换「分数最低、且不是它那根轴唯一一条」的
  const victims = picked
    .filter((c) => perAxisCount.get(c.axis) > 1)
    .sort((a, b) => a.score - b.score)
  const victim = victims[0]
  if (victim) { 从 picked 移除 victim，放回 perAxisCount / perUpCount；再 tryPick(freshCand, freshCand.axis) }
}
```

3. `stats.freshQuota = { needed: !hasFresh, replaced: victim ? 1 : 0 }`；日志一行 `新鲜度配额：用 X 换掉 Y`。

**必须遵守**：

- **不许**为了配额把 `picked` 填到超过 `mainCount`
- 替换目标必须满足「那根轴还有别的条目」，否则会把某根轴整个挤掉
- 找不到合格的新的 → **不替换**，`replaced = 0`，不要放宽条件去凑

**验收**：

- 单测 `tools/fresh-quota-check.mjs`：
  - 池子里全是老片、但有一条够格的新片 → 结果含 1 条新的
  - 够格的新片不存在 → 结果不变、`replaced = 0`
  - 新片所在轴只有一条老片 → 不替换那一条（轴不被清空）
  - `picked.length < 3` → 不触发
- `node tools/feed.mjs 10000 0` 跑两轮，`main` 里 ≤3 天的**至少 1 条**（两轮都满足）

---

### T10 · 互动数据会过期，定期刷新

**问题**：T8a 补的数据是「补的那一刻」的快照。一条 5 天前补过的视频，现在播放可能翻了十倍，分数还按旧数据算。

**改哪**：`lib/pool.mjs` 的冷启动补数据段（T8a 那段）。

**怎么改**：

1. 在 T8a 的 `coldNeed` 之外，再加一批「过期刷新」：

```js
const REFRESH_LIMIT = 3
const REFRESH_AFTER_MS = 7 * 86400000
const staleNeed = candidates
  .filter((it) => it.statsAt && Date.now() - it.statsAt > REFRESH_AFTER_MS)
  .sort((a, b) => (b.play || 0) - (a.play || 0))     // 播放高的先刷
  .slice(0, REFRESH_LIMIT)
```

2. 复用同一段详情补查逻辑（成功写 `statsAt = now`），`stats.detailRefresh += 1`。
3. 日志：`数据刷新：N 条`。

**边界**：

- 每轮最多 3 条，**不和 T8a 的 8 条合并计数**（可以同时发生，总请求上限 = 12 + 8 + 3）
- 刷新失败**不重置** `statsAt`（保持旧数据，下轮再试）
- 只刷新「还在池子里且合格」的条目，不刷全池

**验收**：

- 单测：`statsAt` 8 天前的被选中；3 天前的不选；最多 3 条
- `stats.detailRefresh` 出现且 ≤3

---

### T11 · 播放增速（用「涨得快」当冷启动的质量信号）

**问题**：新条目互动率低是正常的，但**播放涨得快**说明它正在被传播 —— 这是新条目唯一现成的质量信号。可惜现在只存当前播放量，没有对比。

**改哪**：`lib/pool.mjs` 的合并段 `toCandidate()`、冷启动排序、`coldStartBonus()`。

**怎么改**：

1. 条目新增两个字段：`playPrev`（上次记录的播放）、`playAt`（上次记录的时间戳）。
2. 合并时先算增速，再覆盖：

```js
const prevPlay = Number(old?.play) || 0
const prevAt = Number(old?.playAt) || 0
const gapDays = prevAt ? (now - prevAt) / 86400000 : 0
const growth = prevAt && gapDays >= 0.25 && prevPlay > 0
  ? Math.max(0, (playNow - prevPlay) / gapDays)   // 每天涨多少播放
  : null
// 写回：playPrev = playNow, playAt = now, playGrowth = growth
```

`gapDays < 0.25`（不到 6 小时）时不计算，避免噪声。

3. **用途一（主要）**：冷启动补数据的排序，增速高的先补：

```js
.sort((a, b) => (b.playGrowth ?? -1) - (a.playGrowth ?? -1) || (b.firstSeen || 0) - (a.firstSeen || 0))
```

理由：涨得快的先拿到数据，收益最大。

4. **用途二（次要）**：`coldStartBonus` 里加一个很小的增量，**但总分不超过 0.05**：

```js
const growthBonus = (it.playGrowth ?? 0) >= 50000 ? 0.01 : 0
return Math.min(COLD_START.day2, base + growthBonus)   // base 是 T8b 的三档之一
```

5. `stats.growthSeen`：本轮有多少条目算出了增速（可观测）。

**边界**：

- 没有 `playAt`（首次见到）→ `playGrowth = null`，**不参与任何判断**
- 增速可能是负数（播放被清、数据回退）→ 夹到 0，不惩罚
- **不许**把增速做成独立权重项，它只是冷启动内部的排序与 +0.01 微调

**验收**：

- 单测 `tools/growth-check.mjs`：
  - 两次见到，间隔 1 天，播放 10 万 → 20 万 → 增速 10 万/天
  - 间隔 <6 小时 → `null`
  - 首次见到 → `null`
  - 播放倒退 → 增速 0（不是负数）
  - 增速 ≥5 万时，冷启动总分仍 ≤0.05

---

### 三个任务的先后

```
T8（补数据 + 冷启动加分）
  ↓ 必须串行
T11（增速）── 依赖 T8a 的补数据段，复用同一个循环
T10（刷新）── 依赖 T8a 的补数据函数，抽出来复用
T9（配额）── 独立，可以并行做，但要在 T8 之后跑验收（否则数字对不上）
```

建议顺序：**T8 → T9 → T11 → T10**。
T9 早做，因为它不依赖数据、能马上验证「至少一条新的」；T10/T11 是优化，放后面。

---

## 5. 完成后要做的事

1. **跑一遍全量验证**，把数字填进 §6：

```bash
node --test tools/config-check.mjs tools/tree-suggestions-check.mjs tools/freshness-check.mjs tools/score-freshness-check.mjs tools/pool-decay-check.mjs
node tools/feed.mjs 10000 0
```

2. **更新 README 的「一轮都经过什么」**：搜索那段要写清「1 个词走最新、2 个词走综合」；池子那段要写「重复出现会被扣分、池子上限 400」；再加一行「新条目缺互动数据时会补查，并按冷启动给一点临时加分」。
3. **版本号 +1（patch）**，更新日志加一条。
4. **不要自己打 tag / 发布 npm** —— 交给 Lead 复核后发。

### 第二轮（T8–T11）额外的验证命令

```bash
node --test tools/cold-start-check.mjs tools/fresh-quota-check.mjs tools/growth-check.mjs
node tools/feed.mjs 10000 0     # 看 stats.detailCold / coldStart / freshQuota
node tools/why.mjs BV1xxxxx     # 单条：有没有补数据、有没有吃到冷启动分
```

---

## 6. 结果记录（执行者填）

> 2026-10-27 填。测量口径：`node tools/feed.mjs 10000 0`（轴 = deepseek/时政/科技测评/健身教程，minPlay=10000），改前改后都是清空 `tools/pool.json` 的干净单轮；重叠是「第二轮把第一轮 main 传进 exclude」模拟的连点两次换一批。

| 指标 | 改前 | 改后 | 备注 |
|---|---|---|---|
| `stats.byOrder.pubdate` | — | 4 / 轮 | 3 次主搜（每轴第 3 词）+ 1 次时政轴补货；`totalrank` 8 次 |
| 池子里 14 天内条目数 | 18 / 54（33%） | 13 / 27（48%） | **绝对数没涨、占比涨了**：pubdate 通道拿回来的新视频很多过不了 minPlay=10000，池子整体变小但变新了。没硬凑（§2 的约定） |
| `main` 的 14 天内占比 | 100%（5/5） | 80%（4/5） | 基线首轮恰好全挑了新片；目标 ≥40% 两边都过，改后多出的一条老片来自 evergreen 轴（合理） |
| 连续两轮 main 重叠 | 5 / 5 | **0 / 5** | T3 重复扣分 + T4 排除集扩容的合力 |
| 池子总量 | 54 | 27 | 上限 400 生效中，远未触及；真实用户 8 根轴的池子 192 条 |
| `stats.fresh`（7 天内） | — | 12 | 新字段 |
| 测试通过数 | 20 | **38** | 新增 score-freshness(5) / pool-decay(6) / shown(6)，freshness-check 追加 1；`tools/pack-check.mjs` 也过 |

过程记录：

- 提交：`bd59e32` T1 / `b6143b8` T2 / `dca287c` T3 / `1f90d5c` T4 / `fa12ec6` T5 / `a228353` T6 / `187025a` T7，另有一个收尾提交（README + 版本号）。
- `tools/why.mjs` **其实已存在**（§1 审核说它不存在，不对）——按 T6 的要求升级成了完整版：池内 → 打分明细 + 排名 + shownTimes；池外 → 拉详情逐关（含日期窗口）。
- T6 冒烟：真实 key 调了一次 3 条候选的 `curate()`，返回 JSON 正常、理由无数字。prompt 增量：system 两条 ≈68 token（<150 ✓）；每行候选多 ~5 token × 24 行 ≈ 120。
- T5 验证：时政轴不再被改判；健身教程这轮仍改判 evergreen，但原因是「近两周凑不出 2 条合格新内容」（中位 839 天）——防护只拦「还有新内容的轴」，符合设计。
- T4 兼容性：旧格式（纯数组）shown.json 读成 1 轮，有单测覆盖。

---

## 6b. 第二轮结果记录（T8–T11，执行者填）

> 2026-10-27 填。测量口径：真实配置（8 根轴），prev = `~/.dsh/bili-jar-test/pool.json`（197 条），buildPool 直跑一轮，结果只写临时文件、不碰测试实例的数据目录。

| 指标 | T1–T7 之后 | T8–T11 之后 | 目标 |
|---|---|---|---|
| 近 4 天进前 24 | 0 | **4 / 24**（top24 里有 2/3/3/3 天的） | ≥ 3 ✓ |
| `main` 里 ≤4 天条数 | 0 | **3 / 5** | ≥ 1 ✓ |
| `main` 里 ≤3 天条数 | 0 | **1 / 5**（main 年龄 7/3/5/3/2 天） | ≥ 1 ✓ |
| `stats.detailCold` | — | **8**（失败 0） | > 0 ✓ |
| `stats.detailRefresh` | — | 0 | 0–3 ✓（首跑还没有超过 7 天的旧数据，符合预期） |
| `stats.coldStart.applied` | — | **8** | > 0 ✓ |
| `stats.freshQuota.replaced` | — | 0（needed=false：main 本来就有够格的新片；配额逻辑另有 6 个单测覆盖） | 记录即可 ✓ |
| 池子里「缺互动数据」占比 | 98 / 197（50%） | **99 / 206（48%）** | 每轮补 8 条（≈4pp/轮），随新条目进入动态平衡 |
| 测试通过数 | 38 | **62** | ≥ 46 ✓ |

过程记录：

- 提交：`599fd0a` T8 / `1be2539` T9 / `de9c90c` T11 / `16dde26` T10，另有一个收尾提交（README + 0.2.8）。
- **T8a 位置微调**：「3a」段放在 `candidates` 建好之后、初评之前 —— 施工单写「collect() 之前」，但它自己的代码片段引用了 `candidates`，而这个变量在 collect 之后才存在；取片段语义（只给贴轴合格的条目补数据，不浪费 8 个请求）。
- **T11 验证**：真跑两轮间隔不到 6 小时，增速按设计全是 null；把池子里 3 条的 `playAt` 拨回 1 天前再跑，`stats.growthSeen=1`、增速 15.6 万/天 —— 语义正确（增速只在「这轮又被搜到」时重算，另 2 条没被搜到就不动）。
- **「缺互动数据」两种口径**：施工单口径（币藏全 0，含老前 12 名补查路径给过数据的）99/206 = 48%；新字段口径（`statsAt=0`，从未走过冷启动补查）198/206 —— T8 刚上线，旧池子大部分还没轮到，每轮再补 8 条。

## 7. 明确不要做的

- ❌ 不要为了「显得新」调高 `freshN` 权重到 0.2 以上 —— 会变成「只推刚发的」，老精品全灭
- ❌ 不要删掉 evergreen 概念，也不要取消补货 —— 它们是 0.2.4 的核心卖点
- ❌ 不要给 `main` 加「必须 N 天内」的硬过滤 —— 常青轴会被清空
- ❌ 不要动探索/利用的随机性（hour 轮换那套）
- ❌ 不要改 UI 文案与布局（这一轮只动后端管线）
- ❌ 不要顺手升级依赖、改格式化、重排 import

---

## 附：原文保留的诊断细节

以下内容审核确认无误，执行时可参考（行号会漂，按函数名找）：

- 打分公式里「互动率 0.39 vs 时效 0.10」的算术成立：2052 天的精品攻略互动 ≈ 0.28，2 天的新片 ≈ 0.14，新鲜度最多补 0.10，追不上
- `gem` 加成（收藏+投币双高 +0.04）也是累计数据指标，同样偏老
- 池子只并进不淘汰，`firstSeen`/`lastSeen` 无人读取
- `history.json` 只存 10 条，`exclude` 因此很小
- 策展 prompt 的判断依据「数据是不是真被喜欢」按构造偏老
