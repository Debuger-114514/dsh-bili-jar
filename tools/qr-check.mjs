/**
 * tools/qr-check.mjs —— 拿 Python 的 qrcode 当标准答案，逐位比对 lib/qr.mjs
 * 跑法：ELECTRON_RUN_AS_NODE=1 "D:\HARNESS\DeepSeek Harness.exe" tools/qr-check.mjs
 *
 * 比对方式是"同版本 + 同掩码"下矩阵必须一模一样 —— 这样数据编码、纠错、
 * 交织、填充、格式信息、版本信息、掩码，任何一处错都会露出来。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
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

function ref(text, version, mask) {
  const r = spawnSync(PY, ['-c', PY_CODE, text, String(version), String(mask)], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error('python 出错：' + (r.stderr || r.error?.message))
  return JSON.parse(r.stdout)
}

const CASES = [
  // 真实登录 URL（132 字符，版本 8 左右）
  'https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key=eb7b3c438eedcaa9b8d605998baf3433&from=main-fe-header',
  'https://passport.bilibili.com/h5-app/passport/login/scan?navhide=1&qrcode_key=0123456789abcdef0123456789abcdef&from=main-fe-header',
  'hello',
  'a',
  'https://example.com/',
  '中文也要能编码，因为 B站 的 URL 参数偶尔会带中文',
  'https://www.bilibili.com/video/BV1GJ411x7h7?spm_id_from=333.1007',
  'x'.repeat(100),
  'y'.repeat(150),
  'z'.repeat(200),
]

if (!existsSync(PY)) {
  console.log(`没有 python（${PY}）—— 只能自检，不能比对`)
  process.exit(0)
}

let pass = 0
let fail = 0
for (const text of CASES) {
  const mine = encodeQr(text)
  const refM = ref(text, mine.version, mine.mask)
  const mineM = mine.modules.map((row) => row.map((d) => (d ? 1 : 0)))
  const same = JSON.stringify(mineM) === JSON.stringify(refM)
  const sizeOk = refM.length === mine.size
  if (same) {
    pass++
    console.log(`OK   v${mine.version} mask${mine.mask}  ${text.slice(0, 40)}…`)
  } else {
    fail++
    console.log(`DIFF v${mine.version} mask${mine.mask} size=${mine.size}/${refM.length}  ${text.slice(0, 40)}…`)
    if (sizeOk) {
      let diff = 0
      for (let r = 0; r < mine.size; r++) for (let c = 0; c < mine.size; c++) if (mineM[r][c] !== refM[r][c]) diff++
      console.log(`     不同格数：${diff} / ${mine.size * mine.size}`)
      // 掩码选得不一样也算"能扫"，但先看看换个掩码是否能对上
      for (let m = 0; m < 8; m++) {
        if (m === mine.mask) continue
        const alt = encodeQr(text, { version: mine.version, mask: m })
        if (JSON.stringify(alt.modules.map((row) => row.map((d) => (d ? 1 : 0)))) === JSON.stringify(refM)) {
          console.log(`     → 但用 mask${m} 完全一致：说明只是掩码打分不同`)
        }
      }
    }
  }
}

console.log(`\n${pass} 过 / ${fail} 错`)
process.exit(fail ? 1 : 0)
