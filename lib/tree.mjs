/**
 * lib/tree.mjs —— 轴树：内置的那棵 + 你自己长出来的枝
 * ============================================================================
 * 内置部分（AXIS_TREE）是那次抓 1412 条视频做完聚类后人工确认的：
 *   deepseek 0 个子簇 / 时政 5 个 / 科技测评 4 个 / 健身教程 3 个
 * 但你新加的轴（比如「历史」）不在里面 —— 只能拿轴词本身去搜，没有轮换。
 *
 * 所以这里多了一层：**用户树**（`~/.dsh/bili-jar/axis-tree.json`）。
 *   · 内置 = 出厂值，不随用户改动
 *   · 用户树 = 只存"新增/覆盖"的部分，启动时和内置合并
 *   · 合并规则：search 追加去重、subs 按名字追加、groups 追加去重
 *
 * `suggestSubs()` 从现有池子里挖子簇：tag 的 DF + 两两共现的 PMI。
 * 挖出来只是**建议**，要不要采纳由你点。
 * ============================================================================
 */

import { AXIS_PRESETS } from './axis-presets.mjs'

export const AXIS_TREE = {
  deepseek: {
    search: ['deepseek', 'dsh', '深度求索'],
    groups: [['deepseek', 'dsh', '深度求索']],
    subs: [],
    cats: ['科技数码', '知识'],
    none: [],
  },

  时政: {
    // ⚠️ 搜「时政」出来的是考公内容（见 docs/tag-tree.md），所以主词只留一个，
    //    真正管用的是轮换出来的实体词。
    search: ['时政', '国际局势'],
    groups: [[
      '时政', '国际', '局势', '时事', '外交', '地缘', '大选', '关税', '制裁', '冲突', '战争', '军事',
      '台海', '中美', '时评', '政治', '选举', '国会', '白宫', '政府', '首相', '总统', '联合国',
      '特朗普', '川普', '拜登', '普京', '泽连斯基', '内塔尼亚胡', '哈马斯', '以色列', '巴勒斯坦',
      '伊朗', '乌克兰', '俄罗斯', '欧盟', '北约', '中东',
    ]],
    subs: [
      { name: '中东', terms: ['以色列', '哈马斯', '伊朗', '中东', '加沙'] },
      { name: '美国', terms: ['特朗普', '川普', '拜登', '白宫', '美国大选'] },
      { name: '俄乌', terms: ['俄乌', '普京', '泽连斯基', '乌克兰', '俄罗斯'] },
      { name: '台海', terms: ['台海', '两岸', '台湾'] },
      { name: '欧洲', terms: ['欧盟', '北约', '欧洲', '德国', '法国', '英国'] },
    ],
    cats: ['资讯', '知识'],
    none: [],
  },

  科技测评: {
    search: ['科技测评', '数码'],
    groups: [
      ['科技', '数码', '手机', '电脑', 'ai', '相机', '耳机', '显卡', '外设', '软件', '硬件', '芯片', '平板', '笔记本'],
      ['测评', '评测', '实测', '上手', '开箱', '横评', '对比'],
    ],
    subs: [
      { name: '电脑硬件', terms: ['显卡', 'cpu', '装机', '硬件', '主板', '散热', '内存'] },
      { name: '耳机', terms: ['耳机', '降噪', 'hifi', '音频'] },
      { name: '手机', terms: ['手机', '红米', '小米', 'iphone', '华为', '荣耀'] },
      { name: '笔记本', terms: ['笔记本', '轻薄本', '游戏本'] },
    ],
    cats: ['科技数码'],
    none: ['英雄联盟', 'lpl', '赛事', '电竞', '比赛集锦'],
  },

  健身教程: {
    search: ['健身教程', '健身跟练'],
    groups: [
      ['健身', '训练', '减脂', '增肌', '瑜伽', '拉伸', '有氧', '力量', '塑形'],
      ['教程', '跟练', '计划', '动作', '入门', '新手'],
    ],
    subs: [
      { name: '增肌', terms: ['增肌', '肌肉', '力量', '哑铃', '卧推', '手臂'] },
      { name: '减脂', terms: ['减脂', '减肥', '燃脂', '有氧', '体脂'] },
      { name: '跟练', terms: ['跟练', '健身操', '瑜伽', '拉伸', '普拉提'] },
    ],
    cats: ['健身', '运动', '体育'],
    none: ['机器人', '编程', '开发', '算法', '强化学习', '代码', '运控'],
  },
}

/** 出厂树 = 分区预设 + 我手写的那几根（同名以手写为准） */
export const AXIS_BASE = { ...AXIS_PRESETS, ...AXIS_TREE }

