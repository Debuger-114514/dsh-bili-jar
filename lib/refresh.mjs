/**
 * lib/refresh.mjs —— 三档刷新判定（纯逻辑，不读文件、不联网）
 * ============================================================================
 * 契约见 docs/ups-and-refresh.md §2：
 *   0–3h 不动 / 3h–24h 轻量探测 / >24h 全量重建
 *
 * 判定顺序（按文档，不许改）：
 *   ① !fullAt 或 now - fullAt >= 24h  → 'full'
 *   ② opened 且 now - probedAt >= 3h  → 'probe'
 *   ③ now - probedAt >= 6h            → 'probe'
 *   ④ 否则                            → 'none'
 *
 * “触发同时清零”由调用方负责：真正开始探测/重建时写 probedAt = now，
 * 全量重建再额外写 fullAt = now，落到 ~/.dsh/bili-jar/refresh.json。
 * ============================================================================
 */

/** 打开面板，距上次探测 ≥3h 才探 */
export const OPEN_AFTER_MS = 3 * 3600e3
/** 不管开不开，≥6h 自动探 */
export const AUTO_AFTER_MS = 6 * 3600e3
/** ≥24h 直接全量重建 */
export const FULL_AFTER_MS = 24 * 3600e3

/**
 * @param {{now:number, probedAt:number, fullAt:number, opened:boolean}} s
 * @returns {'full'|'probe'|'none'}
 */
export function decideRefresh(s) {
  const now = Number(s?.now) || 0
  const probedAt = Number(s?.probedAt) || 0
  const fullAt = Number(s?.fullAt) || 0
  const opened = Boolean(s?.opened)

  // ① 从没全量跑过，或者已经超过 24 小时 → 全量（最高优先级）
  if (!fullAt || now - fullAt >= FULL_AFTER_MS) return 'full'

  // ② 用户打开了面板，距上次探测超过 3 小时 → 轻量探测
  if (opened && now - probedAt >= OPEN_AFTER_MS) return 'probe'

  // ③ 不管打没打开，距上次探测超过 6 小时 → 轻量探测
  if (now - probedAt >= AUTO_AFTER_MS) return 'probe'

  // ④ 都是新鲜的，不动
  return 'none'
}
