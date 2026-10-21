// 从 client.js 里把 CSS 抽出来，替换掉 ${PANEL_W}/${PANEL_H}，写成 out/design.css
// 用途：本地用 Chrome 截图预览面板（改完样式能立刻看见）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const start = src.indexOf('const CSS = `')
if (start < 0) { console.error('没找到 CSS 块'); process.exit(1) }
const bodyStart = start + 'const CSS = `'.length
// 文件是 CRLF，按行切开找那个单独的反引号
const lines = src.slice(bodyStart).split(/\r?\n/)
const closeAt = lines.findIndex((l) => l.trim() === '`')
if (closeAt < 0) { console.error('没找到 CSS 结尾'); process.exit(1) }
const css = lines.slice(0, closeAt).join('\n')
  .replace(/\$\{PANEL_W\}/g, '360')
  .replace(/\$\{PANEL_H\}/g, '520')
mkdirSync(new URL('../out/', import.meta.url), { recursive: true })
writeFileSync(new URL('../out/design.css', import.meta.url), css, 'utf8')
console.log('out/design.css', css.length, 'bytes')
