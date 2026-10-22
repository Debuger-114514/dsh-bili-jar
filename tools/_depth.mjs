import { searchVideos } from '../lib/bili.mjs'
const BV = 'BV1t54y1a792'
console.log('① 翻更深：totalrank 第 1–10 页')
let hit = 0
for (let p = 1; p <= 10; p++) {
  const r = await searchVideos('空洞骑士', p, 'totalrank')
  const n = (r.items || []).length
  if ((r.items || []).some((x) => x.bvid === BV)) { hit = p; break }
  process.stdout.write(`  第${p}页 ${n}条 · `)
  await new Promise((res) => setTimeout(res, 300))
}
console.log(hit ? `\n  → 第 ${hit} 页找到` : '\n  → 10 页都没找到')
