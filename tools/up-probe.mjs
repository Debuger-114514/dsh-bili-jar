/**
 * tools/up-probe.mjs —— 诊断「固定 UP 通道」到底坏在哪一步
 * 只读、不改仓库状态。跑法：node tools/up-probe.mjs
 */
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
]
const cookies = new Map()
let wbiCache = null

function cookieHeader() { return Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ') }

async function raw(url, { wbi = false, extra = '' } = {}) {
  const u = new URL(url + extra)
  if (wbi) {
    const signed = await signWbi(Object.fromEntries(u.searchParams))
    for (const [k, v] of Object.entries(signed)) u.searchParams.set(k, v)
  }
  const res = await fetch(u, {
    headers: {
      'user-agent': UA,
      referer: 'https://space.bilibili.com/',
      origin: 'https://space.bilibili.com',
      'accept-language': 'zh-CN,zh;q=0.9',
      accept: 'application/json, text/plain, */*',
      ...(cookies.size ? { cookie: cookieHeader() } : {}),
    },
  })
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = { _nonJson: text.slice(0, 120).replace(/\s+/g, ' ') } }
  return { status: res.status, body }
}

async function wbiKeys() {
  if (wbiCache && Date.now() - wbiCache.at < 6 * 3600_000) return wbiCache
  const j = await raw('https://api.bilibili.com/x/web-interface/nav')
  const img = j.body?.data?.wbi_img?.img_url || ''
  const sub = j.body?.data?.wbi_img?.sub_url || ''
  const pick = (s) => s.slice(s.lastIndexOf('/') + 1).replace(/\.\w+$/, '')
  const rawKey = pick(img) + pick(sub)
  const mixinKey = MIXIN_TAB.map((i) => rawKey[i]).join('').slice(0, 32)
  wbiCache = { mixinKey, at: Date.now() }
  return wbiCache
}

async function signWbi(params) {
  const { mixinKey } = await wbiKeys()
  const p = { ...params, wts: Math.floor(Date.now() / 1000) }
  const query = Object.keys(p).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`).join('&')
  p.w_rid = createHash('md5').update(query + mixinKey).digest('hex')
  return p
}

// 1) 载入本机凭证（插件实际用的是这一份）
const credPath = join(homedir(), '.dsh', 'bili-jar', 'credential.json')
if (process.env.NO_CRED) {
  console.log('凭证：按 NO_CRED 故意跳过 —— 模拟游客模式')
} else if (existsSync(credPath)) {
  const c = JSON.parse(readFileSync(credPath, 'utf8'))
  for (const k of ['SESSDATA', 'bili_jct', 'DedeUserID', 'buvid3']) if (c[k]) cookies.set(k, String(c[k]))
  console.log('凭证：已载入', Array.from(cookies.keys()).join(', '))
} else {
  console.log('凭证：没有 credential.json —— 走游客模式')
}

// 2) nav 看登录态
const nav = await raw('https://api.bilibili.com/x/web-interface/nav')
console.log('nav:', nav.status, 'isLogin =', nav.body?.data?.isLogin, '| code =', nav.body?.code, nav.body?.message || '')
if (nav.body?.data?.wbi_img) {
  const spi = await raw('https://api.bilibili.com/x/frontend/finger/spi')
  if (spi.body?.data?.b_3) cookies.set('buvid3', spi.body.data.b_3)
  if (spi.body?.data?.b_4) cookies.set('buvid4', spi.body.data.b_4)
  console.log('buvid: spi 拿到', Boolean(spi.body?.data?.b_3), Boolean(spi.body?.data?.b_4))
}

// 3) 按名字找 UP
const kw = process.argv[2] || '小约翰可汗'
const su = await raw(`https://api.bilibili.com/x/web-interface/wbi/search/type?search_type=bili_user&keyword=${encodeURIComponent(kw)}`, { wbi: true })
const hit = (su.body?.data?.result || [])[0]
console.log(`\n[搜索用户] 「${kw}」 status=${su.status} code=${su.body?.code} 命中=${hit ? `${hit.uname} (mid=${hit.mid})` : '无'}`)
if (!hit) process.exit(0)
const mid = hit.mid

// 4) 四种拉投稿的写法，逐个对照
const dmParams = '&dm_img_list=%5B%5D&dm_img_str=V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ&dm_img_inter=%7B%22ds%22%3A%5B%5D%2C%22wh%22%3A%5B0%2C0%2C0%5D%2C%22of%22%3A%5B0%2C0%2C0%5D%7D&web_location=1550101'
const cases = [
  ['A 当前实现：/x/space/wbi/arc/search（wbi 签名，无 dm_img）',
    `https://api.bilibili.com/x/space/wbi/arc/search?mid=${mid}&ps=6&pn=1&order=pubdate&platform=web`, true, ''],
  ['B /x/space/wbi/arc/search + dm_img 系列参数',
    `https://api.bilibili.com/x/space/wbi/arc/search?mid=${mid}&ps=6&pn=1&order=pubdate&platform=web`, true, dmParams],
  ['C 老接口 /x/space/arc/search（不签名）',
    `https://api.bilibili.com/x/space/arc/search?mid=${mid}&ps=6&pn=1&order=pubdate`, false, ''],
  ['D 动态流 /x/polymer/web-dynamic/v1/feed/space（wbi）',
    `https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=${mid}&timezone_offset=-480&platform=web`, true, dmParams],
]

for (const [label, url, wbi, extra] of cases) {
  const r = await raw(url, { wbi, extra })
  const b = r.body || {}
  const n = b?.data?.list?.vlist?.length
  let note = ''
  if (n != null) note = `vlist=${n} 条`
  else if (b?.data?.items) note = `动态 items=${b.data.items.length} 条`
  else if (b?._nonJson) note = 'HTML: ' + b._nonJson.slice(0, 60)
  else note = `message=${b.message}`
  console.log(`\n[${label}]`)
  console.log(`  HTTP ${r.status}  code=${b.code}  ${note}`)
  if (n) {
    console.log('  最新三条：')
    for (const v of b.data.list.vlist.slice(0, 3)) {
      const days = ((Date.now() / 1000 - v.created) / 86400).toFixed(1)
      console.log(`    · ${String(v.title).slice(0, 30)}  ${days} 天前  ${v.play} 播放`)
    }
  }
  await new Promise((r2) => setTimeout(r2, 800))
}
