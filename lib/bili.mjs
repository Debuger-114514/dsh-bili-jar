/**
 * lib/bili.mjs —— 极简 B站 客户端（只做我们要用的三件事）
 * ============================================================================
 * 搜索 / 视频详情 / UP 主信息。全部走公开接口，不需要登录。
 * WBI 签名是必须的：没有 w_rid 会被 -403 挡回来。
 *
 * 实测（2026-10-21，从澳洲 IP）：
 *   · 搜索 ✅ code=0，返回 66 个字段，含 duration / tag / is_charge_video
 *   · 详情 ❌ 老的 /x/web-interface/view 会被 WAF 挡回 HTML ⇒ 改走 WBI 版 /x/web-interface/wbi/view
 *   · 粉丝 ❌ acc/info 不再返回 fans ⇒ 走 /x/relation/stat
 * ============================================================================
 */
import { createHash } from 'node:crypto'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
]

const cookies = new Map()
let wbiCache = null

function cookieHeader() {
  return Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ')
}

function absorbCookies(res) {
  try {
    const list = res.headers.getSetCookie ? res.headers.getSetCookie() : []
    for (const c of list) {
      const [pair] = c.split(';')
      const i = pair.indexOf('=')
      if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim())
    }
  } catch { /* 拿不到就算了 */ }
}

async function req(url, { wbi = false } = {}) {
  const u = new URL(url)
  if (wbi) {
    const signed = await signWbi(Object.fromEntries(u.searchParams))
    for (const [k, v] of Object.entries(signed)) u.searchParams.set(k, v)
  }
  const res = await fetch(u, {
    headers: {
      'user-agent': UA,
      referer: 'https://www.bilibili.com/',
      origin: 'https://www.bilibili.com',
      'accept-language': 'zh-CN,zh;q=0.9',
      ...(cookies.size ? { cookie: cookieHeader() } : {}),
    },
  })
  absorbCookies(res)
  const text = await res.text()
  try { return JSON.parse(text) } catch { return { code: -1, message: 'non-json: ' + text.slice(0, 80).replace(/\s+/g, ' ') } }
}

/** 首次请求拿一个 buvid3 —— 没有它，风控概率明显更高 */
async function ensureBuvid() {
  if (cookies.has('buvid3')) return
  try {
    const j = await req('https://api.bilibili.com/x/frontend/finger/spi')
    const b3 = j?.data?.b_3
    if (b3) cookies.set('buvid3', b3)
  } catch { /* 没有也能试 */ }
}

async function wbiKeys() {
  if (wbiCache && Date.now() - wbiCache.at < 6 * 3600_000) return wbiCache
  await ensureBuvid()
  const j = await req('https://api.bilibili.com/x/web-interface/nav')
  const img = j?.data?.wbi_img?.img_url || ''
  const sub = j?.data?.wbi_img?.sub_url || ''
  const pick = (s) => s.slice(s.lastIndexOf('/') + 1).replace(/\.\w+$/, '')
  const raw = pick(img) + pick(sub)
  if (raw.length < 64) throw new Error('拿不到 WBI key（nav 返回异常：' + (j?.message || j?.code) + '）')
  const mixinKey = MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32)
  wbiCache = { mixinKey, at: Date.now() }
  return wbiCache
}

async function signWbi(params) {
  const { mixinKey } = await wbiKeys()
  const p = { ...params, wts: Math.floor(Date.now() / 1000) }
  const query = Object.keys(p).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`)
    .join('&')
  p.w_rid = createHash('md5').update(query + mixinKey).digest('hex')
  return p
}

/** "12:34" / "1:02:03" → 秒 */
export function parseDuration(d) {
  if (typeof d === 'number' && Number.isFinite(d)) return d
  const s = String(d || '').trim()
  if (!s) return 0
  const parts = s.split(':').map((x) => Number(x))
  if (parts.some((n) => !Number.isFinite(n))) return 0
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

/**
 * 搜索视频
 * @returns {Promise<{ok:boolean, code:number, message:string, items:Array}>}
 */
export async function searchVideos(keyword, page = 1, order = 'totalrank') {
  await ensureBuvid()
  const j = await req(
    `https://api.bilibili.com/x/web-interface/wbi/search/type?search_type=video&keyword=${encodeURIComponent(keyword)}&page=${page}&order=${order}`,
    { wbi: true },
  )
  const list = j?.data?.result || []
  return {
    ok: j?.code === 0,
    code: j?.code ?? -1,
    message: j?.message || '',
    items: list.map((it) => ({
      bvid: it.bvid,
      aid: it.aid,
      title: String(it.title || '').replace(/<[^>]+>/g, ''),
      author: it.author,
      mid: it.mid,
      duration: parseDuration(it.duration),
      durationText: it.duration,
      play: it.play,
      pubdate: it.pubdate,
      /** 逗号分隔的 tag 字符串 */
      tag: it.tag,
      tags: String(it.tag || '').split(',').map((s) => s.trim()).filter(Boolean),
      description: String(it.description || '').slice(0, 200),
      pic: it.pic,
      /** ⭐ 搜索层就能判定充电专属，不用再查详情 */
      isCharge: it.is_charge_video === 1,
      isPay: it.is_pay === 1,
      isUnion: it.is_union_video === 1,
      subtitle: Boolean(it.subtitle),
      raw: it,
    })),
  }
}

