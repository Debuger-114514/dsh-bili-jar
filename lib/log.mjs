/**
 * lib/log.mjs —— 插件自己的日志
 * ============================================================================
 * 写到 `~/.dsh/bili-jar/bili-jar.log`，一行一个 JSON：
 *   { ts, level, event, detail }
 *
 * 为什么要它：之前出问题只能靠 /debug 猜，策展失败、字幕没取到、搜索被风控
 * 全都看不见。有了日志，"这一轮到底干了什么"一查就知道。
 * ============================================================================
 */
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs'

const MAX_LINES = 2000
let filePath = ''

export function setLogFile(p) { filePath = p }

export function log(level, event, detail = '') {
  const row = { ts: Date.now(), level, event, detail: typeof detail === 'string' ? detail.slice(0, 500) : detail }
  try {
    if (!filePath) return row
    appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8')
  } catch { /* 写不进去也不能影响主流程 */ }
  return row
}

export const info = (event, detail) => log('info', event, detail)
export const warn = (event, detail) => log('warn', event, detail)
export const error = (event, detail) => log('error', event, detail)

/** 读最近 n 行（从新到旧） */
export function tail(n = 100) {
  try {
    if (!filePath || !existsSync(filePath)) return []
    const lines = readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean)
    // 超过上限就截断，别让文件无限长
    if (lines.length > MAX_LINES * 2) {
      writeFileSync(filePath, lines.slice(-MAX_LINES).join('\n') + '\n', 'utf8')
    }
    return lines.slice(-n).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean).reverse()
  } catch { return [] }
}
