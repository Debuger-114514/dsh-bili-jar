/**
 * dsh-bili-jar —— 浏览器半端（阶段 2：罐子里真的装东西了）
 * ============================================================================
 * ⭐ client bundle 不是 ESM，是自注册脚本：
 *     window.__ModuleLoader__.load({ id: '<包名>', factory: () => ({ apply(ctx) {} }) })
 *
 * 页签：推荐 / 关注 / 待看 / 历史 / 设置。数据来自 `/api/bili-jar`。
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
      const ART = API + '/art'
      const WALK = [ART + '?f=walk-a', ART + '?f=walk-b']
      /** 底部小人当前摆哪个姿势：点一次「更多」换一个 */
      let poseIdx = 0
      /** 「轴的细分（子簇）」那一节是否展开：默认收起，切页签后保持 */
      let treeOpen = false
      let presetsOpen = false

      /**
       * 日志 detail 说人话。
       * feed:built 的 detail 是一整串 JSON（{"searches":9,"raw":180,...}），
       * 直接贴出来再被省略号一切，就成了看不懂的乱码样。
       */
      function prettyDetail(event, d) {
        if (d == null || d === '') return ''
        if (typeof d === 'string') return d
        if (d.searches !== undefined && (d.raw !== undefined || d.pool !== undefined)) {
          return `搜 ${d.searches} 次 · 原始 ${d.raw ?? '?'} · 入池 ${d.pool ?? '?'} · 合格 ${d.qualified ?? '?'} · 推 ${d.picked ?? '?'}`
        }
        try { return JSON.stringify(d) } catch { return String(d) }
      }
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
  font:13px/1.55 'Segoe UI',system-ui,-apple-system,'Microsoft YaHei',sans-serif;color:#1f2a5e;
  --ink:#1e2a63;--ink2:#39477f;--paper:#fbfbff;--paper2:#fff;
  --blue:#4a6ad0;--blue-d:#2c3f9c;--sky:#a9cdf5;--sky-l:#e4efff;
  --blush:#ffd9e2;--gold:#f6d488;--mint:#a8e6c9;
  --txt:#1f2a5e;--muted:#6b78a8;}

/* ── 罐子 ─────────────────────────────────────────────────── */
.jar{width:64px;height:64px;border:0;padding:0;background:transparent;cursor:grab;position:relative;
  display:block;touch-action:none;user-select:none;
  filter:drop-shadow(0 4px 6px rgba(24,36,90,.32));
  transition:transform .2s cubic-bezier(.34,1.56,.64,1);}
.jar:hover{transform:translateY(-3px) rotate(-2deg) scale(1.05);}
.jar:active,.jar[data-dragging]{cursor:grabbing;transform:scale(1.08) rotate(2deg);transition:none;}
.jar img{width:100%;height:100%;object-fit:contain;display:block;pointer-events:none;}
.jar svg{width:100%;height:100%;display:block;pointer-events:none;}
/* 睡着的那张在没人管的时候轻轻呼吸 */
.jar[data-state="closed"] img{animation:breathe 4.2s ease-in-out infinite;transform-origin:50% 85%;}
.jar[data-state="open"] img{animation:bob 3s ease-in-out infinite;transform-origin:50% 85%;}
@keyframes breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.015)}}
@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}

.badge{position:absolute;top:-2px;right:-3px;min-width:19px;height:19px;padding:0 5px;box-sizing:border-box;
  border-radius:10px;background:#ff6f8b;color:#fff;font-size:11px;font-weight:800;line-height:15px;text-align:center;
  border:2px solid var(--ink);box-shadow:2px 2px 0 rgba(30,42,99,.3);}
.badge[hidden]{display:none;}

/* ── 面板 ─────────────────────────────────────────────────── */
.panel{position:absolute;width:${PANEL_W}px;max-height:min(${PANEL_H}px,72vh);overflow:hidden;
  display:flex;flex-direction:column;background:var(--paper);
  border:2.5px solid var(--ink);border-radius:20px;
  box-shadow:0 6px 0 rgba(30,42,99,.10),0 18px 36px rgba(30,42,99,.22);}
.panel[hidden]{display:none;}
.panel[data-v="down"]{top:78px;}
.panel[data-v="up"]{bottom:78px;}
.panel[data-h="right"]{left:0;}
.panel[data-h="left"]{right:0;}

