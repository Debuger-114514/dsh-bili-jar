/**
 * 每根轴的「内容会不会过期」。
 * ============================================================================
 * news      —— 14 天窗口，时效分权重 0.10。时政、财经这类今天不看就没意义的内容。
 * evergreen —— 不设窗口，时效分权重 0.02。攻略、音乐、历史这类什么时候看都行的内容。
 *
 * 判定不看条数，看**合格条目的年龄中位数**：> 90 天就是 evergreen。
 * 实测七个冷门词分得很干净（丝之歌 361 天 / 空洞骑士 2052 / vtuber 2385
 * vs 时政 13 / 深蓝 26 / 术力口 5 / kards 5），中间几乎没有模糊地带。
 * 用条数当判据会被搜索波动带着跳，中位数不会。
 *
 * 预分配：内置轴按分类一次标好；新轴默认 news，跑一轮后由 index.js 按年龄中位自动切。
 */
import { AXIS_BASE, getUserTree } from './tree.mjs'

/** 年龄中位数超过这个值就算常青内容 */
export const EVERGREEN_AFTER_DAYS = 90

/** 内置轴的分类倾向（数据，不是逻辑；想调就改这里） */
const BY_NAME = {
  // 会过期
  news: ['时政', '财经', '军事', '娱乐八卦', '新闻'],
  // 不过期
  evergreen: [
    '游戏', '音乐', '术力口', '历史', '纪录片', '编程', '数学', '物理',
    '健身', '手工', '摄影', '学习', '动画', '影视', '生活', '美食', '旅行',
    '科技测评', '数码', 'deepseek', 'AI',
  ],
}

const PRESET_FRESHNESS = (() => {
  const map = {}
  for (const name of BY_NAME.evergreen) map[name] = 'evergreen'
  for (const name of BY_NAME.news) map[name] = 'news'
  return map
})()

/** 某个值是不是合法取值 */
export function isFreshness(v) {
  return v === 'news' || v === 'evergreen'
}

/**
 * 这根轴现在算什么。
 * 优先级：用户手填 > 内置预设 > 默认 news
 */
export function freshnessOf(axis) {
  const key = String(axis || '').trim()
  if (!key) return 'news'
  const mine = (getUserTree()[key] || {}).freshness
  if (isFreshness(mine)) return mine
  if (isFreshness(PRESET_FRESHNESS[key])) return PRESET_FRESHNESS[key]
  return 'news'
}

/** 这轮建池，每根轴用多宽的日期窗口（天）；0 = 不限 */
export function windowOf(axis, globalMaxDays) {
  if (freshnessOf(axis) === 'evergreen') return 0
  return Number(globalMaxDays) > 0 ? Number(globalMaxDays) : 0
}

/**
 * 按合格条目的年龄中位数判断这根轴该是什么。
 * @param {number[]} ages 合格条目的「多少天前」
 * @param {{freshCount?:number}} [opts] 近 14 天发布的合格条目数 ——
 *   ≥2 时**不允许判 evergreen**。池子进料天然偏老（综合排序 + related 扩散），
 *   年龄中位数会被老内容抬高：不设防护的话，明明还有新内容的轴会被误判成常青，
 *   然后日期窗被彻底拆掉，从此更推旧内容 —— 系统里最强的正反馈回路。
 * @returns {{freshness:string, medianAge:number, reason:string}}
 */
export function decideFreshness(ages, opts = {}) {
  const list = (ages || []).filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
  if (!list.length) return { freshness: 'news', medianAge: 0, reason: '没有合格条目' }
  const mid = list[Math.floor(list.length / 2)]
  if (mid > EVERGREEN_AFTER_DAYS) {
    const freshCount = Number(opts.freshCount) || 0
    if (freshCount >= 2) {
      return { freshness: 'news', medianAge: mid, reason: `近两周有 ${freshCount} 条新内容，不判常青` }
    }
    return { freshness: 'evergreen', medianAge: mid, reason: `合格 ${list.length} 条，年龄中位 ${Math.round(mid)} 天` }
  }
  return { freshness: 'news', medianAge: mid, reason: `合格 ${list.length} 条，年龄中位 ${Math.round(mid)} 天` }
}

/** 内置轴是不是预设过的（只是给 UI 标一下） */
export function isPresetAxis(axis) {
  return Object.hasOwn(AXIS_BASE, String(axis || '').trim())
}
