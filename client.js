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
.item .whyRow{display:flex;gap:6px;align-items:flex-start;margin-top:6px;}
.pet{width:20px;height:20px;flex:none;cursor:pointer;transition:transform .15s ease;}
.pet:hover{transform:scale(1.1);}
.pet svg{width:100%;height:100%;display:block;}
.pet img{width:100%;height:100%;border-radius:50%;object-fit:cover;display:block;
  border:1px solid rgba(255,255,255,.22);background:#1b1d21;}
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
.cfg{display:flex;flex-direction:column;gap:9px;padding:4px 2px;}
.cfg .row2{display:flex;align-items:center;gap:8px;}
.cfg .lbl{font-size:11.5px;color:#9aa0a6;flex:1;}
.cfg .sw{flex:none;min-width:44px;height:24px;border-radius:12px;border:1px solid rgba(255,255,255,.14);
  background:rgba(255,255,255,.06);color:#9aa0a6;font-size:11px;cursor:pointer;font-family:inherit;}
.cfg .sw[data-on]{background:rgba(59,130,246,.28);border-color:rgba(59,130,246,.5);color:#bfdbfe;}
.cfg .ta{width:100%;box-sizing:border-box;padding:8px;border-radius:8px;font-size:11.5px;line-height:17px;
  font-family:inherit;resize:vertical;color:#e8eaed;background:rgba(255,255,255,.05);
  border:1px solid rgba(255,255,255,.12);}
.cfg .ta:focus{outline:none;border-color:rgba(59,130,246,.6);}
.cfg .ta1{width:100%;box-sizing:border-box;padding:6px 8px;border-radius:7px;font-size:11px;font-family:inherit;
  color:#e8eaed;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);}
.cfg .ta1:focus{outline:none;border-color:rgba(59,130,246,.6);}
.cfg .sel{width:100%;box-sizing:border-box;padding:6px 8px;border-radius:7px;font-size:11px;font-family:inherit;
  color:#e8eaed;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);}
.cfg .save{align-self:flex-start;font-size:11.5px;padding:5px 14px;border-radius:7px;cursor:pointer;
  font-family:inherit;border:1px solid rgba(59,130,246,.45);background:rgba(59,130,246,.16);color:#93c5fd;}
.cfg .tip{font-size:10.5px;color:#6b7280;line-height:15px;}
.cfg .loginlink{color:#93c5fd;font-size:11px;text-decoration:none;}
.cfg .loginlink:hover{text-decoration:underline;}
.cfg .ced{display:flex;flex-direction:column;gap:5px;}
.chips2{display:flex;flex-wrap:wrap;gap:5px;align-items:center;}
.chip2{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:2px 7px;border-radius:6px;
  background:rgba(59,130,246,.16);color:#bfdbfe;border:1px solid rgba(59,130,246,.3);}
.chip2 .x{cursor:pointer;font-weight:700;opacity:.7;font-style:normal;}
.chip2 .x:hover{opacity:1;color:#fca5a5;}
.cfg .add{width:88px;padding:3px 7px;border-radius:6px;font-size:11px;font-family:inherit;color:#e8eaed;
  background:rgba(255,255,255,.05);border:1px dashed rgba(255,255,255,.2);}
.cfg .add:focus{outline:none;border-color:rgba(59,130,246,.6);border-style:solid;}
.cfg .logbox{display:flex;flex-direction:column;gap:3px;max-height:150px;overflow:auto;padding:6px;
  border-radius:8px;background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.07);}
.cfg .logline{font-size:10px;line-height:14px;color:#6b7280;font-family:ui-monospace,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.av{width:18px;height:18px;border-radius:50%;flex:none;display:inline-flex;align-items:center;justify-content:center;
  font-size:10px;font-weight:700;color:#0b1220;background:#93c5fd;margin-right:5px;vertical-align:-3px;}
`

      /** 桌宠头像：罐子本人。点它 = 让它多说两句 */
      const PET_SVG = `
<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect x="11" y="3.5" width="10" height="3" rx="1.2" fill="#e7b563"/>
  <rect x="7" y="6.5" width="18" height="21" rx="5" fill="#9fd0c0" stroke="#5f9c8a" stroke-width="1.2"/>
  <circle cx="13" cy="16" r="1.7" fill="#0f172a"/>
  <circle cx="19.5" cy="16" r="1.7" fill="#0f172a"/>
  <path d="M12.5 20.5c1.8 1.8 5.2 1.8 7 0" stroke="#0f172a" stroke-width="1.4" fill="none" stroke-linecap="round"/>
</svg>`

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
        const tabCfg = el('button', null, '设置')
        for (const t of [tabMain, tabUp, tabLater, tabCfg]) { t.type = 'button'; tabsEl.appendChild(t) }
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
          for (const [btn, key] of [[tabMain, 'main'], [tabUp, 'up'], [tabLater, 'later'], [tabCfg, 'cfg']]) {
            btn.classList.toggle('on', key === t)
          }
          render()
        }
        tabMain.addEventListener('click', () => setTab('main'))
        tabUp.addEventListener('click', () => setTab('up'))
        tabLater.addEventListener('click', () => setTab('later'))
        tabCfg.addEventListener('click', () => { setTab('cfg'); loadConfig() })

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

          const whyText = it.why || reasonsMap[it.bvid]
          if (whyText) {
            const row = el('div', 'whyRow')
            const pet = el('span', 'pet')
            pet.title = '点我看更长的推荐理由'
            const img = document.createElement('img')
            img.src = API + '/avatar'
            img.alt = ''
            img.onerror = () => { pet.innerHTML = PET_SVG }
            pet.appendChild(img)
            row.appendChild(pet)

            const w = el('div', 'why2', whyText)
            w.title = '点开看更长的理由'
            w.style.cursor = 'pointer'
            const expand = async () => {
              if (w.dataset.open) { w.textContent = whyText; delete w.dataset.open; return }
              w.textContent = whyText + ' …'
              try {
                const res = await fetch(API + '/explain?bvid=' + encodeURIComponent(it.bvid), { credentials: 'same-origin' })
                const d = await res.json()
                if (d.ok && d.long) { w.textContent = whyText + ' ｜ ' + d.long; w.dataset.open = '1' }
                else w.textContent = whyText
              } catch { w.textContent = whyText }
            }
            pet.addEventListener('click', expand)
            w.addEventListener('click', expand)
            row.appendChild(w)
            box.appendChild(row)
          }

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
          laterBtn.addEventListener('click', async () => {
            const has = later.some((x) => x.bvid === it.bvid)
            try {
              const r = await fetch(API + '/later', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ bvid: it.bvid, action: has ? 'remove' : 'add', item: it }),
              })
              const d = await r.json()
              if (d.ok && Array.isArray(d.items)) later = d.items
            } catch { /* 后端不在就只本地 */ }
            if (has) later = later.filter((x) => x.bvid !== it.bvid)
            else if (!later.some((x) => x.bvid === it.bvid)) later = [{ ...it, addedAt: Date.now() }, ...later]
            setTab(tab === 'later' ? 'later' : tab)
          })
          acts.appendChild(laterBtn)

          for (const [act, label] of [['like', '👍'], ['dislike', '👎']]) {
            const b = el('button', null, label)
            b.type = 'button'
            b.title = act === 'like' ? '喜欢，以后多推这类' : '不喜欢，以后少推'
            b.addEventListener('click', async () => {
              try {
                await fetch(API + '/feedback', {
                  method: 'POST',
                  credentials: 'same-origin',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ bvid: it.bvid, action: act }),
                })
                b.dataset.on = '1'
                b.textContent = act === 'like' ? '👍 已记' : '👎 已记'
              } catch { /* 失败就算了 */ }
            })
            acts.appendChild(b)
          }

          box.appendChild(acts)
          return box
        }

        // ---- 设置页（DSH 原生设置页看不见这些字段，只能自己做在罐子里）----
        let cfgDraft = null

        async function loadConfig() {
          try {
            const res = await fetch(API + '/state', { credentials: 'same-origin', cache: 'no-store' })
            const data = await res.json()
            cfgDraft = { ...(data.config || {}) }
            if (data.usage) cfgDraft.usage = data.usage
            if (tab === 'cfg') render()
          } catch { /* 读不到就空着 */ }
        }

        async function saveConfig(patch) {
          try {
            const res = await fetch(API + '/config', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(patch),
            })
            const data = await res.json()
            if (data.ok) cfgDraft = { ...(data.config || {}) }
            return Boolean(data.ok)
          } catch { return false }
        }

        function renderCfg() {
          if (!cfgDraft) { msg('读取配置…'); return }
          const box = el('div', 'cfg')

          const rowOf = (label, node) => {
            const r = el('div', 'row2')
            r.appendChild(el('span', 'lbl', label))
            r.appendChild(node)
            return r
          }
          const mkSwitch = (key) => {
            const b = el('button', 'sw')
            b.type = 'button'
            const paint = (on) => {
              if (on) b.dataset.on = '1'
              else delete b.dataset.on
              b.textContent = on ? '开' : '关'
            }
            paint(Boolean(cfgDraft[key]))
            b.addEventListener('click', async () => {
              const next = !cfgDraft[key]
              cfgDraft[key] = next
              paint(next)
              const ok = await saveConfig({ [key]: next })
              if (!ok) { cfgDraft[key] = !next; paint(!next) }
            })
            return b
          }
          box.appendChild(rowOf('让模型当策展人', mkSwitch('curatorOn')))
          box.appendChild(rowOf('给每条写理由', mkSwitch('explainOn')))

          // ---- 可编辑的词表：兴趣轴 / 固定关注 ----
          const chipEditor = (key, title, placeholder) => {
            const wrap = el('div', 'ced')
            wrap.appendChild(el('div', 'lbl', title))
            const chips = el('div', 'chips2')
            const draw = () => {
              chips.textContent = ''
              for (const v of (cfgDraft[key] || [])) {
                const c = el('span', 'chip2', String(v))
                const x = el('b', 'x', '×')
                x.addEventListener('click', async () => {
                  cfgDraft[key] = (cfgDraft[key] || []).filter((z) => z !== v)
                  await saveConfig({ [key]: cfgDraft[key] })
                  draw()
                })
                c.appendChild(x)
                chips.appendChild(c)
              }
              const inp = el('input', 'add')
              inp.placeholder = placeholder
              inp.addEventListener('keydown', async (e) => {
                if (e.key !== 'Enter') return
                const v = inp.value.trim()
                if (!v) return
                cfgDraft[key] = [...(cfgDraft[key] || []), v]
                inp.value = ''
                await saveConfig({ [key]: cfgDraft[key] })
                draw()
              })
              chips.appendChild(inp)
            }
            draw()
            wrap.appendChild(chips)
            return wrap
          }
          box.appendChild(chipEditor('axes', '兴趣轴（回车加，× 删）', '例如 数码'))
          box.appendChild(chipEditor('ups', '固定关注的 UP（UID 或名字）', '例如 江平舟'))

          // ---- API 设置（默认 DeepSeek 官方；不填 key 就走宿主模型）----
          const apiRow = (label, key, ph) => {
            const wrap = el('div', 'ced')
            wrap.appendChild(el('div', 'lbl', label))
            const inp = el('input', 'ta1')
            inp.value = cfgDraft[key] || ''
            inp.placeholder = ph
            inp.autocomplete = 'off'
            inp.addEventListener('change', async () => { await saveConfig({ [key]: inp.value.trim() }) })
            wrap.appendChild(inp)
            return wrap
          }
          box.appendChild(apiRow('API 地址', 'apiBase', 'https://api.deepseek.com'))
          box.appendChild(apiRow('API Key（只存本机）', 'apiKey', 'sk-...'))
          box.appendChild(apiRow('模型', 'apiModel', 'deepseek-chat'))

          // ---- B站 登录（插件自己的扫码登录，用来取 AI 字幕）----
          const loginWrap = el('div', 'ced')
          loginWrap.appendChild(el('div', 'lbl', 'B站 登录（取字幕用）'))
          const loginStatus = el('div', 'tip', '检查中…')
          const loginBtn = el('button', 'save', '扫码登录')
          loginBtn.type = 'button'
          loginWrap.append(loginBtn, loginStatus)
          box.appendChild(loginWrap)

          fetch(API + '/login/status', { credentials: 'same-origin', cache: 'no-store' })
            .then((r) => r.json())
            .then((d) => { loginStatus.textContent = d.loggedIn ? '已登录' : '未登录' })
            .catch(() => { loginStatus.textContent = '状态未知' })

          loginBtn.addEventListener('click', async () => {
            loginBtn.disabled = true
            loginStatus.textContent = '请求二维码…'
            try {
              const r = await fetch(API + '/login/start', { credentials: 'same-origin' })
              const d = await r.json()
              if (!d.ok) { loginStatus.textContent = '失败：' + (d.error || ''); loginBtn.disabled = false; return }
              loginStatus.textContent = ''
              const a = el('a', 'loginlink', '用手机打开这个链接确认登录 →')
              a.href = d.url
              a.target = '_blank'
              a.rel = 'noreferrer'
              loginStatus.appendChild(a)
              const tick = async () => {
                try {
                  const pr = await fetch(API + '/login/poll?key=' + encodeURIComponent(d.key), { credentials: 'same-origin' })
                  const pd = await pr.json()
                  if (pd.state === 'ok') { loginStatus.textContent = '登录成功 ✓（凭证已存本机）'; loginBtn.disabled = false; return }
                  if (pd.state === 'expired') { loginStatus.textContent = '二维码过期了，重新点一次'; loginBtn.disabled = false; return }
                  loginStatus.textContent = pd.state === 'scanned' ? '已扫码，手机上点确认' : '等待扫码…'
                } catch { /* 网络抖一下继续轮询 */ }
                setTimeout(tick, 2000)
              }
              setTimeout(tick, 1500)
            } catch {
              loginStatus.textContent = '请求失败'
              loginBtn.disabled = false
            }
          })

          // ---- 内容源 ----
          const csWrap = el('div', 'ced')
          csWrap.appendChild(el('div', 'lbl', '内容源'))
          const csSel = el('select', 'sel')
          for (const [v, label] of [
            ['self', '只用自己的搜索'],
            ['scroll', '额外读「刷B站」的报告（只读文件）'],
            ['both', '两者都要'],
          ]) {
            const o = el('option', null, label)
            o.value = v
            if ((cfgDraft.contentSource || 'self') === v) o.selected = true
            csSel.appendChild(o)
          }
          csSel.addEventListener('change', async () => {
            cfgDraft.contentSource = csSel.value
            await saveConfig({ contentSource: csSel.value })
          })
          csWrap.appendChild(csSel)
          box.appendChild(csWrap)

          box.appendChild(rowOf('复用「刷B站」的登录（取字幕）', mkSwitch('useScrollLogin')))
          box.appendChild(el('div', 'tip', '⚠️ 会读 bili-scroll 的 B站 登录凭证（只读），两个插件共享同一份登录态。不勾选时绝不会读那个文件。'))

          box.appendChild(el('div', 'lbl', '语言风格'))
          const ta = el('textarea', 'ta')
          ta.rows = 4
          ta.value = cfgDraft.reasonStyle || ''
          ta.placeholder = '例如：像朋友在饭桌上随口推荐，别用感叹号，别写“这条视频”'
          box.appendChild(ta)

          const save = el('button', 'save', '保存')
          save.type = 'button'
          save.addEventListener('click', async () => {
            save.textContent = '保存中…'
            const ok = await saveConfig({ reasonStyle: ta.value })
            save.textContent = ok ? '已保存 ✓' : '保存失败'
            setTimeout(() => { save.textContent = '保存' }, 1600)
          })
          box.appendChild(save)

          if (cfgDraft.usage) {
            const u = cfgDraft.usage
            const t = u.today || u
            const all = u.total || u
            box.appendChild(el('div', 'tip', `今天 ${t.calls} 次 · ${t.in + t.out} tok · ¥${t.cost}　累计 ${all.calls} 次 · ¥${all.cost}`))
            if (u.last) box.appendChild(el('div', 'tip', `最近一次：${u.last.kind} · ${u.last.in}+${u.last.out} tok · ¥${u.last.cost}`))
          }
          const logs = el('div', 'logbox')
          logs.appendChild(el('div', 'lbl', '最近日志'))
          box.appendChild(logs)
          fetch(API + '/log?n=20', { credentials: 'same-origin', cache: 'no-store' })
            .then((r) => r.json())
            .then((d) => {
              if (!d.ok || !d.lines?.length) { logs.appendChild(el('div', 'logline', '还没有日志')); return }
              for (const l of d.lines.slice(0, 20)) {
                const t = new Date(l.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                const det = typeof l.detail === 'string' ? l.detail : JSON.stringify(l.detail || '')
                logs.appendChild(el('div', 'logline', `${t} ${l.event} ${det}`.slice(0, 130)))
              }
            })
            .catch(() => { logs.appendChild(el('div', 'logline', '日志读不到')) })

          box.appendChild(el('div', 'tip', '改完点「换一批」会按新设置重新挑。'))

          bd.appendChild(box)
        }

        function render() {
          bd.textContent = ''
          if (tab === 'cfg') { renderCfg(); return }
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
          if (tab === 'main' && feed.curated === false) {
            msg('模型没挑成（' + String(feed.curatorNote || '未知原因') + '），下面是规则片单')
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
            syncLater()
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

        /** 从后端同步「待看」（不再只靠 localStorage） */
        async function syncLater() {
          try {
            const res = await fetch(API + '/later', { credentials: 'same-origin', cache: 'no-store' })
            const d = await res.json()
            if (d.ok && Array.isArray(d.items)) { later = d.items; if (tab === 'later') render() }
          } catch { /* 后端不在就用本地那份 */ }
        }

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
