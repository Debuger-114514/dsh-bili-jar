# 阶段 1 实测记录（B站 接口）

> 环境：2026-10-21 01:10，澳洲 IP，**未登录**，Node 24。
> 结论全部来自 `tools/probe.mjs` 实跑，不是文档抄来的。

## 一句话结论

**搜索、详情、粉丝，三条路都不需要登录就能走通。** 充电视频在搜索层就有标记，不用再查详情。

## 逐项实测

| 问题 | 结论 | 说明 |
|---|---|---|
| 搜索能用吗 | ✅ `code=0`，20 条 | `/x/web-interface/wbi/search/type?search_type=video` |
| 返回多少字段 | 66 个 | 含 `duration` `tag` `is_charge_video` `subtitle` `is_pay` |
| `duration` 格式 | `"21:9"` / `"208:0"` | 是 `分:秒`，不是 `时:分`；要自己解析成秒 |
| `tag` 格式 | 逗号分隔字符串 | `"deepseek,dsh,大肥鱼,ai,刷屏"` |
| **充电视频** | ✅ `is_charge_video === 1` | **搜索层直接过滤，0 额外请求** |
| 详情老接口 | ❌ 被 WAF 挡 | `/x/web-interface/view` 返回 HTML，不是 JSON |
| 详情新接口 | ✅ `code=0` | 改走 `/x/web-interface/wbi/view`（要 WBI 签名） |
| 详情充电字段 | ✅ 5 个 | `is_upower_exclusive` / `is_upower_play` / `is_upower_preview` / `is_chargeable_season` / `is_upower_exclusive_with_qa` |
| 粉丝数 | ❌ `acc/info` 的 `fans` 是 null | B站 已经把它挪走了 |
| 粉丝数（正确路） | ✅ `/x/relation/stat?vmid=` 的 `follower` | 实测拿到 8652 |

## 踩到的坑

1. **搜索结果里有 `bvid` 为空的行**（直播卡片、专题聚合）。入池前必须 `filter(it => it.bvid)`，否则后面查详情会炸。
2. **`buvid3` 要先拿**（`/x/frontend/finger/spi`）。没有它，同一台机器连搜几次就会被 `-352` 打回来。
3. **WBI 签名是硬门槛**：`w_rid` = md5(排序后的 query + mixinKey)，`mixinKey` 由 `nav` 里的两个 key 按 64 位表重排得到。少了它，搜索和详情都返回 `-403`。
4. **未登录也能跑，但排序会漂**：同一关键词两次搜，前几条顺序不一样。所以「判重」不能只靠排名，必须靠 BV 号。
5. **非大陆 IP 暂时没被挡**，但风控更敏感。请求间隔要留（目前打算 300–600ms + 每个关键词一页）。

## 对设计的影响

- **充电检测的成本归零**：原计划「只对入选的前 N 条查详情」，现在搜索层就能滤掉，连那 8 次请求都省了。详情只在需要「分P / 精确时长」时才查。
- **粉丝数变贵了**：一个 UP 一次 `relation/stat`，没法批量。所以必须靠缓存（按 mid，TTL 7 天），并且只对**已经通过 tag/时长/充电筛选**的候选查。
- **`subtitle` 字段**：搜索结果里带这个布尔值，可以提前知道「这条有没有字幕」，用来决定要不要走读字幕那条路——不用等字幕接口返回空。

## 下一步（阶段 2）

1. 多轴搜索：每根轴 × 同义词 → 候选池（含节流）
2. 结构化过滤：时长 / 充电 / bvid 非空 / 发布时间窗
3. 打分：tag 贴近度（Jaccard）+ 轴覆盖
4. 片单：主推荐 N 条 + 固定 UP 板块
