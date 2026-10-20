/**
 * tools/crawl-tags.mjs —— 抓一批「视频 + 它的 tag」当语料
 * ============================================================================
 * 关键前提：**搜索结果自带 tag 字段**，所以抓 20 条视频只要 1 次请求。
 * 输出 data/corpus.json：[{ bvid, title, tags: [], play, duration }]
 *
 * 用法：node tools/crawl-tags.mjs [每词页数]
 * ============================================================================
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { searchVideos } from '../lib/bili.mjs'

const KEYWORDS = [
  // 时政
  '时政', '国际局势', '特朗普', '俄乌', '中东', '中美关系',
  // 科技 / 测评
  '科技测评', '数码', '手机评测', '笔记本', '耳机', '显卡',
  // 健身
  '健身', '健身教程', '减脂', '增肌', '跟练',
  // AI / 编程
  'deepseek', '大模型', 'AI编程',
]

const PAGES = Number(process.argv[2] || 4)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const seen = new Map()

const t0 = Date.now()
for (const kw of KEYWORDS) {
  for (let page = 1; page <= PAGES; page += 1) {
    let r
    try { r = await searchVideos(kw, page, 'totalrank') } catch (e) {
      console.error(`! ${kw} p${page}: ${e?.message ?? e}`)
      continue
    }
    let added = 0
    for (const it of r.items) {
      if (!it.bvid || seen.has(it.bvid)) continue
      seen.set(it.bvid, {
        bvid: it.bvid,
        title: it.title,
        tags: it.tags || [],
        play: it.play || 0,
        duration: it.duration || 0,
        foundBy: kw,
      })
      added += 1
    }
    console.error(`${kw} p${page}: +${added} (总 ${seen.size}, code=${r.code})`)
    await sleep(450)
  }
}

mkdirSync(new URL('../data/', import.meta.url), { recursive: true })
const out = new URL('../data/corpus.json', import.meta.url)
writeFileSync(out, JSON.stringify([...seen.values()], null, 0), 'utf8')
const withTags = [...seen.values()].filter((v) => v.tags.length).length
console.log(JSON.stringify({
  videos: seen.size,
  withTags,
  noTags: seen.size - withTags,
  avgTags: seen.size ? Number(([...seen.values()].reduce((a, v) => a + v.tags.length, 0) / seen.size).toFixed(2)) : 0,
  seconds: Math.round((Date.now() - t0) / 1000),
}))