/** 视频详情：时长 / 充电专属 / 分P 数 */
export async function videoDetail(bvid) {
  await ensureBuvid()
  const j = await req(`https://api.bilibili.com/x/web-interface/wbi/view?bvid=${encodeURIComponent(bvid)}`, { wbi: true })
  const d = j?.data
  if (j?.code !== 0 || !d) return { ok: false, code: j?.code, message: j?.message, data: null }
  return {
    ok: true,
    data: {
      bvid: d.bvid, aid: d.aid, title: d.title, mid: d.owner?.mid, author: d.owner?.name,
      duration: d.duration, pubdate: d.pubdate, pages: (d.pages || []).length,
      /** 播放 / 点赞 / 投币 / 收藏 / 弹幕 / 评论 —— 详情层才有投币 */
      stat: d.stat || {},
      isUpowerExclusive: d.is_upower_exclusive === true,
      isUpowerPlay: d.is_upower_play === true,
      isUpowerPreview: d.is_upower_preview === true,
      raw: d,
    },
  }
}

/** UP 主：粉丝数（relation/stat）+ 昵称（acc/info） */
export async function userInfo(mid) {
  await ensureBuvid()
  const st = await req(`https://api.bilibili.com/x/relation/stat?vmid=${encodeURIComponent(mid)}`)
  const info = await req(`https://api.bilibili.com/x/space/wbi/acc/info?mid=${encodeURIComponent(mid)}`, { wbi: true })
  const fans = st?.data?.follower ?? null
  const d = info?.data || null
  if (st?.code !== 0 && info?.code !== 0) {
    return { ok: false, code: st?.code ?? info?.code, message: st?.message || info?.message, data: null }
  }
  return { ok: true, data: { mid, name: d?.name ?? '', fans, level: d?.level ?? null, sign: d?.sign ?? '' } }
}

/** 按名字找 UP（填"固定关注"时用；能填 UID 就别用这个） */
export async function searchUsers(keyword) {
  await ensureBuvid()
  const j = await req(
    `https://api.bilibili.com/x/web-interface/wbi/search/type?search_type=bili_user&keyword=${encodeURIComponent(keyword)}`,
    { wbi: true },
  )
  const list = j?.data?.result || []
  return {
    ok: j?.code === 0,
    code: j?.code ?? -1,
    message: j?.message || '',
    items: list.map((u) => ({ mid: u.mid, name: u.uname, fans: u.fans, videos: u.videos, sign: u.usign })),
  }
}

/** UP 的投稿列表（按发布倒序） */
export async function userVideos(mid, count = 12) {
  await ensureBuvid()
  const j = await req(
    `https://api.bilibili.com/x/space/wbi/arc/search?mid=${encodeURIComponent(mid)}&ps=${count}&pn=1&order=pubdate&platform=web`,
    { wbi: true },
  )
  const list = j?.data?.list?.vlist || []
  return {
    ok: j?.code === 0,
    code: j?.code ?? -1,
    message: j?.message || '',
    items: list.map((v) => ({
      bvid: v.bvid,
      title: String(v.title || '').replace(/<[^>]+>/g, ''),
      author: v.author,
      mid: v.mid,
      duration: parseDuration(v.length),
      durationText: v.length,
      play: v.play,
      pubdate: v.created,
      tag: v.tag,
      tags: String(v.tag || '').split(',').map((s) => s.trim()).filter(Boolean),
      description: String(v.description || '').slice(0, 200),
      pic: v.pic,
      isCharge: v.is_charge_video === 1,
      isPay: v.is_pay === 1,
      isUnion: v.is_union_video === 1,
      subtitle: Boolean(v.subtitle),
      raw: v,
    })),
  }
}

/** 视频 tag 列表（详情层才带，搜不到的时候用它诊断） */
export async function videoTags(bvid) {
  const j = await req(`https://api.bilibili.com/x/web-interface/view/detail?bvid=${encodeURIComponent(bvid)}`)
  const list = j?.data?.Tags || []
  return list.map((t) => t.tag_name).filter(Boolean)
}
