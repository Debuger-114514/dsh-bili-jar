/**
 * dsh-bili-jar —— 浏览器半端（阶段 2：罐子里真的装东西了）
 * ============================================================================
 * ⭐ client bundle 不是 ESM，是自注册脚本：
 *     window.__ModuleLoader__.load({ id: '<包名>', factory: () => ({ apply(ctx) {} }) })
 *
 * 三个页签：推荐 / 关注 / 待看。数据来自 `/api/bili-jar/feed`。
 * 罐子可拖动，位置记在 localStorage。
 * ============================================================================
 */
(function () {
  const LOADER = window.__ModuleLoader__
  if (!LOADER) {
    try { console.warn('[bili-jar] 没有 __ModuleLoader__，客户端半端跳过') } catch (e) { /* 无所谓 */ }
    return
  }

  LOADER.load({
    id: 'dsh-bili-jar',
    factory: () => {
      const API = '/api/bili-jar'
      const POS_KEY = 'dsh-bili-jar:pos'
      const LATER_KEY = 'dsh-bili-jar:later'
      const SIZE = 64
      const PANEL_W = 360
      const PANEL_H = 520

      let hostEl = null
      let cleanup = null
      /** LLM 写的推荐理由：bvid → 一句话 */
      const reasonsMap = {}

      const CSS = `
:host{all:initial;}
.wrap{position:fixed;left:0;top:0;z-index:2147483000;width:64px;height:64px;
  font:13px/1.5 system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#e8eaed;}
.jar{width:64px;height:64px;border:0;padding:0;background:transparent;cursor:grab;position:relative;
  display:block;filter:drop-shadow(0 6px 14px rgba(0,0,0,.35));touch-action:none;user-select:none;
  transition:transform .18s ease;}
.jar:hover{transform:translateY(-2px) scale(1.03);}
.jar[data-dragging]{cursor:grabbing;transform:scale(1.06);transition:none;}
.jar svg{width:100%;height:100%;display:block;pointer-events:none;}
.badge{position:absolute;top:-2px;right:-2px;min-width:18px;height:18px;padding:0 5px;box-sizing:border-box;
  border-radius:9px;background:#ef4444;color:#fff;font-size:11px;font-weight:700;line-height:18px;text-align:center;
  box-shadow:0 2px 6px rgba(0,0,0,.35);}
.badge[hidden]{display:none;}
.panel{position:absolute;width:${PANEL_W}px;max-height:min(${PANEL_H}px,72vh);overflow:hidden;
  display:flex;flex-direction:column;background:#1b1d21;border:1px solid rgba(255,255,255,.10);
  border-radius:14px;box-shadow:0 18px 40px rgba(0,0,0,.45);}
.panel[hidden]{display:none;}
.panel[data-v="down"]{top:76px;}
.panel[data-v="up"]{bottom:76px;}
.panel[data-h="right"]{left:0;}
.panel[data-h="left"]{right:0;}
.hd{display:flex;align-items:center;gap:8px;padding:11px 13px 9px;}
.hd b{font-size:13px;font-weight:600;flex:1;}
.close{border:0;background:transparent;color:#9aa0a6;font-size:16px;line-height:1;cursor:pointer;padding:2px 4px;border-radius:6px;}
.close:hover{background:rgba(255,255,255,.08);color:#e8eaed;}
.tabs{display:flex;gap:4px;padding:0 10px 8px;}
.tabs button{border:0;background:transparent;color:#9aa0a6;font-size:12px;padding:5px 9px;border-radius:8px;cursor:pointer;font-family:inherit;}
.tabs button:hover{background:rgba(255,255,255,.06);color:#e8eaed;}
.tabs button.on{background:rgba(59,130,246,.18);color:#93c5fd;}
.bd{overflow:auto;padding:2px 10px 10px;display:flex;flex-direction:column;gap:8px;flex:1;}
.item{border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:9px 10px;background:rgba(255,255,255,.03);}
.item:hover{background:rgba(255,255,255,.055);}
.item .t{display:flex;gap:7px;align-items:baseline;}
.item .dur{flex:none;font-size:11px;color:#93c5fd;font-variant-numeric:tabular-nums;}
.item a.tt{color:#e8eaed;text-decoration:none;font-size:12.5px;font-weight:600;line-height:17px;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
.item a.tt:hover{color:#93c5fd;text-decoration:underline;}
.item .meta{margin-top:4px;font-size:11px;color:#6b7280;}
.item .why{margin-top:5px;font-size:11px;line-height:16px;color:#8b949e;}
.item .why2{margin-top:5px;font-size:11.5px;line-height:17px;color:#c8d3e0;}
.item .why2::before{content:'“';color:#93c5fd;}
.item .why2::after{content:'”';color:#93c5fd;}
.item .chips{margin-top:5px;display:flex;flex-wrap:wrap;gap:4px;}
.item .chips span{font-size:10px;padding:1px 6px;border-radius:5px;background:rgba(255,255,255,.06);color:#9aa0a6;}
.item .acts{margin-top:7px;display:flex;gap:6px;}
.item .acts button{font-size:11px;padding:3px 8px;border-radius:6px;cursor:pointer;font-family:inherit;
  border:1px solid rgba(255,255,255,.12);background:transparent;color:#9aa0a6;}
.item .acts button:hover{background:rgba(255,255,255,.08);color:#e8eaed;}
.item .acts button[data-on]{background:rgba(59,130,246,.2);color:#93c5fd;border-color:rgba(59,130,246,.4);}
.msg{font-size:11.5px;line-height:18px;color:#8b949e;padding:10px 4px;text-align:center;}
.msg b{color:#e8eaed;}
.ft{display:flex;align-items:center;gap:8px;padding:8px 12px 10px;border-top:1px solid rgba(255,255,255,.07);}
.ft button{font-size:11.5px;padding:4px 10px;border-radius:7px;cursor:pointer;font-family:inherit;
  border:1px solid rgba(59,130,246,.45);background:rgba(59,130,246,.16);color:#93c5fd;}
.ft button:hover{background:rgba(59,130,246,.26);}
.ft button[disabled]{opacity:.5;cursor:default;}
.ft .ts{margin-left:auto;font-size:10.5px;color:#6b7280;}
`

      const JAR_SVG = `
<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="glass" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#c9e8de" stop-opacity=".92"/>
      <stop offset="1" stop-color="#7fb8a6" stop-opacity=".82"/>
    </linearGradient>
  </defs>
  <rect x="22" y="6" width="20" height="7" rx="2.5" fill="#e7b563"/>
  <rect x="15" y="12" width="34" height="44" rx="9" fill="url(#glass)" stroke="#5f9c8a" stroke-width="1.4"/>
  <ellipse cx="25.5" cy="41" rx="6" ry="5.2" fill="#8fbf5a"/>
  <ellipse cx="37" cy="45" rx="6.4" ry="5.6" fill="#a8cc6b"/>
  <ellipse cx="33" cy="33" rx="5.4" ry="4.6" fill="#7aa94c"/>
  <path d="M22 18c-2.6 3.4-2.6 20 0 23" stroke="#ffffff" stroke-opacity=".55" stroke-width="2" fill="none" stroke-linecap="round"/>
</svg>`

      function el(tag, cls, text) {
        const n = document.createElement(tag)
        if (cls) n.className = cls
        if (text != null) n.textContent = text
        return n
      }

      const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

      function loadPos() {
        try {
          const p = JSON.parse(localStorage.getItem(POS_KEY) || 'null')
          if (Number.isFinite(p?.x) && Number.isFinite(p?.y)) return p
        } catch { /* 坏数据 */ }
        return null
      }

      function loadLater() {
        try {
          const a = JSON.parse(localStorage.getItem(LATER_KEY) || '[]')
          return Array.isArray(a) ? a : []
        } catch { return [] }
      }

      function saveLater(list) {
        try { localStorage.setItem(LATER_KEY, JSON.stringify(list.slice(0, 50))) } catch { /* 满了 */ }
      }

      const fmtPlay = (n) => {
        const v = Number(n) || 0
        if (v >= 1e8) return (v / 1e8).toFixed(1) + '亿'
        if (v >= 1e4) return (v / 1e4).toFixed(1) + '万'
        return String(v)
      }

      const fmtAgo = (ts) => {
        const s = Number(ts)
        if (!s) return ''
        const d = Math.floor((Date.now() / 1000 - s) / 86400)
        if (d <= 0) return '今天'
        if (d === 1) return '昨天'
        if (d < 30) return d + '天前'
        return Math.floor(d / 30) + '个月前'
      }

      function build() {
        hostEl = document.createElement('div')
        hostEl.setAttribute('data-dsh-bili-jar', '')
        const shadow = hostEl.attachShadow({ mode: 'open' })

        const wrap = el('div', 'wrap')
        const jar = el('button', 'jar')
        jar.type = 'button'
        jar.title = '电子榨菜罐（可以拖动）'
        jar.innerHTML = JAR_SVG

        const badge = el('span', 'badge')
        badge.hidden = true
        jar.appendChild(badge)

        const panel = el('div', 'panel')
        panel.hidden = true

        const hd = el('div', 'hd')
        hd.appendChild(el('b', null, '电子榨菜罐'))
        const close = el('button', 'close', '×')
        close.type = 'button'
        hd.appendChild(close)

        const tabsEl = el('div', 'tabs')
        const tabMain = el('button', null, '推荐')
        const tabUp = el('button', null, '关注')
        const tabLater = el('button', null, '待看')
        for (const t of [tabMain, tabUp, tabLater]) { t.type = 'button'; tabsEl.appendChild(t) }
        tabMain.classList.add('on')

        const bd = el('div', 'bd')
        const ft = el('div', 'ft')
        const refresh = el('button', null, '换一批')
        refresh.type = 'button'
        const tsEl = el('span', 'ts', '')
        ft.append(refresh, tsEl)

        panel.append(hd, tabsEl, bd, ft)

        const style = document.createElement('style')
        style.textContent = CSS

        shadow.append(style, wrap)
        wrap.append(panel, jar)
        document.body.appendChild(hostEl)

        // ---- 位置 ----
        let pos = loadPos() || { x: window.innerWidth - SIZE - 18, y: window.innerHeight - SIZE - 18 }
        const clampPos = (p) => ({
          x: clamp(p.x, 8, Math.max(8, window.innerWidth - SIZE - 8)),
          y: clamp(p.y, 8, Math.max(8, window.innerHeight - SIZE - 8)),
        })
        const applyPos = () => {
          pos = clampPos(pos)
          wrap.style.left = pos.x + 'px'
          wrap.style.top = pos.y + 'px'
        }
        const placePanel = () => {
          const below = window.innerHeight - (pos.y + SIZE + 12)
          panel.dataset.v = below >= Math.min(PANEL_H, 300) ? 'down' : 'up'
          panel.dataset.h = pos.x + SIZE / 2 < window.innerWidth / 2 ? 'right' : 'left'
        }
        applyPos()
        placePanel()

        // ---- 拖动 ----
        let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0, pid = null
        const endDrag = () => {
          if (!dragging) return
          dragging = false
          delete jar.dataset.dragging
          try { if (pid != null) jar.releasePointerCapture(pid) } catch { /* 已释放 */ }
          pid = null
          if (moved) { try { localStorage.setItem(POS_KEY, JSON.stringify(pos)) } catch { /* 无所谓 */ } }
        }

        jar.addEventListener('pointerdown', (e) => {
          if (e.pointerType === 'mouse' && e.button !== 0) return
          dragging = true; moved = false
          sx = e.clientX; sy = e.clientY; ox = pos.x; oy = pos.y; pid = e.pointerId
          try { jar.setPointerCapture(e.pointerId) } catch { /* 不支持 */ }
        })
        jar.addEventListener('pointermove', (e) => {
          if (!dragging) return
          const dx = e.clientX - sx, dy = e.clientY - sy
          if (!moved && Math.hypot(dx, dy) < 4) return
          moved = true
          jar.dataset.dragging = '1'
          pos = clampPos({ x: ox + dx, y: oy + dy })
          applyPos(); placePanel()
        })
        jar.addEventListener('pointerup', () => {
          const wasMoved = moved
          endDrag()
          if (!wasMoved) {
            panel.hidden = !panel.hidden
            placePanel()
            if (!panel.hidden) openFeed()
          }
        })
        jar.addEventListener('pointercancel', endDrag)
        jar.addEventListener('lostpointercapture', endDrag)
        close.addEventListener('click', () => { panel.hidden = true })

        const onKey = (e) => { if (e.key === 'Escape') panel.hidden = true }
        document.addEventListener('keydown', onKey)
        const onResize = () => { applyPos(); placePanel() }
        window.addEventListener('resize', onResize)

        // ---- 数据 ----
        let feed = null
        let tab = 'main'
        let loading = false
        let later = loadLater()

        const setTab = (t) => {
          tab = t
          for (const [btn, key] of [[tabMain, 'main'], [tabUp, 'up'], [tabLater, 'later']]) {
            btn.classList.toggle('on', key === t)
          }
          render()
        }
        tabMain.addEventListener('click', () => setTab('main'))
        tabUp.addEventListener('click', () => setTab('up'))
        tabLater.addEventListener('click', () => setTab('later'))

        refresh.addEventListener('click', () => openFeed(true))

        function msg(text) {
          const d = el('div', 'msg')
          d.textContent = text
          bd.appendChild(d)
        }

        function card(it) {
          const box = el('div', 'item')

          const t = el('div', 't')
          t.appendChild(el('span', 'dur', it.durationText || ''))
          const a = el('a', 'tt', it.title || '')
          a.href = it.url
          a.target = '_blank'
          a.rel = 'noreferrer'
          t.appendChild(a)
          box.appendChild(t)

          const p = it.pct || {}
          const rate = (p.like != null) ? ` · 赞${p.like}% 币${p.coin}% 藏${p.fav}%` : ''
          box.appendChild(el('div', 'meta', `${it.author || ''} · ${fmtPlay(it.play)}播放 · ${fmtAgo(it.pubdate)}${rate}`))
          if (reasonsMap[it.bvid]) box.appendChild(el('div', 'why2', reasonsMap[it.bvid]))

          if (it.reasons?.length) box.appendChild(el('div', 'why', it.reasons.join(' · ')))

          if (it.tags?.length) {
            const chips = el('div', 'chips')
            for (const tag of it.tags.slice(0, 4)) chips.appendChild(el('span', null, tag))
            box.appendChild(chips)
          }

          const acts = el('div', 'acts')
          const open = el('button', null, '打开')
          open.type = 'button'
          open.addEventListener('click', () => window.open(it.url, '_blank', 'noopener'))
          acts.appendChild(open)

          const laterBtn = el('button', null, later.some((x) => x.bvid === it.bvid) ? '已在待看' : '稍后看')
          laterBtn.type = 'button'
          laterBtn.addEventListener('click', () => {
            const i = later.findIndex((x) => x.bvid === it.bvid)
            if (i >= 0) later.splice(i, 1)
            else later.unshift({ ...it, addedAt: Date.now() })
            saveLater(later)
            setTab(tab === 'later' ? 'later' : tab)
          })
          acts.appendChild(laterBtn)

          box.appendChild(acts)
          return box
        }

        function render() {
          bd.textContent = ''
          if (loading) { msg('正在装罐…（十几秒）'); return }

          if (tab === 'later') {
            if (!later.length) { msg('待看是空的。看到感兴趣的但没空看，就点「稍后看」。'); return }
            for (const it of later) bd.appendChild(card(it))
            return
          }

          if (!feed || !feed.ok) {
            msg('还没装上东西。点下面「换一批」开始。')
            return
          }

          const list = tab === 'main' ? (feed.main || []) : (feed.up || [])
          if (!list.length) {
            msg(tab === 'main' ? '今天没凑够。试试「换一批」，或者放宽时长/粉丝。' : '固定关注还是空的：去设置里填几个 UP（UID 或名字）。')
            return
          }
          for (const it of list) bd.appendChild(card(it))

          const missing = feed.coverage?.missing || []
          if (tab === 'main' && missing.length) msg('这几根轴今天没货：' + missing.join('、'))
        }

        async function openFeed(force) {
          if (loading) return
          loading = true
          render()
          if (force) refresh.disabled = true
          try {
            const res = await fetch(API + '/feed' + (force ? '?refresh=1' : ''), { credentials: 'same-origin', cache: 'no-store' })
            const data = await res.json()
            if (!res.ok || data.ok === false) throw new Error(data?.error || ('HTTP ' + res.status))
            feed = data
            const n = (data.main || []).length
            badge.textContent = String(n)
            badge.hidden = n === 0
            const when = data.ts ? new Date(data.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''
            tsEl.textContent = data.cached ? `${when} 的库存` : `刚装好 · ${Math.round((data.tookMs || 0) / 1000)}s`
            loadReasons()
          } catch (e) {
            feed = null
            tsEl.textContent = '失败'
            bd.textContent = ''
            msg('装罐失败：' + String(e?.message || e).slice(0, 60))
            return
          } finally {
            loading = false
            refresh.disabled = false
            if (panel.hidden === false) render()
          }
        }

        render()

        /** 让宿主用模型写推荐理由（按需 + 服务端缓存） */
        async function loadReasons() {
          try {
            const res = await fetch(API + '/explain', { credentials: 'same-origin', cache: 'no-store' })
            const data = await res.json()
            if (!data?.ok || !data.reasons) return
            let added = 0
            for (const [bvid, text] of Object.entries(data.reasons)) {
              if (text && reasonsMap[bvid] !== text) { reasonsMap[bvid] = text; added += 1 }
            }
            if (added) render()
          } catch { /* 写不出理由不影响片单 */ }
        }

        return () => {
          window.removeEventListener('resize', onResize)
          document.removeEventListener('keydown', onKey)
          try { hostEl.remove() } catch { /* 已经没了 */ }
        }
      }

      return {
        inject: [],
        apply() {
          if (hostEl && hostEl.isConnected) return
          cleanup = build()
          return () => { try { cleanup?.() } catch { /* 收摊 */ } }
        },
      }
    },
  })
})()