/** 没在树里定义的轴：退回「轴词 + 同义词」当一组 */
export const SYNONYMS = {
  deepseek: ['deepseek', 'dsh', '深度求索', 'deepseek harness'],
  时政: ['时政', '国际', '局势', '时事', '观察', '解读', '新闻'],
  科技测评: ['测评', '评测', '实测', '上手', '横评', '开箱', '体验'],
  健身教程: ['健身', '训练', '动作', '增肌', '减脂', '拉伸', '教程'],
}

/** 没在树里定义的轴：退回「轴词 + 同义词」当一组 */
const FALLBACK = (key) => ({
  search: [key, ...(SYNONYMS[key] || [])].filter(Boolean),
  groups: [[key, ...(SYNONYMS[key] || [])].filter(Boolean)],
  subs: [], cats: [], none: [],
})

/** 用户在面板里长出来的那部分（启动时从 axis-tree.json 读进来） */
let userTree = {}

export function setUserTree(t) { userTree = (t && typeof t === 'object') ? t : {} }
export function getUserTree() { return userTree }

/** 合并：内置打底，用户的往后追加（同名子簇以用户为准） */
function mergeNode(base, add) {
  if (!add) return base
  const uniq = (arr) => Array.from(new Set((arr || []).filter(Boolean)))
  const subs = [...(base.subs || [])]
  for (const s of add.subs || []) {
    const i = subs.findIndex((x) => x.name === s.name)
    if (i >= 0) subs[i] = { name: s.name, terms: uniq([...(subs[i].terms || []), ...(s.terms || [])]) }
    else subs.push({ name: s.name, terms: uniq(s.terms || []) })
  }
  return {
    ...base,
    search: uniq([...(base.search || []), ...(add.search || [])]),
    groups: (base.groups || []).length
      ? (base.groups || []).map((g, i) => (i === 0 ? uniq([...g, ...((add.groups || [])[0] || [])]) : g))
      : (add.groups || []),
    subs,
    cats: uniq([...(base.cats || []), ...(add.cats || [])]),
    none: uniq([...(base.none || []), ...(add.none || [])]),
  }
}

/** 这根轴最终用的节点（内置 + 用户） */
export function nodeFor(axis) {
  const key = String(axis || '').trim()
  const base = AXIS_BASE[key] || FALLBACK(key)
  const add = userTree[key]
  return add ? mergeNode(base, add) : base
}

/* ── 从数据里挖子簇 ───────────────────────────────────────────────────── */

const isAscii = (s) => {
  for (const ch of String(s)) if (ch.codePointAt(0) > 127) return false
  return true
}

/**
 * 泛标签黑名单：B站 的活动/系列标签 + 纯装饰标签。
 * 这类 tag 跟谁都能共现，但没有任何分类意义 —— 它们会被下面的「泛度」再过滤一次，
 * 这里列出来只是省一次计算，也方便你手动加。
 */
const GENERIC = new Set([
  '必剪创作', '直播', '高能', '生活记录', 'vlog', '原创', '日常', '记录', '自制', '剪辑',
  '科技猎手', 'b站ai无限竞技场', '请回答这个时代', '双11', '双十一', '新品测评官',
  '搞笑', '娱乐', '热门', '推荐', '分享',
])

/**
 * 从池子里给某根轴挖子簇建议（v2）。
 *
 * 相比 v1 改了三件事：
 *   1. **泛 tag 用 PMI 中位数判**，不再靠裸 DF —— 「健身」DF 高但它跟健身类 tag 的 PMI 也高，
 *      不该被当泛 tag；「必剪创作」跟谁 PMI 都低，才是真泛。
 *   2. **跨轴去重**：种子词如果是别的轴的核心词，直接跳过（不然「科技测评」里会挖出 deepseek 簇）。
 *   3. **PMI 阈值自适应**：取所有候选对的 75 分位，而不是写死 0.2。
 *
 * @param {object[]} items 池子（要带 tags）
 * @param {string} axis
 * @param {(item:object, axis:string)=>{qualified:boolean}} qualify
 * @param {{maxClusters?:number, minDf?:number, minPair?:number}} [opts]
 */
