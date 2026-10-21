/**
 * tools/qr-live.mjs —— 端到端：真去 B站 要一个登录 URL → 自己编码 → 和 Python 逐位比对
 * 顺便把 SVG 写到 out/login-qr.svg，用浏览器打开能直接看。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { encodeQr, qrSvg, qrDataUrl } from '../lib/qr.mjs'

const PY = 'C:/Users/21415/.dsh/bili-duty/.venv/Scripts/python.exe'
const PY_CODE = `
import sys, json, qrcode
from qrcode.util import QRData, MODE_8BIT_BYTE
url, ver, mask = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
qr = qrcode.QRCode(version=ver, error_correction=qrcode.constants.ERROR_CORRECT_M, border=0, mask_pattern=mask)
qr.add_data(QRData(url.encode('utf8'), mode=MODE_8BIT_BYTE))
qr.make(fit=False)
print(json.dumps([[1 if c else 0 for c in row] for row in qr.get_matrix()]))
`

const res = await fetch('https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header', {
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36' },
})
const j = await res.json()
const url = j?.data?.url
if (!url) { console.log('拿不到 URL：', JSON.stringify(j).slice(0, 200)); process.exit(1) }
console.log(`URL（${url.length} 字符）：${url}`)
console.log(`qrcode_key：${j.data.qrcode_key}`)

const mine = encodeQr(url)
console.log(`编码：v${mine.version} / ${mine.size}×${mine.size} / mask${mine.mask}`)

const r = spawnSync(PY, ['-c', PY_CODE, url, String(mine.version), String(mine.mask)], { encoding: 'utf8' })
if (r.status !== 0) { console.log('python 比对失败：', r.stderr.slice(0, 400)); process.exit(1) }
const ref = JSON.parse(r.stdout)
const same = JSON.stringify(mine.modules.map((row) => row.map((d) => (d ? 1 : 0)))) === JSON.stringify(ref)
console.log(same ? '与 Python qrcode 逐位一致 ✓' : '和参考矩阵不一致 ✗')

mkdirSync(new URL('../out/', import.meta.url), { recursive: true })
writeFileSync(new URL('../out/login-qr.svg', import.meta.url), qrSvg(url, { margin: 4, unit: 6 }))
const dataUrl = qrDataUrl(url)
console.log(`SVG data URL：${dataUrl.length} 字符（${Math.round(dataUrl.length / 1024)} KB）`)
writeFileSync(new URL('../out/login-qr-ascii.txt', import.meta.url), mine.modules.map((row) => row.map((d) => (d ? '██' : '  ')).join('')).join('\n'))

// ③ SVG 能不能还原成同一个网格（验"画"的那一步，不只是"算"的那一步）
const parsed = spawnSync(PY, [fileURLToPath(new URL('./qr-svg-parse.py', import.meta.url)), fileURLToPath(new URL('../out/login-qr.svg', import.meta.url))], { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } })
if (parsed.status !== 0) { console.log('SVG 解析失败：', (parsed.stderr || '').slice(0, 400)); process.exit(1) }
const margin = 4
const expected = []
for (let i = 0; i < margin; i++) expected.push('.'.repeat(mine.size + margin * 2))
for (const row of mine.modules) expected.push('.'.repeat(margin) + row.map((d) => (d ? '#' : '.')).join('') + '.'.repeat(margin))
for (let i = 0; i < margin; i++) expected.push('.'.repeat(mine.size + margin * 2))
const strip = (t) => t.replace(/\r/g, '').trim()   // Windows 下 python 写管道会把 \n 变 \r\n
const svgOk = strip(parsed.stdout) === strip(expected.join('\n'))
console.log(svgOk ? `SVG 还原一致 ✓（${parsed.stderr.trim()}）` : 'SVG 还原不一致 ✗')

process.exit(same && svgOk ? 0 : 1)
