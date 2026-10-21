/**
 * tools/sub.mjs —— 验证「能不能拿到字幕」
 * 用法：node tools/sub.mjs BV1x2Jq6NEbT
 *
 * 链路：view 取 cid → player/v2 取 subtitle_url → 抓 JSON → 拼正文
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const H = { 'user-agent': UA, referer: 'https://www.bilibili.com/' }

const bvid = process.argv[2] || 'BV1x2Jq6NEbT'

const view = await (await fetch(`https://api.bilibili.com/x/web-interface/wbi/view?bvid=${bvid}`, { headers: H })).json().catch(() => null)
// wbi 版可能 403，退回老的 view
const v = view?.code === 0 ? view : await (await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers: H })).json()
const d = v?.data
if (!d) { console.log('view 失败', v?.code, v?.message); process.exit(1) }
const cid = d.cid || d.pages?.[0]?.cid
console.log(`标题=${String(d.title).slice(0, 40)} cid=${cid} 分P=${d.pages?.length}`)

const p = await (await fetch(`https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`, { headers: H })).json()
console.log('player/v2 code=', p?.code, 'msg=', p?.message || '')
const subs = p?.data?.subtitle?.subtitles || []
console.log('字幕轨数=', subs.length)
for (const s of subs) console.log('  -', s.lan, s.lan_doc, s.subtitle_url?.slice(0, 80))
if (!subs.length) { console.log('⚠️ 这条没有字幕'); process.exit(0) }

const url = subs[0].subtitle_url.startsWith('//') ? 'https:' + subs[0].subtitle_url : subs[0].subtitle_url
const body = await (await fetch(url, { headers: H })).json()
const text = (body?.body || []).map((x) => x.content).join('')
console.log('正文字符数=', text.length)
console.log('开头 200 字：', text.slice(0, 200))
