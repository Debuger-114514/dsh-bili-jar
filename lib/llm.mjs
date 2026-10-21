/**
 * lib/llm.mjs —— 直接的 OpenAI 兼容调用（DeepSeek 官方就是这个协议）
 * ============================================================================
 * 为什么不走宿主：`ctx.llm.prepareCall` 那套签名没有文档，反推的两种写法都失败了。
 * 直接 POST /chat/completions 最确定，而且 token 用量能从响应里直接读出来。
 * ============================================================================
 */

export function normalizeBase(base) {
  const b = String(base || '').trim().replace(/\/+$/, '')
  if (!b) return 'https://api.deepseek.com'
  return b.endsWith('/v1') ? b : b + '/v1'
}

/**
 * @returns {Promise<{ok:boolean, text:string, usage?:object, error?:string}>}
 */
export async function chat({ base, key, model, system, user, maxTokens = 400, timeoutMs = 45000 }) {
  if (!key) return { ok: false, text: '', error: '没有 API key' }
  const url = normalizeBase(base) + '/chat/completions'
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: model || 'deepseek-chat',
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user },
        ],
        max_tokens: maxTokens,
        temperature: 0.7,
        stream: false,
      }),
      signal: ac.signal,
    })
    const text = await res.text()
    let j = null
    try { j = JSON.parse(text) } catch { /* 不是 JSON */ }
    if (!res.ok) return { ok: false, text: '', error: `HTTP ${res.status} ${String(j?.error?.message || text).slice(0, 160)}` }
    const out = j?.choices?.[0]?.message?.content || ''
    return { ok: Boolean(out), text: String(out).trim(), usage: j?.usage, error: out ? '' : '空响应' }
  } catch (e) {
    return { ok: false, text: '', error: String(e?.message || e).slice(0, 160) }
  } finally {
    clearTimeout(timer)
  }
}
