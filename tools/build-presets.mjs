/**
 * tools/build-presets.mjs —— 灌「预设树」：拿 B站 的分区当骨架，抓样本、聚类、起名
 * ============================================================================
 * 目标：别人装了插件，兴趣轴不管填哪个大类，都能有像样的子簇可用
 *       （而不是只有时政/科技测评那几根我手写的）。
 *
 * 做法：
 *   ① 分区表 + 每区 2–3 个检索词（手写，覆盖 B站 主要分区）
 *   ② 每区搜一轮，收集 tag
 *   ③ 复用 suggestSubs（DF + PMI）挖候选子簇
 *   ④ 让模型过一遍：起中文名、丢掉活动标签/噪声
 *   ⑤ 生成 lib/axis-presets.mjs（纯数据，随包发布）
 *
 * 跑法：
 *   ELECTRON_RUN_AS_NODE=1 "D:\HARNESS\DeepSeek Harness.exe" tools/build-presets.mjs
 *   只跑几个区：... tools/build-presets.mjs 游戏 音乐
 *   不调模型（省钱，只看规则结果）：... --no-llm
 *
 * 成本：20 个区 × 1 次调用 ≈ ¥0.04（谷时）
 * ============================================================================
 */
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { searchVideos } from '../lib/bili.mjs'
import { suggestSubs, setUserTree } from '../lib/tree.mjs'
import { reviewClusters } from '../lib/tree-review.mjs'

/** B站 主要分区：名字 → 检索词（第一条决定"这是哪个区"） */
const REGIONS = {
  游戏: ['游戏实况', '单机游戏', '手游'],
  音乐: ['音乐现场', '原创音乐', '翻唱'],
  舞蹈: ['舞蹈', '街舞', '宅舞'],
  动画: ['动画', '动漫', '番剧'],
  知识: ['科普', '知识', '科普知识'],
  科技: ['科技前沿', '数码产品', '科技测评'],
  影视: ['影视解说', '电影解说', '电视剧'],
  娱乐: ['明星八卦', '综艺', '娱乐圈'],
  生活: ['生活记录', '日常vlog', '生活方式'],
  美食: ['美食', '做饭', '美食探店'],
  运动: ['运动', '健身', '跑步'],
  汽车: ['汽车', '汽车评测', '试驾'],
  时尚: ['时尚', '穿搭', '美妆'],
  动物: ['动物', '宠物', '萌宠'],
  鬼畜: ['鬼畜', '鬼畜调教', '音MAD'],
  纪录片: ['纪录片', '纪实', '历史纪录片'],
  搞笑: ['搞笑', '沙雕', '搞笑视频'],
  学习: ['学习', '考研', '考公'],
  手工: ['手工', 'DIY', '手作'],
  摄影: ['摄影', '相机', '摄影技巧'],
  历史: ['历史', '历史解说', '世界史'],
  哲学: ['哲学', '哲学入门', '思想史'],
  心理学: ['心理学', '心理分析', '心理学知识'],
  编程: ['编程', '编程教程', '代码'],
  数学: ['数学', '数学科普', '高数'],
  物理: ['物理', '物理科普', '量子力学'],
  军事: ['军事', '军事科普', '武器装备'],
  财经: ['财经', '经济', '投资理财'],
  职场: ['职场', '职场经验', '求职'],
  育儿: ['育儿', '亲子', '家庭教育'],
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function loadCfg() {
  try { return JSON.parse(readFileSync(join(homedir(), '.dsh', 'bili-jar', 'config.json'), 'utf8')) } catch { return {} }
}

const args = process.argv.slice(2)
const noLlm = args.includes('--no-llm')
const only = args.filter((a) => !a.startsWith('--'))
const useLlm = !noLlm && Boolean(loadCfg().apiKey)

const cfg = loadCfg()
setUserTree({})

const out = {}
const report = []

/** 只跑部分区时，先把已经生成的并进来 —— 不然一次重跑会把别的区冲掉 */
if (only.length) {
  try {
    const prev = readFileSync(new URL('../lib/axis-presets.mjs', import.meta.url), 'utf8')
    const a = prev.indexOf('= {')
    const b = prev.lastIndexOf('}')
    if (a > 0 && b > a) Object.assign(out, JSON.parse(prev.slice(a + 2, b + 1)))
  } catch { /* 第一次跑，没有旧文件 */ }
}

for (const [region, terms] of Object.entries(REGIONS)) {
  if (only.length && !only.includes(region)) continue
  const byBvid = new Map()
  for (const term of terms) {
    const r = await searchVideos(term, 1)
    if (!r.ok) { report.push(`${region} / ${term}: 搜索失败 ${r.message || ''}`); continue }
    for (const it of r.items) {
      if (!it.bvid) continue
      byBvid.set(it.bvid, {
        bvid: it.bvid, title: it.title,
        tags: (it.tags || []).map((x) => String(x).trim().toLowerCase()).filter(Boolean),
        typeName: it.typeName || '',
      })
    }
    await sleep(400)
  }
  const items = [...byBvid.values()]
  if (!items.length) { report.push(`${region}: 没抓到样本`); continue }

  // 规则挖簇（这里没有轴，所以 qualify 全部通过）
  const sg = suggestSubs(items, region, () => ({ qualified: true }), { maxClusters: 4, minDf: 2 })

  // 这个词表拿来当轴的第一组匹配词（domain 词），最常用的 18 个 tag
  const df = new Map()
  for (const it of items) for (const t of new Set(it.tags)) df.set(t, (df.get(t) || 0) + 1)
  const vocab = [...df.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18).map(([t]) => t)

  let subs = sg.clusters.map((c) => ({ name: c.name, terms: c.terms }))
  let reviewNote = ''

  if (useLlm && sg.clusters.length) {
    const r = await reviewClusters({}, {
      axis: region,
      node: { search: terms, subs: [] },
      clusters: sg.clusters,
      api: { base: cfg.apiBase, key: cfg.apiKey, model: cfg.apiModel },
    })
    if (r.ok) subs = r.kept.map((k) => ({ name: k.name, terms: k.terms }))
    else reviewNote = r.note
  }

  // 一组「或」就够了：命中区名或任一大类 tag 都算贴这根轴。
  // （axisSim 的语义是「组之间且、组内或」，分区很粗，用两组建会过严。）
  out[region] = {
    search: terms,
    groups: [[region, ...vocab]],
    subs,
    cats: [region],
    none: [],
  }
  report.push(`${region}: 样本 ${items.length} · tag ${df.size} · 子簇 ${subs.length}${reviewNote ? '（模型没筛成：' + reviewNote + '）' : ''}`)
  console.log(report[report.length - 1])
}

const body = `/**
 * lib/axis-presets.mjs —— 预设轴树（由 tools/build-presets.mjs 生成，别手改）
 * ============================================================================
 * 拿 B站 的分区当骨架：每区一组检索词 + 一组领域词 + 几个子簇。
 * 子簇 = 该分区搜索结果里 tag 的 DF/PMI 聚类，再让模型起名。
 *
 * 生成于 ${new Date().toISOString().slice(0, 10)}，共 ${Object.keys(out).length} 个区。
 * 想改就改 lib/tree.mjs 里的 AXIS_TREE（手写的那几根会覆盖同名预设）。
 * ============================================================================
 */

export const AXIS_PRESETS = ${JSON.stringify(out, null, 2)}
`
const dest = new URL('../lib/axis-presets.mjs', import.meta.url)
writeFileSync(dest, body, 'utf8')
console.log(`\n写好了 lib/axis-presets.mjs（${Object.keys(out).length} 个区）`)
