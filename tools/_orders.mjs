import { searchVideos } from '../lib/bili.mjs'
const daysAgo = (ts) => (Date.now() / 1000 - ts) / 86400
const q = process.argv[2] || '丝之歌'
for (const order of ['totalrank', 'click', 'stow', 'pubdate']) {
  const r = await searchVideos(q, 1, order)
  const items = (r.items || []).filter((x) => x.bvid)
  const ok = items.filter((x) => {
    const d = (x.duration || 0) / 60
    return d >= 8 && d <= 90 && (x.play || 0) >= 10000
  })
  const ages = items.map((x) => Math.floor(daysAgo(x.pubdate || 0))).sort((a, b) => a - b)
  console.log(`${order.padEnd(10)} 搜到 ${items.length} · 过时长+播放 ${ok.length} · 中位年龄 ${ages[Math.floor(ages.length / 2)]}天`)
  if (ok.length) console.log('   ', ok.slice(0, 3).map((x) => `${Math.round(x.duration / 60)}分/${Math.round((x.play || 0) / 1000)}k/${Math.floor(daysAgo(x.pubdate))}天前`).join(' | '))
  await new Promise((res) => setTimeout(res, 500))
}
