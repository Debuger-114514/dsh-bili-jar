/**
 * lib/reasons.mjs —— 用宿主自己的 LLM 写东西
 * ============================================================================
 * 调用链（从 dsh-experimental-translator / dsh-session-title-llm 里扒出来的）：
 *
 *   const prepared = await ctx.llm.prepareCall({ provider, model, maxTokens }, signal)
 *   const options  = { ...prepared.config, system, messages: [{role:'user', content:[{type:'text',text}]}], signal }
 *   for await (const chunk of prepared.stream(options)) assembler.push(chunk)
 *
 * 两个入口：
 *   writeReasonCore —— 裸调用（策展人用）
 *   writeReason     —— 单条视频的一句话理由
 * ============================================================================
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { addUsage } from './usage.mjs'

/** 最后一次调用失败的原因（给 /debug 看） */
export const lastError = { msg: '' }

/** 记账落点：由 index.js 在 apply 时设置 */
let usageFile = ''
export function setUsageFile(p) { usageFile = p }

/** 从宿主树里拿 dsh-llm 的 BlockAssembler（拿不到就自己拼文本） */
async function loadAssembler() {
  const roots = []
  const exeDir = process.execPath ? process.execPath.replace(/[\\/][^\\/]+$/, '') : ''
  if (exeDir) roots.push(`${exeDir}/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js`)
  roots.push('@deepseek-ai/dsh-llm')
  for (const r of roots) {
    try { const m = await import(r); if (m?.BlockAssembler) return m.BlockAssembler } catch { /* 下一个 */ }
  }
  return null
}

const pick = (o, ...keys) => {
  for (const k of keys) { const v = o?.[k]; if (v !== undefined && v !== null && v !== '') return v }
  return undefined
}

/**
 * 裸调用：给 system + user，拿一段文本。失败返回 ''。
 */
export async function writeReasonCore(ctx, opts = {}) {
  const llm = ctx?.llm || ctx?.get?.('llm')
  if (!llm?.prepareCall) return ''
  const sel = (() => { try { return ctx.get?.('agentDefaultModel')?.currentSelection?.() || {} } catch { return {} } })()

  const provider = pick(opts, 'provider') ?? pick(sel, 'provider', 'providerId')
  const model = pick(opts, 'model') ?? pick(sel, 'model', 'modelId')
  const maxTokens = Number(opts.maxTokens) || 300

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), Number(opts.timeoutMs) || 45000)
  try {
    const prepared = await llm.prepareCall({ provider, model, reasoningEffort: 'off', maxTokens }, ac.signal)
    if (!prepared?.stream) return ''
    const messages = [{ role: 'user', content: [{ type: 'text', text: String(opts.user || '') }] }]
    const options = { ...prepared.config, system: String(opts.system || ''), messages, signal: ac.signal }

    const Assembler = opts.Assembler ?? await loadAssembler()
    let text = ''
    if (Assembler) {
      const asm = new Assembler()
      for await (const chunk of prepared.stream(options)) asm.push(chunk)
      const blocks = typeof asm.blocks === 'function' ? asm.blocks() : []
      text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('')
    } else {
      for await (const chunk of prepared.stream(options)) {
        if (chunk?.type === 'text-delta' && chunk.text) text += chunk.text
      }
    }
    const out = String(text || '').trim()
    if (usageFile && out) {
      try { addUsage(usageFile, { system: opts.system || '', user: opts.user || '', output: out }) } catch { /* 记账失败不影响主流程 */ }
    }
    return out
  } catch (e) {
    lastError.msg = String(e?.message || e).slice(0, 300)
    try { console.error('[bili-jar] LLM 调用失败：', lastError.msg) } catch { /* 无控制台 */ }
    return ''
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 单条视频的一句话推荐语。
 * @returns {Promise<string>} 空字符串 = 没写成（调用方退回规则理由）
 */
export async function writeReason(ctx, item, style, opts = {}) {
  const dur = Math.round((item.duration || 0) / 60)
  const facts = [
    `标题：${item.title}`,
    `UP：${item.author}`,
    `时长：${dur} 分钟`,
    `分区：${item.typeName || '未知'}`,
    `tag：${(item.tags || []).join('、') || '（无）'}`,
    `数据：播放 ${item.play}，点赞率 ${item.pct?.like ?? '?'}%，投币率 ${item.pct?.coin ?? '?'}%，收藏率 ${item.pct?.fav ?? '?'}%`,
    `命中的兴趣轴：${item.axis || ''}${item.sub ? ' · ' + item.sub : ''}`,
  ].join('\n')

  const system = [
    '你在替一个人写「这条视频为什么值得看」的一句话推荐语。',
    '只输出这一句话本身，不要引号、不要解释、不要复述标题。',
    '长度 40–70 字，口语，具体（说清它讲了什么、适合什么时候看），不要用「这条视频」「本期」开头。',
    style ? `语气与风格：${style}` : '语气与风格：像一个了解他口味的朋友在推荐。',
  ].join('\n')

  const text = await writeReasonCore(ctx, { system, user: facts, maxTokens: 220, timeoutMs: 45000, ...opts })
  return text.replace(/^["「『]|["」』]$/g, '').slice(0, 160)
}

/** 本地缓存：同一条视频只花一次钱 */
export function loadReasonCache(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) || {} } catch { return {} }
}

export function saveReasonCache(file, cache) {
  try {
    const keys = Object.keys(cache)
    if (keys.length > 800) {
      const sorted = keys.sort((a, b) => (cache[b]?.at || 0) - (cache[a]?.at || 0))
      const trimmed = {}
      for (const k of sorted.slice(0, 800)) trimmed[k] = cache[k]
      writeFileSync(file, JSON.stringify(trimmed), 'utf8')
      return
    }
    writeFileSync(file, JSON.stringify(cache), 'utf8')
  } catch { /* 写不进去就算了 */ }
}
