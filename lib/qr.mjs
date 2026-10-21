/**
 * lib/qr.mjs —— 极小的 QR 码编码器（字节模式 / 纠错级 M / 版本 1–10）
 * ============================================================================
 * 只为一个用途：把 B站 登录 URL 画成手机能扫的码。
 *
 * 为什么自己写：B站 那个 URL 只有 130 来字符，版本 8 的容量就够；为了它去
 * 借 Python 的 qrcode 或者拉一个 npm 包，换来的是"换台机器就画不出码"。
 * 这里 BCH + Reed-Solomon + 掩码全在内，零依赖、纯函数。
 *
 * 对齐标准：逐位比对过 Python qrcode（相同输入 → 相同矩阵），见 tools/qr-check.mjs。
 * ============================================================================
 */

/* ── 容量表：纠错级 M ──────────────────────────────────────────────────────
 * v: [每块纠错码字数, [[块数, 每块数据码字数], …]] */
const BLOCKS = {
  1: [10, [[1, 16]]],
  2: [16, [[1, 28]]],
  3: [26, [[1, 44]]],
  4: [18, [[2, 32]]],
  5: [24, [[2, 43]]],
  6: [16, [[4, 27]]],
  7: [18, [[4, 31]]],
  8: [22, [[2, 38], [2, 39]]],
  9: [22, [[3, 36], [2, 37]]],
  10: [26, [[4, 43], [1, 44]]],
}

/** 对齐图形中心（v1 没有） */
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
}

/** 放完数据后剩余的填充位数 */
const REMAINDER = { 1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 0, 8: 0, 9: 0, 10: 0 }

/* ── GF(256)，本原多项式 0x11D ─────────────────────────────────────────── */
const EXP = new Array(512)
const LOG = new Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
}
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]])

/** 生成多项式 (x-α⁰)(x-α¹)…(x-α^(d-1))，高位在前 */
function genPoly(degree) {
  let poly = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]
      next[j + 1] ^= mul(poly[j], EXP[i])
    }
    poly = next
  }
  return poly
}

/** 纠错码字（多项式除法取余） */
function rsRemainder(data, ecLen, gen) {
  const rem = new Array(ecLen).fill(0)
  for (const byte of data) {
    const factor = byte ^ rem[0]
    rem.shift()
    rem.push(0)
    for (let i = 0; i < ecLen; i++) rem[i] ^= mul(gen[i + 1], factor)
  }
  return rem
}

/* ── 位流 ──────────────────────────────────────────────────────────────── */
class Bits {
  constructor() { this.bytes = []; this.cur = 0; this.len = 0 }
  put(value, width) {
    for (let i = width - 1; i >= 0; i--) {
      this.cur = (this.cur << 1) | ((value >>> i) & 1)
      if (++this.len === 8) { this.bytes.push(this.cur & 0xff); this.cur = 0; this.len = 0 }
    }
  }
}

/** 选能装下的最小版本 */
function pickVersion(byteLen) {
  for (const v of Object.keys(BLOCKS).map(Number).sort((a, b) => a - b)) {
    const dataCodewords = BLOCKS[v][1].reduce((n, [b, d]) => n + b * d, 0)
    const countBits = v < 10 ? 8 : 16
    if (4 + countBits + byteLen * 8 <= dataCodewords * 8) return v
  }
  throw new Error(`内容太长（${byteLen} 字节），超出本编码器支持的范围`)
}

/** 文本 → 最终码字序列（数据 + 纠错，已交织） */
function encodeCodewords(text, version) {
  const bytes = Buffer.from(String(text), 'utf8')
  if (version < 10 && bytes.length > 255) throw new Error('版本 1–9 的字节计数只有 8 位')
  const bits = new Bits()
  bits.put(0b0100, 4)                                   // 字节模式
  bits.put(bytes.length, version < 10 ? 8 : 16)
  for (const b of bytes) bits.put(b, 8)

  const [ecLen, groups] = BLOCKS[version]
  const dataLen = groups.reduce((n, [b, d]) => n + b * d, 0)
  // 终止符 + 补齐到字节 + 0xEC/0x11 填充
  const capBits = dataLen * 8
  for (let i = 0; i < 4 && bits.len < capBits; i++) bits.put(0, 1)
  while (bits.len % 8 !== 0) bits.put(0, 1)
  const pads = [0xec, 0x11]
  for (let p = 0; bits.bytes.length < dataLen; p++) bits.bytes.push(pads[p % 2])
  const data = bits.bytes.slice(0, dataLen)

  // 分块 + 逐块算纠错
  const blocks = []
  let offset = 0
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i++) {
      const chunk = data.slice(offset, offset + size)
      offset += size
      blocks.push({ data: chunk, ec: rsRemainder(chunk, ecLen, genPoly(ecLen)) })
    }
  }

  // 交织：先按列取数据码字（短块先结束），再按列取纠错码字
  const out = []
  const maxData = Math.max(...blocks.map((b) => b.data.length))
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i])
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.ec[i])
  return out
}

