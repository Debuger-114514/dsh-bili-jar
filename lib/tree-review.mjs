/**
 * lib/tree-review.mjs —— 让模型给「子簇建议」过一遍
 * ============================================================================
 * 规则能挖出簇，但分不清这三种东西：
 *   · 真·细分方向（美国 / 蓝牙耳机）      → 要
 *   · B站 的活动或官方系列标签（人文历史档案馆） → 不要
 *   · 别的轴已经占用的词（科技测评里冒出 deepseek）→ 不要
 *
 * 所以把「轴 + 检索词 + 已有子簇 + 每个候选的词和几条样本标题」丢给模型，
 * 让它：① 判要不要 ② 给个能直接当标签用的中文名 ③ 说一句为什么。
 * 一次调用约 1k 输入 300 输出，谷时不到一分钱。
 * ============================================================================
 */
import { writeReasonCore } from './reasons.mjs'

const clip = (s, n) => String(s || '').slice(0, n)

/**
 * @param {object} ctx cordis context
 * @param {{axis:string, node:object, clusters:object[], api:object, style?:string}} opts
 * @returns {Promise<{ok:boolean, kept:object[], dropped:object[], note:string}>}
 */
export async function reviewClusters(ctx, opts) {
  const clusters = Array.isArray(opts.clusters) ? opts.clusters : []
  if (!clusters.length) return { ok: false, kept: [], dropped: [], note: '没有候选' }

  const axis = String(opts.axis || '')
  const node = opts.node || {}
  const existing = (node.subs || []).map((s) => s.name).join('、') || '（还没有）'
  const list = clusters
    .map((c, i) => [
      `${i + 1}. 候选词：${c.name}`,
      `   同簇词：${(c.terms || []).join(' / ')}`,
      `   命中 ${c.df} 条`,
      c.samples?.length ? `   样本标题：${c.samples.map((t) => clip(t, 34)).join(' ｜ ')}` : '',
    ].filter(Boolean).join('\n'))
    .join('\n')

  const system = [
    '你在帮一个人整理他的 B站 兴趣轴。',
    '下面这根轴会拿去搜索，所以它的「子簇」必须是**能当搜索词用的内容方向**。',
    '',
    '每个候选都要判断，标准只有三条：',
    '① 它是不是这根轴的一个真实细分方向（比如「时政」下的「美国」「俄乌」）？',
    '② 它是不是 B站 的活动标签、官方系列名、UP 主个人品牌、或者纯装饰词？——是就丢掉。',
    '③ 它是不是已经属于别的轴，或者跟已有子簇重复？——是就丢掉，重复的保留已有那个。',
    '',
    '留下的候选，再给它一个能直接当标签用的中文名：2–6 个字，像一个分类，不像一句话。',
    '（「蓝牙耳机推荐」→「蓝牙耳机」；「ai编程」→「AI 编程」；「美国」就保持「美国」）',
    '',
    '只输出 JSON 数组，不要代码块、不要解释：',
    '[{"i":1,"keep":true,"name":"美国","why":"时政的稳定细分方向"},{"i":2,"keep":false,"why":"B站活动标签，不是内容分类"}]',
  ].join('\n')

  const user = [
    `轴：${axis}`,
    `这根轴现在的检索词：${(node.search || []).join('、') || '（无）'}`,
    `已有子簇：${existing}`,
    '',
    '候选：',
    list,
  ].join('\n')

  const text = await writeReasonCore(ctx, {
    system, user,
    maxTokens: 700,
    timeoutMs: 45000,
    api: opts.api,
    kind: 'tree',
  })
  if (!text) return { ok: false, kept: [], dropped: [], note: '模型没返回' }
  if (process.env.JAR_DEBUG) console.log('[tree-review] 原始返回：', text.slice(0, 600))

  let arr = null
  try {
    const m = text.match(/\[[\s\S]*\]/)
    arr = JSON.parse(m ? m[0] : text)
  } catch { arr = null }
  if (!Array.isArray(arr)) return { ok: false, kept: [], dropped: [], note: '模型返回不是 JSON' }

  const kept = []
  const dropped = []
  for (const row of arr) {
    const idx = Number(row?.i) - 1
    const c = clusters[idx]
    if (!c) continue
    const why = clip(row?.why, 60)
    if (!row?.keep) { dropped.push({ seed: c.name, why }); continue }
    const name = clip(row?.name, 12).trim() || c.name
    kept.push({ name, terms: c.terms, df: c.df, why })
  }
  // 模型没提到的候选：宁可不采纳，也别塞进树里
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i]
    if (!arr.some((row) => Number(row?.i) - 1 === i)) dropped.push({ seed: c.name, why: '模型没提，先不用' })
  }
  return { ok: kept.length > 0, kept, dropped, note: kept.length ? '' : '模型一条都没留' }
}
