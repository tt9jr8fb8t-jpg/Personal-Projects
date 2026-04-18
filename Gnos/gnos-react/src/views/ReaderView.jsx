import { useEffect, useLayoutEffect, useRef, useState, useCallback, useContext } from 'react'
import useAppStore, { useAppStoreShallow } from '@/store/useAppStore'
import { PaneContext } from '@/lib/PaneContext'
import { useIsActiveTab } from '@/lib/useIsActiveTab'
import { loadBookContent, addReadingMinutes } from '@/lib/storage'
import { GnosNavButton } from '@/components/SideNav'
import { generateCoverColor } from '@/lib/utils'
import {
  ensurePageStyle, setupColumns, renderChapterContent, revealContent, raiseOverlay,
  measurePageCount, showPage, trimContainerWidth, invalidateCache,
  getTotalPages, setWordWrapEnabled, extractPages, getActivePage,
  scanAllChapters, cancelScan,
  cacheCurrentChapter, loadCachedChapter, clearChapterCache,
} from '@/lib/Paginationengine'

// ── SettingsPanel ─────────────────────────────────────────────────────────────

function Toggle({ on, onClick }) {
  return (
    <div className={`toggle-track ${on ? 'on' : 'off'}`} onClick={onClick}>
      <div className="toggle-thumb" />
    </div>
  )
}

function SettingsPanel({ prefs, onPrefChange, onRebuild, onClose }) {
  const { fontSize, lineSpacing, fontFamily, justifyText, tapToTurn, twoPage, highlightWords, underlineLine, pageTransition } = prefs
  return (
    <div className="settings-panel" style={{ display: 'block' }} onClick={e => e.stopPropagation()}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14,paddingBottom:12,borderBottom:'1px solid var(--borderSubtle)'}}>
        <span style={{fontSize:13,fontWeight:700,color:'var(--text)'}}>Reader Settings</span>
        <button onClick={onClose} title="Close" style={{width:24,height:24,borderRadius:6,border:'1px solid var(--border)',background:'var(--surfaceAlt)',color:'var(--textDim)',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',transition:'background 0.1s,color 0.1s,border-color 0.1s'}} onMouseEnter={e=>{e.currentTarget.style.background='rgba(248,81,73,0.12)';e.currentTarget.style.color='#f85149';e.currentTarget.style.borderColor='rgba(248,81,73,0.4)'}} onMouseLeave={e=>{e.currentTarget.style.background='var(--surfaceAlt)';e.currentTarget.style.color='var(--textDim)';e.currentTarget.style.borderColor='var(--border)'}}><svg width="9" height="9" viewBox="0 0 9 9" fill="none"><path d="M1 1l7 7M8 1l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg></button>
      </div>
      <div className="section-label">DISPLAY</div>
      <div className="reader-slider-row">
        <span className="reader-slider-icon-sm" style={{ fontFamily: 'Georgia, serif', fontWeight: 700 }}>A</span>
        <input type="range" min="14" max="28" step="1" value={fontSize}
          onChange={e => onPrefChange('fontSize', +e.target.value)}
          onMouseUp={onRebuild} onTouchEnd={onRebuild} style={{ flex: 1 }} />
        <span className="reader-slider-icon-lg" style={{ fontFamily: 'Georgia, serif', fontWeight: 700 }}>A</span>
      </div>
      <div className="reader-slider-row">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
          <line x1="2" y1="4" x2="14" y2="4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
          <line x1="2" y1="8" x2="14" y2="8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
          <line x1="2" y1="12" x2="14" y2="12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
        </svg>
        <input type="range" min="1.4" max="2.4" step="0.1" value={lineSpacing}
          onChange={e => onPrefChange('lineSpacing', +e.target.value)}
          onMouseUp={onRebuild} onTouchEnd={onRebuild} style={{ flex: 1 }} />
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
          <line x1="2" y1="2" x2="14" y2="2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
          <line x1="2" y1="8" x2="14" y2="8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
          <line x1="2" y1="14" x2="14" y2="14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
        </svg>
      </div>
      <label style={{ display: 'block', fontSize: 12, marginBottom: 12 }}>
        <div style={{ marginBottom: 5 }}>Font</div>
        <select value={fontFamily} onChange={e => { onPrefChange('fontFamily', e.target.value); onRebuild() }}>
          <option value="Georgia, serif">Georgia</option>
          <option value="'Palatino Linotype', serif">Palatino</option>
          <option value="system-ui, sans-serif">System UI</option>
        </select>
      </label>

      <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--borderSubtle)' }}>
        <div className="section-label">NAVIGATION &amp; LAYOUT</div>
        {[
          { label: 'Tap margins to turn', key: 'tapToTurn',   val: tapToTurn },
          { label: 'Justify text',        key: 'justifyText', val: justifyText !== false, rebuild: true },
          { label: 'Two-page spread',     key: 'twoPage',     val: twoPage,               rebuild: true },
        ].map(({ label, key, val, rebuild }) => (
          <label key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 500 }}>{label}</div>
            <Toggle on={!!val} onClick={() => { onPrefChange(key, !val); if (rebuild) setTimeout(onRebuild, 20) }} />
          </label>
        ))}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 500 }}>Page transition</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {['slide', 'fade'].map(opt => (
              <button key={opt}
                onClick={() => onPrefChange('pageTransition', opt)}
                style={{
                  padding: '3px 10px', fontSize: 11, fontWeight: 600, borderRadius: 6, cursor: 'pointer',
                  border: `1px solid ${pageTransition === opt ? 'var(--accent)' : 'var(--border)'}`,
                  background: pageTransition === opt ? 'rgba(56,139,253,0.12)' : 'var(--surfaceAlt)',
                  color: pageTransition === opt ? 'var(--accent)' : 'var(--textDim)',
                  transition: 'all 0.1s',
                  textTransform: 'capitalize',
                }}>
                {opt}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--borderSubtle)' }}>
        <div className="section-label">ACCESSIBILITY</div>
        {[
          { label: 'Highlight words on hover', key: 'highlightWords', val: highlightWords },
          { label: 'Underline current line',   key: 'underlineLine',  val: underlineLine },
        ].map(({ label, key, val }) => (
          <label key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 500 }}>{label}</div>
            <Toggle on={!!val} onClick={() => { onPrefChange(key, !val); setTimeout(onRebuild, 20) }} />
          </label>
        ))}
      </div>
    </div>
  )
}

// ── ChapterDropdown ───────────────────────────────────────────────────────────

function ChapterDropdown({ chapters, currentChapter, chapterPageCounts, onJump, onClose }) {
  const [search, setSearch] = useState('')
  const realChapters = chapters.filter(c => c.title !== '_cover_')

  // Build global page start map
  let globalPageStart = 0
  const chapterStartPages = chapters.map((_, i) => {
    const pg = globalPageStart
    const count = chapterPageCounts[i]
    if (count != null) globalPageStart += count
    return count != null ? pg : null
  })

  const q = search.trim().toLowerCase()
  const pageNumMatch = q.match(/^p(?:age)?\s*(\d+)$|^(\d+)$/)
  const isPureNumber = pageNumMatch && /^\d+$/.test(q)
  const queryNum = isPureNumber ? parseInt(q, 10) : null

  const bookTitle = useAppStore.getState().activeBook?.title || ''

  return (
    <div className="dropdown" style={{ display: 'block' }} onClick={e => e.stopPropagation()}>
      <div className="dropdown-header">
        <div className="drop-title">{bookTitle}</div>
        <div className="drop-stats">{realChapters.length} chapter(s)</div>
        <input className="chapter-search-input" placeholder="Search chapters..."
          value={search} onChange={e => setSearch(e.target.value)} autoFocus />
      </div>
      <div>
        {chapters.map((ch, i) => {
          if (i === 0 && ch.title === '_cover_') return null
          if (q && !isPureNumber && !ch.title.toLowerCase().includes(q)) return null
          if (isPureNumber && queryNum !== null) {
            if (i !== queryNum && !ch.title.toLowerCase().includes(q)) return null
          }
          const pgStart = chapterStartPages[i]
          const pgLabel = pgStart != null ? `p. ${pgStart + 1}` : ''
          return (
            <div key={i} className={`chapter-item${i === currentChapter ? ' active' : ''}`}
              onClick={() => { onJump(i, 0); onClose() }}>
              <div className="ch-flex">
                <div className="ch-title">{ch.title}</div>
                {pgLabel && <div style={{ fontSize: 11, color: 'var(--textDim)', marginLeft: 8, flexShrink: 0 }}>{pgLabel}</div>}
              </div>
              <div className="ch-sub">Chapter {i}</div>
            </div>
          )
        })}
        {pageNumMatch && (() => {
          const pageNum = parseInt(pageNumMatch[1] || pageNumMatch[2], 10) - 1
          const lastIdx = chapters.length - 1
          const knownTotal = chapterStartPages[lastIdx] != null
            ? (chapterStartPages[lastIdx] || 0) + (chapterPageCounts[lastIdx] || 1)
            : null
          if (!knownTotal || pageNum < 0 || pageNum >= knownTotal) return null
          return (
            <div key="page-jump">
              <div style={{ height: 1, background: 'var(--borderSubtle)', margin: '4px 12px' }} />
              <div className="chapter-item" onClick={() => {
                let remaining = pageNum
                for (let i = 0; i < chapters.length; i++) {
                  const chPgs = chapterPageCounts[i] || 1
                  if (remaining < chPgs) { onJump(i, remaining); onClose(); return }
                  remaining -= chPgs
                }
              }}>
                <div className="ch-flex">
                  <div className="ch-title" style={{ color: 'var(--accent)' }}>Go to page {pageNum + 1}</div>
                </div>
                <div className="ch-sub">of {knownTotal} pages total</div>
              </div>
            </div>
          )
        })()}
      </div>
    </div>
  )
}

