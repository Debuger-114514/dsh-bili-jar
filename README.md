# 电子榨菜罐 · dsh-bili-jar

> DSH 插件：右下角一只罐子，替你挑「今天看哪几条」B 站视频。

不靠 B 站 的推荐流。它按你自己写的一组**兴趣轴**去搜，用**互动率**（赞 / 币 / 藏）而不是播放量排好坏，把结果攒进一个**累积池**，点开就能看。

## 现在能做什么

- **按轴定向搜索**：轴 = 一组词（`deepseek` / `时政` / `科技测评` / `健身教程`），视频的 tag 贴近任意一根就入池
- **硬过滤**：时长 ≥ 8 分钟、播放量门槛、充电专属不推、直播回放不推
- **互动率打分**：点赞率 / 投币率 / 收藏率 / 弹幕率，加新鲜度、字幕、多轴覆盖
- **💎 宝藏标记**：收藏率和投币率同时进候选池前 20%
- **累积池**：今天没搜到的好东西，明天被别的关键词带出来也不会丢
- **换一批**：排除上一批，真的换而不是重排
- **稍后看**：本地存一份待看清单
- 罐子可拖动，位置记在本地

## 界面

右下角一只玻璃罐，点开是面板：`推荐 / 关注 / 待看` 三个页签，滚到底有「换一批」。

## 安装

⚠️ 桌面版 DSH 的 `desktop` profile 不允许用 CLI 装插件（`profile "desktop" is managed exclusively by the Electron application`）。当前只能手工装：

```jsonc
// ~/.dsh/profiles/desktop/package.json
{
  "dependencies": { "dsh-bili-jar": "link:D:/你的路径/电子榨菜罐" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-bili-jar"] } }
}
```

```bash
cd ~/.dsh/profiles/desktop && pnpm install
```

装完**必须重启 DSH**（bundle 层要重新组装）。

## 结构

| 文件 | 干什么 |
|---|---|
| `index.js` | host 半端：配置、`/api/bili-jar/{ping,state,feed,debug}` 路由、累积池落盘 |
| `client.js` | 浏览器半端：罐子 + 面板（`__ModuleLoader__` 自注册） |
| `lib/bili.mjs` | B站 客户端：WBI 签名 / 搜索 / 详情 / 粉丝 / 投稿 / tag |
| `lib/pool.mjs` | 候选池：轴匹配、硬过滤、打分、按轴轮转出片单 |
| `lib/hostdeps.mjs` | 从宿主树里取 `@deepseek-ai/schemastery`（含桌面版 `app.asar` 路径） |
| `docs/` | 设计记录：接口实测、tag 树算法 |

## 工具

```bash
node tools/why.mjs BV1xxxxx        # 这条为什么没进罐子？逐关诊断
node tools/feed.mjs 10000 0        # 跑一次建池，打印片单
node tools/probe.mjs deepseek      # 勘探接口字段
node tools/crawl-tags.mjs 4        # 抓 tag 语料
node tools/tag-tree.mjs            # 从语料里聚类出 tag 树
```

## 已知限制

- 时政区大量视频**没有 tag**，只能靠标题里的实体词判定
- 「时政」这个词在 B 站 被考公党占领，真·国际时政要用实体词搜（见 `docs/tag-tree.md`）
- 粉丝数按 UP 查、没法批量，只对进决赛圈的候选查
- LLM 终审（判营销号）还没做

## 许可

MIT