/* ── 功能图形 ──────────────────────────────────────────────────────────── */
function buildMatrix(version, codewords) {
  const size = 17 + 4 * version
  const mod = Array.from({ length: size }, () => new Array(size).fill(false))
  const fn = Array.from({ length: size }, () => new Array(size).fill(false))
  const set = (r, c, dark) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return
    mod[r][c] = dark
    fn[r][c] = true
  }

  // 三个定位图形（含一圈浅色分隔符）
  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const ring = ((r === 0 || r === 6) && c >= 0 && c <= 6) || ((c === 0 || c === 6) && r >= 0 && r <= 6)
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4
        set(r0 + r, c0 + c, ring || core)
      }
    }
  }

  // 定时图形
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0) }

  // 对齐图形（与定位图形重叠的跳过）
  const centers = ALIGN[version]
  for (const r of centers) {
    for (const c of centers) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1)
      }
    }
  }

  set(size - 8, 8, true)   // 永远是深色的那一格

  // 预留格式信息的位置
  for (let i = 0; i < 9; i++) { fn[8][i] = true; fn[i][8] = true }
  for (let i = 0; i < 8; i++) { fn[8][size - 1 - i] = true; fn[size - 1 - i][8] = true }

  // 预留版本信息的位置（v≥7）
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      fn[Math.floor(i / 3)][size - 11 + (i % 3)] = true
      fn[size - 11 + (i % 3)][Math.floor(i / 3)] = true
    }
  }

  return { size, mod, fn }
}

/** 数据位按之字形填进矩阵（未掩码） */
function placeData(m, codewords) {
  const { size, mod, fn } = m
  const bits = []
  for (const byte of codewords) for (let i = 7; i >= 0; i--) bits.push((byte >>> i) & 1)
  for (const v of Object.values(REMAINDER)) void v   // 余位保持 0，下面越界自然跳过

  let idx = 0
  let upward = true
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--                         // 跳过竖向定时图形那一列
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i
      for (let k = 0; k < 2; k++) {
        const c = col - k
        if (fn[row][c]) continue
        mod[row][c] = idx < bits.length ? bits[idx++] === 1 : false
      }
    }
    upward = !upward
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
]

/** 格式信息：5 位数据（纠错级 M = 00）→ BCH(15,5) → 异或 0x5412 */
function formatBits(mask) {
  const data = mask            // 高 2 位是纠错级，M = 00，所以只剩掩码号
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  return ((data << 10) | rem) ^ 0x5412
}

/** 版本信息：6 位版本号 → BCH(18,6) */
function versionBits(version) {
  let rem = version
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
  return (version << 12) | rem
}

function writeFormat(mod, size, mask) {
  const bits = formatBits(mask)
  const bit = (i) => ((bits >>> i) & 1) === 1
  // 竖排那份：bit0–5 → (0..5,8)、bit6 → (7,8)、bit7 → (8,8)、bit8–14 → 底部 (size-7..size-1,8)
  for (let i = 0; i < 6; i++) mod[i][8] = bit(i)
  mod[7][8] = bit(6)
  mod[8][8] = bit(7)
  for (let i = 8; i < 15; i++) mod[size - 15 + i][8] = bit(i)
  // 横排那份：bit0–7 → (8,size-1..size-8)、bit8 → (8,7)、bit9–14 → (8,5..0)
  for (let i = 0; i < 8; i++) mod[8][size - 1 - i] = bit(i)
  mod[8][7] = bit(8)
  for (let i = 9; i < 15; i++) mod[8][14 - i] = bit(i)
}

