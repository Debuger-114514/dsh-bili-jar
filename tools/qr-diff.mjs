/**
 * tools/qr-diff.mjs —— 打印和 Python 参考矩阵不一样的那些格子的坐标
 */
import { spawnSync } from 'node:child_process'
import { encodeQr } from '../lib/qr.mjs'

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

const text = process.argv[2] || 'hello'
const mine = encodeQr(text)
const r = spawnSync(PY, ['-c', PY_CODE, text, String(mine.version), String(mine.mask)], { encoding: 'utf8' })
if (r.status !== 0) { console.log(r.stderr); process.exit(1) }
const ref = JSON.parse(r.stdout)
const size = mine.size
console.log(`v${mine.version} mask${mine.mask} size=${size}`)

const rows = []
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const a = mine.modules[y][x] ? 1 : 0
    const b = ref[y][x]
    if (a !== b) rows.push(`(${y},${x}) mine=${a} ref=${b}`)
  }
}
console.log(rows.join('\n'))
console.log(`共 ${rows.length} 处`)

// 同时并排打印，方便肉眼看
if (process.env.SHOW) {
  for (let y = 0; y < size; y++) {
    let l = ''
    for (let x = 0; x < size; x++) l += mine.modules[y][x] ? '#' : '.'
    let rr = ''
    for (let x = 0; x < size; x++) rr += ref[y][x] ? '#' : '.'
    console.log(l + '   ' + rr)
  }
}
