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

## 5. 完成后要做的事

1. **跑一遍全量验证**，把数字填进 §6：

```bash
node --test tools/config-check.mjs tools/tree-suggestions-check.mjs tools/freshness-check.mjs tools/score-freshness-check.mjs tools/pool-decay-check.mjs
node tools/feed.mjs 10000 0
```

2. **更新 README 的「一轮都经过什么」**：搜索那段要写清「1 个词走最新、2 个词走综合」；池子那段要写「重复出现会被扣分、池子上限 400」。
3. **版本号 +1（patch）**，更新日志加一条。
4. **不要自己打 tag / 发布 npm** —— 交给 Lead 复核后发。

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