function writeVersion(mod, size, version) {
  if (version < 7) return
  const bits = versionBits(version)
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1
    mod[Math.floor(i / 3)][size - 11 + (i % 3)] = dark
    mod[size - 11 + (i % 3)][Math.floor(i / 3)] = dark
  }
}

/** 掩码惩罚分（标准四条规则） */
function penalty(mod, size) {
  let score = 0
  const line = (get) => {
    let run = 1
    for (let i = 1; i < size; i++) {
      if (get(i) === get(i - 1)) run++
      else { if (run >= 5) score += 3 + (run - 5); run = 1 }
    }
    if (run >= 5) score += 3 + (run - 5)
  }
  for (let r = 0; r < size; r++) line((i) => mod[r][i])
  for (let c = 0; c < size; c++) line((i) => mod[i][c])

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = mod[r][c]
      if (v === mod[r][c + 1] && v === mod[r + 1][c] && v === mod[r + 1][c + 1]) score += 3
    }
  }

  const pat = [true, false, true, true, true, false, true]
  const hit = (get, i) => { for (let k = 0; k < 7; k++) if (get(i + k) !== pat[k]) return false
    // 两侧要有 4 格浅色空间才算
    for (let k = 1; k <= 4; k++) { if (i - k >= 0 && get(i - k)) return false }
    return true }
  for (let r = 0; r < size; r++) for (let i = 0; i + 7 <= size; i++) if (hit((j) => mod[r][j], i)) score += 40
  for (let c = 0; c < size; c++) for (let i = 0; i + 7 <= size; i++) if (hit((j) => mod[j][c], i)) score += 40

  let dark = 0
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (mod[r][c]) dark++
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10
  return score
}

function cloneMatrix(mod, size) {
  return Array.from({ length: size }, (_, r) => mod[r].slice())
}

/**
 * 编码。
 * @param {string} text
 * @param {{ mask?: number, version?: number }} [opts] 一般不用传，调试/比对时才用
 * @returns {{ version:number, size:number, mask:number, modules:boolean[][] }}
 */
export function encodeQr(text, opts = {}) {
  const version = opts.version ?? pickVersion(Buffer.byteLength(String(text), 'utf8'))
  const codewords = encodeCodewords(text, version)
  const base = buildMatrix(version, codewords)
  placeData(base, codewords)
  const { size } = base

  const masks = typeof opts.mask === 'number' ? [opts.mask] : [0, 1, 2, 3, 4, 5, 6, 7]
  let best = null
  let bestScore = Infinity
  for (const mask of masks) {
    const mod = cloneMatrix(base.mod, size)
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!base.fn[r][c] && MASKS[mask](r, c)) mod[r][c] = !mod[r][c]
      }
    }
    writeFormat(mod, size, mask)
    writeVersion(mod, size, version)
    const score = penalty(mod, size)
    if (score < bestScore) { bestScore = score; best = { version, size, mask, modules: mod } }
  }
  return best
}

/** 转成 SVG（每格 1 单位，靠 viewBox 放大；margin 是静区格数，标准 4） */
export function qrSvg(text, { margin = 4, dark = '#000', light = '#fff', unit = 4 } = {}) {
  const { size, modules } = encodeQr(text)
  const dim = size + margin * 2
  const rects = []
  for (let r = 0; r < size; r++) {
    let c = 0
    while (c < size) {
      if (!modules[r][c]) { c++; continue }
      let run = 1
      while (c + run < size && modules[r][c + run]) run++
      rects.push(`M${c + margin} ${r + margin}h${run}v1h-${run}z`)
      c += run
    }
  }
  // 整行扫下来拼成一条 path，比几百个 <rect> 紧凑得多
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim * unit}" height="${dim * unit}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">`
    + `<rect width="${dim}" height="${dim}" fill="${light}"/>`
    + `<path fill="${dark}" d="${rects.join('')}"/></svg>`
}

/** 直接给前端用的 data URL（SVG base64，浏览器免额外路由） */
export function qrDataUrl(text, opts) {
  return 'data:image/svg+xml;base64,' + Buffer.from(qrSvg(text, opts), 'utf8').toString('base64')
}

/** 调试用：把矩阵打成字符串 */
export function qrAscii(text, opts) {
  const { modules } = encodeQr(text, opts)
  return modules.map((row) => row.map((d) => (d ? '#' : '.')).join('')).join('\n')
}
