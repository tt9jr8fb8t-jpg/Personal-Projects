import { listen } from '@tauri-apps/api/event'
import { useEffect, useState, useRef, useCallback, lazy, Suspense } from 'react'
import useAppStore from '@/store/useAppStore'
import { onOpenUrl } from '@tauri-apps/plugin-deep-link'
import { readFile } from '@tauri-apps/plugin-fs'
import OnboardingView from '@/views/OnboardingView'

import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { PaneContext } from '@/lib/PaneContext'
import LibraryView     from '@/views/LibraryView'
import ReaderView      from '@/views/ReaderView'
import AudioPlayerView from '@/views/AudioPlayerView'
import PdfView         from '@/views/PdfView'
import SideNav         from '@/components/SideNav'
import GraphView       from '@/views/GraphView'
import CalendarView    from '@/views/CalendarView'

const NotebookView   = lazy(() => import('@/views/NotebookView'))
const SketchbookView = lazy(() => import('@/views/SketchbookView'))
const FlashcardView  = lazy(() => import('@/views/FlashcardView'))
const KanbanView     = lazy(() => import('@/views/KanbanView'))

const VIEW_LABELS = {
  library: 'Library', reader: 'Reading', 'audio-player': 'Listening',
  notebook: 'Notebook', pdf: 'PDF', sketchbook: 'Sketchbook',
  flashcard: 'Flashcards', graph: 'Graph', calendar: 'Calendar', kanban: 'Tasks',
}

/** Derive a tab label from tab state — show file/content name when available.
 *  Pass `notebooks` from the store so notebook title changes reflect without remounting. */
function getTabLabel(tab, { notebooks = [] } = {}) {
  if (tab.activeBook && (tab.view === 'reader' || tab.view === 'pdf'))
    return tab.activeBook.title || VIEW_LABELS[tab.view] || tab.view
  if (tab.activeNotebook && tab.view === 'notebook') {
    const live = notebooks.find(n => n.id === tab.activeNotebook.id)
    return live?.title || tab.activeNotebook.title || 'Notebook'
  }
  if (tab.activeAudioBook && tab.view === 'audio-player')
    return tab.activeAudioBook.title || 'Listening'
  if (tab.activeSketchbook && tab.view === 'sketchbook')
    return tab.activeSketchbook.title || 'Sketchbook'
  if (tab.activeFlashcardDeck && tab.view === 'flashcard')
    return tab.activeFlashcardDeck.title || 'Flashcards'
  return VIEW_LABELS[tab.view] || tab.view
}

export const TITLEBAR_H = 34

// ── ViewPanel ─────────────────────────────────────────────────────────────────
function ViewPanel({ view }) {
  let content = null
  if (view === 'library')      content = <LibraryView />
  else if (view === 'reader')       content = <ReaderView />
  else if (view === 'audio-player') content = <AudioPlayerView />
  else if (view === 'notebook')     content = <NotebookView />
  else if (view === 'pdf')          content = <PdfView />
  else if (view === 'sketchbook')   content = <SketchbookView />
  else if (view === 'flashcard')    content = <FlashcardView />
  else if (view === 'graph')        content = <GraphView />
  else if (view === 'calendar')     content = <CalendarView />
  else if (view === 'kanban')       content = <KanbanView />
  if (!content) return null
  return <Suspense fallback={null}>{content}</Suspense>
}

// ── TabPane ───────────────────────────────────────────────────────────────────
// Lazily mounts on first activation and stays mounted for the tab's lifetime.
// Visibility is controlled by display:flex/none so the view doesn't remount on
// every tab switch, but the component does unmount when the tab is closed.
function TabPane({ tabId, isActive, isLastActive, isSplit, onFocus }) {
  const tab = useAppStore(s => s.tabs.find(t => t.id === tabId))
  const shouldMount = isActive || isSplit || isLastActive
  const [everActive, setEverActive] = useState(shouldMount)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (shouldMount && !everActive) setEverActive(true)
  }, [shouldMount]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!tab || !everActive) return null

  return (
    <PaneContext.Provider value={tabId}>
      <div
        onMouseDown={() => { if (isSplit && !isActive && onFocus) onFocus() }}
        onFocusCapture={() => { if (isSplit && !isActive && onFocus) onFocus() }}
        style={{
          ...(isSplit
            ? { flex: 1, minWidth: 0, minHeight: 0, position: 'relative' }
            : { position: 'absolute', inset: 0 }
          ),
          overflow: 'hidden',
          display: (isSplit || isActive) ? 'flex' : 'none',
          flexDirection: 'column',
        }}>
        <SideNav isSplitPane={isSplit} />
        <ViewPanel view={tab.view} />
        {isSplit && isActive && (
          <div
            style={{ position: 'absolute', inset: 0, zIndex: 300, pointerEvents: 'none', border: '2px solid var(--accent)', opacity: 0.3 }}
          />
        )}
      </div>
    </PaneContext.Provider>
  )
}

