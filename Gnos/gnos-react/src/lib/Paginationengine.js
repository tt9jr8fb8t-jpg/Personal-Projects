// ─────────────────────────────────────────────────────────────────────────────
// PaginationEngine.js — CSS-columns pagination with per-page DOM buffer (D2)
//
// Render pipeline per chapter:
//   1. renderChapterContent()  — innerHTML into _offscreen (full multi-column)
//   2. measurePageCount()      — reads last-element rect to count columns
//   3. trimContainerWidth()    — shrinks _offscreen to real column count
//   4. extractPages(count)     — clones each page's nodes into _extractedPages[]
//   5. showPage(idx, trans)    — fills 3-slot buffer (prev/cur/next), shows cur
//   6. revealContent()         — fades overlay out
//
// Navigation after first render: buffer swap only.  Adjacent pages are already
// in pre-rasterized viewport-sized containers before the user navigates there.
// ─────────────────────────────────────────────────────────────────────────────

// ── Module state ──────────────────────────────────────────────────────────────
let _pageStyleEl  = null
let _wrapWords    = false
let _colW         = 0       // width of one CSS column (= one logical page)
let _colGap       = 0       // gap between columns (two-page mode only)
let _twoPage      = false
let _colH         = 0       // column / viewport height (px)
let _offscreen    = null    // full-width multi-column container — measurement only
let _wrapper      = null    // overflow:hidden clip div
let _overlay      = null    // solid cover — hides render/rasterization work

// D2 buffer
// _bufferEls[i]   = the i-th physical DOM element (i ∈ 0,1,2)
// _bufferPages[i] = page index currently loaded into physical element i (-1 = empty)
// _slots[j]       = which physical element is in logical slot j (PREV=0, CUR=1, NEXT=2)
//
// Rotation swaps _slots pointers in O(1) — the DOM elements never move.
// On a normal page turn the target is already in NEXT/PREV; we just rotate and
// re-fill only the newly-exposed slot, asynchronously.
let _bufferEls    = []
let _bufferPages  = [-1, -1, -1]
let _slots        = [0, 1, 2]   // _slots[PREV]=0, _slots[CUR]=1, _slots[NEXT]=2
let _extractedPages = []

const PREV = 0, CUR = 1, NEXT = 2

let _lastNavTime  = 0
let _fadeTimer    = null

// Background chapter scan
let _scanAbort    = false

// Chapter extraction cache — keyed by chapter index.
// Populated after each successful extractPages() so revisiting a chapter is instant.
// Cleared on invalidateCache() / handleRebuild (layout params change).
let _chapterCache = {}   // { [chIdx]: { count, pages: extractedPages[][] } }

// ── HTML builders ─────────────────────────────────────────────────────────────

export function blocksToHTML(blocks) {
  return blocks.map(b => {
    if (!b?.text?.trim() && b?.type !== 'cover' && b?.type !== 'image') return ''
    if (b.type === 'cover')      return `<img src="${b.src}" alt="Book cover" class="cover-img">`
    if (b.type === 'pdfPage')    return `<img src="${b.src}" alt="" class="pdf-page-img">`
    if (b.type === 'image')      return `<img src="${b.src}" alt="" class="epub-inline-img">`
    if (b.type === 'heading')    return `<h2>${b.text}</h2>`
    if (b.type === 'subheading') return `<h3>${b.text}</h3>`
    return `<p>${b.text}</p>`
  }).join('\n')
}

export function setWordWrapEnabled(enabled) { _wrapWords = !!enabled }