export function suggestSubs(items, axis, qualify, opts = {}) {
  const maxClusters = opts.maxClusters || 4
  const minDf = opts.minDf || 3
  const minPair = opts.minPair || 2

  const node = nodeFor(axis)
  const known = new Set()
  for (const w of node.search || []) known.add(String(w).toLowerCase())
  for (const g of node.groups || []) for (const w of g) known.add(String(w).toLowerCase())
  for (const sub of node.subs || []) for (const w of sub.terms || []) known.add(String(w).toLowerCase())

  // 别的轴已经占用的核心词 —— 不去抢
  // 只用别的轴的「检索词」做去重依据：每区的领域词表有 18 个，全算进来会把
  // 大部分候选都误杀（历史既是「纪录片」的子簇，也可以是「知识」的子簇）。
  const otherTerms = new Set()
  for (const [name, other] of Object.entries(AXIS_BASE)) {
    if (name === axis) continue
    for (const w of other.search || []) otherTerms.add(String(w).toLowerCase())
  }

  const rows = (items || []).filter((it) => it && (qualify ? qualify(it, axis).qualified : true))
  const n = rows.length || 1

  const df = new Map()
  const pair = new Map()          // tag -> Map(other -> 共现条数)，不用分隔符拼 key
  const bumpPair = (a, b) => {
    let m = pair.get(a)
    if (!m) { m = new Map(); pair.set(a, m) }
    m.set(b, (m.get(b) || 0) + 1)
  }
  const pairCount = (a, b) => {
    const m = pair.get(a)
    return (m && m.get(b)) || 0
  }

  for (const it of rows) {
    const tags = Array.from(new Set(
      (it.tags || []).map((x) => String(x).toLowerCase().trim()).filter(Boolean)
    )).filter((t) => !known.has(t) && !GENERIC.has(t) && t.length >= 2 && !otherTerms.has(t))
    for (const t of tags) df.set(t, (df.get(t) || 0) + 1)
    for (let i = 0; i < tags.length; i++) {
      for (let j = i + 1; j < tags.length; j++) {
        bumpPair(tags[i], tags[j])
        bumpPair(tags[j], tags[i])
      }
    }
  }

  const pmi = (x, y) => {
    const c = pairCount(x, y)
    if (!c) return 0
    const px = (df.get(x) || 0) / n
    const py = (df.get(y) || 0) / n
    const pxy = c / n
    if (!px || !py || !pxy) return 0
    return Math.log(pxy / (px * py))
  }

  /** 泛度 = 该 tag 与所有共现 tag 的 PMI 中位数（低 = 跟谁都不特别） */
  const specificity = (t) => {
    const mates = pair.get(t)
    if (!mates || !mates.size) return 0
    const vals = []
    for (const other of mates.keys()) {
      if ((mates.get(other) || 0) < minPair) continue
      vals.push(pmi(t, other))
    }
    if (!vals.length) return 0
    vals.sort((a, b) => a - b)
    return vals[Math.floor(vals.length / 2)]
  }

  const candidates = []
  for (const [tag, c] of df.entries()) {
    if (c < minDf) continue
    const spec = specificity(tag)
    // 高频 + 不特别 ⇒ 泛 tag，丢掉
    if (c / n >= 0.45 && spec < 0.3) continue
    candidates.push({ tag, df: c, spec })
  }
  candidates.sort((a, b) => b.df - a.df || b.spec - a.spec)

  // 自适应阈值：候选对 PMI 的 75 分位（样本太少就退回 0.2）
  const pairVals = []
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i].tag
      const b = candidates[j].tag
      if (pairCount(a, b) < minPair) continue
      pairVals.push(pmi(a, b))
    }
  }
  pairVals.sort((a, b) => a - b)
  // 用中位数而不是 75 分位：稀有 tag 对的 PMI 会被小样本抬高，
  // 拿 75 分位会把所有同伴都筛掉，最后每个簇只剩一个词。
  const median = pairVals.length ? pairVals[Math.floor(pairVals.length / 2)] : 0.2
  const threshold = Math.max(0.15, Math.min(0.8, median))

  const used = new Set()
  const clusters = []
  for (const cand of candidates) {
    if (clusters.length >= maxClusters) break
    if (used.has(cand.tag)) continue
    const mates = candidates
      .filter((x) => x.tag !== cand.tag && !used.has(x.tag))
      .map((x) => ({ tag: x.tag, s: pmi(cand.tag, x.tag), c: pairCount(cand.tag, x.tag) }))
      .filter((x) => x.c >= minPair && x.s >= threshold)
      .sort((a, b) => b.s - a.s)
      .slice(0, 3)
      .map((x) => x.tag)
    const terms = [cand.tag, ...mates]
    for (const t of terms) used.add(t)
    const samples = rows
      .filter((it) => (it.tags || []).some((x) => String(x).toLowerCase().trim() === cand.tag))
      .slice(0, 3)
      .map((it) => String(it.title || '').slice(0, 40))
    clusters.push({ name: cand.tag, terms, df: cand.df, spec: Number(cand.spec.toFixed(2)), samples })
  }

  const loose = candidates
    .filter((x) => !used.has(x.tag))
    .slice(0, 8)
    .map((x) => ({ tag: x.tag, df: x.df }))

  return {
    axis,
    sampled: rows.length,
    threshold: Number(threshold.toFixed(2)),
    clusters,
    loose,
  }
}
