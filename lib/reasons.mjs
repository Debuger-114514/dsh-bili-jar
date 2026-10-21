/**
 * lib/reasons.mjs —— 用宿主自己的 LLM 写「推荐理由」
 * ============================================================================
 * 调用链（从 dsh-experimental-translator / dsh-session-title-llm 里扒出来的）：
 *
 *   const prepared = await ctx.llm.prepareCall({ provider, model, maxTokens }, signal)
 *   const options  = { ...prepared.config, system, messages: [{role:'user', content:[{type:'text',text}]}], signal }
 *   for await (const chunk of prepared.stream(options)) assembler.push(chunk)
 *
 * 落点是**按需生成 + 本地缓存**：同一条视频只花一次钱（设计上就是「你点才写」）。
 * ============================================================================
 */
import { readFileSync, writeFileSync } from 'node:fs'

const MODEL_HINT = { provider: undefined, model: undefined }

/** 从宿主树里拿 dsh-llm 的 BlockAssembler（拿不到就自己拼） */
async function loadAssembler() {
  const roots = []
  const exeDir = process.env.DSH_ELECTRON_DIR || (process.execPath ? process.execPath.replace(/[\\/][^\\/]+$/, '') : '')
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
 * 让宿主模型写一条推荐理由。
 * @returns {Promise<string>} 空字符串 = 没写成（调用方自己退回规则理由）
 */
export async function writeReason(ctx, item, style, opts = {}) {
  const llm = ctx?.llm || ctx?.get?.('llm')
  if (!llm?.prepareCall) return ''
  const sel = (() => { try { return ctx.get?.('agentDefaultModel')?.currentSelection?.() || {} } catch { return {} } })()

  const provider = pick(opts, 'provider') ?? pick(sel, 'provider', 'providerId')
  const model = pick(opts, 'model') ?? pick(sel, 'model', 'modelId')

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs || 45000)
  try {
    const prepared = await llm.prepareCall({ provider, model, reasoningEffort: 'off', maxTokens: 220 }, ac.signal)
    if (!prepared?.stream) return ''

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

    const messages = [{ role: 'user', content: [{ type: 'text', text: facts }] }]
    const options = { ...prepared.config, system, messages, signal: ac.signal }

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
    return String(text || '').trim().replace(/^["「『]|["」』]$/g, '').slice(0, 160)
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
  }
}

/** 本地缓存：同一条视频只花一次钱 */
export function loadReasonCache(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) || {} } catch { return {} }
}

export function saveReasonCache(file, cache) {
  try {
    const keys = Object.keys(cache)
    // 只留最近 800 条，别让文件无限长
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
