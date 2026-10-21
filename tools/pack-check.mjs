/**
 * tools/pack-check.mjs —— 发 npm 前的自检（prepublishOnly 会跑）
 * ============================================================================
 * 查三件最容易出事的事：
 *   ① 该进包的文件在不在（index.js / client.js / cordis.patch.yml / lib / assets）
 *   ② 源文件里有没有混进 NUL 字节（写坏过一次，grep 会把它当二进制）
 *   ③ 包体积是不是被人不小心塞了原图（上一次 8 MB，就是因为 assets/art 被一起打进去）
 *
 * 跑法：node tools/pack-check.mjs
 * ============================================================================
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MUST = ['index.js', 'client.js', 'cordis.patch.yml', 'package.json', 'README.md', 'lib/tree.mjs', 'lib/pool.mjs', 'assets/jar-closed.png', 'assets/av-sleep.png']
let bad = 0

for (const f of MUST) {
  if (!existsSync(join(ROOT, f))) { console.error(`✗ 缺文件：${f}`); bad++ }
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else out.push([p, st.size])
  }
  return out
}

// ② NUL 字节 / ③ 体积
const files = []
for (const dir of ['lib', 'assets']) if (existsSync(join(ROOT, dir))) walk(join(ROOT, dir), files)
for (const f of ['index.js', 'client.js']) files.push([join(ROOT, f), statSync(join(ROOT, f)).size])

let total = 0
for (const [p, size] of files) {
  total += size
  if (['.js', '.mjs', '.yml', '.json', '.md'].includes(extname(p))) {
    const buf = readFileSync(p)
    if (buf.includes(0)) { console.error(`✗ 有 NUL 字节：${p}`); bad++ }
  }
}

const mb = total / 1024 / 1024
if (mb > 3) { console.error(`✗ 包太大：${mb.toFixed(1)} MB（原图是不是混进 assets 了？）`); bad++ }
else console.log(`· 打包内容 ${(mb).toFixed(2)} MB / ${files.length} 个文件`)

if (bad) { console.error(`\n自检没过（${bad} 项）`); process.exit(1) }
console.log('自检通过')
