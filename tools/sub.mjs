/**
 * tools/sub.mjs —— 验证「能不能拿到字幕」，并对照两个接口
 * 用法：node tools/sub.mjs BV1x2Jq6NEbT
 *
 * 链路：view 取 cid → player/wbi/v2 取 subtitle_url → 抓 JSON → 拼正文
 *
 * ⚠️ 2026-11-08 实测：老的 /x/player/v2 会返回**别的视频的** AI 字幕（串台），
 *    插件已改走 wbi 版。这个脚本把两个接口的正文开头都打出来，方便再出问题时对照。
 *    字幕要登录态，脚本会自动借插件自己的 credential.json（有的话）。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 有凭证就带上 —— 没有登录态时 player 接口不返回字幕轨 */
function cookieHeader() {
  for (const dir of ['bili-jar', 'bili-jar-test']) {
    try {
      const c = JSON.parse(readFileSync(join(homedir(), '.dsh', dir, 'credential.json'), 'utf8'))
      const s = ['SESSDATA', 'bili_jct', 'DedeUserID', 'buvid3', 'buvid4']
        .map((k) => (c[k] ? `${k}=${c[k]}` : '')).filter(Boolean).join('; ')
      if (s) { console.log(`凭证：借 ${dir}/credential.json`); return s }
    } catch { /* 试下一个 */ }
  }
  console.log('凭证：没有，走游客态（多半拿不到字幕）')
  return ''
}

const H = {
  'user-agent': UA,
  referer: 'https://www.bilibili.com/',
  cookie: cookieHeader(),
}

const bvid = process.argv[2] || 'BV1x2Jq6NEbT'

const view = await (await fetch(`https://api.bilibili.com/x/web-interface/wbi/view?bvid=${bvid}`, { headers: H })).json().catch(() => null)
const v = view?.code === 0 ? view : await (await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers: H })).json()
const d = v?.data
if (!d) { console.log('view 失败', v?.code, v?.message); process.exit(1) }
const cid = d.cid || d.pages?.[0]?.cid
console.log(`标题=${String(d.title).slice(0, 40)} cid=${cid} 分P=${d.pages?.length}`)

async function probe(label, url) {
  try {
    const j = await (await fetch(url, { headers: H })).json()
    const subs = j?.data?.subtitle?.subtitles || []
    console.log(`[${label}] code=${j?.code} 轨=${subs.length}`)
    for (const s of subs.slice(0, 2)) {
      const raw = String(s.subtitle_url || '')
      const u = raw.startsWith('//') ? 'https:' + raw : raw
      let head = '（取不到）'
      try {
        const b = await (await fetch(u, { headers: H })).json()
        const t = (b?.body || []).map((x) => x.content).join('')
        head = t.replace(/\s+/g, ' ').slice(0, 70)
        console.log(`    lan=${s.lan} 字数=${t.length}`)
      } catch { /* 忽略 */ }
      console.log(`    开头: ${head}`)
    }
  } catch (e) { console.log(`[${label}] 失败: ${e?.message || e}`) }
}

await probe('player/wbi/v2', `https://api.bilibili.com/x/player/wbi/v2?bvid=${bvid}&cid=${cid}&aid=${d.aid}`)
await probe('player/v2（旧，可能串台）', `https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`)