.hd{display:flex;align-items:center;gap:9px;padding:12px 14px 9px;}
.hd .face{width:26px;height:26px;flex:none;border-radius:50%;overflow:hidden;border:2px solid var(--ink);
  background:#e9f2ff;display:flex;align-items:center;justify-content:center;}
.hd .face img{width:100%;height:100%;object-fit:cover;}
.hd b{font-size:14px;font-weight:800;letter-spacing:.2px;flex:1;color:var(--txt);}
.close{border:2px solid transparent;background:transparent;color:#8ba0c8;font-size:16px;line-height:1;
  cursor:pointer;padding:0;width:25px;height:25px;border-radius:9px;transition:all .15s;}
.close:hover{background:#ffe6ec;color:#e8546b;border-color:var(--ink);}

.tabs{display:flex;gap:6px;padding:0 12px 10px;}
.tabs button{border:2px solid transparent;background:transparent;color:#7b89b8;font-size:12px;font-weight:700;
  padding:5px 11px;border-radius:11px;cursor:pointer;font-family:inherit;transition:all .15s;}
.tabs button:hover{background:var(--sky-l);color:var(--txt);}
.tabs button.on{background:var(--sky);color:#12224f;border-color:var(--ink);box-shadow:2px 2px 0 rgba(30,42,99,.22);}

.bd{overflow:auto;padding:2px 12px 12px;display:flex;flex-direction:column;gap:10px;flex:1;}
.bd::-webkit-scrollbar{width:6px;}
.bd::-webkit-scrollbar-thumb{background:#d3ddff;border-radius:6px;}

/* 装罐时的走路小人（两帧来回切） */
/* 底部廊道：出发 / 回来 */
.corridor{position:relative;height:118px;flex:none;overflow:hidden;
  border-top:1px dashed #dfe6fb;background:linear-gradient(#ffffff,#f4f8ff);}
.corridor[hidden]{display:none;}
.corridor .trip{position:absolute;bottom:2px;left:6px;width:112px;height:112px;opacity:0;
  background:url("${ART}?f=anim-out") 0 0 / 672px 112px no-repeat;}
.corridor[data-state="out"] .trip{opacity:1;
  /* 三件事一起：换帧（每 400ms）+ 位移（分 12 段跳，不匀速）+ 左右轻晃（每步一下） */
  animation:framesOut 1.8s steps(6,end) infinite,
            moveOut 4.8s steps(16,end) forwards,
            wobble .6s steps(2,jump-none) infinite;}
.corridor[data-state="back"] .trip{opacity:1;
  background-image:url("${ART}?f=anim-back");
  animation:framesBack 1.8s steps(6,end) infinite,
            moveBack 2.4s steps(8,end) forwards,
            wobble .6s steps(2,jump-none) infinite;}
.corridor[data-state="away"] .trip{opacity:0;}
@keyframes framesOut{from{background-position:0 0}to{background-position:-672px 0}}
@keyframes framesBack{from{background-position:0 0}to{background-position:-672px 0}}
/* 用 px 不用 %：角色放大了，走完整个 360px 面板需要约 470px 位移 */
@keyframes moveOut{from{transform:translateX(0)}to{transform:translateX(470px)}}
@keyframes moveBack{from{transform:translateX(470px)}to{transform:translateX(0)}}
/* 走路颠簸：每步左右各歪一下，配合 steps(2) 就是「左一步、右一步」 */
@keyframes wobble{0%{rotate:-2deg;translate:0 0}50%{rotate:1.5deg;translate:0 -2px}100%{rotate:-2deg;translate:0 0}}

/* 列表最底下那个小人（点「更多」会换姿势） */
.peek{display:flex;justify-content:center;padding:2px 0 6px;user-select:none;pointer-events:none;}
.peek img{width:64px;height:64px;object-fit:contain;opacity:.92;
  filter:drop-shadow(0 3px 4px rgba(30,42,99,.22));}
.peek.walking{position:relative;height:64px;}
.peek.walking img{position:absolute;left:50%;margin-left:-32px;bottom:0;}
.peek.walking img:nth-child(1){animation:peekA .52s steps(1,end) infinite;}
.peek.walking img:nth-child(2){animation:peekB .52s steps(1,end) infinite;}
@keyframes peekA{0%,49.9%{opacity:1}50%,100%{opacity:0}}
@keyframes peekB{0%,49.9%{opacity:0}50%,100%{opacity:1}}

/* ── 卡片 ─────────────────────────────────────────────────── */
.item{border:2px solid var(--ink);border-radius:14px;padding:11px 12px;background:var(--paper2);
  box-shadow:3px 3px 0 rgba(30,42,99,.12);transition:transform .15s,box-shadow .15s;}
.item:hover{transform:translate(-1px,-2px);box-shadow:5px 5px 0 rgba(30,42,99,.16);}
.item .t{display:flex;gap:7px;align-items:baseline;}
.item .dur{flex:none;font-size:10.5px;font-weight:800;color:#0f2a63;background:var(--sky);
  border:1.5px solid var(--ink);border-radius:7px;padding:0 5px;font-variant-numeric:tabular-nums;line-height:16px;}
.item a.tt{color:var(--txt);text-decoration:none;font-size:12.5px;font-weight:700;line-height:17px;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
.item a.tt:hover{color:var(--blue-d);}
.item .meta{margin-top:5px;font-size:10.5px;color:var(--muted);}
.item .why{margin-top:5px;font-size:11px;line-height:16px;color:var(--muted);}
.item .why2{margin-top:6px;font-size:11.5px;line-height:17.5px;color:#2a3a78;}
.item .why2::before{content:'“';color:var(--blue);font-weight:800;}
.item .why2::after{content:'”';color:var(--blue);font-weight:800;}
.item .whyRow{display:flex;gap:7px;align-items:flex-start;margin-top:6px;}
.pet{width:22px;height:22px;flex:none;cursor:pointer;transition:transform .18s cubic-bezier(.34,1.56,.64,1);}
.pet:hover{transform:scale(1.15) rotate(-6deg);}
.pet svg{width:100%;height:100%;display:block;}
.pet img{width:100%;height:100%;border-radius:50%;object-fit:cover;display:block;
  border:1.5px solid var(--ink);background:#fff;}

.item .chips{margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;}
.item .chips span{font-size:9.5px;padding:1px 6px;border-radius:6px;background:var(--sky-l);color:#4a5f9e;
  border:1px solid #cfdcf8;}

.item .acts{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;}
.item .acts button{font-size:11px;font-weight:700;padding:3px 9px;border-radius:8px;cursor:pointer;
  font-family:inherit;border:1.5px solid var(--ink);background:#fff;color:#26356f;
  transition:transform .1s,box-shadow .1s;box-shadow:2px 2px 0 rgba(30,42,99,.16);}
.item .acts button:hover{background:var(--sky-l);}
.item .acts button:active{transform:translate(2px,2px);box-shadow:none;}
.item .acts button[data-on]{background:var(--mint);color:#11402f;}

.msg{font-size:11.5px;line-height:18px;color:var(--muted);padding:12px 6px;text-align:center;}
.msg b{color:var(--txt);}

.ft{display:flex;align-items:center;gap:7px;padding:9px 12px 12px;border-top:2px dashed #dfe6fb;}
.ft button{font-size:11.5px;font-weight:800;padding:4px 11px;border-radius:9px;cursor:pointer;font-family:inherit;
  border:2px solid var(--ink);background:var(--gold);color:#3d2a06;
  box-shadow:2px 2px 0 rgba(30,42,99,.22);transition:transform .1s,box-shadow .1s;}
.ft button:nth-child(2){background:var(--sky);color:#12224f;}
.ft button:hover{filter:brightness(1.04);}
.ft button:active{transform:translate(2px,2px);box-shadow:none;}
.ft button[disabled]{opacity:.5;cursor:default;box-shadow:none;}
.ft .ts{margin-left:auto;font-size:10px;color:var(--muted);text-align:right;line-height:13px;}

/* ── 设置页 ───────────────────────────────────────────────── */
.cfg{display:flex;flex-direction:column;gap:11px;padding:4px 2px;}
.cfg .row2{display:flex;align-items:center;gap:8px;}
.cfg .lbl{font-size:11.5px;font-weight:700;color:#33437f;flex:1;}
.cfg .sw{flex:none;min-width:46px;height:25px;border-radius:13px;border:2px solid var(--ink);
  background:#fff;color:#8ba0c8;font-size:11px;font-weight:800;cursor:pointer;font-family:inherit;
  box-shadow:2px 2px 0 rgba(30,42,99,.16);transition:all .12s;}
.cfg .sw[data-on]{background:var(--mint);color:#11402f;}
.cfg .sw:active{transform:translate(1px,1px);box-shadow:none;}
.cfg .ta{width:100%;box-sizing:border-box;padding:9px;border-radius:11px;font-size:11.5px;line-height:17px;
  font-family:inherit;resize:vertical;color:var(--txt);background:#fff;border:2px solid var(--ink);
  box-shadow:inset 2px 2px 0 rgba(30,42,99,.05);}
.cfg .ta:focus{outline:none;box-shadow:inset 2px 2px 0 rgba(30,42,99,.05),0 0 0 3px rgba(169,205,245,.6);}
.cfg .ta1,.cfg .sel{width:100%;box-sizing:border-box;padding:6px 9px;border-radius:10px;font-size:11px;
  font-family:inherit;color:var(--txt);background:#fff;border:2px solid var(--ink);}
.cfg .ta1:focus,.cfg .sel:focus{outline:none;box-shadow:0 0 0 3px rgba(169,205,245,.6);}
.cfg .save{align-self:flex-start;font-size:11.5px;font-weight:800;padding:5px 14px;border-radius:10px;cursor:pointer;
  font-family:inherit;border:2px solid var(--ink);background:var(--sky);color:#12224f;
  box-shadow:2px 2px 0 rgba(30,42,99,.2);transition:transform .1s,box-shadow .1s;}
.cfg .save:active{transform:translate(2px,2px);box-shadow:none;}
.cfg .save:disabled{background:#e1e4eb;color:#9299aa;border-color:#b6bdcc;cursor:not-allowed;
  box-shadow:none;transform:none;}
.cfg .axishead{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
.cfg .fr{font-size:10px;font-weight:800;border:2px solid var(--ink);border-radius:999px;
  padding:1px 8px;background:var(--sky-l);color:var(--blue-d);cursor:pointer;font-family:inherit;}
.cfg .fr:hover{background:var(--sky);}
.cfg .fr[data-auto="1"]{border-style:dashed;}
.cfg .tip{font-size:10.5px;color:var(--muted);line-height:15px;}
.cfg .loginlink{color:var(--blue-d);font-size:11px;font-weight:700;text-decoration:none;}
.cfg .loginlink:hover{text-decoration:underline;}
.cfg .qrbox{display:none;}
.cfg .qrbox.on{display:flex;flex-direction:column;gap:6px;align-items:flex-start;}
.cfg .qrbox img{width:132px;height:132px;border-radius:10px;background:#fff;padding:6px;border:2px solid var(--ink);}
.cfg .ced{display:flex;flex-direction:column;gap:6px;}

.chips2{display:flex;flex-wrap:wrap;gap:5px;align-items:center;}
.chip2{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;padding:2px 8px;border-radius:9px;
  background:var(--sky-l);color:#2c3f9c;border:1.5px solid var(--ink);box-shadow:1.5px 1.5px 0 rgba(30,42,99,.14);}
.chip2 .x{cursor:pointer;font-weight:800;opacity:.55;font-style:normal;}
.chip2 .x:hover{opacity:1;color:#e8546b;}

.cfg .add{width:88px;padding:3px 8px;border-radius:9px;font-size:11px;font-family:inherit;color:var(--txt);
  background:#fff;border:2px dashed #b9c7ef;}
.cfg .add:focus{outline:none;border-style:solid;border-color:var(--ink);}

.cfg .logbox{display:flex;flex-direction:column;gap:3px;max-height:150px;overflow:auto;padding:8px;
  border-radius:11px;background:#f1f5ff;border:1.5px solid #d6e0f8;}
.cfg .logline{font-size:10px;line-height:14px;color:#5a6a9e;font-family:ui-monospace,Consolas,monospace;
  white-space:normal;word-break:break-word;display:flex;gap:5px;align-items:baseline;}
.cfg .logline .lt{color:#9aa8cf;flex:none;}
.cfg .logline .le{color:var(--blue-d);flex:none;font-weight:700;}
.cfg .logline .ld{color:#5a6a9e;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;}
.cfg .logline.warn .le{color:#a87b12;}
.cfg .logline.error .le{color:#d1435b;}

.mini{position:fixed;right:16px;bottom:16px;width:420px;max-width:calc(100vw - 32px);z-index:2147483000;
  background:var(--paper);border:2.5px solid var(--ink);border-radius:16px;overflow:hidden;
  box-shadow:0 6px 0 rgba(30,42,99,.12),0 16px 36px rgba(30,42,99,.3);display:flex;flex-direction:column;}
.mini-hd{display:flex;align-items:center;gap:8px;padding:6px 9px;cursor:move;background:var(--sky);
  border-bottom:2px solid var(--ink);touch-action:none;}
.mini-tt{flex:1;min-width:0;font-size:11px;font-weight:800;color:#12224f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.mini-x{flex:none;width:20px;height:20px;line-height:1;border-radius:7px;cursor:pointer;font-size:14px;
  color:#12224f;background:#fff;border:1.5px solid var(--ink);}
.mini-x:hover{background:#ffe6ec;}
.mini iframe{display:block;width:100%;aspect-ratio:16/9;border:0;background:#000;}

/* 折叠小节（默认收起，点开才展开） */
.cfg .fold{display:flex;align-items:center;gap:6px;width:100%;text-align:left;font-family:inherit;
  font-size:11.5px;font-weight:700;color:#33437f;background:transparent;border:0;padding:3px 0;cursor:pointer;}
.cfg .fold::before{content:'▸';font-size:10px;color:#8ba0c8;transition:transform .15s;display:inline-block;}
.cfg .fold[data-open]::before{content:'▾';}
.cfg .fold:hover{color:var(--ink);}
.cfg .foldbody{margin-top:2px;}

/* 头像选择条 */
.avstrip{display:flex;gap:8px;flex-wrap:wrap;}
.avpick{position:relative;width:58px;padding:0;border:2px solid transparent;border-radius:13px;background:transparent;
  cursor:pointer;font-family:inherit;display:flex;flex-direction:column;align-items:center;gap:3px;transition:all .15s;}
.avpick img{width:44px;height:44px;border-radius:50%;object-fit:cover;border:2px solid var(--ink);
  background:#fff;box-shadow:2px 2px 0 rgba(30,42,99,.14);transition:transform .15s;}
.avpick span{font-size:9.5px;color:var(--muted);font-weight:700;white-space:nowrap;}
.avpick:hover img{transform:translateY(-2px) scale(1.04);}
.avpick[data-on]{border-color:var(--ink);background:var(--sky-l);}
.avpick[data-on] span{color:var(--ink);}
.avpick[data-on] img{box-shadow:0 0 0 3px rgba(169,205,245,.8);}

.cfg .avprev{width:46px;height:46px;border-radius:12px;object-fit:cover;background:#fff;
  border:2px solid var(--ink);box-shadow:2px 2px 0 rgba(30,42,99,.14);flex:none;}
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
        jar.dataset.state = 'closed'
        const jarImg = document.createElement('img')
        jarImg.src = ART + '?f=closed'
        jarImg.alt = ''
        jarImg.onerror = () => { jar.innerHTML = JAR_SVG }   // 图挂了还有老 SVG 顶着
        jar.appendChild(jarImg)
        /** 没点开时是睡着的，点开换成抱着电脑那张 */
        const setJarState = (open) => {
          jar.dataset.state = open ? 'open' : 'closed'
          jarImg.src = ART + '?f=' + (open ? 'active' : 'closed')
        }

        const badge = el('span', 'badge')
        badge.hidden = true
        jar.appendChild(badge)

        const panel = el('div', 'panel')
        panel.hidden = true

        const hd = el('div', 'hd')
        const face = el('span', 'face')
        const faceImg = document.createElement('img')
        faceImg.src = API + '/avatar'
        faceImg.alt = ''
        face.appendChild(faceImg)
        hd.append(face, el('b', null, '电子榨菜罐'))
        const close = el('button', 'close', '×')
        close.type = 'button'
        hd.appendChild(close)

        const tabsEl = el('div', 'tabs')
        const tabMain = el('button', null, '推荐')
        const tabUp = el('button', null, '关注')
        const tabLater = el('button', null, '待看')
        const tabHistory = el('button', null, '历史')
        const tabCfg = el('button', null, '设置')
        for (const t of [tabMain, tabUp, tabLater, tabHistory, tabCfg]) { t.type = 'button'; tabsEl.appendChild(t) }
        tabMain.classList.add('on')

        const bd = el('div', 'bd')
        const ft = el('div', 'ft')
        const refresh = el('button', null, '换一批')
        refresh.type = 'button'
        // 不重新搜，直接从上一个池子里再捞几条（理由优先用磁盘上存过的）
        const moreBtn = el('button', null, '更多电子榨菜')
        moreBtn.type = 'button'
        moreBtn.title = '不重新抓取，从上一轮的池子里再捞几条'
        const tsEl = el('span', 'ts', '')
        ft.append(refresh, moreBtn, tsEl)

        const corridor = el('div', 'corridor')
        corridor.hidden = true
        corridor.append(el('div', 'trip'))
        panel.append(hd, tabsEl, bd, corridor, ft)

        /**
         * 出发 / 回来。三种状态：
         *   out  —— 从左边走到右边出画（1.8s，6 帧 × 300ms）
         *   away —— 她在画外，只留一行文字
         *   back —— 从右边走回来（1.8s）
         * 走完动画用 class 切回来，避免重播。
         */
        let tripTimer = null
        const setTrip = (state) => {
          if (tripTimer) { clearTimeout(tripTimer); tripTimer = null }
          corridor.hidden = state === 'idle'
          if (state === 'idle') { corridor.removeAttribute('data-state'); return }
          corridor.dataset.state = state
          if (state === 'out') {
            tripTimer = setTimeout(() => { corridor.dataset.state = 'away' }, 4800)
          }
        }

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
            setJarState(!panel.hidden)
            placePanel()
            if (!panel.hidden) openFeed()
          }
        })
        jar.addEventListener('pointercancel', endDrag)
        jar.addEventListener('lostpointercapture', endDrag)
        close.addEventListener('click', () => { panel.hidden = true; setJarState(false) })

        const onKey = (e) => { if (e.key === 'Escape') { panel.hidden = true; setJarState(false); closeMini() } }
        document.addEventListener('keydown', onKey)
        const onResize = () => { applyPos(); placePanel() }
        window.addEventListener('resize', onResize)

        // ---- 数据 ----
        let feed = null
        /** 「更多电子榨菜」新捞上来的那批，第一个的位置（渲染后滚过去） */
        let moreAnchor = null
        let tab = 'main'
        let loading = false
        let later = loadLater()
        let history = []
        let watchQueue = Promise.resolve()

        function updateBadge() {
          const n = feed?.main?.length || 0
          badge.textContent = String(n)
          badge.hidden = n === 0
        }

        function recordWatched(it) {
          watchQueue = watchQueue.then(async () => {
            try {
              const res = await fetch(API + '/history', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ bvid: it.bvid, item: it }),
              })
              const data = await res.json()
              if (!res.ok || !data.ok) throw new Error(data.error || '保存失败')
              history = data.items
              later = data.later
              saveLater(later)
              if (feed) feed = { ...feed, main: data.main, up: data.up }
              updateBadge()
              render()
            } catch {
              tsEl.textContent = '观看历史保存失败，请再次打开视频重试'
            }
          })
        }

        const setTab = (t) => {
          tab = t
          for (const [btn, key] of [[tabMain, 'main'], [tabUp, 'up'], [tabLater, 'later'], [tabHistory, 'history'], [tabCfg, 'cfg']]) {
            btn.classList.toggle('on', key === t)
          }
          render()
        }
        tabMain.addEventListener('click', () => setTab('main'))
        tabUp.addEventListener('click', () => setTab('up'))
        tabLater.addEventListener('click', () => setTab('later'))
        tabHistory.addEventListener('click', () => { setTab('history'); syncHistory() })
        tabCfg.addEventListener('click', () => { setTab('cfg'); loadConfig() })

        refresh.addEventListener('click', () => openFeed(true))

        moreBtn.addEventListener('click', async () => {
          if (loading) return
          loading = true
          moreBtn.disabled = true
          moreBtn.textContent = '翻池子…'
          try {
            const res = await fetch(API + '/more', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ n: 3 }),
              credentials: 'same-origin',
              cache: 'no-store',
            })
            const d = await res.json()
            if (!res.ok || d.ok === false) {
              tsEl.textContent = String(d?.error || '没有了').slice(0, 28)
              setTimeout(() => { tsEl.textContent = '' }, 4000)
              return
            }
            if (d.main) feed = { ...feed, main: d.main }
            poseIdx += 1   // 底部小人换个姿势
            updateBadge()
            tsEl.textContent = `又捞了 ${d.added?.length || 0} 条 · 池里还剩 ${d.left ?? '?'}`
            setTab('main')
          } catch {
            tsEl.textContent = '翻池子失败'
          } finally {
            loading = false
            moreBtn.disabled = false
            moreBtn.textContent = '更多电子榨菜'
            if (panel.hidden === false) render()
            // 新捞上来的在列表最底下，不滚过去就跟没捞一样
            if (moreAnchor) setTimeout(() => { try { moreAnchor.scrollIntoView({ block: 'start', behavior: 'smooth' }) } catch { /* 老浏览器 */ } }, 30)
          }
        })

        function msg(text) {
          const d = el('div', 'msg')
          d.textContent = text
          bd.appendChild(d)
        }

        /** 小窗播放：B站 的 embed 播放器允许被 iframe 嵌（player.bilibili.com 没设 X-Frame-Options） */
        let miniWin = null
        function closeMini() {
          if (miniWin) { miniWin.remove(); miniWin = null }
        }
        function openMini(it) {
          closeMini()
          recordWatched(it)
          const w = el('div', 'mini')
          const head = el('div', 'mini-hd')
          const tt = el('span', 'mini-tt', it.title || '')
          tt.title = it.title || ''
          const x = el('button', 'mini-x', '×')
          x.type = 'button'
          x.title = '关掉小窗'
          head.append(tt, x)
          const frame = document.createElement('iframe')
          frame.src = `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(it.bvid)}&autoplay=1&high_quality=1&danmaku=1&as_wide=1`
          frame.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture'
          frame.allowFullscreen = true
          frame.setAttribute('frameborder', '0')
          w.append(head, frame)
          wrap.appendChild(w)
          miniWin = w
          x.addEventListener('click', closeMini)
          // 拖动（按住标题栏）
          let drag = null
          head.addEventListener('pointerdown', (e) => {
            if (e.target === x) return
            const r = w.getBoundingClientRect()
            drag = { dx: e.clientX - r.left, dy: e.clientY - r.top }
            head.setPointerCapture(e.pointerId)
          })
          head.addEventListener('pointermove', (e) => {
            if (!drag) return
            const r = w.getBoundingClientRect()
            const left = Math.max(4, Math.min(window.innerWidth - r.width - 4, e.clientX - drag.dx))
            const top = Math.max(4, Math.min(window.innerHeight - r.height - 4, e.clientY - drag.dy))
            w.style.left = left + 'px'
            w.style.top = top + 'px'
            w.style.right = 'auto'
            w.style.bottom = 'auto'
          })
          head.addEventListener('pointerup', () => { drag = null })
          head.addEventListener('pointercancel', () => { drag = null })
        }
        window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMini() })

        function card(it) {
          const box = el('div', 'item')

          const t = el('div', 't')
          t.appendChild(el('span', 'dur', it.durationText || ''))
          const a = el('a', 'tt', it.title || '')
          a.href = it.url
          a.target = '_blank'
          a.rel = 'noreferrer'
          a.addEventListener('click', () => recordWatched(it))
          a.addEventListener('auxclick', (e) => { if (e.button === 1) recordWatched(it) })
          t.appendChild(a)
          box.appendChild(t)

          const p = it.pct || {}
          const rate = (p.like != null) ? ` · 赞${p.like}% 币${p.coin}% 藏${p.fav}%` : ''
          box.appendChild(el('div', 'meta', `${it.author || ''} · ${fmtPlay(it.play)}播放 · ${fmtAgo(it.pubdate)}${rate}`))
          if (tab === 'history' && it.watchedAt) {
            box.appendChild(el('div', 'meta', '观看于 ' + new Date(it.watchedAt).toLocaleString('zh-CN')))
          }

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
          open.addEventListener('click', () => {
            window.open(it.url, '_blank', 'noopener')
            recordWatched(it)
          })
          acts.appendChild(open)

          const miniBtn = el('button', null, '小窗')
          miniBtn.type = 'button'
          miniBtn.title = '在这儿小窗播放，不跳走'
          miniBtn.addEventListener('click', () => openMini(it))
          acts.appendChild(miniBtn)

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
            cfgDraft = { ...(data.config || {}), apiKeyMasked: data.apiKeyMasked || '' }
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
            if (data.ok) cfgDraft = { ...(data.config || {}), apiKeyMasked: data.apiKeyMasked || '' }
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
          box.appendChild(rowOf('点开时展开更长的理由', mkSwitch('explainOn')))

          // ---- 数字设置（以前只能改 config.json）----
          const numRow = (label, key, hint, min, max, step) => {
            const wrap = el('div', 'row2')
            wrap.appendChild(el('span', 'lbl', label))
            const inp = el('input', 'ta1')
            inp.type = 'number'
            inp.style.width = '76px'
            inp.style.flex = 'none'
            inp.value = String(cfgDraft[key] ?? '')
            inp.min = String(min ?? 0)
            if (max != null) inp.max = String(max)
            if (step != null) inp.step = String(step)
            const save = async () => {
              const n = Number(inp.value)
              if (!Number.isFinite(n) || n < (min ?? 0)) { inp.value = String(cfgDraft[key] ?? ''); return }
              cfgDraft[key] = n
              await saveConfig({ [key]: n })
            }
            inp.addEventListener('change', save)
            wrap.appendChild(inp)
            if (hint) wrap.appendChild(el('span', 'tip', hint))
            return wrap
          }
          box.appendChild(numRow('日期窗口（天）', 'maxDays', '0 = 不限', 0))
          box.appendChild(numRow('最短时长（分）', 'minMinutes', '', 0))
          box.appendChild(numRow('最长时长（分）', 'maxMinutes', '', 1))
          box.appendChild(numRow('播放门槛', 'minPlay', '', 0))
          box.appendChild(numRow('每轮几条', 'mainCount', '', 1))
          // 0 = 每次都一样；1 = 很随机。默认 0.5：前 5 名固定，后面的按分数加权打乱
          box.appendChild(numRow('多样性（0–1）', 'diversity', '0 = 固定，越大越随机', 0, 1, 0.1))

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
          // 内置分区与子簇分开，放在兴趣轴编辑器下方。
          const presetsWrap = el('div', 'ced')
          const presetsHead = el('button', 'fold', '内置分区')
          presetsHead.type = 'button'
          const presetsBody = el('div', 'foldbody')
          const presetsBox = el('div', 'chips2')
          presetsBody.append(el('div', 'tip', '点一下加进兴趣轴，带现成的子簇'), presetsBox)
          presetsBody.hidden = !presetsOpen
          if (presetsOpen) presetsHead.dataset.open = '1'
          presetsHead.onclick = () => {
            presetsOpen = !presetsOpen
            presetsBody.hidden = !presetsOpen
            if (presetsOpen) presetsHead.dataset.open = '1'
            else delete presetsHead.dataset.open
          }
          presetsWrap.append(presetsHead, presetsBody)
          box.appendChild(presetsWrap)

          // ---- 轴的细分（子簇）：决定每小时轮换的搜索词 ----
          const treeWrap = el('div', 'ced')
          const treeHead = el('button', 'fold', '轴的细分（子簇）')
          treeHead.type = 'button'
          const treeBox = el('div', 'ced')
          const treeMsg = el('div', 'tip', '自带的子簇删不掉；「看建议」先用本地规则找候选，有候选才调用模型筛选')
          const treeBody = el('div', 'foldbody')
          treeBody.append(treeBox, treeMsg)
          // 默认收起：这块又长又不常用，展开状态在本次会话里记住
          treeBody.hidden = !treeOpen
          if (treeOpen) treeHead.dataset.open = '1'
          treeHead.onclick = () => {
            treeOpen = !treeOpen
            treeBody.hidden = !treeOpen
            if (treeOpen) { treeHead.dataset.open = '1'; paintTree() } else { delete treeHead.dataset.open }
          }
          treeWrap.append(treeHead, treeBody)
          box.appendChild(treeWrap)
          box.appendChild(chipEditor('ups', '固定关注的 UP（UID 或名字）', '例如 江平舟'))

          const treeApi = async (body) => {
            const r = await fetch(API + '/tree', {
              method: 'POST', credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            })
            return r.json()
          }

          let treeRevision = 0
          const paintTree = async () => {
            const revision = ++treeRevision
            let d = null
            try {
              d = await (await fetch(API + '/tree', { credentials: 'same-origin', cache: 'no-store' })).json()
            } catch { d = null }
            if (revision !== treeRevision) return
            treeBox.textContent = ''
            if (!d || !d.ok) { treeMsg.textContent = '读不到轴树'; return }

            presetsBox.textContent = ''
            const have = new Set(cfgDraft.axes || [])
            const spare = (d.presets || []).filter((n) => !have.has(n))
            if (!spare.length) presetsBox.appendChild(el('span', 'tip', '内置分区已全部添加'))
            for (const name of spare) {
              const b = el('button', 'save', '＋ ' + name)
              b.type = 'button'
              b.onclick = async () => {
                const axes = [...new Set([...(cfgDraft.axes || []), name])]
                if (await saveConfig({ axes })) render()
              }
              presetsBox.appendChild(b)
            }

            for (const ax of (cfgDraft.axes || [])) {
              const node = (d.nodes && d.nodes[ax]) || { subs: [] }
              const line = el('div', 'ced')
              const head = el('div', 'lbl')
              head.textContent = ax + (node.builtin ? '' : '（自己建的）')
              // 时效：news = 只看最近 14 天；evergreen = 不限日期
              const fresh = el('button', 'fr', node.freshness === 'evergreen' ? '不过期' : '新闻 14 天')
              fresh.type = 'button'
              fresh.title = node.freshness === 'evergreen'
                ? '内容不过期：不按日期过滤。点一下改回「新闻 14 天」'
                : '内容会过期：只看最近 14 天。点一下改成「不过期」'
              if (node.freshnessAuto) fresh.dataset.auto = '1'
              fresh.onclick = async () => {
                const next = node.freshness === 'evergreen' ? 'news' : 'evergreen'
                const r = await treeApi({ axis: ax, action: 'setFreshness', value: next })
                if (r.ok) { node.freshness = next; node.freshnessAuto = false; render() }
              }
              const headWrap = el('div', 'axishead')
              headWrap.append(head, fresh)
              line.appendChild(headWrap)
              const chips = el('div', 'chips2')
              const axisMsg = el('div', 'tip')
              const suggestionButtons = new Map()
              const paintSubs = () => {
                chips.textContent = ''
                if (!(node.subs || []).length) chips.appendChild(el('span', 'tip', '还没有子簇'))
                for (const sub of node.subs || []) {
                  const c = el('span', 'chip2', sub.name)
                  c.title = (sub.terms || []).join(' / ')
                  if (sub.mine) {
                    const x = el('i', 'x', '×')
                    x.onclick = async () => {
                      try {
                        const result = await treeApi({ axis: ax, action: 'delSub', name: sub.name })
                        if (!result.ok) throw new Error(result.error || '删除失败')
                        node.subs = node.subs.filter((it) => it.name !== sub.name)
                        paintSubs()
                        const option = suggestionButtons.get(sub.name)
                        if (option) {
                          option.button.disabled = false
                          option.button.textContent = option.label
                        }
                        axisMsg.textContent = `已删除「${sub.name}」，可从本轮建议重新添加`
                      } catch { axisMsg.textContent = `删除「${sub.name}」失败，请重试` }
                    }
                    c.appendChild(x)
                  }
                  chips.appendChild(c)
                }
              }
              paintSubs()
              const sug = el('button', 'save', '看建议')
              const suggestions = el('div', 'ced')
              sug.type = 'button'
              sug.title = '本地没有候选时不调用模型；有候选才请求模型筛选'
              sug.onclick = async () => {
                if (sug.disabled) return
                sug.disabled = true
                sug.textContent = '挖…'
                // 每次请求替换本轴的结果，空结果或失败也不会留下上次的建议。
                suggestions.textContent = ''
                suggestionButtons.clear()
                axisMsg.textContent = '正在查找并筛选建议…'
                try {
                  const r = await fetch(API + '/tree/suggest?axis=' + encodeURIComponent(ax) + '&review=1', { credentials: 'same-origin', cache: 'no-store' })
                  const sd = await r.json()
                  if (revision !== treeRevision) return
                  if (!sd.ok) { axisMsg.textContent = sd.error || '没有建议'; return }
                  const out = el('div', 'chips2')
                  if (!sd.clusters || !sd.clusters.length) {
                    // 模型把候选都否了 —— 把它的理由摊开，比只说"没有"有用
                    const why = (sd.dropped || []).map((d) => `${d.seed}：${d.why}`).join('；')
                    axisMsg.textContent = why ? `${ax}：都没留下 —— ${why}` : `${ax}：没有够格的建议`
                    return
                  }
                  axisMsg.textContent = sd.reviewed ? '模型筛过一遍了，点一个加进去' : (sd.reviewNote || '')
                  for (const c of sd.clusters) {
                    const optionName = String(c.name).trim().slice(0, 24)
                    if (suggestionButtons.has(optionName)) continue
                    const b = el('button', 'save', `＋ ${c.name}（${c.df} 条）`)
                    suggestionButtons.set(optionName, { button: b, label: b.textContent })
                    b.type = 'button'
                    b.title = (c.why ? c.why + ' ｜ ' : '') + (c.terms || []).join(' / ')
                    b.onclick = async () => {
                      if (b.disabled) return
                      b.disabled = true
                      const label = b.textContent
                      b.textContent = '添加中…'
                      try {
                        const result = await treeApi({ axis: ax, action: 'addSub', name: c.name, terms: c.terms })
                        if (!result.ok) throw new Error(result.error || '添加失败')
                        const name = String(c.name).trim().slice(0, 24)
                        const saved = result.nodes?.[ax]?.subs?.find((it) => it.name === name)
                        node.subs = [...(node.subs || []).filter((it) => it.name !== name),
                          { name, terms: saved?.terms || c.terms || [], mine: true }]
                        paintSubs()
                        b.textContent = `已添加 · ${name}`
                        axisMsg.textContent = `给「${ax}」加上子簇「${name}」，可以继续添加其他建议`
                      } catch {
                        b.disabled = false
                        b.textContent = label
                        axisMsg.textContent = `添加「${c.name}」失败，请重试`
                      }
                    }
                    out.appendChild(b)
                  }
                  if (sd.dropped && sd.dropped.length) {
                    const d = el('div', 'tip', '模型否掉的：' + sd.dropped.map((x) => `${x.seed}（${x.why}）`).join('；'))
                    suggestions.appendChild(d)
                  }
                  suggestions.appendChild(out)
                } catch {
                  if (revision === treeRevision) axisMsg.textContent = `${ax}：获取建议失败，请重试`
                } finally {
                  sug.disabled = false
                  sug.textContent = '看建议'
                }
              }
              line.append(chips, sug, suggestions, axisMsg)
              treeBox.appendChild(line)
            }
          }
          paintTree()

          // ---- 头像 ----
          const avWrap = el('div', 'ced')
          avWrap.appendChild(el('div', 'lbl', '头像（推荐理由旁边那只）'))

          // 四档内置头像，点一下就用；自己传的图会盖住它们
          const AV_PRESETS = [['sleep', '睡觉'], ['tv', '看电视'], ['explore', '探险'], ['other', '哦鲸鲸'], ['walk', '走路']]
          const avStrip = el('div', 'avstrip')
          for (const [key, label] of AV_PRESETS) {
            const b = el('button', 'avpick')
            b.type = 'button'
            b.title = '换成「' + label + '」'
            const im = document.createElement('img')
            im.src = API + '/avatar?p=' + key
            im.alt = label
            b.appendChild(im)
            b.appendChild(el('span', null, label))
            if ((cfgDraft.avatarPreset || 'sleep') === key) b.dataset.on = '1'
            b.addEventListener('click', async () => {
              try {
                const r = await fetch(API + '/avatar/preset', {
                  method: 'POST', credentials: 'same-origin',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ name: key }),
                })
                const d = await r.json()
                if (!d.ok) { avMsg.textContent = d.error || '换不了'; return }
                cfgDraft.avatarPreset = key
                avMsg.textContent = '已换成「' + label + '」'
                faceImg.src = API + '/avatar?t=' + Date.now()   // 页头那个是常驻的，render() 不会重建它
                render()
              } catch { avMsg.textContent = '换不了' }
            })
            avStrip.appendChild(b)
          }
          avWrap.appendChild(avStrip)

          const avRow = el('div', 'row2')
          const avImg = document.createElement('img')
          avImg.className = 'avprev'
          avImg.src = API + '/avatar?t=' + Date.now()
          avImg.alt = ''
          const avPick = el('button', 'save', '换一张')
          avPick.type = 'button'
          const avReset = el('button', 'save', '恢复默认')
          avReset.type = 'button'
          const avFile = document.createElement('input')
          avFile.type = 'file'
          avFile.accept = 'image/png,image/jpeg,image/webp'
          avFile.style.display = 'none'
          const avMsg = el('div', 'tip', 'png / jpeg / webp，方形最好，3 MB 以内')
          avRow.append(avImg, avPick, avReset, avFile)
          avWrap.append(avRow, avMsg)
          box.appendChild(avWrap)

          avPick.addEventListener('click', () => avFile.click())
          avFile.addEventListener('change', () => {
            const f = avFile.files && avFile.files[0]
            if (!f) return
            if (f.size > 3 * 1024 * 1024) { avMsg.textContent = '超过 3 MB 了，换张小点的'; return }
            const reader = new FileReader()
            reader.onload = async () => {
              try {
                const r = await fetch(API + '/avatar', {
                  method: 'POST', credentials: 'same-origin',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ dataUrl: String(reader.result) }),
                })
                const d = await r.json()
                if (!d.ok) { avMsg.textContent = d.error || '换失败'; return }
                avMsg.textContent = '换好了 ✓'
                faceImg.src = API + '/avatar?t=' + Date.now()
                render()
              } catch { avMsg.textContent = '上传失败' }
            }
            reader.readAsDataURL(f)
          })
          avReset.addEventListener('click', async () => {
            try {
              const r = await fetch(API + '/avatar', { method: 'DELETE', credentials: 'same-origin' })
              const d = await r.json()
              if (d.ok) {
                avMsg.textContent = '已恢复默认'
                faceImg.src = API + '/avatar?t=' + Date.now()
                render()
              }
            } catch { avMsg.textContent = '恢复失败' }
          })

          // ---- API 设置（默认 DeepSeek 官方；不填 key 就走宿主模型）----
          const apiRow = (label, key, ph) => {
            const wrap = el('div', 'ced')
            wrap.appendChild(el('div', 'lbl', label))
            const inp = el('input', 'ta1')
            const isKey = key === 'apiKey'
            inp.type = isKey ? 'password' : 'text'
            inp.value = isKey ? '' : (cfgDraft[key] || '')
            inp.placeholder = isKey ? (cfgDraft.apiKeyMasked || ph) : ph
            inp.autocomplete = 'off'
            inp.addEventListener('change', async () => {
              const ok = await saveConfig({ [key]: inp.value.trim() })
              if (ok && isKey) {
                inp.value = ''
                inp.placeholder = cfgDraft.apiKeyMasked || ph
              }
            })
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
          // 二维码：host 端自己编码成 SVG 的 data URL（lib/qr.mjs），这里只负责摆
          const qrBox = el('div', 'qrbox')
          const qrImg = el('img', '')
          qrImg.alt = 'B站 登录二维码'
          const qrTip = el('div', 'tip', '手机 B站 → 我的 → 扫一扫；确认时选「记住我」那张，不然明天还得重扫')
          qrBox.append(qrImg, qrTip)
          loginWrap.append(loginBtn, loginStatus, qrBox)
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
              qrBox.classList.remove('on')
              qrImg.removeAttribute('src')
              if (d.qr) {
                qrImg.src = d.qr
                qrBox.classList.add('on')
              } else {
                // 编码器挂了的兜底：至少给个能点的链接
                const a = el('a', 'loginlink', '二维码没画出来，点这里用手机打开确认登录 →')
                a.href = d.url
                a.target = '_blank'
                a.rel = 'noreferrer'
                loginStatus.appendChild(a)
              }
              const tick = async () => {
                try {
                  const pr = await fetch(API + '/login/poll?key=' + encodeURIComponent(d.key), { credentials: 'same-origin' })
                  const pd = await pr.json()
                  if (pd.state === 'ok') { loginStatus.textContent = '登录成功 ✓（凭证已存本机）'; loginBtn.disabled = false; return }
                  if (pd.state === 'expired') { loginStatus.textContent = '二维码过期了，重新点一次'; qrBox.classList.remove('on'); loginBtn.disabled = false; return }
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

          box.appendChild(el('div', 'lbl', '语言风格（理由按它写，也可以从 .md 导入）'))
          const ta = el('textarea', 'ta')
          ta.rows = 4
          ta.value = cfgDraft.reasonStyle || ''
          ta.placeholder = '例如：像朋友在饭桌上随口推荐，别用感叹号，别写“这条视频”'
          box.appendChild(ta)
          box.appendChild(el('div', 'tip', '超过 1500 字的部分不会送进模型（每次调用都按它算钱），导入的 .md 一样'))

          const save = el('button', 'save', '保存')
          save.type = 'button'
          save.addEventListener('click', async () => {
            save.textContent = '保存中…'
            const ok = await saveConfig({ reasonStyle: ta.value })
            save.textContent = ok ? '已保存 ✓' : '保存失败'
            setTimeout(() => { save.textContent = '保存' }, 1600)
          })

          // ---- 语气预设 / 导入 .md ----
          const styleApi = async (body) => {
            const r = await fetch(API + '/style', {
              method: 'POST', credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            })
            return r.json()
          }
          const styleSel = el('select', 'sel')
          const styleApply = el('button', 'save', '应用')
          styleApply.type = 'button'
          const styleDel = el('button', 'save', '删除')
          styleDel.type = 'button'
          const styleRow = el('div', 'row2')
          styleRow.append(styleSel, styleApply, styleDel)

          const styleName = el('input', 'ta1')
          styleName.placeholder = '预设名字，例如「鲸鱼女仆」'
          const styleSave = el('button', 'save', '存为预设')
          styleSave.type = 'button'
          const styleImport = el('button', 'save', '导入 .md')
          styleImport.type = 'button'
          const styleFile = document.createElement('input')
          styleFile.type = 'file'
          styleFile.accept = '.md,.markdown,.txt,text/markdown,text/plain'
          styleFile.style.display = 'none'
          const styleRow2 = el('div', 'row2')
          styleRow2.append(styleName, styleSave, styleImport, styleFile)

          const styleMsg = el('div', 'tip', '')
          const saveRow = el('div', 'row2')
          saveRow.append(save)

          box.append(styleRow, styleRow2, saveRow, styleMsg)

          let builtinStyles = []
          const drawStyles = (map, builtin) => {
            if (Array.isArray(builtin)) builtinStyles = builtin
            styleSel.textContent = ''
            const names = Object.keys(map || {})
            if (!names.length) {
              const o = document.createElement('option')
              o.textContent = '（还没有语气预设）'
              styleSel.appendChild(o)
              return
            }
            for (const n of names) {
              const o = document.createElement('option')
              o.value = n
              o.textContent = builtinStyles.includes(n) ? n + ' · 自带' : n
              styleSel.appendChild(o)
            }
          }
          fetch(API + '/style', { credentials: 'same-origin', cache: 'no-store' })
            .then((r) => r.json())
            .then((d) => { if (d.ok) drawStyles(d.presets, d.builtin) })
            .catch(() => drawStyles({}))

          styleSave.addEventListener('click', async () => {
            const name = styleName.value.trim()
            if (!name) { styleMsg.textContent = '先给它起个名字'; return }
            if (!ta.value.trim()) { styleMsg.textContent = '上面还没写内容'; return }
            try {
              const d = await styleApi({ action: 'save', name, text: ta.value })
              if (!d.ok) { styleMsg.textContent = d.error || '保存失败'; return }
              drawStyles(d.presets, builtinStyles)
              styleSel.value = name
              styleName.value = ''
              styleMsg.textContent = `已存下「${name}」`
            } catch { styleMsg.textContent = '保存失败' }
          })

          styleApply.addEventListener('click', async () => {
            const name = styleSel.value
            if (!name) return
            try {
              const d = await styleApi({ action: 'apply', name })
              if (!d.ok) { styleMsg.textContent = d.error || '应用失败'; return }
              ta.value = d.text || ''
              cfgDraft.reasonStyle = ta.value
              drawStyles(d.presets, builtinStyles)
              styleSel.value = name
              styleMsg.textContent = `已切到「${name}」，新的理由会按它写`
            } catch { styleMsg.textContent = '应用失败' }
          })

          styleDel.addEventListener('click', async () => {
            const name = styleSel.value
            if (!name) return
            try {
              const d = await styleApi({ action: 'delete', name })
              if (!d.ok) { styleMsg.textContent = d.error || '删不掉'; return }
              drawStyles(d.presets, builtinStyles)
              styleMsg.textContent = `删掉「${name}」`
            } catch { styleMsg.textContent = '删除失败' }
          })

          styleImport.addEventListener('click', () => styleFile.click())
          styleFile.addEventListener('change', () => {
            const f = styleFile.files && styleFile.files[0]
            if (!f) return
            if (f.size > 512 * 1024) { styleMsg.textContent = '文件太大了（上限 512 KB）'; return }
            const reader = new FileReader()
            reader.onload = async () => {
              const text = String(reader.result || '').trim()
              if (!text) { styleMsg.textContent = '这个文件是空的'; return }
              const name = (f.name || '导入的风格').replace(/\.(md|markdown|txt)$/i, '').slice(0, 40)
              ta.value = text
              cfgDraft.reasonStyle = text
              try {
                const d = await styleApi({ action: 'import', name, text })
                if (d.ok) { drawStyles(d.presets, builtinStyles); styleSel.value = name }
                await saveConfig({ reasonStyle: text })
                styleMsg.textContent = `已导入「${name}」· ${text.length} 字，并保存`
              } catch { styleMsg.textContent = '导入失败' }
            }
            reader.readAsText(f, 'utf-8')
          })

          if (cfgDraft.usage) {
            const u = cfgDraft.usage
            const t = u.today || u
            const all = u.total || u
            const money = (v) => Number(v || 0).toFixed(4)
            box.appendChild(el('div', 'tip', `今天 ${t.calls} 次 · ${t.in + t.out} tok · ¥${money(t.cost)}　累计 ${all.calls} 次 · ¥${money(all.cost)}`))
            // 单价随时段变 —— 不写清楚，数字永远对不上平台
            const p = u.pricing
            if (p) {
              const now = p.period === 'peak' ? '峰时' : '谷时（半价）'
              box.appendChild(el('div', 'tip', `当前${now}：未命中 ¥${p.unit.cacheMiss}/M · 命中 ¥${p.unit.cacheHit}/M · 输出 ¥${p.unit.output}/M`))
              if (p.covered === false) box.appendChild(el('div', 'tip', `${p.calendarYear} 年的法定节假日还没收录，按「工作日即峰时」估算`))
            }
            if (u.estimated) box.appendChild(el('div', 'tip', '（有几次接口没返回真实用量，按字数估的）'))
            if (u.last) box.appendChild(el('div', 'tip', `最近一次：${u.last.kind} · ${u.last.in}+${u.last.out} tok · ¥${Number(u.last.cost || 0).toFixed(6)}`))
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
                const row = el('div', 'logline' + (l.level === 'warn' ? ' warn' : l.level === 'error' ? ' error' : ''))
                row.title = `${t} ${l.event} ${typeof l.detail === 'string' ? l.detail : JSON.stringify(l.detail || '')}`
                row.appendChild(el('span', 'lt', t))
                row.appendChild(el('span', 'le', l.event))
                const det = prettyDetail(l.event, l.detail)
                if (det) row.appendChild(el('span', 'ld', det))
                logs.appendChild(row)
              }
            })
            .catch(() => { logs.appendChild(el('div', 'logline', '日志读不到')) })

          box.appendChild(el('div', 'tip', '改完点「换一批」会按新设置重新挑。'))

          bd.appendChild(box)
        }

        function render() {
          bd.textContent = ''
          try {
            renderInner()
          } catch (e) {
            // 一处异常别让整个页签白屏：把错误摆出来，至少知道坏了什么
            bd.textContent = ''
            msg('这块渲染出错了：' + (e && e.message ? e.message : String(e)))
            try { console.error('[bili-jar] render', e) } catch { /* 无控制台 */ }
          }
        }

        function renderInner() {
          if (tab === 'cfg') { renderCfg(); return }
          if (tab === 'history') {
            msg('打开视频即计入历史，保留最近 10 条。')
            if (!history.length) { msg('还没有观看记录。'); return }
            for (const it of history) bd.appendChild(card(it))
            return
          }
          // 有旧片单就继续显示它（走路动画在廊道里表示正在更新），
          // 只有真的没东西可看时才显示「装罐中」
          const emptyNow = !(feed && Array.isArray(feed.main) && feed.main.length)
          if (loading && emptyNow) {
            msg('正在装罐…（十几秒）')
            return
          }

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
          for (const it of list) {
            if (tab === 'main' && it.more && !moreAnchor) {
              const nMore = list.filter((x) => x.more).length
              moreAnchor = el('div', 'msg', `↓ 又从池子里捞了 ${nMore} 条（没重新抓）`)
              bd.appendChild(moreAnchor)
            }
            bd.appendChild(card(it))
          }

          // 列表最底下的小人：点「更多电子榨菜」会换个姿势
          if (tab === 'main' && list.length) {
            const peek = el('div', 'peek' + (loading ? ' walking' : ''))
            if (loading) {
              // 装罐中：两帧来回迈步（就是原来那个走路动画，现在当桌宠用）
              for (const src of [WALK[0], WALK[1]]) {
                const im = document.createElement('img')
                im.src = src
                im.alt = ''
                peek.appendChild(im)
              }
            } else {
              const p = document.createElement('img')
              p.src = WALK[poseIdx % WALK.length]
              p.alt = ''
              peek.appendChild(p)
            }
            bd.appendChild(peek)
          }

          const missing = feed.coverage?.missing || []
          if (tab === 'main' && missing.length) msg('这几根轴今天没货：' + missing.join('、'))
        }

        /** 这一趟「出门找」是否真的在跑（用于决定要不要走回来） */
        let tripActive = false
        let tripHintTimer = null

        const startTrip = () => {
          if (tripActive) return
          tripActive = true
          setTrip('out')
          const t0 = Date.now()
          tsEl.textContent = '出门找…'
          // 她在画外的时候，用底栏那行字报进度（不占列表、不压角色）
          tripHintTimer = setInterval(() => {
            tsEl.textContent = `在翻… ${Math.round((Date.now() - t0) / 1000)}s`
          }, 1000)
        }

        /** 数据到了：走回来（1.8s），走完再收起廊道 */
        const endTrip = async (empty) => {
          if (!tripActive) return
          tripActive = false
          if (tripHintTimer) { clearInterval(tripHintTimer); tripHintTimer = null }
          if (empty) { setTrip('idle'); return }
          setTrip('back')
          tsEl.textContent = '满载而归'
          await new Promise((r) => setTimeout(r, 2450))
          setTrip('idle')
        }

        async function openFeed(force) {
          if (loading) return
          loading = true
          render()
          if (force) refresh.disabled = true
          // 真正要等的时候才走：点「换一批」立刻出发；被动刷新等 400ms 还没回来再出发
          if (force) startTrip()
          else setTimeout(() => { if (loading) startTrip() }, 400)
          try {
            const res = await fetch(API + '/feed' + (force ? '?refresh=1' : ''), { credentials: 'same-origin', cache: 'no-store' })
            const data = await res.json()
            if (!res.ok || data.ok === false) throw new Error(data?.error || ('HTTP ' + res.status))
            feed = data
            updateBadge()
            const when = data.ts ? new Date(data.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''
            tsEl.textContent = data.cached ? `${when} 的库存` : `刚装好 · ${Math.round((data.tookMs || 0) / 1000)}s`
            loadReasons()
            syncLater()
            syncHistory()
            await endTrip(false)
          } catch (e) {
            feed = null
            tsEl.textContent = '失败'
            bd.textContent = ''
            msg('装罐失败：' + String(e?.message || e).slice(0, 60))
            return
          } finally {
            await endTrip(true)
            loading = false
            refresh.disabled = false
            if (panel.hidden === false) render()
          }
        }

        render()

        async function syncHistory() {
          try {
            const res = await fetch(API + '/history', { credentials: 'same-origin', cache: 'no-store' })
            const data = await res.json()
            if (res.ok && data.ok && Array.isArray(data.items)) {
              history = data.items
              if (tab === 'history') render()
            }
          } catch { /* 下次打开历史时重试 */ }
        }

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
