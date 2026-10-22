import { searchVideos, videoDetail } from '../lib/bili.mjs'
import { axisSim } from '../lib/pool.mjs'

const BV = 'BV1t54y1a792'
const d = await videoDetail(BV)
if (!d.ok) { console.log('详情取不到：', d.message); process.exit(1) }
const v = d.data
const dur = Math.round((v.duration || 0) / 60)
const tags = (v.tags || []).map((t) => t.tag_name || t).slice(0, 10)
const days = Math.floor((Date.now() / 1000 - v.pubdate) / 86400)
console.log('标题:', v.title)
console.log('UP:', v.owner?.name, '| 分区:', v.tname, '| 时长:', dur, '分 | 播放:', v.stat?.view, '|', days, '天前')
console.log('tag:', tags.join(' / '))
console.log('简介:', String(v.desc || '').slice(0, 80))

const it = { bvid: BV, title: v.title, tags, play: v.stat?.view, duration: v.duration, pubdate: v.pubdate, typeName: v.tname }
for (const axis of ['空洞骑士', '丝之歌']) {
  const s = axisSim(it, axis)
  console.log(`轴「${axis}」→ 贴得上=${s.qualified} 相似度=${s.sim} 命中=${s.hits.join(',')}`)
}

console.log('\n它出现在搜索的哪一页？')
for (const order of ['totalrank', 'click', 'stow', 'pubdate']) {
  let found = -1
  for (let page = 1; page <= 3; page++) {
    const r = await searchVideos('空洞骑士', page, order)
    const hit = (r.items || []).find((x) => x.bvid === BV)
    if (hit) { found = page; break }
    await new Promise((res) => setTimeout(res, 350))
  }
  console.log(`  ${order}: 前 3 页里${found > 0 ? `第 ${found} 页找到` : '没找到'}`)
}
