/**
 * lib/curator.mjs —— 让 LLM 当策展人（这才是这个项目真正想要的东西）
 * ============================================================================
 * 分工：
 *   规则（pool.mjs）：把 200 多条搜来的东西压到 20 多条「技术上够格」的候选
 *   LLM（这里）：读这 20 多条，**挑出 5 条并写理由** —— 判断"值不值得占他一次注意力"
 *
 * 一次调用搞定，不逐条问，所以成本是 ¥0.002 量级（约 2–3k 输入 + 300 输出）。
 * ============================================================================
 */
import { writeReasonCore } from './reasons.mjs'

/** 把候选压成一行文本，省 token */
function lineOf(c, i) {
  const dur = Math.round((c.duration || 0) / 60)
  const p = c.pct || {}
  // 发布日期：之前不带给模型，它只看「数据是不是真被喜欢」——按构造就是老视频赢
  const ageDays = Number(c.pubdate) > 0
    ? Math.max(0, Math.round((Date.now() / 1000 - Number(c.pubdate)) / 86400))
    : null
  return [
    String(i + 1).padStart(2, '0'),
    c.bvid,
    `《${String(c.title || '').slice(0, 42)}》`,
    `UP:${String(c.author || '').slice(0, 10)}`,
    `${dur}分钟`,
    ageDays == null ? '日期未知' : `发布${ageDays}天前`,
    `播放${Math.round((c.play || 0) / 1000)}k`,
    `赞${p.like ?? '?'}%/币${p.coin ?? '?'}%/藏${p.fav ?? '?'}%`,
    c.typeName ? `区:${c.typeName}` : '',
    c.axis ? `轴:${c.axis}${c.sub ? '·' + c.sub : ''}` : '',
    (c.tags || []).slice(0, 4).join(','),
  ].filter(Boolean).join(' | ')
}

/**
 * @returns {Promise<{ok:boolean, picks:{bvid:string, why:string}[], note:string}>}
 */
export async function curate(ctx, items, style, opts = {}) {
  if (!Array.isArray(items) || items.length === 0) return { ok: false, picks: [], note: '没有候选' }
  const n = Math.min(Number(opts.pick) || 5, items.length)
  const list = items.map(lineOf).join('\n')

  const styleText = style ? String(style).slice(0, 1500) : ''

  const system = [
    '你是一个人的 B 站视频策展人。他会自己看，你要做的是让他**今天只看这几条**。',
    `从候选里挑 ${n} 条，按"值得占他一次注意力"的程度排序。`,
    '判断依据：有没有实质信息、是不是标题党、时长值不值得、和他兴趣轴贴不贴、数据是不是真被喜欢。',
    '候选行里带「发布X天前」。同等条件下优先较新的。',
    '教程、音乐、历史这类常青内容，老一点不是缺点；新闻、时事、数码新品这类，旧的就是过期。',
    '宁缺毋滥：宁可只给 3 条，也不要凑数。',
    '🔴 理由里**不许出现任何数字**（播放量、点赞率、收藏率、投币率、弹幕数都不行），也不许用数据来论证。',
    '🔴 只写内容：它讲了什么、怎么讲的（有实测？有地图？有跟练？）、适合什么时候看。',
    '数据你可以用来**挑**，但不许写进**理由**里。',
    styleText ? `语气与风格：${styleText}` : '语气与风格：像一个了解他口味的朋友，具体、不吹、不用感叹号。',
    '只输出 JSON 数组，不要代码块、不要解释。每项：{"bvid":"BV...","why":"40–70 字的一句话理由"}',
  ].join('\n')

  const user = `候选（每行：序号 | BV | 标题 | UP | 时长 | 播放 | 赞/币/藏率 | 分区 | 轴 | tag）：\n${list}`

  const text = await writeReasonCore(ctx, { system, user, maxTokens: 900, timeoutMs: opts.timeoutMs || 60000, api: opts.api })
  if (!text) return { ok: false, picks: [], note: '模型没返回' }

  // 从返回里抠出 JSON（模型偶尔会裹代码块）
  let arr = null
  try {
    const m = text.match(/\[[\s\S]*\]/)
    arr = JSON.parse(m ? m[0] : text)
  } catch { arr = null }
  if (!Array.isArray(arr)) return { ok: false, picks: [], note: '返回不是 JSON: ' + text.slice(0, 80) }

  const byBvid = new Map(items.map((c) => [c.bvid, c]))
  const picks = []
  for (const p of arr) {
    const bvid = String(p?.bvid || '').trim()
    const why = String(p?.why || '').trim().slice(0, 160)
    if (!bvid || !byBvid.has(bvid) || !why) continue // 编出来的 BV 直接丢
    if (picks.some((x) => x.bvid === bvid)) continue
    picks.push({ bvid, why })
    if (picks.length >= n) break
  }
  return { ok: picks.length > 0, picks, note: picks.length ? '' : '模型给的 BV 全对不上候选' }
}