// ── Tab Layout Modal ──────────────────────────────────────────────────────────
function TabLayoutModal({ onClose, splitDir, splitPanes, setSplitDir, setSplitPanes, switchTab }) {
  const tabs        = useAppStore(s => s.tabs)
  const activeTabId = useAppStore(s => s.activeTabId)
  const closeTab    = useAppStore(s => s.closeTab)
  const openNewTab  = useAppStore(s => s.openNewTab)

  const isSplit = splitDir !== null
    && splitPanes.length === 2
    && splitPanes.every(id => tabs.some(t => t.id === id))

  function startSplit(dir) {
    // Capture the current active tab ID NOW before any store mutations
    const currentActiveId = useAppStore.getState().activeTabId
    let allTabs = useAppStore.getState().tabs
    let otherId = allTabs.find(t => t.id !== currentActiveId)?.id
    if (!otherId) {
      // No second tab exists — create one, then read the updated tabs
      openNewTab({ view: 'library', activeLibTab: 'library' })
      // openNewTab switches the active tab — get the new tab's id
      allTabs = useAppStore.getState().tabs
      otherId = useAppStore.getState().activeTabId
    }
    if (!otherId || otherId === currentActiveId) return
    setSplitDir(dir)
    setSplitPanes([currentActiveId, otherId])
    onClose()
  }

  function endSplit() {
    setSplitDir(null)
    setSplitPanes([])
    onClose()
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onClose}
    >
      <div
        style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: 380, maxWidth: '92vw', boxShadow: '0 20px 60px rgba(0,0,0,0.55)', overflow: 'hidden' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px 12px', borderBottom: '1px solid var(--borderSubtle)' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>Tab Layout</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--textDim)', cursor: 'pointer', fontSize: 20, lineHeight: 1, padding: '0 2px' }}>×</button>
        </div>

        <div style={{ padding: '16px 18px 18px', display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Open tabs */}
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--textDim)', marginBottom: 8 }}>Open Tabs</div>
            {tabs.map(tab => (
              <div key={tab.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 8, background: tab.id === activeTabId ? 'rgba(56,139,253,0.1)' : 'transparent', marginBottom: 2 }}>
                <div style={{ width: 6, height: 6, borderRadius: 3, background: tab.id === activeTabId ? 'var(--accent)' : 'var(--border)', flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: 13, color: tab.id === activeTabId ? 'var(--accent)' : 'var(--text)', fontWeight: tab.id === activeTabId ? 600 : 400 }}>
                  {VIEW_LABELS[tab.view] || tab.view}
                  {tab.id === activeTabId && <span style={{ fontSize: 10, color: 'var(--textDim)', marginLeft: 6 }}>active</span>}
                </span>
                {tab.id !== activeTabId && (
                  <button
                    onClick={() => { switchTab(tab.id); onClose() }}
                    style={{ fontSize: 11, background: 'var(--surfaceAlt)', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--textDim)', cursor: 'pointer', padding: '2px 8px', fontFamily: 'inherit' }}
                  >Switch</button>
                )}
                {tabs.length > 1 && (
                  <button
                    onClick={() => closeTab(tab.id)}
                    style={{ fontSize: 11, background: 'none', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--textDim)', cursor: 'pointer', padding: '2px 8px', fontFamily: 'inherit' }}
                  >Close</button>
                )}
              </div>
            ))}
            <button
              onClick={() => { openNewTab({ view: 'library', activeLibTab: 'library' }); onClose() }}
              style={{ marginTop: 6, width: '100%', padding: '8px 0', background: 'none', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--textDim)', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', transition: 'border-color 0.1s, color 0.1s' }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.color = 'var(--accent)' }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--textDim)' }}
            >+ New Tab</button>
          </div>

          {/* Split layout */}
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--textDim)', marginBottom: 8 }}>Split View</div>
            {isSplit ? (
              <button
                onClick={endSplit}
                style={{ width: '100%', padding: '9px 0', background: 'rgba(248,81,73,0.08)', border: '1px solid rgba(248,81,73,0.3)', borderRadius: 8, color: '#f85149', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit', fontWeight: 500 }}
              >Remove Split</button>
            ) : (
              <div style={{ display: 'flex', gap: 8 }}>
                {[
                  { dir: 'horizontal', label: 'Side by Side', icon: (
                    <svg width="32" height="22" viewBox="0 0 32 22" fill="none">
                      <rect x="1" y="1" width="13" height="20" rx="2" stroke="currentColor" strokeWidth="1.5"/>
                      <rect x="18" y="1" width="13" height="20" rx="2" stroke="currentColor" strokeWidth="1.5"/>
                    </svg>
                  )},
                  { dir: 'vertical', label: 'Top / Bottom', icon: (
                    <svg width="32" height="22" viewBox="0 0 32 22" fill="none">
                      <rect x="1" y="1" width="30" height="9" rx="2" stroke="currentColor" strokeWidth="1.5"/>
                      <rect x="1" y="12" width="30" height="9" rx="2" stroke="currentColor" strokeWidth="1.5"/>
                    </svg>
                  )},
                ].map(({ dir, label, icon }) => (
                  <button key={dir} onClick={() => startSplit(dir)}
                    style={{ flex: 1, padding: '10px 0 8px', background: 'var(--surfaceAlt)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)', cursor: 'pointer', fontSize: 11, fontFamily: 'inherit', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7, transition: 'border-color 0.1s, background 0.1s' }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.background = 'rgba(56,139,253,0.06)' }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.background = 'var(--surfaceAlt)' }}
                  >
                    {icon}
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  )
}

// ── Tab CSS ───────────────────────────────────────────────────────────────────
const TAB_CSS = `
  .gnos-titlebar {
    position: fixed; top: 0; left: 0; right: 0;
    height: ${TITLEBAR_H}px; z-index: 9999;
    display: flex; align-items: flex-end;
    padding-left: 88px; padding-right: 12px; gap: 2px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    box-sizing: border-box; overflow: visible;
  }
  .gnos-titlebar-settings {
    display: flex; align-items: center;
    align-self: center;
    flex-shrink: 0;
  }
  .gnos-settings-btn {
    width: 22px; height: 22px; border-radius: 4px;
    background: none; border: 1px solid transparent;
    color: var(--textDim); cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: background 0.12s, border-color 0.12s, color 0.12s;
  }
  .gnos-settings-btn:hover {
    background: var(--surfaceAlt); border-color: var(--border); color: var(--text);
  }
  .gnos-tab {
    display: flex; align-items: flex-end;
    height: 100%; flex-shrink: 0;
    user-select: none; -webkit-app-region: no-drag;
  }
  .gnos-tab-body {
    display: flex; align-items: center; gap: 8px;
    height: calc(100% - 4px); bottom: -1px; position: relative;
    padding: 0 12px 1px 16px;
    border-radius: 12px 12px 0 0;
    border: 1px solid transparent; border-bottom: none;
    cursor: pointer;
    transition: background 0.14s, border-color 0.14s;
    min-width: 130px; max-width: 220px;
  }
  .gnos-tab.active .gnos-tab-body {
    background: var(--bg); border-color: var(--border);
    border-bottom-color: var(--bg);
  }
  .gnos-tab:not(.active) .gnos-tab-body { background: transparent; border-color: transparent; }
  .gnos-tab:not(.active):hover .gnos-tab-body {
    background: rgba(255,255,255,0.05); border-color: var(--borderSubtle);
    border-bottom-color: transparent;
  }
  .gnos-tab-label {
    font-size: 12px; font-family: var(--font-ui, system-ui);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    letter-spacing: -0.01em; line-height: 1; flex: 1;
    transition: color 0.12s, opacity 0.12s;
  }
  .gnos-tab.active .gnos-tab-label { color: var(--text); font-weight: 600; opacity: 1; }
  .gnos-tab:not(.active) .gnos-tab-label { color: var(--textDim); font-weight: 400; opacity: 0.5; }
  .gnos-tab:not(.active):hover .gnos-tab-label { opacity: 0.8; }
  .gnos-tab-x {
    width: 16px; height: 16px; border-radius: 4px;
    border: 1px solid transparent; background: none;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; flex-shrink: 0; padding: 0; color: var(--textDim);
    opacity: 0; transition: opacity 0.12s, background 0.1s, color 0.1s, border-color 0.1s;
  }
  .gnos-tab.has-close:hover .gnos-tab-x  { opacity: 0.45; }
  .gnos-tab.active.has-close .gnos-tab-x { opacity: 0.35; }
  .gnos-tab-x:hover {
    opacity: 1 !important; background: rgba(248,81,73,0.12) !important;
    color: #f85149 !important; border-color: rgba(248,81,73,0.35) !important;
  }
  .gnos-split-divider {
    flex-shrink: 0; background: var(--border);
    transition: background 0.12s; z-index: 10;
  }
  .gnos-split-divider:hover { background: var(--accent); }
  .gnos-split-divider.h { width: 1px; cursor: col-resize; align-self: stretch; }
  .gnos-split-divider.v { height: 1px; cursor: row-resize; align-self: stretch; }
  @media all and (display-mode: fullscreen) {
    .gnos-titlebar { padding-left: 12px; }
  }
  .gnos-titlebar.is-fullscreen { padding-left: 12px; }
  .gnos-new-tab-btn {
    display: flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; border-radius: 4px;
    border: 1px solid transparent; background: transparent;
    color: var(--textDim); cursor: pointer; flex-shrink: 0;
    align-self: center; margin-top: 5px;
    opacity: 0.35;
    transition: background 0.13s, color 0.13s, opacity 0.13s, border-color 0.13s;
  }
  .gnos-new-tab-btn:hover { background: var(--surfaceAlt); border-color: var(--border); color: var(--text); opacity: 1; }
  .gnos-tab-nav-btn {
    display: flex; align-items: center; justify-content: center;
    width: 20px; height: 20px; border-radius: 4px;
    border: 1px solid transparent; background: transparent;
    color: var(--textDim); cursor: pointer; flex-shrink: 0;
    align-self: center; padding: 0;
    opacity: 0.45;
    transition: background 0.12s, color 0.12s, opacity 0.12s, border-color 0.12s;
    font-size: 14px; line-height: 1;
  }
  .gnos-tab-nav-btn:hover:not(:disabled) { background: var(--surfaceAlt); border-color: var(--border); color: var(--text); opacity: 1; }
  .gnos-tab-nav-btn:disabled { opacity: 0.15; cursor: default; }
  .gnos-tab.drag-over .gnos-tab-body { border-color: var(--accent) !important; background: rgba(56,139,253,0.08) !important; }
`

// ── Theme palettes for loading screen ─────────────────────────────────────────
const LOADING_THEMES = {
  sepia:  { bg: '#faf8f5', accent: '#8b5e3c', text: '#3b2f20', dim: '#7a6652', border: '#d4c4b0' },
  light:  { bg: '#f6f8fa', accent: '#0969da', text: '#1f2328', dim: '#636c76', border: '#d0d7de' },
  moss:   { bg: '#eef3e8', accent: '#3d6e32', text: '#1e2c14', dim: '#4e6840', border: '#a8c090' },
  dark:   { bg: '#0d1117', accent: '#388bfd', text: '#e6edf3', dim: '#8b949e', border: '#30363d' },
  cherry: { bg: '#0e0608', accent: '#e05c7a', text: '#f2dde1', dim: '#9e6d76', border: '#3d1a20' },
  sunset: { bg: '#0f0a04', accent: '#e8922a', text: '#f5e6c8', dim: '#a07840', border: '#4a3010' },
}

// ── Loading Screen ────────────────────────────────────────────────────────────
function GnosLoadingScreen({ onDone }) {
  const themeKey = useAppStore(s => s.themeKey) || 'sepia'
  const p = LOADING_THEMES[themeKey] || LOADING_THEMES.sepia
  const isLight = themeKey === 'sepia' || themeKey === 'light' || themeKey === 'moss'
  const ruleOpacity = isLight ? 0.05 : 0.03

  const [fade, setFade]         = useState(false)
  const [update, setUpdate]     = useState(null)
  const [phase, setPhase]       = useState('checking') // checking | idle | downloading | error
  const [downloaded, setDownloaded] = useState(0)
  const [total, setTotal]       = useState(null)
  const [errorMsg, setErrorMsg] = useState('')
  const dismissedRef = useRef(false)

  const dismiss = useCallback(() => {
    if (dismissedRef.current) return
    dismissedRef.current = true
    setFade(true)
    setTimeout(onDone, 400)
  }, [onDone])

  useEffect(() => {
    let cancelled = false
    // Timeout: if update check takes longer than 2.5s, proceed normally
    const timeout = setTimeout(() => { if (!cancelled) dismiss() }, 2500)

    check().then(u => {
      if (cancelled) return
      clearTimeout(timeout)
      if (u?.available) {
        setUpdate(u)
        setPhase('idle')
      } else {
        // No update — dismiss after minimum display time
        setTimeout(dismiss, 600)
      }
    }).catch(() => {
      if (!cancelled) { clearTimeout(timeout); setTimeout(dismiss, 600) }
    })

    return () => { cancelled = true; clearTimeout(timeout) }
  }, []) // eslint-disable-line

  async function startUpdate() {
    setPhase('downloading')
    setDownloaded(0)
    setTotal(null)
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') setTotal(event.data.contentLength ?? null)
        else if (event.event === 'Progress') setDownloaded(d => d + (event.data.chunkLength ?? 0))
      })
      await relaunch()
    } catch (e) {
      setPhase('error')
      setErrorMsg(String(e))
    }
  }

  const percent = total && downloaded ? Math.min(100, Math.round((downloaded / total) * 100)) : null
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 99999,
      background: p.bg,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 16,
      opacity: fade ? 0 : 1,
      transition: 'opacity 0.4s ease',
      pointerEvents: fade ? 'none' : 'auto',
    }}>
      {/* Ruled paper lines */}
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0,
        backgroundImage: `repeating-linear-gradient(transparent, transparent 27px, ${p.accent} 28px)`,
        backgroundSize: '100% 28px', opacity: ruleOpacity,
      }} />

      {/* Corner brackets */}
      <svg style={{ position: 'absolute', top: 18, right: 22, opacity: 0.16, pointerEvents: 'none', transform: 'scaleX(-1)' }}
        width="48" height="48" viewBox="0 0 48 48" fill="none">
        <path d="M4 44 L4 4 L44 4" stroke={p.accent} strokeWidth="1.2" fill="none" />
        <path d="M4 4 L13 4 M4 4 L4 13" stroke={p.accent} strokeWidth="2" strokeLinecap="round"/>
      </svg>
      <svg style={{ position: 'absolute', bottom: 18, left: 22, opacity: 0.16, pointerEvents: 'none', transform: 'scaleY(-1)' }}
        width="48" height="48" viewBox="0 0 48 48" fill="none">
        <path d="M4 44 L4 4 L44 4" stroke={p.accent} strokeWidth="1.2" fill="none" />
        <path d="M4 4 L13 4 M4 4 L4 13" stroke={p.accent} strokeWidth="2" strokeLinecap="round"/>
      </svg>

      {/* Quill icon */}
      <svg width="44" height="44" viewBox="0 0 32 32" fill="none" style={{ opacity: 0.45, position: 'relative', zIndex: 1 }}>
        <path d="M26 3C22 5 14 10 10 18C8 22 7 25 6.5 28" stroke={p.dim} strokeWidth="1.1" strokeLinecap="round" />
        <path d="M26 3C24 8 18 15 10 18" stroke={p.dim} strokeWidth="0.7" strokeLinecap="round" opacity="0.6" />
        <path d="M26 3C25 6 22 10 16 14" stroke={p.dim} strokeWidth="0.5" strokeLinecap="round" opacity="0.35" />
        <path d="M6.5 28L9 23" stroke={p.dim} strokeWidth="1.1" strokeLinecap="round" />
      </svg>
      <div style={{
        fontFamily: 'Georgia, serif', fontSize: 36, fontWeight: 700,
        color: p.text, letterSpacing: '-1px', position: 'relative', zIndex: 1,
      }}>Gnos</div>
      <div style={{
        width: 36, height: 2, borderRadius: 1,
        background: p.dim, opacity: 0.5, position: 'relative', zIndex: 1,
      }} />

      {/* Update card — shown when update is available */}
      {update && (
        <div style={{
          position: 'relative', zIndex: 2, marginTop: 8,
          background: 'rgba(0,0,0,0.08)', border: `1px solid ${p.accent}40`,
          borderRadius: 12, padding: '14px 18px', width: 280,
          display: 'flex', flexDirection: 'column', gap: 10,
        }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: p.text }}>Update available</div>
          <div style={{ fontSize: 12, color: p.dim }}>
            v{update.currentVersion} → <strong style={{ color: p.accent }}>v{update.version}</strong>
          </div>
          {update.body && (
            <div style={{ fontSize: 11, color: p.dim, lineHeight: 1.5, maxHeight: 60, overflowY: 'auto' }}>
              {update.body}
            </div>
          )}
          {phase === 'downloading' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <div style={{ height: 3, borderRadius: 3, background: `${p.accent}30`, overflow: 'hidden' }}>
                <div style={{
                  height: '100%', borderRadius: 3, background: p.accent,
                  width: percent != null ? `${percent}%` : '40%',
                  transition: percent != null ? 'width 0.2s ease' : undefined,
                  animation: percent == null ? 'gnos-update-indeterminate 1.2s ease-in-out infinite' : undefined,
                }} />
              </div>
              <span style={{ fontSize: 11, color: p.dim, textAlign: 'right' }}>
                {percent != null ? `${percent}%` : 'Downloading…'}
              </span>
            </div>
          )}
          {phase === 'error' && (
            <div style={{ fontSize: 11, color: '#f85149' }}>{errorMsg}</div>
          )}
          {phase === 'idle' && (
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={dismiss} style={{
                flex: 1, padding: '6px 0', borderRadius: 6, cursor: 'pointer', fontSize: 12,
                background: 'none', border: `1px solid ${p.accent}50`, color: p.dim,
              }}>Later</button>
              <button onClick={startUpdate} style={{
                flex: 1, padding: '6px 0', borderRadius: 6, cursor: 'pointer', fontSize: 12,
                background: p.accent, border: 'none', color: '#fff', fontWeight: 600,
              }}>Update & Restart</button>
            </div>
          )}
          {phase === 'error' && (
            <button onClick={dismiss} style={{
              padding: '6px 0', borderRadius: 6, cursor: 'pointer', fontSize: 12,
              background: 'none', border: `1px solid ${p.accent}50`, color: p.dim,
            }}>Dismiss</button>
          )}
          <style>{`
            @keyframes gnos-update-indeterminate {
              0%   { transform: translateX(-100%); width: 40%; }
              100% { transform: translateX(350%);  width: 40%; }
            }
          `}</style>
        </div>
      )}
    </div>
  )
}


