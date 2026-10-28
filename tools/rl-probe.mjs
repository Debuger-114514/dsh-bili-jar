/**
 * tools/rl-probe.mjs —— 连打 arc/search，看「non-json: <!DOCTYPE html>」怎么冒出来
 * 只读。跑法：node tools/rl-probe.mjs [次数] [--login]
 */
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
const cookies = new Map()
const N = Number(process.argv[2] || 8)
const login = process.argv.includes('--login')

if (login) {
  const p = join(homedir(), '.dsh', 'bili-jar', 'credential.json')
  if (existsSync(p)) {
    const c = JSON.parse(readFileSync(p, 'utf8'))
    for (const k of ['SESSDATA', 'bili_jct', 'DedeUserID']) if (c[k]) cookies.set(k, String(c[k]))
  }
}
console.log(`模式：${login ? '登录' : '游客'}，连打 ${N} 次（无间隔）`)

function ck() { return Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ') }

let mixinKey = ''
async function keys() {
  if (mixinKey) return mixinKey
  const r = await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: { 'user-agent': UA } })
  const j = await r.json()
  const pick = (s) => s.slice(s.lastIndexOf('/') + 1).replace(/\.\w+$/, '')
  const raw = pick(j.data.wbi_img.img_url) + pick(j.data.wbi_img.sub_url)
  mixinKey = MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32)
  return mixinKey
}

const mid = 23947287
for (let i = 1; i <= N; i++) {
  const u = new URL(`https://api.bilibili.com/x/space/wbi/arc/search?mid=${mid}&ps=6&pn=1&order=pubdate&platform=web`)
  const mk = await keys()
  const p = Object.fromEntries(u.searchParams)
  p.wts = Math.floor(Date.now() / 1000)
  const q = Object.keys(p).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`).join('&')
  p.w_rid = createHash('md5').update(q + mk).digest('hex')
  for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v)
  const res = await fetch(u, {
    headers: {
      'user-agent': UA, referer: 'https://space.bilibili.com/', origin: 'https://space.bilibili.com',
      'accept-language': 'zh-CN,zh;q=0.9', accept: 'application/json, text/plain, */*',
      ...(cookies.size ? { cookie: ck() } : {}),
    },
  })
  const text = await res.text()
  let tag
  if (text.trimStart().startsWith('<')) tag = `HTML 拦截页（${text.slice(0, 40).replace(/\s+/g, ' ')}…）`
  else { const j = JSON.parse(text); tag = `code=${j.code} ${j.message || 'ok'}` }
  console.log(`  #${i}  HTTP ${res.status}  ${tag}`)
}