export function blocksToDisplayHTML(blocks) {
  return blocks.map(b => {
    if (!b?.text?.trim() && b?.type !== 'cover' && b?.type !== 'image') return ''
    if (b.type === 'cover')      return `<img src="${b.src}" alt="Book cover" class="cover-img">`
    if (b.type === 'pdfPage')    return `<img src="${b.src}" alt="" class="pdf-page-img">`
    if (b.type === 'image')      return `<img src="${b.src}" alt="" class="epub-inline-img">`
    if (b.type === 'heading')    return `<h2>${b.text}</h2>`
    if (b.type === 'subheading') return `<h3>${b.text}</h3>`
    if (_wrapWords) {
      const wrapped = b.text.replace(/(\S+)/g, w => {
        const clean = w.replace(/[^a-zA-Z'\u2019-]/g, '')
        return `<span class="col-word" data-word="${clean}">${w}</span>`
      })
      return `<p>${wrapped}</p>`
    }
    return `<p>${b.text}</p>`
  }).join('\n')
}

// ── Typography CSS ────────────────────────────────────────────────────────────
// Padding is applied to child elements so it is consistent on every page.

export function buildPageStyles(prefs) {
  const fs      = prefs.fontSize    || 18
  const ls      = prefs.lineSpacing || 1.6
  const ff      = prefs.fontFamily  || 'Georgia, serif'
  const paraGap = Math.round(fs * 0.55)
  const justify = prefs.justifyText !== false ? 'justify' : 'left'

  return `
    .col-container {
      font-family: ${ff};
      font-size: ${fs}px;
      line-height: ${ls};
      color: var(--readerText);
      text-rendering: optimizeLegibility;
      hyphens: auto;
      box-sizing: border-box;
    }
    .col-container > * {
      padding-left: 64px;
      padding-right: 64px;
      box-sizing: border-box;
    }
    .col-container > img {
      padding-left: 0;
      padding-right: 0;
    }
    .col-container > p:first-child,
    .col-container > h2:first-child,
    .col-container > h3:first-child { margin-top: 0; }
    .col-container p {
      margin: 0 0 ${paraGap}px;
      text-align: ${justify};
      hanging-punctuation: first last;
      font-feature-settings: "kern" 1, "liga" 1, "onum" 1;
      orphans: 2; widows: 2;
      text-indent: 2em;
    }
    .col-container h2 + p,
    .col-container h3 + p { text-indent: 0; }
    .col-container h2 {
      font-family: Georgia, serif;
      font-size: ${Math.round(fs * 1.65)}px;
      font-weight: 700; line-height: 1.2;
      margin: 1.2em 0 0.5em; text-indent: 0;
      break-before: auto; break-inside: auto; break-after: avoid;
    }
    .col-container h3 {
      font-family: Georgia, serif;
      font-size: ${Math.round(fs * 1.1)}px;
      font-weight: 600; line-height: 1.3;
      margin: 1em 0 0.4em; text-indent: 0;
      break-before: auto; break-inside: auto; break-after: avoid;
    }
    .col-container .cover-img {
      display: block;
      width: 100%;
      height: var(--col-h, 600px);
      object-fit: contain;
      border-radius: 0;
    }
    .col-container .epub-inline-img {
      width: 100%;
      max-height: var(--col-h, 600px);
      height: auto; display: block; margin: 0 auto; border-radius: 4px;
      object-fit: contain;
    }
    .pdf-fill-page .pdf-page-img {
      width: 100% !important; height: 100% !important;
      object-fit: contain !important; display: block; background: #fff;
    }
    .highlight-words .col-word:hover {
      background: rgba(56,139,253,0.22); border-radius: 2px; cursor: default;
    }
    .col-word.reader-hl {
      background: rgba(255,210,0,0.65);
      box-shadow: 5px 0 0 rgba(255,210,0,0.65), -1px 0 0 rgba(255,210,0,0.65);
      border-radius: 1px; cursor: pointer; color: #1a1200;
    }
    .col-word.reader-hl:hover {
      background: rgba(255,210,0,0.85);
      box-shadow: 5px 0 0 rgba(255,210,0,0.85), -1px 0 0 rgba(255,210,0,0.85);
    }
    .col-word.tts-word-active {
      background: rgba(56,139,253,0.28); border-radius: 2px;
    }
    .underline-line .col-word.same-line {
      text-decoration: underline;
      text-decoration-color: rgba(56,139,253,0.55);
      text-underline-offset: 3px;
    }
  `
}

export function ensurePageStyle(prefs) {
  if (!_pageStyleEl) {
    _pageStyleEl = document.createElement('style')
    _pageStyleEl.id = 'gnos-page-style'
    document.head.appendChild(_pageStyleEl)
  }
  _pageStyleEl.textContent = buildPageStyles(prefs)
}

// ── Column setup ──────────────────────────────────────────────────────────────

// Top gap between the header border and the first line of text on every page.
const COL_TOP_PAD = 20

// Extra pixels subtracted from _offscreen column height vs buffer height.
// CSS columns break this many pixels before the buffer's edge, preventing last-line
// clipping when content renders fractionally taller inside the buffer's formatting context.
const BOTTOM_SAFETY = 4

export function setupColumns(cardEl, prefs) {
  if (!cardEl) return

  cardEl.innerHTML = ''

  const w   = cardEl.clientWidth
  const h   = cardEl.clientHeight - COL_TOP_PAD
  const gap = prefs.twoPage ? 64 : 0

  _colW    = prefs.twoPage ? Math.floor((w - gap) / 2) : w
  _colGap  = gap
  _twoPage = !!prefs.twoPage
  _colH    = h

  _wrapper = document.createElement('div')
  _wrapper.style.cssText = `overflow:hidden;width:100%;height:100%;position:relative;padding-top:${COL_TOP_PAD}px;box-sizing:border-box;`

  // _offscreen: full-width multi-column container used only for layout
  // measurement and content extraction.  It is invisible to the user (opacity:0)
  // and sits behind the buffer elements.
  _offscreen = document.createElement('div')
  _offscreen.className = 'col-container'   // NOT page-content — keeps it out of TTS/highlight queries

  const containerW  = 100 * (_colW + _colGap)
  const offscreenH  = h - BOTTOM_SAFETY  // columns break slightly before buffer edge
  _offscreen.style.cssText = [
    `column-width:${_colW}px`,
    'column-fill:auto',
    `column-gap:${_colGap}px`,
    `height:${offscreenH}px`,
    `width:${containerW}px`,
    'overflow-y:hidden',
    'word-break:break-word',
    'opacity:0',
    'pointer-events:none',
  ].join(';')
  _offscreen.style.setProperty('--col-h', offscreenH + 'px')

  // Three buffer elements — each exactly one logical page in size.
  // position:absolute + top:COL_TOP_PAD places them in the content area,
  // aligned with where _offscreen starts in normal flow.
  _bufferEls   = [null, null, null]
  _bufferPages = [-1, -1, -1]
  const bufW = _twoPage ? _colW * 2 + _colGap : _colW

  // In two-page mode each buffer element is a plain container (no col-container
  // so .col-container > * padding doesn't land on the panels themselves).
  // Two absolutely-positioned inner panels — left and right — each carry
  // col-container so typography CSS applies directly to their <p> children.
  // In single-page mode the buffer element IS the col-container as before.
  for (let i = 0; i < 3; i++) {
    const el = document.createElement('div')
    el.style.cssText = [
      `width:${bufW}px`,
      `height:${_colH}px`,
      'overflow:hidden',
      'position:absolute',
      `top:${COL_TOP_PAD}px`,
      'left:0',
      'display:none',
      'contain:layout style paint',
    ].join(';')
    el.style.setProperty('--col-h', _colH + 'px')

    if (_twoPage) {
      el.className = 'page-content buf-spread'
      const panelCSS = `height:${_colH}px;overflow:hidden;position:absolute;top:0;word-break:break-word;`
      const left  = document.createElement('div')
      left.className = 'col-container page-content buf-panel'
      left.style.cssText = panelCSS + `width:${_colW}px;left:0;`
      left.style.setProperty('--col-h', _colH + 'px')
      const right = document.createElement('div')
      right.className = 'col-container page-content buf-panel'
      right.style.cssText = panelCSS + `width:${_colW}px;left:${_colW + _colGap}px;`
      right.style.setProperty('--col-h', _colH + 'px')
      el.appendChild(left)
      el.appendChild(right)
    } else {
      el.className = 'col-container page-content'
      el.style.wordBreak = 'break-word'
    }

    _bufferEls[i] = el
    _wrapper.appendChild(el)
  }

  // Overlay covers everything (z-index:1) while new content is being laid out.
  _overlay = document.createElement('div')
  _overlay.style.cssText = 'position:absolute;inset:0;background:var(--readerCard);z-index:1;pointer-events:none;'

  _wrapper.appendChild(_offscreen)
  _wrapper.appendChild(_overlay)
  cardEl.appendChild(_wrapper)
}

// ── Chapter rendering ─────────────────────────────────────────────────────────
// Loads content into _offscreen and raises the overlay.
// Call measurePageCount() → trimContainerWidth() → extractPages() → showPage()
// inside two nested rAFs, then revealContent().

export function renderChapterContent(blocks) {
  _scanAbort = true    // cancel any in-flight background scan
  if (!_offscreen) return
  if (_overlay) { _overlay.style.transition = 'none'; _overlay.style.opacity = '1' }
  _offscreen.innerHTML = blocksToDisplayHTML(blocks)
}

export function raiseOverlay() {
  if (!_overlay) return
  _overlay.style.transition = 'none'
  _overlay.style.opacity    = '1'
}

export function revealContent() {
  if (!_overlay) return
  _overlay.style.transition = 'opacity 0.1s ease'
  _overlay.style.opacity    = '0'
}

// ── Page measurement ──────────────────────────────────────────────────────────
// Call inside a requestAnimationFrame after renderChapterContent().

export function measurePageCount() {
  if (!_offscreen || _colW <= 0) return 1
  const lastEl = _offscreen.lastElementChild
  if (!lastEl) return 1
  const unit         = _colW + _colGap
  const containerRect = _offscreen.getBoundingClientRect()
  const elRect        = lastEl.getBoundingClientRect()
  const midX          = (elRect.left + elRect.right) / 2 - containerRect.left
  const colIdx        = Math.max(0, Math.floor(midX / unit))
  // Always return the raw CSS-column count.
  // In two-page mode the caller (ReaderView) uses step=2 to advance one
  // spread at a time; _fillSlot shows pageIdx in the left panel and
  // pageIdx+1 in the right panel, so each "page index" is one CSS column.
  return colIdx + 1
}

// ── Page extraction ───────────────────────────────────────────────────────────
// Walks every child of _offscreen, determines which logical page(s) it belongs
// to, and clones it (split at column boundaries when necessary) into
// _extractedPages[pageIdx][].  Must be called while _offscreen is laid out and
// the overlay is opaque.

// CSS-column index for an x-coordinate relative to the offscreen container.
// Each "page" is always one CSS column; two-page display is handled in _fillSlot.
function _xToPage(x) {
  return Math.floor(x / (_colW + _colGap))
}

// X-coordinate of the right edge of CSS column P.
function _pageBoundaryX(page) {
  return (page + 1) * (_colW + _colGap)
}

// Split `el` at `boundaryX` (relative to container left).
// Returns [beforeEl, afterEl] — either may be null if there is nothing on that side.
function _splitAtBoundary(el, boundaryX, cLeft) {
  const before = el.cloneNode(false)   // empty clone preserving tag + attributes
  const after  = el.cloneNode(false)

  if (_wrapWords) {
    // Content is word-spans — assign each child node to before/after by midpoint.
    for (const child of el.childNodes) {
      // Skip truly empty text nodes (e.g. formatting newlines in HTML).
      // Do NOT skip single-space text nodes — they are the inter-word separators
      // and must be preserved; dropping them causes words to run together.
      if (child.nodeType === Node.TEXT_NODE && !child.textContent) continue
      let midX
      if (child.nodeType === Node.TEXT_NODE) {
        const r = document.createRange()
        r.selectNode(child)
        const rect = r.getBoundingClientRect()
        midX = (rect.left + rect.right) / 2 - cLeft
      } else {
        const rect = child.getBoundingClientRect()
        midX = (rect.left + rect.right) / 2 - cLeft
      }
      ;(midX < boundaryX ? before : after).appendChild(child.cloneNode(true))
    }
  } else {
    // Raw text — binary search for the character offset at the column boundary,
    // then step back to the nearest word boundary.
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    const tn = walker.nextNode()
    if (!tn) return [el.cloneNode(true), null]

    const text = tn.textContent
    const len  = text.length
    let lo = 0, hi = len
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const r = document.createRange()
      r.setStart(tn, 0); r.setEnd(tn, mid)
      const rect = r.getBoundingClientRect()
      // Use <= so a range whose right edge lands exactly at the boundary stays on
      // the current page (fixes off-by-one in colGap=0 single-page mode).
      if (rect.right - cLeft <= boundaryX) lo = mid + 1
      else hi = mid
    }
    // Walk left to nearest space so we don't cut mid-word.
    let split = lo
    while (split > 0 && text[split - 1] !== ' ') split--
    if (split === 0) split = lo   // no space found — hard character split

    const bText = text.slice(0, split).trimEnd()
    const aText = text.slice(split).trimStart()
    if (bText) before.appendChild(document.createTextNode(bText))
    if (aText) after.appendChild(document.createTextNode(aText))
  }

  return [
    before.childNodes.length ? before : null,
    after.childNodes.length  ? after  : null,
  ]
}

export function extractPages(pageCount) {
  if (!_offscreen || _colW <= 0 || !pageCount) { _extractedPages = []; return }
  _extractedPages = Array.from({ length: pageCount }, () => [])

  const cRect = _offscreen.getBoundingClientRect()
  const cLeft = cRect.left

  for (const child of _offscreen.children) {
    const rect      = child.getBoundingClientRect()
    const startX    = rect.left  - cLeft
    const endX      = rect.right - cLeft
    const startPage = Math.max(0, _xToPage(startX))
    // Clamp endPage to be >= startPage: sub-pixel float error on endX can otherwise
    // produce endPage < startPage, causing the split loop to skip the element entirely.
    const endPage   = Math.min(pageCount - 1, Math.max(startPage, _xToPage(Math.max(0, endX - 1))))

    if (startPage === endPage || child.tagName === 'IMG') {
      // Element fits in one page, or is an image (never split images).
      if (startPage < pageCount) _extractedPages[startPage].push(child.cloneNode(true))
      continue
    }

    // Element spans one or more page breaks — split iteratively.
    let remainder = child
    for (let page = startPage; page <= endPage && remainder; page++) {
      if (page < endPage) {
        const [before, after] = _splitAtBoundary(remainder, _pageBoundaryX(page), cLeft)
        if (before) _extractedPages[page].push(before)
        remainder = after
      } else {
        _extractedPages[page].push(remainder.cloneNode(true))
        remainder = null
      }
    }
  }
}

// ── Chapter extraction cache ──────────────────────────────────────────────────

// Snapshot the current extraction so revisiting this chapter skips render+extract.
export function cacheCurrentChapter(chIdx, count) {
  _chapterCache[chIdx] = { count, pages: _extractedPages.map(pg => [...pg]) }
}

// Restore a previously-cached chapter.  Returns the page count, or null on miss.
export function loadCachedChapter(chIdx) {
  const cached = _chapterCache[chIdx]
  if (!cached) return null
  _extractedPages = cached.pages.map(pg => [...pg])
  return cached.count
}

export function clearChapterCache() {
  _chapterCache = {}
}

// ── Buffer management ─────────────────────────────────────────────────────────
// Slot rotation: _slots[j] = physical element index for logical role j.
// _rotateFwd/Bwd swap the three pointers in O(1) — no DOM moves.

function _rotateFwd() {
  const tmp    = _slots[PREV]
  _slots[PREV] = _slots[CUR]
  _slots[CUR]  = _slots[NEXT]
  _slots[NEXT] = tmp
}

function _rotateBwd() {
  const tmp    = _slots[NEXT]
  _slots[NEXT] = _slots[CUR]
  _slots[CUR]  = _slots[PREV]
  _slots[PREV] = tmp
}

// physIdx is a physical element index (0–2), not a logical slot.
// In single-page mode pageIdx is the CSS column index.
// In two-page mode pageIdx is the LEFT column; the right panel gets pageIdx+1.
function _fillSlot(physIdx, pageIdx) {
  const el = _bufferEls[physIdx]
  if (!el) return
  _bufferPages[physIdx] = pageIdx

  if (_twoPage) {
    const leftPanel  = el.firstElementChild
    const rightPanel = el.lastElementChild
    if (!leftPanel || !rightPanel) return
    const fill = (panel, idx) => {
      panel.replaceChildren()
      if (idx < 0 || !_extractedPages || idx >= _extractedPages.length) return
      const frag = document.createDocumentFragment()
      for (const node of _extractedPages[idx]) frag.appendChild(node.cloneNode(true))
      panel.appendChild(frag)
    }
    fill(leftPanel,  pageIdx)
    fill(rightPanel, pageIdx + 1)
    return
  }

  el.replaceChildren()
  if (pageIdx < 0 || !_extractedPages || pageIdx >= _extractedPages.length) return
  const frag = document.createDocumentFragment()
  for (const node of _extractedPages[pageIdx]) frag.appendChild(node.cloneNode(true))
  el.appendChild(frag)
}

// Show the physical element that is currently mapped to logical CUR.
function _activateSlot() {
  const curPhys = _slots[CUR]
  _bufferEls.forEach((el, i) => {
    const active = i === curPhys
    el.style.display = active ? 'block' : 'none'
    el.classList.toggle('buf-active', active)
    if (!active) { el.style.transition = 'none'; el.style.transform = '' }
  })
}

// Returns the currently visible page element — used by ReaderView for TTS
// and highlight queries so they operate only on visible content.
export function getActivePage() {
  return _bufferEls[_slots[CUR]] || null
}

// ── Navigation ────────────────────────────────────────────────────────────────
// Normal page turn: target is already in NEXT/PREV → rotate pointers (O(1)),
// show new CUR, then asynchronously fill the newly-exposed slot.
// Jump (chapter load / seek): fill CUR synchronously, fill adj slots in rAF.
// Rapid successive calls (< 180 ms) skip animations to prevent backlog.

export function showPage(pageIdx, transition) {
  if (!_wrapper || !_bufferEls.length) return

  const now   = Date.now()
  const rapid = now - _lastNavTime < 120
  _lastNavTime = now

  if (_fadeTimer !== null) { clearTimeout(_fadeTimer); _fadeTimer = null }

  const step      = _twoPage ? 2 : 1
  const curPage   = _bufferPages[_slots[CUR]]
  const inNext    = pageIdx === _bufferPages[_slots[NEXT]]
  const inPrev    = pageIdx === _bufferPages[_slots[PREV]]
  const goForward = pageIdx > (curPage >= 0 ? curPage : pageIdx - 1)

  // ── Rotate or fill ──────────────────────────────────────────────────────
  if (inNext) {
    _rotateFwd()
    // Newly-exposed logical NEXT needs to be pre-filled for the next forward turn.
    const physNext = _slots[NEXT]
    requestAnimationFrame(() => _fillSlot(physNext, pageIdx + step))
  } else if (inPrev) {
    _rotateBwd()
    // Newly-exposed logical PREV needs to be pre-filled for the next backward turn.
    const physPrev = _slots[PREV]
    requestAnimationFrame(() => _fillSlot(physPrev, pageIdx - step))
  } else {
    // Jump: fill CUR sync so it's ready immediately; fill adj slots in rAF.
    _fillSlot(_slots[CUR], pageIdx)
    const [pp, np] = [_slots[PREV], _slots[NEXT]]
    requestAnimationFrame(() => {
      _fillSlot(pp, pageIdx - step)
      _fillSlot(np, pageIdx + step)
    })
  }

  // ── Transitions ─────────────────────────────────────────────────────────
  if (!rapid && transition === 'fade') {
    if (_overlay) { _overlay.style.transition = 'opacity 0.06s ease'; _overlay.style.opacity = '1' }
    _fadeTimer = setTimeout(() => {
      _fadeTimer = null
      if (!_overlay) return
      _activateSlot()
      _overlay.style.transition = 'opacity 0.08s ease'
      _overlay.style.opacity    = '0'
    }, 60)
    return
  }

  if (!rapid && transition === 'slide') {
    _activateSlot()
    const el = _bufferEls[_slots[CUR]]
    if (el) {
      el.style.willChange = 'transform'
      el.style.transition = 'none'
      el.style.transform  = `translateX(${goForward ? '100%' : '-100%'})`
      // offsetWidth read is scoped to this element only (contain:layout), so the
      // forced reflow is fast and lets the animation start on the very next frame.
      void el.offsetWidth
      el.style.transition = 'transform 0.1s ease-out'
      el.style.transform  = 'translateX(0)'
      const cleanup = () => { el.style.willChange = ''; el.removeEventListener('transitionend', cleanup) }
      el.addEventListener('transitionend', cleanup, { once: true })
    }
    return
  }

  // Instant or rapid-fire.
  _activateSlot()
  const el = _bufferEls[_slots[CUR]]
  if (el) { el.style.transition = 'none'; el.style.transform = 'translateX(0)' }
}

// ── Container width trimming ──────────────────────────────────────────────────
// Narrows _offscreen to the real column count so getBoundingClientRect reads
// during extractPages() are not affected by unused trailing space.

export function trimContainerWidth(pageCount) {
  if (!_offscreen || _colW <= 0) return
  const step     = _twoPage ? 2 : 1
  const colCount = pageCount * step
  // +1 column as a sub-pixel rounding buffer
  _offscreen.style.width = ((colCount + 1) * (_colW + _colGap)) + 'px'
}

// ── Cache / teardown ──────────────────────────────────────────────────────────

export function invalidateCache() {
  _scanAbort = true
  _chapterCache = {}
  _colW = 0; _colGap = 0
  _offscreen = null; _wrapper = null; _overlay = null
  _bufferEls = []; _bufferPages = [-1, -1, -1]; _slots = [0, 1, 2]; _extractedPages = []
  if (_fadeTimer !== null) { clearTimeout(_fadeTimer); _fadeTimer = null }
  _lastNavTime = 0
}

// ── Background chapter scan ───────────────────────────────────────────────────
// Renders every chapter into _offscreen one at a time, measures page count, and
// calls onChapterDone(chIdx, count) for each.  Yields between chapters via
// setTimeout(0) so the main thread stays responsive.  Cancelled automatically
// when renderChapterContent() fires (chapter navigation) or explicitly via
// cancelScan().

export function cancelScan() {
  _scanAbort = true
}

export function scanAllChapters(chapters, onChapterDone) {
  _scanAbort = false
  if (!_offscreen || _colW <= 0 || !chapters.length) return

  // Reset offscreen to full width for accurate column measurement.
  _offscreen.style.width = (100 * (_colW + _colGap)) + 'px'

  let i = 0

  function step() {
    if (_scanAbort || !_offscreen || i >= chapters.length) return

    const chIdx = i++
    _offscreen.innerHTML = blocksToDisplayHTML(chapters[chIdx].blocks)

    requestAnimationFrame(() => {
      if (_scanAbort || !_offscreen) return
      const count = measurePageCount()
      onChapterDone(chIdx, count)
      setTimeout(step, 0)   // yield main thread between chapters
    })
  }

  // Small initial delay so the current-chapter extraction pipeline can finish
  // painting before the scan starts touching _offscreen.
  setTimeout(step, 200)
}

// ── Global page-count estimation ─────────────────────────────────────────────
// Sums known chapter page-counts; estimates unmeasured chapters using the
// average of measured ones to avoid wildly-low totals.

export function getTotalPages(chapterPageCounts, numChapters) {
  let measuredSum = 0, measuredCount = 0
  for (let i = 0; i < numChapters; i++) {
    const c = chapterPageCounts[i]
    if (c != null) { measuredSum += c; measuredCount++ }
  }
  const avg = measuredCount > 0 ? measuredSum / measuredCount : 10
  let total = 0
  for (let i = 0; i < numChapters; i++) total += chapterPageCounts[i] ?? avg
  return Math.round(total)
}