export default function App() {
  const init        = useAppStore(s => s.init)
  const tabs        = useAppStore(s => s.tabs)
  const activeTabId = useAppStore(s => s.activeTabId)
  const switchTab   = useAppStore(s => s.switchTab)
  const closeTab    = useAppStore(s => s.closeTab)
  const openNewTab  = useAppStore(s => s.openNewTab)
  const sideNavOpen = useAppStore(s => s.sideNavOpen)
  const onboardingComplete    = useAppStore(s => s.onboardingComplete)
  const setOnboardingComplete = useAppStore(s => s.setOnboardingComplete)

  const reorderTabs   = useAppStore(s => s.reorderTabs)
  const notebooks     = useAppStore(s => s.notebooks)
  const tabHistories  = useAppStore(s => s.tabHistories)
  const goBack        = useAppStore(s => s.goBack)
  const goForward     = useAppStore(s => s.goForward)

  const [splitDir,        setSplitDir]        = useState(null)
  const [splitPanes,      setSplitPanes]      = useState([])
  const [tabSettingsOpen, setTabSettingsOpen] = useState(false)
  const [showLoading, setShowLoading] = useState(true)
  const handleLoadingDone = useCallback(() => setShowLoading(false), [])
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [prevActiveTabId, setPrevActiveTabId] = useState(null)
  const [zenMode, setZenMode] = useState(false)
  const [zenPeekLeft, setZenPeekLeft] = useState(false)
  const zenPeekTimerRef = useRef({})
  const [dragTabId,  setDragTabId]  = useState(null)
  const [dropTabIdx, setDropTabIdx] = useState(null)
  const tabPointerRef = useRef(null) // { tabId, tabIdx, startX, dragging }

  const contentRef = useRef(null)
  const leftDragRef = useRef(null)
  const midDragRef  = useRef(null)
  const tauriWinRef = useRef(null)
  useEffect(() => {
    import('@tauri-apps/api/window')
      .then(m => { tauriWinRef.current = m.getCurrentWindow() })
      .catch(() => {})
  }, [])

  // macOS window keyboard shortcuts
  useEffect(() => {
    const onKeyDown = async (e) => {
      const win = tauriWinRef.current
      // Cmd+\ — Toggle sidebar
      if (e.metaKey && e.key === '\\') {
        e.preventDefault()
        useAppStore.getState().toggleSideNav()
        return
      }
      // Cmd+Shift+F — Toggle zen mode
      if (e.metaKey && e.shiftKey && e.code === 'KeyF') {
        e.preventDefault()
        setZenMode(z => !z)
        return
      }
      // Cmd+T — New tab
      if (e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey && e.key === 't') {
        e.preventDefault()
        useAppStore.getState().openNewTab({ view: 'library', activeLibTab: 'library' })
        return
      }
      // Cmd+W — Close current tab
      if (e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey && e.key === 'w') {
        e.preventDefault()
        const s = useAppStore.getState()
        if (s.tabs.length > 1) s.closeTab(s.activeTabId)
        return
      }
      // Cmd+Shift+] — Next tab
      if (e.metaKey && e.shiftKey && !e.ctrlKey && e.key === ']') {
        e.preventDefault()
        const s = useAppStore.getState()
        const idx = s.tabs.findIndex(t => t.id === s.activeTabId)
        const next = s.tabs[(idx + 1) % s.tabs.length]
        if (next) s.switchTab(next.id)
        return
      }
      // Cmd+Shift+[ — Previous tab
      if (e.metaKey && e.shiftKey && !e.ctrlKey && e.key === '[') {
        e.preventDefault()
        const s = useAppStore.getState()
        const idx = s.tabs.findIndex(t => t.id === s.activeTabId)
        const prev = s.tabs[(idx - 1 + s.tabs.length) % s.tabs.length]
        if (prev) s.switchTab(prev.id)
        return
      }
      // Cmd+1…9 — Switch to tab N
      if (e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey && e.key >= '1' && e.key <= '9') {
        const s = useAppStore.getState()
        const tab = s.tabs[parseInt(e.key) - 1]
        if (tab) { e.preventDefault(); s.switchTab(tab.id) }
        return
      }
      if (!win) return
      // Cmd+Ctrl+F — Toggle fullscreen
      if (e.metaKey && e.ctrlKey && e.key === 'f') {
        e.preventDefault()
        const isFs = await win.isFullscreen().catch(() => false)
        win.setFullscreen(!isFs)
      }
      // Cmd+M — Minimize
      if (e.metaKey && !e.ctrlKey && !e.shiftKey && e.key === 'm') {
        e.preventDefault()
        win.minimize()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
  // Listen for zen mode toggle from settings modal
  useEffect(() => {
    const h = (e) => setZenMode(e.detail.enabled)
    window.addEventListener('gnos:zen-mode', h)
    return () => window.removeEventListener('gnos:zen-mode', h)
  }, [])

  // Sync zen mode CSS class on body (hides view headers via global CSS)
  useEffect(() => {
    document.body.classList.toggle('zen-active', zenMode)
    return () => document.body.classList.remove('zen-active')
  }, [zenMode])

  // Zen peek — track mouse near left edge to reveal sidenav
  useEffect(() => {
    if (!zenMode) { setZenPeekLeft(false); return }
    const EDGE = 12
    const HIDE_DELAY = 600
    const onMove = (e) => {
      if (e.clientX <= EDGE) {
        clearTimeout(zenPeekTimerRef.current.left)
        setZenPeekLeft(true)
      } else if (e.clientX > 260) {
        clearTimeout(zenPeekTimerRef.current.left)
        zenPeekTimerRef.current.left = setTimeout(() => setZenPeekLeft(false), HIDE_DELAY)
      }
    }
    window.addEventListener('mousemove', onMove)
    return () => { window.removeEventListener('mousemove', onMove); clearTimeout(zenPeekTimerRef.current.left) }
  }, [zenMode])

  // Pointer-based tab drag (HTML5 drag API doesn't fire reliably in Tauri/WebKit)
  useEffect(() => {
    function getTabIdxAt(x) {
      const els = [...document.querySelectorAll('.gnos-tab')]
      for (let i = 0; i < els.length; i++) {
        const r = els[i].getBoundingClientRect()
        if (x < r.left + r.width / 2) return i
      }
      return Math.max(0, els.length - 1)
    }
    function onMove(e) {
      const d = tabPointerRef.current
      if (!d) return
      if (!d.dragging) {
        if (Math.abs(e.clientX - d.startX) > 5) { d.dragging = true; setDragTabId(d.tabId) }
        return
      }
      setDropTabIdx(getTabIdxAt(e.clientX))
    }
    function onUp(e) {
      const d = tabPointerRef.current
      if (!d) return
      if (d.dragging) {
        const toIdx = getTabIdxAt(e.clientX)
        if (toIdx !== d.tabIdx) useAppStore.getState().reorderTabs(d.tabIdx, toIdx)
      }
      tabPointerRef.current = null
      setDragTabId(null)
      setDropTabIdx(null)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [])

  // Attach native mousedown once the titlebar is rendered (after loading screen)
  useEffect(() => {
    if (showLoading) return
    const h = (e) => { if (e.button === 0) tauriWinRef.current?.startDragging() }
    const l = leftDragRef.current
    const r = midDragRef.current
    l?.addEventListener('mousedown', h)
    r?.addEventListener('mousedown', h)
    return () => { l?.removeEventListener('mousedown', h); r?.removeEventListener('mousedown', h) }
  }, [showLoading])

  // Track previous active tab so we keep it mounted
  const prevActiveRef = useRef(null)
  useEffect(() => {
    if (prevActiveRef.current && prevActiveRef.current !== activeTabId) {
      setPrevActiveTabId(prevActiveRef.current)
    }
    prevActiveRef.current = activeTabId
  }, [activeTabId])

  const isSplit = splitDir !== null
    && splitPanes.length === 2
    && splitPanes.every(id => tabs.some(t => t.id === id))

  const hasMultipleTabs = tabs.length > 1

  useEffect(() => {
    // Detect fullscreen to move tabs left
    const onResize = () => setIsFullscreen(window.innerHeight === screen.height && window.innerWidth === screen.width)
    window.addEventListener('resize', onResize)
    onResize()

    init()
    const unlisten = listen('menu', (event) => {
      const id = event.payload
      const store = useAppStore.getState()
      if (id === 'tab_library')     { store.setView('library'); store.setActiveLibTab('library') }
      if (id === 'tab_books')       { store.setView('library'); store.setActiveLibTab('books') }
      if (id === 'tab_audiobooks')  { store.setView('library'); store.setActiveLibTab('audiobooks') }
      if (id === 'tab_notebooks')   { store.setView('library'); store.setActiveLibTab('notebooks') }
      if (id === 'tab_collections') { store.setView('library'); store.setActiveLibTab('collections') }
      if (id === 'import')          { store.setView('library'); store.setActiveLibTab('library') }
      if (id === 'new_notebook')    { store.setView('library'); store.setActiveLibTab('notebooks') }
      if (id === 'new_sketchbook')  { store.setView('library'); store.setActiveLibTab('collections') }
    })
    const unlistenFiles = onOpenUrl(async (urls) => {
      const store = useAppStore.getState()
      for (const url of urls) {
        const path = decodeURIComponent(url.replace('file://', ''))
        const filename = path.split('/').pop()
        const ext = filename.split('.').pop().toLowerCase()
        try {
          const contents = await readFile(path)
          const file = new File([contents], filename)
          if (['epub', 'txt', 'md', 'pdf'].includes(ext)) {
            store.setView('library'); store.setActiveLibTab('library')
            window.dispatchEvent(new CustomEvent('open-file', { detail: { file } }))
          } else if (['mp3', 'm4b'].includes(ext)) {
            store.setView('library'); store.setActiveLibTab('audiobooks')
            window.dispatchEvent(new CustomEvent('open-file', { detail: { file } }))
          }
        } catch (err) { console.error('Failed to read file:', path, err) }
      }
    })
    return () => { unlisten.then(fn => fn()); unlistenFiles.then(fn => fn()); window.removeEventListener('resize', onResize) }
  }, [init])

  if (showLoading) {
    return <GnosLoadingScreen onDone={handleLoadingDone} />
  }

  if (!onboardingComplete) {
    return <OnboardingView onComplete={() => setOnboardingComplete(true)} />
  }

  return (
    <div id="app">
      <style>{TAB_CSS}</style>

      {/* ── Title bar ──────────────────────────────────────────────────────── */}
      <div className={`gnos-titlebar${isFullscreen ? ' is-fullscreen' : ''}`}>
        {/* Left drag area covers the traffic-light / padding gap */}
        <div ref={leftDragRef} style={{ position: 'absolute', left: 0, top: 0, width: 88, height: '100%', cursor: 'default' }} />

        {/* Back / Forward navigation arrows — per-tab history */}
        {(() => {
          const hist = tabHistories[activeTabId] || { back: [], forward: [] }
          const canBack = hist.back.length > 0
          const canFwd  = hist.forward.length > 0
          return (
            <div style={{ display: 'flex', alignSelf: 'center', gap: 1, marginRight: 3, flexShrink: 0 }}>
              <button
                className="gnos-tab-nav-btn"
                title="Go back"
                disabled={!canBack}
                onMouseDown={e => e.stopPropagation()}
                onClick={() => goBack()}
              >‹</button>
              <button
                className="gnos-tab-nav-btn"
                title="Go forward"
                disabled={!canFwd}
                onMouseDown={e => e.stopPropagation()}
                onClick={() => goForward()}
              >›</button>
            </div>
          )
        })()}

        {tabs.map((tab, tabIdx) => {
          const isActive = tab.id === activeTabId
          const label = getTabLabel(tab, { notebooks })
          return (
            <div
              key={tab.id}
              className={`gnos-tab${isActive ? ' active' : ''}${hasMultipleTabs ? ' has-close' : ''}${dragTabId && dropTabIdx === tabIdx && dragTabId !== tab.id ? ' drag-over' : ''}`}
              onMouseDown={hasMultipleTabs ? e => {
                if (e.button !== 0) return
                tabPointerRef.current = { tabId: tab.id, tabIdx, startX: e.clientX, dragging: false }
              } : undefined}
              style={{ opacity: dragTabId === tab.id ? 0.4 : 1 }}
            >
              <div className="gnos-tab-body" onClick={() => switchTab(tab.id)}>
                <span className="gnos-tab-label">{label}</span>
                {hasMultipleTabs && (
                  <button
                    className="gnos-tab-x"
                    onMouseDown={e => e.stopPropagation()}
                    onClick={e => { e.stopPropagation(); closeTab(tab.id) }}
                    title="Close tab"
                  >
                    <svg width="8" height="8" viewBox="0 0 9 9" fill="none">
                      <path d="M1 1l7 7M8 1l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    </svg>
                  </button>
                )}
              </div>
            </div>
          )
        })}

        {/* New tab button */}
        <button
          className="gnos-new-tab-btn"
          title="New tab"
          onMouseDown={e => e.stopPropagation()}
          onClick={() => openNewTab({ view: 'library', activeLibTab: 'library' })}
        >
          <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
            <path d="M4.5 1v7M1 4.5h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>

        {/* Draggable empty space — fills gap between tabs and settings button */}
        <div ref={midDragRef} style={{ flex: 1, height: '100%', minWidth: 20 }} />

        {/* Layout settings button — right side on macOS, handled via CSS on Windows */}
        <div className="gnos-titlebar-settings">
          <button
            className="gnos-settings-btn"
            title="Tab layout"
            onClick={() => setTabSettingsOpen(true)}
            style={{ border: '1px solid var(--border)', borderRadius: 5 }}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              {/* Safari-style tab overview icon: overlapping rounded rects */}
              <rect x="5" y="5" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="1.3" fill="none" opacity="0.45"/>
              <rect x="2" y="2" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="1.3" fill="var(--surface)"/>
            </svg>
          </button>
        </div>
      </div>

      {/* ── Content ────────────────────────────────────────────────────────── */}
      <div
        ref={contentRef}
        className={`sidenav-push-wrapper${sideNavOpen ? ' pushed' : ''}${zenMode && zenPeekLeft ? ' zen-force-nav' : ''}`}
        style={{
          paddingTop: TITLEBAR_H, height: '100vh',
          boxSizing: 'border-box', display: 'flex',
          flexDirection: isSplit && splitDir === 'vertical' ? 'column' : 'row',
          overflow: 'hidden', position: 'relative',
        }}
      >
        {isSplit ? (
          <>
            <TabPane
              tabId={splitPanes[0]}
              isActive={splitPanes[0] === activeTabId}
              isSplit={true}
              onFocus={() => switchTab(splitPanes[0])}
            />
            <div className={`gnos-split-divider ${splitDir === 'vertical' ? 'v' : 'h'}`} />
            <TabPane
              tabId={splitPanes[1]}
              isActive={splitPanes[1] === activeTabId}
              isSplit={true}
              onFocus={() => switchTab(splitPanes[1])}
            />
          </>
        ) : (
          <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
            {tabs.map(tab => (
              <TabPane
                key={tab.id}
                tabId={tab.id}
                isActive={tab.id === activeTabId}
                isLastActive={tab.id === prevActiveTabId}
                isSplit={false}
              />
            ))}
          </div>
        )}
      </div>

      {/* Tab layout modal */}
      {tabSettingsOpen && (
        <TabLayoutModal
          onClose={() => setTabSettingsOpen(false)}
          splitDir={splitDir}
          splitPanes={splitPanes}
          setSplitDir={setSplitDir}
          setSplitPanes={setSplitPanes}
          switchTab={switchTab}
        />
      )}

    </div>
  )
}