/**
 * tools/snapshot.mjs —— 给罐子拍张快照（手动版）
 * ============================================================================
 * ① 把状态目录里的数据文件复制到 backups/<时间>/（只留最近 5 份）
 * ② 调 lib/statefile.mjs 重写 STATE.md
 *
 * 平时不用手动跑：插件启动时和每轮刷新后都会重写 STATE.md，只是不做备份。
 * 跑法：ELECTRON_RUN_AS_NODE=1 "D:\HARNESS\DeepSeek Harness.exe" tools/snapshot.mjs
 * ============================================================================
 */
import { mkdirSync, existsSync, copyFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { writeStateDoc, FILES } from '../lib/statefile.mjs'

const DIR = join(homedir(), '.dsh', 'bili-jar')
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const backupDir = join(DIR, 'backups', stamp)

mkdirSync(backupDir, { recursive: true })
let copied = 0
for (const f of FILES) {
  if (!existsSync(join(DIR, f))) continue
  copyFileSync(join(DIR, f), join(backupDir, f))
  copied++
}

// 只留最近 5 份
const backups = readdirSync(join(DIR, 'backups')).sort()
for (const old of backups.slice(0, Math.max(0, backups.length - 5))) {
  try { rmSync(join(DIR, 'backups', old), { recursive: true, force: true }) } catch { /* 删不掉算了 */ }
}

const out = writeStateDoc(DIR, { backupDir })
console.log(`备份：${backupDir}（${copied} 个文件）`)
console.log(`摘要：${out || '写失败了'}`)