// ── ReaderView ────────────────────────────────────────────────────────────────

const BUILT_IN_THEMES = {
  dark: {
    name: 'Dark', bg: '#0d1117', surface: '#161b22', accent: '#388bfd',
    readerCard: '#161b22', readerText: '#cdd9e5',
  },
  light: {
    name: 'Light (Cream)', bg: '#f5f0e8', surface: '#fdfaf4', accent: '#7c6034',
    readerCard: '#fdfaf4', readerText: '#3a2e1e',
  },
}

export default function ReaderView() {
  const paneTabId          = useContext(PaneContext)
  const isActive           = useIsActiveTab()
  const activeBook         = useAppStore(useCallback(
    s => {
      const tab = paneTabId ? s.tabs.find(t => t.id === paneTabId) : null
      return tab?.activeBook ?? s.activeBook
    },
    [paneTabId]
  ))
  const setPref            = useAppStore(s => s.setPref)
  const persistPreferences = useAppStore(s => s.persistPreferences)
  const sideNavOpen        = useAppStore(s => s.sideNavOpen)

  // Read all prefs in one selector so settings panel always stays in sync
  const prefs = useAppStoreShallow(s => ({
    fontSize:        s.fontSize,
    lineSpacing:     s.lineSpacing,
    fontFamily:      s.fontFamily,
    justifyText:     s.justifyText,
    tapToTurn:       s.tapToTurn,
    twoPage:         s.twoPage,
    highlightWords:  s.highlightWords,
    underlineLine:   s.underlineLine,
    themeKey:        s.themeKey,
    customThemes:    s.customThemes,
    pageTransition:  s.pageTransition ?? 'slide',
  }))

  const cardRef      = useRef(null)
  const containerRef = useRef(null)
  const resizeDebounceRef = useRef(null)
  const lastHeightRef     = useRef(0)

  const [chapters,     setChapters]     = useState([])
  const [curChapter,   setCurChapter]   = useState(0)
  const [curPage,      setCurPage]      = useState(0)
  const [loading,      setLoading]      = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [pageCount,    setPageCount]    = useState(1)  // pages in current chapter
  const [pageInput,    setPageInput]    = useState(null)

  const chapterPageCountsRef = useRef({}) // { [chapterIdx]: pageCount }
  const [scanTick, setScanTick] = useState(0) // incremented when background scan updates a count

  // Rapid-nav scrubber: during bursts of taps only the footer counter updates.
  // 180ms after the last tap a single showPage() renders the settled page.
  const lastNavTimeRef   = useRef(0)
  const rapidNavTimerRef = useRef(null)
  const persistTimerRef  = useRef(null)

  const chaptersRef   = useRef([])
  const curChapterRef = useRef(0)
  const curPageRef    = useRef(0)
  const prefsRef      = useRef(prefs)
  prefsRef.current    = prefs

  // Keep refs in sync — assigned every render, no useEffect needed
  chaptersRef.current   = chapters
  curChapterRef.current = curChapter
  curPageRef.current    = curPage

  // ── Reading timer — tracks minutes spent reading for streak/stats ───────────
  useEffect(() => {
    if (!activeBook || !isActive) return
    const TICK_MS  = 60_000   // save every 60 s
    const IDLE_MS  = 120_000  // stop counting after 2 min of inactivity
    let lastActive = Date.now()
    let accumulated = 0

    const onActivity = () => { lastActive = Date.now() }
    window.addEventListener('mousemove', onActivity, { passive: true })
    window.addEventListener('keydown',   onActivity, { passive: true })

    const interval = setInterval(() => {
      if (Date.now() - lastActive < IDLE_MS) {
        accumulated += TICK_MS / 60_000   // accumulate fractional minutes
        if (accumulated >= 1) {
          addReadingMinutes(Math.floor(accumulated)).catch(() => {})
          accumulated -= Math.floor(accumulated)
        }
      }
    }, TICK_MS)

    return () => {
      clearInterval(interval)
      window.removeEventListener('mousemove', onActivity)
      window.removeEventListener('keydown',   onActivity)
      // Flush any partial minute on unmount
      if (accumulated >= 0.1) addReadingMinutes(Math.max(1, Math.round(accumulated))).catch(() => {})
    }
  }, [activeBook, isActive])

  // ── Load ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!activeBook) return
    let cancelled = false

    async function load() {
      console.log('[Reader] load() start, bookId=', activeBook.id)
      setLoading(true)
      invalidateCache()

      const rawChapters = await loadBookContent(activeBook.id)
      console.log('[Reader] rawChapters=', rawChapters ? `${rawChapters.length} chapters` : 'NULL')
      if (cancelled) return
      if (!rawChapters) { setLoading(false); return }

      const coverChapter = {
        title: '_cover_',
        blocks: [{ type: 'cover', text: '', src: activeBook.coverDataUrl || '' }],
      }
      const allChapters = [coverChapter, ...rawChapters]
      chaptersRef.current = allChapters

      const sc = activeBook.currentChapter || 0
      const sp = activeBook.currentPage    || 0
      const resumeChapter = (sc > 0 || sp > 0) ? sc + 1 : 0
      const resumePage    = resumeChapter === 0 ? 0 : sp

      setChapters(allChapters)
      setCurChapter(resumeChapter)
      setCurPage(resumePage)
      curChapterRef.current = resumeChapter
      curPageRef.current    = resumePage

      // Give DOM a tick to mount the card, then compute + render
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
      console.log('[Reader] after rAF, cardRef=', cardRef.current, 'cancelled=', cancelled)
      if (cancelled || !cardRef.current) return

      const p = prefsRef.current
      console.log('[Reader] card dims:', cardRef.current.clientWidth, 'x', cardRef.current.offsetHeight)
      setWordWrapEnabled(p.highlightWords || p.underlineLine)
      ensurePageStyle(p)
      cardRef.current.classList.toggle('two-page', p.twoPage)
      cardRef.current.classList.toggle('highlight-words', p.highlightWords)
      cardRef.current.classList.toggle('underline-line', p.underlineLine)

      invalidateCache()
      setupColumns(cardRef.current, p)
      chapterPageCountsRef.current = {}
      renderChapterContent(allChapters[resumeChapter].blocks, resumePage)

      await new Promise(r => requestAnimationFrame(r))
      if (cancelled || !cardRef.current) return

      const count = measurePageCount()
      chapterPageCountsRef.current[resumeChapter] = count
      prevChapterRef.current = resumeChapter  // prevent re-render effect from re-rendering
      console.log('[Reader] pages in ch', resumeChapter, ':', count)
      setPageCount(count)
      trimContainerWidth(count)
      extractPages(count)
      cacheCurrentChapter(resumeChapter, count)
      showPage(resumePage, false)
      revealContent()
      setLoading(false)
      startBackgroundScan(resumeChapter)
    }

    load()
    return () => { cancelled = true; cancelScan(); clearTimeout(rapidNavTimerRef.current); clearTimeout(persistTimerRef.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBook?.id])

  // ── Word hover (underline-line feature) ─────────────────────────────────
  useEffect(() => {
    const card = cardRef.current
    if (!card) return
    const handleMouseover = (e) => {
      const target = e.target
      if (target.tagName !== 'SPAN' || !target.classList.contains('col-word')) return
      const page = target.closest('.page-content')
      if (!page) return
      const targetTop = target.getBoundingClientRect().top
      card.querySelectorAll('.col-word.same-line').forEach(s => s.classList.remove('same-line'))
      page.querySelectorAll('.col-word').forEach(s => {
        if (Math.abs(s.getBoundingClientRect().top - targetTop) < 4) s.classList.add('same-line')
      })
    }
    const handleMouseleave = (e) => {
      // Only clear if leaving the card entirely, not just moving between words
      if (!e.relatedTarget || !card.contains(e.relatedTarget)) {
        card.querySelectorAll('.col-word.same-line').forEach(s => s.classList.remove('same-line'))
      }
    }
    card.addEventListener('mouseover', handleMouseover)
    card.addEventListener('mouseleave', handleMouseleave)
    return () => {
      card.removeEventListener('mouseover', handleMouseover)
      card.removeEventListener('mouseleave', handleMouseleave)
    }
  }, []) // attach once — card element never changes

  // ── Re-render when chapter/page changes (after load) ─────────────────────
  const prevChapterRef   = useRef(-1)
  const chapterRenderRef = useRef(null) // debounce timer for cross-chapter renders

  useEffect(() => {
    if (loading || !cardRef.current || chapters.length === 0) return
    if (prevChapterRef.current === curChapter) return // page-only change: handled directly in nextPage/prevPage
    prevChapterRef.current = curChapter
    const chapterAtRender = curChapter

    // Check cache first — if we've already extracted this chapter the render pipeline
    // is skipped entirely: instant chapter load.
    const cachedCount = loadCachedChapter(chapterAtRender)
    if (cachedCount !== null) {
      const pageAtRender = curPageRef.current
      chapterPageCountsRef.current[chapterAtRender] = cachedCount
      setPageCount(cachedCount)
      showPage(pageAtRender, false)   // buffer swap is instant since pages are cached
      revealContent()                 // overlay is already transparent, this is a no-op
      requestAnimationFrame(() => applyHighlightsToCard(cardRef.current, bookIdRef.current, chapterAtRender))
      return
    }

    // Cache miss: raise overlay immediately so the in-progress render is hidden.
    // renderChapterContent() also raises it, but doing it here prevents a flash of
    // the previous chapter's content during the 20ms debounce window.
    raiseOverlay()

    // Cache miss — run the full render pipeline.
    // Debounce so rapid chapter-boundary crossings skip intermediate renders
    // and only commit the chapter the user actually lands on.
    clearTimeout(chapterRenderRef.current)
    chapterRenderRef.current = setTimeout(() => {
      if (prevChapterRef.current !== chapterAtRender) return
      const pageAtRender = curPageRef.current  // read ref — always current even in closure
      renderChapterContent(chapters[chapterAtRender].blocks, pageAtRender)
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (prevChapterRef.current !== chapterAtRender) return
        const count = measurePageCount()
        chapterPageCountsRef.current[chapterAtRender] = count
        setPageCount(count)
        trimContainerWidth(count)
        extractPages(count)
        cacheCurrentChapter(chapterAtRender, count)
        showPage(pageAtRender, false)
        revealContent()
        applyHighlightsToCard(cardRef.current, bookIdRef.current, chapterAtRender)
        startBackgroundScan(chapterAtRender)
      }))
    }, 20)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curChapter])

  // ── Keyboard nav ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isActive) return
    const handler = (e) => {
      if (settingsOpen || dropdownOpen || e.target.tagName === 'INPUT') return
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') nextPage()
      if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   prevPage()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, settingsOpen, dropdownOpen])

  // ── Close panels on outside click ────────────────────────────────────────
  useEffect(() => {
    if (!settingsOpen && !dropdownOpen) return
    const handler = () => { setSettingsOpen(false); setDropdownOpen(false) }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [settingsOpen, dropdownOpen])

  // ── Nav helpers ───────────────────────────────────────────────────────────
  // Use store.getState() to avoid stale closure issues with Zustand async actions
  function saveProgress(chapter, page) {
    const book = useAppStore.getState().activeBook
    if (!book) return
    const savedChapter = Math.max(0, chapter - 1)
    const savedPage    = chapter === 0 ? 0 : page
    useAppStore.getState().updateBookProgress(book.id, savedChapter, savedPage)
    // Debounce the localStorage write — updateBookProgress keeps state current,
    // persistLibrary only needs to flush once the user pauses.
    clearTimeout(persistTimerRef.current)
    persistTimerRef.current = setTimeout(() => {
      useAppStore.getState().persistLibrary()
    }, 500)
  }

  // Schedules the settle render: 180ms after the last rapid tap, show the page
  // the user landed on with no animation and save progress.
  function scheduleSettle() {
    clearTimeout(rapidNavTimerRef.current)
    rapidNavTimerRef.current = setTimeout(() => {
      const ch = curChapterRef.current
      const pg = curPageRef.current
      showPage(pg, false)   // instant — no animation after a scrub
      requestAnimationFrame(() => {
        saveProgress(ch, pg)
        applyHighlightsToCard(cardRef.current, bookIdRef.current, ch)
      })
    }, 120)
  }

  function nextPage() {
    const chaps = chaptersRef.current
    const ch    = curChapterRef.current
    const pg    = curPageRef.current
    const p     = prefsRef.current
    const step  = p.twoPage ? 2 : 1
    const total = chapterPageCountsRef.current[ch] || 1
    const trans = p.pageTransition || 'slide'

    const now   = Date.now()
    const rapid = now - lastNavTimeRef.current < 120
    lastNavTimeRef.current = now

    if (pg + step <= total - 1) {
      const np = pg + step
      curPageRef.current = np
      if (!rapid) {
        showPage(np, trans)
        requestAnimationFrame(() => {
          setCurPage(np); saveProgress(ch, np)
          applyHighlightsToCard(cardRef.current, bookIdRef.current, ch)
        })
      } else {
        // Rapid: update footer counter only — no DOM/layout work at all.
        // scheduleSettle() will render the final page once the burst stops.
        setCurPage(np)
        scheduleSettle()
      }
    } else if (pg < total - 1) {
      const np = total - 1
      curPageRef.current = np
      if (!rapid) {
        showPage(np, trans)
        requestAnimationFrame(() => {
          setCurPage(np); saveProgress(ch, np)
          applyHighlightsToCard(cardRef.current, bookIdRef.current, ch)
        })
      } else {
        setCurPage(np)
        scheduleSettle()
      }
    } else if (ch < chaps.length - 1) {
      // Chapter boundary: cancel any pending settle and do a full chapter transition.
      clearTimeout(rapidNavTimerRef.current)
      const nc = ch + 1
      curChapterRef.current = nc; curPageRef.current = 0
      setCurChapter(nc); setCurPage(0); saveProgress(nc, 0)
    }
  }

  function prevPage() {
    const ch    = curChapterRef.current
    const pg    = curPageRef.current
    const p     = prefsRef.current
    const step  = p.twoPage ? 2 : 1
    const trans = p.pageTransition || 'slide'

    const now   = Date.now()
    const rapid = now - lastNavTimeRef.current < 120
    lastNavTimeRef.current = now

    if (pg >= step) {
      const np = pg - step
      curPageRef.current = np
      if (!rapid) {
        showPage(np, trans)
        requestAnimationFrame(() => {
          setCurPage(np); saveProgress(ch, np)
          applyHighlightsToCard(cardRef.current, bookIdRef.current, ch)
        })
      } else {
        setCurPage(np)
        scheduleSettle()
      }
    } else if (pg > 0) {
      curPageRef.current = 0
      if (!rapid) {
        showPage(0, trans)
        requestAnimationFrame(() => {
          setCurPage(0); saveProgress(ch, 0)
          applyHighlightsToCard(cardRef.current, bookIdRef.current, ch)
        })
      } else {
        setCurPage(0)
        scheduleSettle()
      }
    } else if (ch > 0) {
      clearTimeout(rapidNavTimerRef.current)
      const nc = ch - 1
      const prevCount = chapterPageCountsRef.current[nc]
      const lastPage  = prevCount != null
        ? (p.twoPage ? Math.floor((prevCount - 1) / 2) * 2 : prevCount - 1)
        : 0
      curChapterRef.current = nc; curPageRef.current = lastPage
      setCurChapter(nc); setCurPage(lastPage); saveProgress(nc, lastPage)
    }
  }

  // ── Background book scan ──────────────────────────────────────────────────
  // Scans all chapters except the currently-displayed one to populate
  // chapterPageCountsRef, then triggers a re-render so totalPages updates.
  function startBackgroundScan(currentChapterIdx) {
    const chapters = chaptersRef.current
    if (!chapters.length) return
    scanAllChapters(chapters, (chIdx, count) => {
      // Don't overwrite the count for the current chapter — it was just measured
      // accurately by the full render pipeline and trimContainerWidth.
      if (chIdx !== currentChapterIdx) {
        chapterPageCountsRef.current[chIdx] = count
        setScanTick(t => t + 1)
      }
    })
  }

  function jumpToChapter(chIdx, pgIdx = 0) {
    const sameChapter = chIdx === curChapterRef.current
    curChapterRef.current = chIdx
    curPageRef.current    = pgIdx
    if (sameChapter) showPage(pgIdx, false)
    setCurChapter(chIdx); setCurPage(pgIdx)
    saveProgress(chIdx, pgIdx)
  }

  // ── Prefs ─────────────────────────────────────────────────────────────────
  const persistDebounceRef = useRef(null)
  function handlePrefChange(key, value) {
    setPref(key, value)
    // Debounce persistence so rapid toggle clicks don't block the UI
    if (persistDebounceRef.current) clearTimeout(persistDebounceRef.current)
    persistDebounceRef.current = setTimeout(() => persistPreferences(), 400)
  }

  // Keep a stable ref so the zoom keydown effect can call the current rebuild
  const handleRebuildRef = useRef(null)

  // ── Cmd/Ctrl + +/- zoom ───────────────────────────────────────────────────
  useEffect(() => {
    if (!isActive) return
    const handler = (e) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key !== '+' && e.key !== '=' && e.key !== '-') return
      e.preventDefault()
      const current = prefsRef.current.fontSize
      const next = e.key === '-' ? Math.max(14, current - 1) : Math.min(28, current + 1)
      if (next === current) return
      setPref('fontSize', next)
      clearTimeout(persistDebounceRef.current)
      persistDebounceRef.current = setTimeout(() => persistPreferences(), 400)
      // Trigger a re-render then rebuild pagination with new size
      setTimeout(() => handleRebuildRef.current?.(), 0)
    }
    window.addEventListener('keydown', handler, { capture: true })
    return () => window.removeEventListener('keydown', handler, { capture: true })
  }, [isActive]) // isActive + refs only — stable

  function handleRebuild() {
    if (!cardRef.current || chaptersRef.current.length === 0) return
    const p     = prefsRef.current
    const cardEl = cardRef.current
    const ch    = curChapterRef.current
    const pg    = curPageRef.current

    setWordWrapEnabled(p.highlightWords || p.underlineLine)
    ensurePageStyle(p)
    cardEl.classList.toggle('two-page', p.twoPage)
    cardEl.classList.toggle('highlight-words', p.highlightWords)
    cardEl.classList.toggle('underline-line', p.underlineLine)

    invalidateCache()       // also clears _chapterCache via PaginationEngine
    clearChapterCache()     // ensure stale layout params don't survive
    setupColumns(cardEl, p)
    chapterPageCountsRef.current = {}
    prevChapterRef.current = ch  // prevent re-render effect from double-rendering

    renderChapterContent(chaptersRef.current[ch].blocks, pg)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const count = measurePageCount()
      chapterPageCountsRef.current[ch] = count
      setPageCount(count)
      const clampedPg = Math.min(pg, Math.max(0, count - 1))
      trimContainerWidth(count)
      extractPages(count)
      cacheCurrentChapter(ch, count)
      showPage(clampedPg, false)
      revealContent()
      if (clampedPg !== pg) { setCurPage(clampedPg); saveProgress(ch, clampedPg) }
      requestAnimationFrame(() => applyHighlightsToCard(cardEl, bookIdRef.current, ch))
      // Scan all other chapters with the new layout settings so totalPages stays accurate.
      startBackgroundScan(ch)
    }))
  }
  handleRebuildRef.current = handleRebuild

  // ── Auto-rebuild when container height changes (e.g. window resize) ───────
  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => {
      const h = entries[0]?.contentRect?.height ?? 0
      if (Math.abs(h - lastHeightRef.current) < 2) return // ignore sub-pixel jitter
      lastHeightRef.current = h
      clearTimeout(resizeDebounceRef.current)
      resizeDebounceRef.current = setTimeout(() => {
        handleRebuildRef.current?.()
      }, 150)
    })
    ro.observe(el)
    return () => { ro.disconnect(); clearTimeout(resizeDebounceRef.current) }
  }, []) // refs only — stable

  // ── Page jump ─────────────────────────────────────────────────────────────
  function handlePageJump(val) {
    const target = parseInt(val, 10)
    const total  = getTotalPages(chapterPageCountsRef.current, chaptersRef.current.length)
    const p      = prefsRef.current
    // target is entered as a display page (spread number in two-page mode).
    // Convert back to raw column index so chapter lookup works correctly.
    const dispTotal = p.twoPage ? Math.ceil(total / 2) : total
    setPageInput(null)
    if (isNaN(target) || target < 1 || target > dispTotal) return
    const rawTarget = p.twoPage ? (target - 1) * 2 : target - 1
    let remaining = rawTarget
    for (let i = 0; i < chaptersRef.current.length; i++) {
      const chPgs = chapterPageCountsRef.current[i] || 1
      if (remaining < chPgs) { jumpToChapter(i, remaining); return }
      remaining -= chPgs
    }
    jumpToChapter(chaptersRef.current.length - 1, 0)
  }

  // ── TTS (Text-To-Speech) state ─────────────────────────────────────────────
  const [ttsActive,   setTtsActive]   = useState(false)
  const [ttsSentence, setTtsSentence] = useState('')
  const [ttsPaused,   setTtsPaused]   = useState(false)
  const [ttsProgress, setTtsProgress] = useState(0)
  const ttsUtterRef   = useRef(null)
  const ttsSentencesRef = useRef([])
  const ttsSentIdxRef   = useRef(0)
  const ttsActiveWordRef = useRef(null) // currently highlighted .col-word el

  // ── Highlight state ────────────────────────────────────────────────────────
  const highlightsRef = useRef({}) // { [bookId]: [{ id, chapterIdx, text }] }
  const bookIdRef = useRef(null)
  const wordMenuRef = useRef(null)
  const defPopupRef = useRef(null)

  // Load/save highlights from localStorage
  useEffect(() => {
    if (!activeBook?.id) return
    bookIdRef.current = activeBook.id
    try {
      const stored = JSON.parse(localStorage.getItem('gnos_highlights') || '{}')
      highlightsRef.current = stored
    } catch { highlightsRef.current = {} }
  }, [activeBook?.id])

  function saveHighlights() {
    try { localStorage.setItem('gnos_highlights', JSON.stringify(highlightsRef.current)) } catch { /* */ }
  }

  function applyHighlightsToCard(cardEl, bookId, chapterIdx) {
    if (!cardEl || !bookId) return
    const hls = (highlightsRef.current[bookId] || []).filter(h => h.chapterIdx === chapterIdx)
    if (!hls.length) return
    const wordSpans = Array.from(cardEl.querySelectorAll('.col-word'))
    for (const hl of hls) {
      const words = hl.text.trim().split(/\s+/)
      const cleanWords = words.map(w => w.toLowerCase().replace(/[^a-z0-9'\u2019]/g, ''))
      for (let i = 0; i <= wordSpans.length - words.length; i++) {
        const slice = wordSpans.slice(i, i + words.length)
        const sliceClean = slice.map(s => (s.dataset.word || s.textContent).toLowerCase().replace(/[^a-z0-9'\u2019]/g, ''))
        if (sliceClean.join(' ') === cleanWords.join(' ')) {
          slice.forEach(s => { s.classList.add('reader-hl'); s.dataset.hlId = hl.id })
          break
        }
      }
    }
  }

  // ── Word context menu state ────────────────────────────────────────────────
  const [wordMenu,       setWordMenu]       = useState(null) // { word, sentence, x, y }
  const [defPopup,       setDefPopup]       = useState(null) // { word, mode:'define'|'translate', x, y, content, loading }
  const [translateLang,  setTranslateLang]  = useState('es') // target language for translation

  // Clamp word-menu to viewport after it renders
  useLayoutEffect(() => {
    if (!wordMenu || !wordMenuRef.current) return
    const el = wordMenuRef.current
    const w = el.offsetWidth, h = el.offsetHeight
    const centerX = Math.max(w / 2 + 8, Math.min(wordMenu.x, window.innerWidth - w / 2 - 8))
    el.style.left = centerX + 'px'
    el.style.top  = Math.max(60, Math.min(wordMenu.y - 64, window.innerHeight - h - 8)) + 'px'
  }, [wordMenu])

  // Clamp def-popup to viewport after it renders
  useLayoutEffect(() => {
    if (!defPopup || !defPopupRef.current) return
    const el = defPopupRef.current
    const w = el.offsetWidth, h = el.offsetHeight
    const centerX = Math.max(w / 2 + 8, Math.min(defPopup.x, window.innerWidth - w / 2 - 8))
    el.style.left = centerX + 'px'
    el.style.top  = Math.max(60, Math.min(defPopup.y + 8, window.innerHeight - h - 8)) + 'px'
  }, [defPopup])

  // Available LibreTranslate target languages
  const LIBRE_LANGS = [
    { code:'es', name:'Spanish' }, { code:'fr', name:'French' }, { code:'de', name:'German' },
    { code:'it', name:'Italian' }, { code:'pt', name:'Portuguese' }, { code:'nl', name:'Dutch' },
    { code:'pl', name:'Polish' }, { code:'ru', name:'Russian' }, { code:'ja', name:'Japanese' },
    { code:'zh', name:'Chinese' }, { code:'ar', name:'Arabic' }, { code:'ko', name:'Korean' },
    { code:'sv', name:'Swedish' }, { code:'tr', name:'Turkish' }, { code:'uk', name:'Ukrainian' },
    { code:'hi', name:'Hindi' },
  ]

  function extractSentences(text) {
    return text.match(/[^.!?…]+[.!?…]+|[^.!?…]+$/g)?.map(s => s.trim()).filter(Boolean) || []
  }

  function ttsClearWordHighlight() {
    if (ttsActiveWordRef.current) {
      ttsActiveWordRef.current.classList.remove('tts-word-active')
      ttsActiveWordRef.current = null
    }
  }

  function ttsSpeakSentence(sentence, onEnd) {
    window.speechSynthesis.cancel()
    ttsClearWordHighlight()
    // Build ordered list of word spans for this sentence to match by position
    const card = cardRef.current
    const ttsPageEl = getActivePage() || card
    const allSpans = ttsPageEl ? Array.from(ttsPageEl.querySelectorAll('.col-word')) : []
    const sentWords = sentence.trim().replace(/[\u201c\u201d\u2018\u2019]/g, '').split(/\s+/).filter(Boolean)
    let sentenceSpans = []
    let spanIdx = 0
    outer: for (let start = 0; start < allSpans.length; start++) {
      for (let len = sentWords.length; len >= Math.max(1, sentWords.length - 2); len--) {
        const candidate = allSpans.slice(start, start + len)
        const candidateText = candidate.map(s => s.textContent.replace(/[\u201c\u201d\u2018\u2019]/g, '').trim()).join(' ')
        const sentText = sentWords.slice(0, len).join(' ')
        if (candidateText.toLowerCase() === sentText.toLowerCase()) {
          sentenceSpans = candidate
          break outer
        }
      }
    }
    const utt = new SpeechSynthesisUtterance(sentence)
    utt.rate = 1
    utt.onend = () => { ttsClearWordHighlight(); spanIdx = 0; onEnd() }
    utt.onboundary = (e) => {
      if (e.name !== 'word') return
      const charIdx = e.charIndex
      let end = charIdx
      while (end < sentence.length && /\S/.test(sentence[end])) end++
      const rawWord = sentence.slice(charIdx, end)
      const clean = rawWord.replace(/[^a-zA-Z'\u2019\u2018]/g, '').toLowerCase().replace(/[\u2019\u2018]/g, "'")
      if (!clean) return

      ttsClearWordHighlight()

      let found = null

      // Primary: advance through this sentence's pre-matched spans by index
      if (sentenceSpans.length > 0) {
        while (spanIdx < sentenceSpans.length) {
          const t = (sentenceSpans[spanIdx].dataset.word || sentenceSpans[spanIdx].textContent)
            .toLowerCase().replace(/[^a-zA-Z']/g, '').replace(/[\u2019\u2018]/g, "'")
          if (t === clean || t.startsWith(clean) || clean.startsWith(t)) {
            found = sentenceSpans[spanIdx]
            spanIdx++
            break
          }
          spanIdx++
        }
      }

      // Fallback: scan forward from last highlighted position across active page spans
      if (!found) {
        const fbPageEl = getActivePage() || cardRef.current
        if (fbPageEl) {
          const spans = Array.from(fbPageEl.querySelectorAll('.col-word'))
          const startFrom = ttsActiveWordRef._lastIdx ?? 0
          for (let i = startFrom; i < spans.length; i++) {
            const t = (spans[i].dataset.word || spans[i].textContent)
              .toLowerCase().replace(/[^a-zA-Z']/g, '').replace(/[\u2019\u2018]/g, "'")
            if (t === clean || t.startsWith(clean) || clean.startsWith(t)) {
              found = spans[i]
              ttsActiveWordRef._lastIdx = i + 1
              break
            }
          }
        }
      }

      if (found) {
        found.classList.add('tts-word-active')
        ttsActiveWordRef.current = found
      }
    }
    ttsActiveWordRef._lastIdx = 0
    ttsUtterRef.current = utt
    window.speechSynthesis.speak(utt)
    setTtsSentence(sentence)
  }

  function ttsStart(startText) {
    const card = cardRef.current
    if (!card) return
    const activePage = getActivePage() || card
    const allText = Array.from(activePage.querySelectorAll('p, h2, h3'))
      .map(el => el.textContent.trim()).filter(Boolean).join(' ')
    const sentences = extractSentences(allText)
    if (!sentences.length) return

    // Find closest sentence to clicked text
    let startIdx = 0
    if (startText) {
      const lower = startText.toLowerCase()
      startIdx = sentences.findIndex(s => s.toLowerCase().includes(lower))
      if (startIdx < 0) startIdx = 0
    }

    ttsSentencesRef.current = sentences
    ttsSentIdxRef.current   = startIdx
    setTtsActive(true)
    setTtsPaused(false)

    const speakNext = () => {
      const idx = ttsSentIdxRef.current
      if (idx >= ttsSentencesRef.current.length) { ttsStop(); return }
      setTtsProgress(idx / Math.max(1, ttsSentencesRef.current.length))
      ttsSpeakSentence(ttsSentencesRef.current[idx], () => {
        ttsSentIdxRef.current++
        speakNext()
      })
    }
    speakNext()
  }

  function ttsStop() {
    window.speechSynthesis.cancel()
    ttsClearWordHighlight()
    setTtsActive(false)
    setTtsSentence('')
    setTtsPaused(false)
    setTtsProgress(0)
    ttsSentencesRef.current = []
    ttsSentIdxRef.current   = 0
  }

  function ttsTogglePause() {
    if (ttsPaused) {
      window.speechSynthesis.resume()
      setTtsPaused(false)
    } else {
      window.speechSynthesis.pause()
      setTtsPaused(true)
    }
  }

  function ttsNav(dir) {
    // dir=1 → next sentence, dir=-1 → previous sentence
    const delta = dir > 0 ? 1 : -1
    ttsSentIdxRef.current = Math.max(0, Math.min(
      ttsSentencesRef.current.length - 1,
      ttsSentIdxRef.current + delta
    ))
    window.speechSynthesis.cancel()
    ttsClearWordHighlight()
    const speakNext = () => {
      const idx = ttsSentIdxRef.current
      if (idx >= ttsSentencesRef.current.length) { ttsStop(); return }
      setTtsProgress(idx / Math.max(1, ttsSentencesRef.current.length))
      ttsSpeakSentence(ttsSentencesRef.current[idx], () => {
        ttsSentIdxRef.current++
        speakNext()
      })
    }
    speakNext()
  }

  // Stop TTS when leaving view
  useEffect(() => { return () => window.speechSynthesis?.cancel() }, [])

  // ── Card click handler for word context menu + TTS start ─────────────────
  function handleCardClick(e) {
    // Right-click opens word menu (via onContextMenu)
    // Left-click on a word when TTS is active → jump to that sentence
    if (ttsActive) {
      const word = e.target.closest('.col-word')
      if (word) {
        const wordText = word.dataset.word || word.textContent
        ttsStop()
        setTimeout(() => ttsStart(wordText), 50)
      }
    }
  }

  function handleCardContextMenu(e) {
    const wordEl = e.target.closest('.col-word')
    if (!wordEl) return
    e.preventDefault()
    const word = wordEl.dataset.word || wordEl.textContent

    // Extract sentence context
    const page = wordEl.closest('.page-content')
    const pageText = page ? page.textContent : ''
    const sentences = extractSentences(pageText)
    const sentence = sentences.find(s => s.toLowerCase().includes(word.toLowerCase())) || ''

    setWordMenu({ word, sentence, x: e.clientX, y: e.clientY,
      hlText: word, hlId: wordEl.dataset.hlId || null, hlChapterIdx: curChapterRef.current })
  }

  // ── Highlight: detect text selection on card mouseup ─────────────────────
  useEffect(() => {
    const card = cardRef.current
    if (!card) return
    const handleMouseUp = () => {
      // Tiny delay so the selection is fully committed before we read it
      setTimeout(() => {
        const sel = window.getSelection()
        if (!sel || sel.isCollapsed || !sel.toString().trim()) return
        const text = sel.toString().trim()
        if (!card.contains(sel.anchorNode)) return
        const rect = sel.getRangeAt(0).getBoundingClientRect()
        const x = rect.left + rect.width / 2
        const y = rect.top
        // Don't clear the selection — let the user see what they selected
        setWordMenu({ word: text, sentence: text, x, y,
          hlText: text, hlChapterIdx: curChapterRef.current })
      }, 10)
    }
    card.addEventListener('mouseup', handleMouseUp)
    return () => card.removeEventListener('mouseup', handleMouseUp)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Click on highlighted word → show word menu with remove option
  useEffect(() => {
    const card = cardRef.current
    if (!card) return
    const handleHlClick = (e) => {
      const span = e.target.closest('.reader-hl')
      if (!span?.dataset.hlId) return
      e.stopPropagation()
      const word = span.dataset.word || span.textContent || ''
      const page = span.closest('.page-content')
      const pageText = page ? page.textContent : ''
      const sentences = extractSentences(pageText)
      const sentence = sentences.find(s => s.toLowerCase().includes(word.toLowerCase())) || ''
      setWordMenu({ word, sentence, x: e.clientX, y: e.clientY,
        hlId: span.dataset.hlId, hlChapterIdx: curChapterRef.current })
    }
    card.addEventListener('click', handleHlClick)
    return () => card.removeEventListener('click', handleHlClick)
  }, [])

  // Close word menu on outside click
  useEffect(() => {
    if (!wordMenu) return
    const h = () => setWordMenu(null)
    document.addEventListener('click', h)
    return () => document.removeEventListener('click', h)
  }, [wordMenu])

  // Close def popup on outside click
  useEffect(() => {
    if (!defPopup) return
    const h = () => setDefPopup(null)
    document.addEventListener('click', h)
    return () => document.removeEventListener('click', h)
  }, [defPopup])

  // ── Derived state ─────────────────────────────────────────────────────────
  const totalInChapter = pageCount
  // scanTick is read here so that background-scan updates trigger a re-render
  // and totalPages recomputes from the freshly-updated chapterPageCountsRef.
  void scanTick
  const totalPages     = getTotalPages(chapterPageCountsRef.current, chapters.length)
  let globalPage = curPage
  for (let _i = 0; _i < curChapter; _i++) globalPage += chapterPageCountsRef.current[_i] || 1

  // In two-page mode each "page entry" is one CSS column; navigation steps by 2
  // so the reader sees spreads.  Convert raw column counts to spread counts for
  // all display values so the footer reads naturally.
  const navStep        = prefs.twoPage ? 2 : 1
  const displayPage    = prefs.twoPage ? Math.floor(globalPage  / 2) : globalPage
  const displayTotal   = prefs.twoPage ? Math.ceil(totalPages   / 2) : totalPages
  const displayInChap  = prefs.twoPage ? Math.ceil(totalInChapter / 2) : totalInChapter

  const pct = displayTotal > 1 ? (displayPage / (displayTotal - 1)) * 100 : 0
  const atStart        = curChapter === 0 && curPage === 0
  // Disable Next when we are on the last valid spread (can't step navStep forward).
  const atEnd          = curChapter >= chapters.length - 1 && curPage >= totalInChapter - navStep
  const pagesLeft      = displayInChap - Math.floor(curPage / navStep) - 1
  const isCover        = chapters[curChapter]?.title === '_cover_'
  const chapterTitle   = isCover ? 'Cover' : (chapters[curChapter]?.title || '')
  const [c1, c2]       = activeBook ? generateCoverColor(activeBook.title) : ['#1a1a2e', '#16213e']

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="view active" style={{ flexDirection: 'column' }}>
      <style>{`
        /* ── Word hover features ──────────────────────────────────────────── */
        .highlight-words .col-word:hover {
          background: rgba(56,139,253,0.22);
          border-radius: 2px;
          cursor: pointer;
        }
        .underline-line .col-word.same-line {
          text-decoration: underline;
          text-decoration-color: rgba(56,139,253,0.5);
          text-underline-offset: 2px;
        }

        /* ── Font size slider icons ───────────────────────────────────────── */
        .reader-slider-row {
          display: flex; align-items: center; gap: 8px; margin-bottom: 12px;
        }
        .reader-slider-icon-sm { font-size: 11px; opacity: 0.55; flex-shrink: 0; }
        .reader-slider-icon-lg { font-size: 16px; opacity: 0.8; flex-shrink: 0; }
        .reader-slider-icon-sm-line { font-size: 10px; opacity: 0.55; flex-shrink: 0; line-height: 1; }
        .reader-slider-icon-lg-line { font-size: 10px; opacity: 0.8; flex-shrink: 0; line-height: 1; white-space: pre; }

        /* ── Word context menu — horizontal pill ─────────────────────────── */
        .word-menu {
          position: fixed; z-index: 9999;
          background: var(--surface); border: 1px solid var(--border);
          border-radius: 12px; padding: 4px 6px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.45);
          display: flex; align-items: center; gap: 2px;
          animation: word-menu-in 0.12s ease;
          transform: translateX(-50%);
        }
        @keyframes word-menu-in {
          from { opacity: 0; transform: translateX(-50%) scale(0.92) translateY(-4px); }
          to   { opacity: 1; transform: translateX(-50%) scale(1) translateY(0); }
        }
        .word-menu-item {
          display: flex; flex-direction: row; align-items: center; gap: 6px;
          padding: 7px 10px; border: none; background: none;
          cursor: pointer; border-radius: 8px;
          font-size: 10px; font-weight: 600; color: var(--textDim); font-family: inherit;
          transition: background 0.08s, color 0.08s;
          letter-spacing: 0.03em; text-transform: uppercase; white-space: nowrap;
        }
        .word-menu-item:hover { background: var(--hover); color: var(--text); }
        .word-menu-item svg { flex-shrink: 0; }
        .word-menu-sep { width: 1px; height: 28px; background: var(--borderSubtle); margin: 0 2px; flex-shrink: 0; }

        /* ── Definition / Translate popup ────────────────────────────────── */
        .def-popup {
          position: fixed; z-index: 10000;
          background: var(--surface); border: 1px solid var(--border);
          border-radius: 12px; padding: 14px 16px;
          box-shadow: 0 12px 48px rgba(0,0,0,0.5);
          max-width: 380px; min-width: 260px;
          animation: word-menu-in 0.12s ease;
          transform: translateX(-50%);
        }
        .def-popup-word {
          font-size: 16px; font-weight: 700; color: var(--text);
          margin-bottom: 4px; font-family: Georgia, serif;
        }
        .def-popup-content {
          font-size: 13px; color: var(--textDim); line-height: 1.6;
          max-height: 180px; overflow-y: auto;
        }
        .def-popup-close {
          position: absolute; top: 8px; right: 10px;
          background: none; border: none; color: var(--textDim);
          cursor: pointer; font-size: 18px; line-height: 1; padding: 2px 4px;
          border-radius: 4px; transition: color 0.1s;
        }
        .def-popup-close:hover { color: var(--text); }
        .def-popup-loading {
          display: flex; align-items: center; gap: 8px;
          font-size: 12px; color: var(--textDim);
        }

        /* ── TTS Player bar — Gnos style ──────────────────────────────────── */
        .tts-bar {
          position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 12px; padding: 10px 12px 12px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.45);
          display: flex; flex-direction: column; gap: 8px;
          width: 440px; max-width: calc(100vw - 24px);
          z-index: 8500;
          animation: tts-bar-in 0.18s cubic-bezier(0.4,0,0.2,1);
        }
        @keyframes tts-bar-in {
          from { opacity: 0; transform: translateX(-50%) translateY(10px); }
          to   { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
        .tts-top-row {
          display: flex; align-items: center; justify-content: space-between; gap: 8px;
        }
        .tts-controls-row {
          display: flex; align-items: center; justify-content: center; gap: 6px; flex: 1;
        }
        .tts-progress-bar {
          height: 3px; border-radius: 2px;
          background: var(--surfaceAlt); overflow: hidden;
        }
        .tts-progress-fill {
          height: 100%; background: var(--accent);
          transition: width 0.3s ease; border-radius: 2px;
        }
        .tts-sentence {
          font-size: 11px; color: var(--textDim); line-height: 1.5;
          font-style: italic; text-align: center;
          white-space: normal; word-break: break-word;
        }
        /* Gnos bordered button style */
        .tts-ctrl {
          height: 30px; min-width: 30px; padding: 0 6px;
          border: 1px solid var(--border); border-radius: 7px;
          background: var(--surface); color: var(--text);
          cursor: pointer;
          display: flex; align-items: center; justify-content: center; flex-shrink: 0;
          transition: background 0.1s, border-color 0.1s;
          font-size: 11px; font-weight: 600;
        }
        .tts-ctrl:hover { background: var(--surfaceAlt); border-color: var(--accent); }
        .tts-ctrl.primary {
          border-color: var(--accent); color: var(--accent);
          width: 36px; height: 36px; border-radius: 9px;
          box-shadow: 0 0 0 2px rgba(56,139,253,0.15);
        }
        .tts-ctrl.primary:hover { background: rgba(56,139,253,0.1); }
        /* X close button */
        .tts-close-btn {
          width: 26px; height: 26px; border-radius: 7px; flex-shrink: 0;
          border: 1px solid var(--border); background: var(--surface);
          color: var(--textDim); cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          transition: background 0.1s, color 0.1s, border-color 0.1s;
        }
        .tts-close-btn:hover {
          background: rgba(248,81,73,0.12);
          color: #f85149; border-color: rgba(248,81,73,0.4);
        }

        /* ── Reader text highlights ──────────────────────────────────────── */
        .col-word.reader-hl {
          background: rgba(255, 210, 0, 0.65);
          /* Extend right to fill the inter-word space gap, close left gap */
          box-shadow: 5px 0 0 rgba(255, 210, 0, 0.65), -1px 0 0 rgba(255, 210, 0, 0.65);
          border-radius: 1px;
          cursor: pointer;
          color: #1a1200;
        }
        .col-word.reader-hl:hover {
          background: rgba(255, 210, 0, 0.85);
          box-shadow: 5px 0 0 rgba(255, 210, 0, 0.85), -1px 0 0 rgba(255, 210, 0, 0.85);
        }

        /* ── TTS word highlight ───────────────────────────────────────────── */
        .col-word.tts-word-active {
          background: rgba(56,139,253,0.28);
          border-radius: 2px;
          outline: none;
        }
      `}</style>

      {/* Header */}
      <header className="reader-header">
        <div className="reader-header-logo">
          <GnosNavButton />
        </div>

        <div className="chapter-nav-wrapper">
          <button className="btn-chapter" onClick={e => { e.stopPropagation(); setDropdownOpen(o => !o); setSettingsOpen(false) }}>
            <div className="title-row">
              <span>{activeBook?.title || ''}</span>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div className="sub-row">{chapterTitle}</div>
          </button>
          {dropdownOpen && (
            <ChapterDropdown chapters={chapters} currentChapter={curChapter}
              chapterPageCounts={chapterPageCountsRef.current} onJump={jumpToChapter} onClose={() => setDropdownOpen(false)} />
          )}
        </div>

        <div className="reader-actions">
          <button className="btn-reader-icon" title="Read aloud (TTS)"
            onClick={() => ttsActive ? ttsStop() : ttsStart(null)}
            style={ttsActive ? { color: 'var(--accent)' } : undefined}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M2 5.5h3l4-3.5v11L5 9.5H2v-4z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
              <path d="M11 5c.9.8 1.5 1.8 1.5 3s-.6 2.2-1.5 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              <path d="M13 3c1.5 1.3 2.5 3 2.5 5s-1 3.7-2.5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
          </button>
          <button className="btn-reader-icon" title="Reader settings"
            onClick={e => { e.stopPropagation(); setSettingsOpen(o => !o); setDropdownOpen(false) }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.4"/>
              <path d="M8 1.5v1.2M8 13.3v1.2M1.5 8h1.2M13.3 8h1.2M3.4 3.4l.85.85M11.75 11.75l.85.85M12.6 3.4l-.85.85M4.25 11.75l-.85.85"
                stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      </header>

      {/* Settings panel */}
      {settingsOpen && (
        <SettingsPanel prefs={prefs}
          onPrefChange={handlePrefChange} onRebuild={handleRebuild} onClose={() => setSettingsOpen(false)} />
      )}

      {/* Tap zones — left zone shifts right when sidebar is open */}
      {prefs.tapToTurn && !loading && (
        <>
          <div className="tap-zone left" onClick={prevPage}
            style={sideNavOpen ? { left: 238 } : undefined}>
            <div className="tap-icon">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M9 2L4 7l5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
          </div>
          <div className="tap-zone right" onClick={nextPage}>
            <div className="tap-icon">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M5 2l5 5-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
          </div>
        </>
      )}

      {/* Main card area */}
      <main ref={containerRef} className="reader-main" style={{ position: 'relative' }}>
        <div ref={cardRef} className="reader-card"
          onClick={handleCardClick}
          onContextMenu={handleCardContextMenu}
        />

        {loading && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 24,
            background: 'var(--readerCard)', zIndex: 10,
          }}>
            {activeBook?.coverDataUrl
              ? <img src={activeBook.coverDataUrl} alt=""
                  style={{ maxWidth: 220, maxHeight: 300, objectFit: 'contain', borderRadius: 8, boxShadow: '0 8px 40px rgba(0,0,0,0.35)' }} />
              : <div style={{ width: 160, height: 220, borderRadius: 8, background: `linear-gradient(135deg,${c1},${c2})`, boxShadow: '0 8px 40px rgba(0,0,0,0.3)', display: 'flex', alignItems: 'flex-end', padding: 14, boxSizing: 'border-box' }}>
                  <span style={{ color: 'rgba(255,255,255,0.9)', fontSize: 13, fontWeight: 700, fontFamily: 'Georgia,serif', lineHeight: 1.3 }}>{activeBook?.title}</span>
                </div>
            }
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--textDim)', fontSize: 12 }}>
              <div className="spinner" /><span>Loading…</span>
            </div>
          </div>
        )}
      </main>


      {/* Footer */}
      <footer className="reader-footer">
        <div className="footer-nav">
          <button className="btn outline" disabled={atStart} onClick={prevPage}>← Prev</button>

          <span className="page-indicator">
            {'Page '}
            {pageInput !== null
              ? <input type="number" min={1} max={displayTotal} value={pageInput}
                  autoFocus
                  style={{ width: Math.max(36, String(displayTotal).length * 10 + 16), background: 'transparent', border: 'none', borderBottom: '1px solid var(--textDim)', color: 'var(--text)', fontSize: 'inherit', fontFamily: 'inherit', textAlign: 'center', padding: '0 2px', outline: 'none' }}
                  onChange={e => setPageInput(e.target.value)}
                  onBlur={e => handlePageJump(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handlePageJump(e.target.value); if (e.key === 'Escape') setPageInput(null) }}
                  onClick={e => e.target.select()} />
              : <span style={{ cursor: 'pointer' }} onClick={() => setPageInput(displayPage + 1)}>
                  {displayPage + 1}
                </span>
            }
            {` of ${displayTotal} · ${Math.round(pct)}%`}
            {!isCover && (pagesLeft <= 0
              ? ' · last page'
              : pagesLeft === 1
                ? ' · 1 pg left'
                : ` · ${pagesLeft} pgs left`
            )}
          </span>

          <button className="btn outline" disabled={atEnd} onClick={nextPage}>Next →</button>
        </div>
        <div className="progress-track">
          <div className="progress-bar" style={{ width: `${pct}%` }} />
        </div>
      </footer>

      {/* ── Word context menu — horizontal pill ── */}
      {wordMenu && (
        <div ref={wordMenuRef} className="word-menu" style={{ top: wordMenu.y - 64, left: wordMenu.x }} onClick={e => e.stopPropagation()}>
          <button className="word-menu-item" onClick={() => {
            const word = wordMenu.word
            const x = wordMenu.x, y = wordMenu.y
            setWordMenu(null)
            setDefPopup({ word, mode: 'define', x, y: y + 12, content: null, loading: true })
            // Fetch definition from Free Dictionary API
            fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`)
              .then(r => r.json())
              .then(data => {
                const entry = Array.isArray(data) ? data[0] : null
                if (!entry) { setDefPopup(p => p && ({ ...p, loading: false, content: 'No definition found.' })); return }
                const meanings = entry.meanings?.slice(0, 2).map(m =>
                  `<b>${m.partOfSpeech}</b>: ${m.definitions?.slice(0,2).map(d => d.definition).join('; ')}`
                ).join('<br>') || 'No definition found.'
                const phonetic = entry.phonetic || ''
                setDefPopup(p => p && ({ ...p, loading: false, content: meanings, phonetic }))
              })
              .catch(() => setDefPopup(p => p && ({ ...p, loading: false, content: 'Could not load definition.' })))
          }}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M3 14V3a1.5 1.5 0 0 1 1.5-1.5h9V14H4.5A1.5 1.5 0 0 1 3 12.5v0A1.5 1.5 0 0 1 4.5 11H13.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
              <line x1="6" y1="5.5" x2="11" y2="5.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              <line x1="6" y1="8" x2="10" y2="8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
            Define
          </button>
          <div className="word-menu-sep" />

          <button className="word-menu-item" onClick={() => {
            const word = wordMenu.word
            const ctx = wordMenu.sentence || word
            const x = wordMenu.x, y = wordMenu.y
            const tl = translateLang
            setWordMenu(null)
            setDefPopup({ word: ctx.length > 60 ? word : ctx, mode: 'translate', x, y: y + 12, content: null, loading: true, targetLang: tl })

            const textToTranslate = (ctx.length > 500 ? ctx.slice(0, 500) : ctx).trim()

            // Primary: MyMemory (free, no API key)
            // Fallback: Google Translate unofficial endpoint
            async function doTranslate() {
              // Try MyMemory first
              try {
                const mmUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(textToTranslate)}&langpair=en|${tl}`
                const r = await fetch(mmUrl)
                const data = await r.json()
                if (data.responseStatus === 200 && data.responseData?.translatedText &&
                    !data.responseData.translatedText.toLowerCase().includes('mymemory warning')) {
                  const translated = data.responseData.translatedText
                  setDefPopup(p => p && ({ ...p, loading: false, content: translated }))
                  return
                }
              } catch { /* fall through */ }

              // Fallback: Lingva Translate (open-source Google Translate front-end)
              try {
                const lingvaUrl = `https://lingva.ml/api/v1/en/${tl}/${encodeURIComponent(textToTranslate)}`
                const r = await fetch(lingvaUrl)
                const data = await r.json()
                if (data?.translation) {
                  setDefPopup(p => p && ({ ...p, loading: false, content: data.translation }))
                  return
                }
              } catch { /* fall through */ }

              // Last resort: unofficial Google Translate
              try {
                const gtUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${tl}&dt=t&q=${encodeURIComponent(textToTranslate)}`
                const r = await fetch(gtUrl)
                const data = await r.json()
                const translated = data?.[0]?.map(s => s?.[0]).filter(Boolean).join('') || ''
                if (translated) {
                  setDefPopup(p => p && ({ ...p, loading: false, content: translated }))
                  return
                }
              } catch { /* fall through */ }

              setDefPopup(p => p && ({ ...p, loading: false, content: '⚠️ Translation service unavailable. Please check your internet connection.' }))
            }
            doTranslate()
          }}>
            {/* Language translation icon from svgrepo.com/svg/324210/language-translation */}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0 0 14.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z" fill="currentColor"/>
            </svg>
            Translate
          </button>
          <div className="word-menu-sep" />
          <button className="word-menu-item" onClick={() => {
            ttsStart(wordMenu.sentence || wordMenu.word)
            setWordMenu(null)
          }}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <polygon points="4,3 13,8 4,13" fill="currentColor"/>
            </svg>
            Play
          </button>
          <div className="word-menu-sep" />
          {wordMenu.hlId ? (
            <button className="word-menu-item" style={{ color: '#f85149' }} onClick={() => {
              const bookId = bookIdRef.current
              if (bookId && wordMenu.hlId) {
                highlightsRef.current[bookId] = (highlightsRef.current[bookId] || []).filter(h => h.id !== wordMenu.hlId)
                saveHighlights()
                cardRef.current?.querySelectorAll(`[data-hl-id="${wordMenu.hlId}"]`).forEach(el => { el.classList.remove('reader-hl'); delete el.dataset.hlId })
              }
              setWordMenu(null)
            }}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M1 1l14 14M15 1L1 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              Remove highlight
            </button>
          ) : (
            <button className="word-menu-item" onClick={() => {
              const bookId = bookIdRef.current
              if (!bookId || !wordMenu.hlText) { setWordMenu(null); return }
              const hl = { id: `hl_${Date.now()}`, chapterIdx: wordMenu.hlChapterIdx ?? curChapterRef.current, text: wordMenu.hlText }
              if (!highlightsRef.current[bookId]) highlightsRef.current[bookId] = []
              highlightsRef.current[bookId].push(hl)
              saveHighlights()
              requestAnimationFrame(() => applyHighlightsToCard(cardRef.current, bookId, hl.chapterIdx))
              setWordMenu(null)
            }}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                <rect x="2" y="5" width="12" height="7" rx="1" fill="rgba(255,210,0,0.5)" stroke="currentColor" strokeWidth="1.3"/>
                <path d="M5 5V3.5a3 3 0 0 1 6 0V5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              </svg>
              Highlight
            </button>
          )}
        </div>
      )}

      {/* ── Definition / Translate popup ── */}
      {defPopup && (
        <div ref={defPopupRef} className="def-popup" style={{ top: defPopup.y + 8, left: defPopup.x }} onClick={e => e.stopPropagation()}>
          <button className="def-popup-close" onClick={() => setDefPopup(null)}>×</button>

          {/* Header row — word + mode badge */}
          <div style={{ display:'flex', alignItems:'baseline', gap:8, marginBottom:4, flexWrap:'wrap' }}>
            <div className="def-popup-word" style={{ marginBottom:0 }}>
              {defPopup.word}
              {defPopup.phonetic && <span style={{ fontSize:12, fontWeight:400, fontStyle:'italic', color:'var(--textDim)', marginLeft:8 }}>{defPopup.phonetic}</span>}
            </div>
            {defPopup.mode === 'translate' && (
              <span style={{ fontSize:10, background:'var(--surfaceAlt)', border:'1px solid var(--border)', borderRadius:4, padding:'1px 6px', color:'var(--textDim)', flexShrink:0, fontFamily:'inherit' }}>
                → {LIBRE_LANGS.find(l=>l.code===defPopup.targetLang)?.name || defPopup.targetLang}
              </span>
            )}
          </div>

          {/* Language selector — only in translate mode, at top of popup */}
          {defPopup.mode === 'translate' && (
            <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:8, padding:'6px 8px', background:'var(--surfaceAlt)', borderRadius:6, border:'1px solid var(--border)' }}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ color:'var(--textDim)', flexShrink:0 }}>
                <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3"/>
                <path d="M8 1.5C8 1.5 5.5 4 5.5 8s2.5 6.5 2.5 6.5M8 1.5C8 1.5 10.5 4 10.5 8s-2.5 6.5-2.5 6.5M1.5 8h13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              </svg>
              <span style={{ fontSize:11, color:'var(--textDim)', flexShrink:0 }}>Translate to</span>
              <select
                value={translateLang}
                onChange={e => {
                  const newLang = e.target.value
                  setTranslateLang(newLang)
                  const word = defPopup.word
                  setDefPopup(p => p && ({ ...p, loading: true, content: null, targetLang: newLang }))
                  const _txt = word.slice(0, 500).trim();
                  (async () => {
                    try {
                      const r = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(_txt)}&langpair=en|${newLang}`)
                      const d = await r.json()
                      if (d.responseStatus === 200 && d.responseData?.translatedText && !d.responseData.translatedText.toLowerCase().includes('mymemory warning')) {
                        setDefPopup(p => p && ({ ...p, loading: false, content: d.responseData.translatedText, targetLang: newLang })); return
                      }
                    } catch { /* fall through */ }
                    try {
                      const r = await fetch(`https://lingva.ml/api/v1/en/${newLang}/${encodeURIComponent(_txt)}`)
                      const d = await r.json()
                      if (d?.translation) { setDefPopup(p => p && ({ ...p, loading: false, content: d.translation, targetLang: newLang })); return }
                    } catch { /* fall through */ }
                    try {
                      const r = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${newLang}&dt=t&q=${encodeURIComponent(_txt)}`)
                      const d = await r.json()
                      const translated = d?.[0]?.map(s => s?.[0]).filter(Boolean).join('') || ''
                      if (translated) { setDefPopup(p => p && ({ ...p, loading: false, content: translated, targetLang: newLang })); return }
                    } catch { /* fall through */ }
                    setDefPopup(p => p && ({ ...p, loading: false, content: '⚠️ Translation service unavailable.' }))
                  })()
                }}
                onClick={e => e.stopPropagation()}
                style={{ background:'var(--bg)', border:'1px solid var(--border)', borderRadius:5, color:'var(--text)', fontSize:11, fontFamily:'inherit', padding:'2px 6px', cursor:'pointer', outline:'none', flex:1 }}
              >
                {LIBRE_LANGS.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
              </select>
            </div>
          )}

          <div className="def-popup-content">
            {defPopup.loading
              ? <div className="def-popup-loading"><div className="spinner" />Loading…</div>
              : <>
                  <span dangerouslySetInnerHTML={{ __html: defPopup.content || '' }} />

                  {/* Translation metadata */}
                  {defPopup.mode === 'translate' && defPopup.confidence != null && (
                    <div style={{ marginTop:8, paddingTop:6, borderTop:'1px solid var(--borderSubtle)', display:'flex', gap:10, flexWrap:'wrap' }}>
                      <span style={{ fontSize:10, color:'var(--textDim)', display:'flex', alignItems:'center', gap:5 }}>
                        Match quality:
                        <span style={{
                          display:'inline-block', width:48, height:5, background:'var(--border)',
                          borderRadius:3, overflow:'hidden', verticalAlign:'middle', marginLeft:3,
                        }}>
                          <span style={{ display:'block', height:'100%', width:`${defPopup.confidence}%`,
                            background: defPopup.confidence > 70 ? 'var(--accent)' : defPopup.confidence > 40 ? '#d29922' : '#f85149',
                            borderRadius:3, transition:'width 0.3s',
                          }} />
                        </span>
                        <b style={{ color:'var(--text)' }}>{defPopup.confidence}%</b>
                      </span>
                    </div>
                  )}

                  {/* Target-language definition (if fetched) */}
                  {defPopup.mode === 'translate' && defPopup.targetDefinition && (
                    <div style={{ marginTop:8, paddingTop:6, borderTop:'1px solid var(--borderSubtle)' }}>
                      <div style={{ fontSize:10, fontWeight:600, color:'var(--textDim)', textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:4 }}>
                        Definition in {LIBRE_LANGS.find(l=>l.code===defPopup.targetLang)?.name || defPopup.targetLang}
                      </div>
                      <div style={{ fontSize:12, color:'var(--textDim)', lineHeight:1.5 }}>
                        {defPopup.targetDefinition}
                      </div>
                    </div>
                  )}
                </>
            }
          </div>

          {/* Powered-by note */}
          {defPopup.mode === 'translate' && !defPopup.loading && (
            <div style={{ marginTop:8, paddingTop:6, borderTop:'1px solid var(--borderSubtle)', fontSize:10, color:'var(--textDim)', opacity:0.6, textAlign:'right' }}>
              Free translation
            </div>
          )}
        </div>
      )}

      {/* ── TTS Player bar ── */}
      {ttsActive && (
        <div className="tts-bar">
          <div className="tts-top-row">
            <div className="tts-controls-row">
              <button className="tts-ctrl" onClick={() => ttsNav(-1)} title="Previous sentence">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <polygon points="10,2 3,6 10,10" fill="currentColor"/>
                  <rect x="1" y="2" width="2" height="8" rx="0.5" fill="currentColor"/>
                </svg>
              </button>
              <button className="tts-ctrl primary" onClick={ttsTogglePause} title={ttsPaused ? 'Resume' : 'Pause'}>
                {ttsPaused
                  ? <svg width="13" height="13" viewBox="0 0 12 12" fill="none"><polygon points="2,1 11,6 2,11" fill="currentColor"/></svg>
                  : <svg width="13" height="13" viewBox="0 0 12 12" fill="none"><rect x="2" y="1" width="3" height="10" rx="0.5" fill="currentColor"/><rect x="7" y="1" width="3" height="10" rx="0.5" fill="currentColor"/></svg>
                }
              </button>
              <button className="tts-ctrl" onClick={() => ttsNav(1)} title="Next sentence">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <polygon points="2,2 9,6 2,10" fill="currentColor"/>
                  <rect x="9" y="2" width="2" height="8" rx="0.5" fill="currentColor"/>
                </svg>
              </button>
            </div>
            {/* × close — pinned to far right */}
            <button className="tts-close-btn" onClick={ttsStop} title="Stop reading" style={{marginLeft:'auto'}}>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
          <div className="tts-progress-bar">
            <div className="tts-progress-fill" style={{ width: `${Math.round(ttsProgress * 100)}%` }} />
          </div>
          {ttsSentence && (
            <div className="tts-sentence">&ldquo;{ttsSentence}&rdquo;</div>
          )}
        </div>
      )}
    </div>
  )
}