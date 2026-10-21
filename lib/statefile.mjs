/**
 * lib/statefile.mjs —— 把罐子现在的样子写成一份人眼能看的 `STATE.md`
 * ============================================================================
 * 为什么要有：重启 DSH 会把内存里那些东西（池子、片单、理由缓存）清干净，
 * 磁盘上的 json 虽然都在，但没人愿意去翻 68 KB 的 pool.json。
 * 所以每次启动 / 每轮刷新之后，顺手写一份人能读的摘要。
 *
 * 只读不写别的文件；失败不影响主流程。
 * ============================================================================
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { summary as usageSummary } from './usage.mjs'

const read = (dir, name, dflt = null) => {
  try { return JSON.parse(readFileSync(join(dir, name), 'utf8')) } catch { return dflt }
}
const readText = (dir, name) => { try { return readFileSync(join(dir, name), 'utf8') } catch { return '' } }
const sizeOf = (dir, name) => { try { return readFileSync(join(dir, name)).length } catch { return 0 } }
const kb = (n) => (n > 1024 ? `${(n / 1024).toFixed(0)} KB` : `${n} B`)
const when = (ts) => (ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—')

const FILES = ['config.json', 'feed.json', 'pool.json', 'shown.json', 'reasons.json', 'later.json', 'history.json', 'feedback.jsonl', 'usage.json', 'credential.json']

/**
 * 写一份 STATE.md。
 * @param {string} dir 状态目录（~/.dsh/bili-jar）
 * @returns {string|null} 写成功返回路径
 */
export function writeStateDoc(dir, extra = {}) {
  try {
    const cfg = read(dir, 'config.json', {})
    const feed = read(dir, 'feed.json', {})
    const pool = read(dir, 'pool.json', [])
    const later = read(dir, 'later.json', [])
    const history = read(dir, 'history.json', [])
    const reasons = read(dir, 'reasons.json', {})
    const cred = read(dir, 'credential.json', null)
    const usage = usageSummary(join(dir, 'usage.json'))

    const feedback = readText(dir, 'feedback.jsonl').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    const likes = feedback.filter((f) => f.action === 'like').length
    const dislikes = feedback.filter((f) => f.action === 'dislike').length

    const main = Array.isArray(feed?.main) ? feed.main : []
    const poolList = Array.isArray(pool) ? pool : (pool?.items || [])
    const logLines = readText(dir, 'bili-jar.log').trim().split('\n').filter(Boolean).slice(-12)

    const w = []
    w.push('# 电子榨菜罐 · 状态快照')
    w.push('')
    w.push('> 这份文件由插件自己维护（启动时、每轮刷新后重写），可以随时删，删了下次自动再生成。')
    w.push('')
    w.push(`记录时间：${when(Date.now())}（本机时区）`)
    w.push(`数据目录：\`${dir}\``)
    if (extra.backupDir) w.push(`最近备份：\`${extra.backupDir}\``)
    w.push('')
    w.push('## 现在的配置')
    w.push('')
    w.push(`- 兴趣轴：${(cfg.axes || []).join(' / ') || '（默认）'}`)
    w.push(`- 盯的 UP：${(cfg.ups || []).join(' / ') || '（无）'}`)
    w.push(`- 时长：${cfg.minMinutes ?? 8}–${cfg.maxMinutes ?? 90} 分钟　播放门槛：${cfg.minPlay ?? 10000}`)
    w.push(`- 日期窗口：${Number(cfg.maxDays) === 0 ? '不限' : String(cfg.maxDays ?? 14) + ' 天内'}`)
    w.push(`- 每轮条数：${cfg.mainCount ?? 5}　充电专属：${cfg.showCharging ? '推' : '不推'}`)
    w.push(`- 模型：${cfg.apiModel || 'deepseek-chat'}　key：${cfg.apiKey ? '已配置（不记录内容）' : '没配'}`)
    w.push(`- 策展人：${cfg.curatorOn === false ? '关' : '开'}　展开理由：${cfg.explainOn === false ? '关' : '开'}`)
    w.push(`- 内容源：${cfg.contentSource || 'self'}　风格：${(cfg.reasonStyle || '').split('\n')[0].slice(0, 40) || '（默认）'}`)
    w.push('')
    w.push('## 池子与片单')
    w.push('')
    w.push(`- 池子：${poolList.length} 条　片单：${main.length} 条（生成于 ${when(feed?.ts)}）`)
    w.push(`- 本轮统计：搜 ${feed?.stats?.searches ?? '?'} 次 / 原始 ${feed?.stats?.raw ?? '?'} 条 / 入池 ${feed?.stats?.pool ?? '?'} / 合格 ${feed?.stats?.qualified ?? '?'}`)
    w.push('')
    if (main.length) {
      w.push('### 这一批推的是')
      w.push('')
      main.forEach((it, i) => {
        const dur = Math.round((it.duration || 0) / 60)
        w.push(`${i + 1}. **${it.title}**  \`${it.bvid}\``)
        w.push(`   ${it.author} · ${dur} 分钟 · 轴 ${it.axis || '—'}${it.sub ? '·' + it.sub : ''}`)
        if (it.why) w.push(`   > ${it.why}`)
        w.push('')
      })
    }
    w.push('## 记账')
    w.push('')
    w.push(`- 调用 ${usage.total.calls} 次 · 输入 ${usage.total.in} tok · 输出 ${usage.total.out} tok · 合计 ¥${usage.total.cost.toFixed(4)}`)
    w.push(`- 今天 ${usage.today.calls} 次 · ¥${usage.today.cost.toFixed(4)}${usage.estimated ? '（含估算的行）' : ''}`)
    if (usage.last) w.push(`- 最近一次：${usage.last.kind} · ${usage.last.in}+${usage.last.out} tok · ${when(usage.last.ts)}`)
    w.push(`- 当前时段：${usage.pricing.period === 'peak' ? '峰时' : '谷时（半价）'} · 未命中 ¥${usage.pricing.unit.cacheMiss}/M`)
    w.push('')
    w.push('## 别的东西')
    w.push('')
    w.push(`- 待看：${Array.isArray(later) ? later.length : 0} 条`)
    w.push(`- 观看历史：${Array.isArray(history) ? history.length : 0} 条（最多 10 条）`)
    w.push(`- 攒下的理由：${Object.keys(reasons || {}).length} 条`)
    w.push(`- 赞 / 踩：${likes} / ${dislikes}${feedback.length < 20 ? `（还差 ${20 - feedback.length} 条才参与打分）` : '（已参与打分）'}`)
    w.push(`- B站 登录：${cred ? '有凭证（插件自己的）' : '没有'}`)
    w.push('')
    w.push('## 文件占用')
    w.push('')
    for (const f of FILES) if (existsSync(join(dir, f))) w.push(`- \`${f}\` — ${kb(sizeOf(dir, f))}`)
    w.push('')
    w.push('## 最近日志')
    w.push('')
    w.push('```')
    w.push(...(logLines.length ? logLines : ['（还没有日志）']))
    w.push('```')
    w.push('')

    const out = join(dir, 'STATE.md')
    writeFileSync(out, w.join('\n'), 'utf8')
    return out
  } catch {
    return null
  }
}

export { FILES }
