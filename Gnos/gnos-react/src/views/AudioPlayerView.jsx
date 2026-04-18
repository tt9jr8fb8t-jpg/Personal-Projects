import { useEffect, useRef, useState } from 'react'
import useAppStore from '@/store/useAppStore'
import { useIsActiveTab } from '@/lib/useIsActiveTab'
import { loadAudioChapter, loadSingleAudioData, addReadingMinutes } from '@/lib/storage'
import { generateCoverColor } from '@/lib/utils'
import { GnosNavButton } from '@/components/SideNav'
import { TITLEBAR_H } from '@/App'
import { getGlobalAudio } from '@/lib/globalAudio'

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]

const fmt = (s) => {
  if (!isFinite(s) || s < 0) return '0:00'
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
    : `${m}:${String(sec).padStart(2,'0')}`
}

export default function AudioPlayerView() {
  const book    = useAppStore(s => s.activeAudioBook)
  const isActive = useIsActiveTab()

  const audioRef    = useRef(getGlobalAudio())
  const chapCacheRef = useRef({})

  const [chapIdx,   setChapIdx]   = useState(0)
  const [speed,     setSpeed]     = useState(1)
  const [playing,   setPlaying]   = useState(false)
  const [progress,  setProgress]  = useState(0)   // 0–1
  const [timeCur,   setTimeCur]   = useState('0:00')
  const [timeDur,   setTimeDur]   = useState('0:00')
  const [volume,    setVolume]    = useState(1)
  const [audioError, setAudioError] = useState(null)
  const [showSettings, setShowSettings] = useState(false)
  const [chapOpen, setChapOpen] = useState(true)

  const chapIdxRef = useRef(0)
  const speedRef    = useRef(1)
  chapIdxRef.current = chapIdx
  speedRef.current   = speed

  const chaps = book?.audioChapters
  const isMulti = chaps && chaps.length > 1

  // ── Load chapter ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!book) return
    // Revoke any Blob URLs created for the previous book to free memory
    for (const src of Object.values(chapCacheRef.current)) {
      if (typeof src === 'string' && src.startsWith('blob:')) {
        try { URL.revokeObjectURL(src) } catch { /* ignore */ }
      }
    }
    chapCacheRef.current = {}
    const startIdx = book.currentChapter || 0
    setChapIdx(startIdx)
    setSpeed(1)
    loadAndPlayChapter(startIdx, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book?.id])

  async function loadAndPlayChapter(idx, autoplay = true) {
    const audio = audioRef.current
    const book = useAppStore.getState().activeAudioBook
    if (!audio || !book) return

    audio.pause()
    setPlaying(false)
    setProgress(0)
    setTimeCur('0:00')
    setTimeDur('—')
    setChapIdx(idx)
    chapIdxRef.current = idx

    let src = ''
    const cache = chapCacheRef.current

    if (book.format === 'audiofolder') {
      if (cache[idx]) {
        src = cache[idx]
      } else {
        // Populate from in-memory data first (synchronous)
        if (book.audioChapters?.[idx]?.dataUrl) {
          src = book.audioChapters[idx].dataUrl
          cache[idx] = src
        }
        // Try to upgrade to the persisted version (binary file or legacy data URL)
        try {
          const stored = await loadAudioChapter(book, idx)
          if (stored) {
            const raw = stored.value ?? stored
            let storedSrc = ''
            if (raw instanceof Blob) {
              storedSrc = URL.createObjectURL(raw)
            } else if (typeof raw === 'string') {
              // Could be a bare data URL or JSON-encoded string
              if (raw.startsWith('data:')) {
                storedSrc = raw
              } else {
                try { const p = JSON.parse(raw); storedSrc = typeof p === 'string' ? p : '' } catch { storedSrc = raw }
              }
            }
            if (storedSrc) { src = storedSrc; cache[idx] = src }
          }
        } catch { /* fall through */ }
      }
    } else {
      // Single audio file
      if (cache[0]) {
        src = cache[0]
      } else {
        // Populate synchronously from book object first
        if (book.audioDataUrl) {
          src = book.audioDataUrl
          cache[0] = src
        }
        // Try to upgrade from storage (binary file or legacy data URL)
        try {
          const stored = await loadSingleAudioData(book)
          if (stored) {
            const raw = stored.value ?? stored
            let storedSrc = ''
            if (raw instanceof Blob) {
              storedSrc = URL.createObjectURL(raw)
            } else if (typeof raw === 'string') {
              if (raw.startsWith('data:')) {
                storedSrc = raw
              } else {
                try { const p = JSON.parse(raw); storedSrc = typeof p === 'string' ? p : '' } catch { storedSrc = raw }
              }
            }
            if (storedSrc) { src = storedSrc; cache[0] = src }
          }
        } catch { /* fall through */ }
        if (!src) src = book.audioDataUrl || ''
        if (src) cache[0] = src
      }
    }

    if (!src) {
      console.warn('[AudioPlayer] No audio source found for book', book.id)
      setAudioError('Audio file not found in storage. This can happen when the app is used offline or the audio data exceeded storage limits. Please re-import the audio file.')
      return
    }
    setAudioError(null)

    audio.src = src
    audio.playbackRate = speedRef.current

    // Preload next chapter quietly
    if (book.format === 'audiofolder' && book.audioChapters && idx + 1 < book.audioChapters.length) {
      setTimeout(async () => {
        if (!cache[idx + 1]) {
          try {
            const s = await loadAudioChapter(book, idx + 1)
            if (s) {
              const val = s.value ?? s
              cache[idx + 1] = val instanceof Blob ? URL.createObjectURL(val) : val
            }
          } catch { /* ignore */ }
        }
      }, 5000)
    }

    if (autoplay) {
      audio.play().catch(err => console.warn('[AudioPlayer] play() failed:', err))
    }

    useAppStore.getState().updateBookProgress(book.id, idx, 0)
    useAppStore.getState().setMiniAudioBook(book)
    useAppStore.getState().setMiniAudioTitle(book.title || '')
  }

  // ── Audio event handlers ───────────────────────────────────────────────────
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const onTimeUpdate = () => {
      if (!audio.duration || !isFinite(audio.duration)) return
      setProgress(audio.currentTime / audio.duration)
      setTimeCur(fmt(audio.currentTime))
      // Save overall listen progress across all chapters
      const b = useAppStore.getState().activeAudioBook
      if (b?.audioChapters?.length > 1) {
        const totalChaps = b.audioChapters.length
        const chapProgress = (chapIdxRef.current + audio.currentTime / audio.duration) / totalChaps
        useAppStore.getState().updateBook(b.id, { listenProgress: chapProgress })
      } else if (b) {
        useAppStore.getState().updateBook(b.id, { listenProgress: audio.currentTime / audio.duration })
      }
    }
    const onLoaded = () => setTimeDur(fmt(audio.duration))
    const onPlay   = () => { setPlaying(true);  useAppStore.getState().setMiniAudioPlaying(true) }
    const onPause  = () => { setPlaying(false); useAppStore.getState().setMiniAudioPlaying(false) }
    const onEnded  = () => {
      setPlaying(false)
      const b = useAppStore.getState().activeAudioBook
      if (b?.audioChapters && chapIdxRef.current < b.audioChapters.length - 1)
        loadAndPlayChapter(chapIdxRef.current + 1, true)
    }

    audio.addEventListener('timeupdate',    onTimeUpdate)
    audio.addEventListener('loadedmetadata',onLoaded)
    audio.addEventListener('play',          onPlay)
    audio.addEventListener('pause',         onPause)
    audio.addEventListener('ended',         onEnded)
    return () => {
      audio.removeEventListener('timeupdate',    onTimeUpdate)
      audio.removeEventListener('loadedmetadata',onLoaded)
      audio.removeEventListener('play',          onPlay)
      audio.removeEventListener('pause',         onPause)
      audio.removeEventListener('ended',         onEnded)
    }
  }, [])

  // ── Controls ───────────────────────────────────────────────────────────────
  function togglePlay() {
    const audio = audioRef.current
    if (!audio) return

    // Pause is always synchronous — do it immediately
    if (!audio.paused) { audio.pause(); return }

    // Detect un-loaded state: blank src resolves to the page URL in browsers
    const srcIsBlank = !audio.src || audio.src === window.location.href ||
      audio.src === window.location.origin + window.location.pathname ||
      audio.src === window.location.origin + '/'

    if (!srcIsBlank) {
      // Src already set — ensure it's loaded, then play
      if (audio.readyState < 2) {
        // Not yet ready — load then play
        audio.load()
        audio.addEventListener('canplay', () => {
          audio.play().catch(() => loadAndPlayChapter(chapIdxRef.current, true))
        }, { once: true })
        return
      }
      audio.play().catch(() => loadAndPlayChapter(chapIdxRef.current, true))
      return
    }

    // Src is blank — resolve synchronously from cache or book object so
    // audio.play() is called within the same user-gesture stack frame.
    const bk    = useAppStore.getState().activeAudioBook
    const cache = chapCacheRef.current
    const idx   = chapIdxRef.current

    // Helper to extract a playable src string from a raw stored value
    const extractSrc = (raw) => {
      if (!raw) return ''
      if (raw instanceof Blob) return URL.createObjectURL(raw)
      if (typeof raw === 'string') {
        if (raw.startsWith('data:') || raw.startsWith('blob:') || raw.startsWith('http')) return raw
        try { const p = JSON.parse(raw); return typeof p === 'string' ? p : '' } catch { return raw }
      }
      return ''
    }

    const syncSrc = bk?.format === 'audiofolder'
      ? (cache[idx] || extractSrc(bk?.audioChapters?.[idx]?.dataUrl) || '')
      : (cache[0]   || extractSrc(bk?.audioDataUrl) || '')

    if (syncSrc) {
      audio.src = syncSrc
      // Populate cache for future calls
      if (bk?.format === 'audiofolder') { if (!cache[idx]) cache[idx] = syncSrc }
      else { if (!cache[0]) cache[0] = syncSrc }
      audio.playbackRate = speedRef.current
      // play() called synchronously — browser gesture context still alive
      audio.play().catch(err => {
        console.warn('[AudioPlayer] sync play failed, retrying via load:', err)
        loadAndPlayChapter(idx, true)
      })
    } else {
      // Nothing in memory — kick off async load
      loadAndPlayChapter(idx, true)
    }
  }

  function skipBy(sec) {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + sec))
  }

  function scrubTo(clientX, rect) {
    const audio = audioRef.current
    if (!audio?.duration) return
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    audio.currentTime = pct * audio.duration
  }

  function onProgressPointerDown(e) {
    const track = e.currentTarget
    track.setPointerCapture(e.pointerId)
    scrubTo(e.clientX, track.getBoundingClientRect())
    const onMove = mv => scrubTo(mv.clientX, track.getBoundingClientRect())
    const onUp   = () => { track.removeEventListener('pointermove', onMove); track.removeEventListener('pointerup', onUp) }
    track.addEventListener('pointermove', onMove)
    track.addEventListener('pointerup', onUp)
  }

  function onVolChange(e) {
    const v = parseFloat(e.target.value)
    setVolume(v)
    if (audioRef.current) audioRef.current.volume = v
  }

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!isActive) return

    const handler = (e) => {
      // Don't steal keys from any text input or contenteditable (e.g. CodeMirror)
      const el = document.activeElement
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (el?.isContentEditable) return
      if (el?.closest('[contenteditable="true"]')) return

      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault()
        togglePlay()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        skipBy(e.shiftKey ? 30 : 10)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        skipBy(e.shiftKey ? -30 : -10)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]) // isActive + togglePlay/skipBy close over refs — intentionally stable

  // ── Listening timer — credits minutes while audio is playing ───────────────
  useEffect(() => {
    if (!playing) return
    const TICK_MS = 60_000
    const interval = setInterval(() => {
      addReadingMinutes(1).catch(() => {})
    }, TICK_MS)
    return () => clearInterval(interval)
  }, [playing])

  // ── Close settings on outside click ───────────────────────────────────────
  useEffect(() => {
    if (!showSettings) return
    const h = (e) => {
      if (!e.target.closest('.ap-settings-area')) setShowSettings(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [showSettings])
  const [c1, c2] = generateCoverColor(book?.title || '')
  const hasCover = !!book?.coverDataUrl

  const chapName = isMulti
    ? (chaps[chapIdx]?.title || `Chapter ${chapIdx + 1}`)
    : ''
  const chapLabel = isMulti
    ? `Chapter ${chapIdx + 1} of ${chaps.length} — ${chapName}`
    : ''

  if (!book) return null

  return (
    <div className="view active" style={{ padding: 0, display: 'flex', flexDirection: 'column' }}>

      {/* ── Top header bar ── */}
      <header style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px',
        height: 48, flexShrink: 0,
        background: 'var(--headerBg, var(--surface))',
        borderBottom: '1px solid var(--border)',
        zIndex: 20,
      }}>
        <GnosNavButton />
        <div style={{ width: 1, height: 18, background: 'var(--border)', flexShrink: 0 }} />

        {/* Centered title */}
        <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', overflow: 'hidden' }}>
          <span style={{
            fontSize: 13, fontWeight: 600, color: 'var(--text)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            maxWidth: '60%',
          }}>
            {book.title || 'Audiobook'}
          </span>
          {book.author && (
            <span style={{ fontSize: 12, color: 'var(--textDim)', marginLeft: 8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '30%' }}>
              — {book.author}
            </span>
          )}
        </div>

        {/* Settings button + dropdown */}
        <div className="ap-settings-area" style={{ position: 'relative', flexShrink: 0 }}>
        <button
          title="Playback settings"
          onClick={() => setShowSettings(s => !s)}
          style={{
            width: 30, height: 30, borderRadius: 7,
            border: showSettings ? '1px solid var(--accent)' : '1px solid var(--border)',
            background: showSettings ? 'rgba(56,139,253,.1)' : 'var(--surface)',
            color: showSettings ? 'var(--accent)' : 'var(--textDim)',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'all 0.12s',
            flexShrink: 0,
          }}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.4"/>
            <path d="M8 1.5v1.2M8 13.3v1.2M1.5 8h1.2M13.3 8h1.2M3.4 3.4l.85.85M11.75 11.75l.85.85M12.6 3.4l-.85.85M4.25 11.75l-.85.85" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
          </svg>
        </button>

        {/* Settings dropdown */}
        {showSettings && (
          <div style={{
            position: 'absolute', top: 38, right: 0,
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 12, padding: 14, minWidth: 220,
            boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
            zIndex: 100,
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--textDim)', opacity: .6, marginBottom: 10 }}>Playback Speed</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
              {SPEEDS.map(s => (
                <button key={s} onClick={() => { speedRef.current = s; setSpeed(s); if (audioRef.current) audioRef.current.playbackRate = s; }}
                  style={{
                    padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 500,
                    border: '1px solid var(--border)',
                    background: speed === s ? 'var(--accent)' : 'var(--surfaceAlt)',
                    color: speed === s ? '#fff' : 'var(--text)',
                    cursor: 'pointer', transition: 'all .1s',
                  }}>
                  {s}×
                </button>
              ))}
            </div>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--textDim)', opacity: .6, marginBottom: 8 }}>Volume</div>
            <input type="range" min="0" max="1" step="0.02"
              value={volume} onChange={onVolChange}
              style={{ width: '100%', accentColor: 'var(--accent)', marginBottom: 14 }} />

            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--textDim)', opacity: .6, marginBottom: 8 }}>Sleep Timer</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
              {[15, 30, 45, 60, 90].map(m => (
                <button key={m} onClick={() => {
                  if (window._gnosSleepTimer) clearTimeout(window._gnosSleepTimer)
                  window._gnosSleepTimer = setTimeout(() => { if (audioRef.current) audioRef.current.pause() }, m * 60000)
                  setShowSettings(false)
                }} style={{
                  padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 500,
                  border: '1px solid var(--border)', background: 'var(--surfaceAlt)',
                  color: 'var(--text)', cursor: 'pointer', transition: 'all .1s',
                }}>
                  {m}m
                </button>
              ))}
              <button onClick={() => { if (window._gnosSleepTimer) { clearTimeout(window._gnosSleepTimer); window._gnosSleepTimer = null } }} style={{
                padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 500,
                border: '1px solid var(--border)', background: 'var(--surfaceAlt)',
                color: 'var(--textDim)', cursor: 'pointer',
              }}>Off</button>
            </div>
          </div>
        )}
        </div>
      </header>

      <div className="ap-layout" style={{ flex: 1, overflow: 'hidden' }}>

        {/* ── Floating open-chapters button (only when closed) ── */}
        {!chapOpen && (
          <button
            onClick={() => setChapOpen(true)}
            title="Open chapters"
            style={{
              position: 'fixed', left: 12, top: TITLEBAR_H + 58,
              zIndex: 1200, padding: '7px 12px 7px 10px', borderRadius: 9,
              border: '1px solid var(--border)', background: 'var(--surface)',
              color: 'var(--textDim)', cursor: 'pointer', fontFamily: 'inherit',
              fontSize: 12, fontWeight: 600,
              boxShadow: '0 2px 12px rgba(0,0,0,0.3)',
              display: 'flex', alignItems: 'center', gap: 7,
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--surfaceAlt)'; e.currentTarget.style.color = 'var(--text)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--surface)'; e.currentTarget.style.color = 'var(--textDim)' }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <line x1="3" y1="4" x2="13" y2="4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              <line x1="3" y1="8" x2="13" y2="8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              <line x1="3" y1="12" x2="10" y2="12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
            <span style={{ letterSpacing: '0.01em' }}>Chapters</span>
          </button>
        )}
        {/* ── Chapters sidebar — close button lives inside the header ── */}
        {chapOpen && (
          <aside style={{
            position: 'fixed', left: 0, top: TITLEBAR_H + 48, bottom: 0, width: 270, zIndex: 1100,
            background: 'var(--surface)', borderRight: '1px solid var(--border)',
            boxShadow: '6px 0 24px rgba(0,0,0,0.35)', display: 'flex', flexDirection: 'column',
            animation: 'ap-slide-in 0.2s ease',
          }}>
            {/* Integrated header row */}
            <div style={{
              padding: '12px 10px 8px 14px',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              borderBottom: '1px solid var(--borderSubtle)', flexShrink: 0,
            }}>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--textDim)' }}>
                Chapters
              </span>
              <button
                onClick={() => setChapOpen(false)}
                title="Close chapters"
                style={{
                  width: 26, height: 26, borderRadius: 6, border: '1px solid var(--border)',
                  background: 'transparent', color: 'var(--textDim)', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.12s',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--surfaceAlt)'; e.currentTarget.style.color = 'var(--text)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--textDim)' }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </button>
            </div>
            <div className="ap-chapter-list" style={{ flex: 1, overflow: 'auto', padding: '0 6px 12px' }}>
              {isMulti ? chaps.map((c, i) => (
                <button key={i} className={`ap-chap-item${i === chapIdx ? ' active' : ''}`}
                  onClick={() => loadAndPlayChapter(i, true)}>
                  <span className="ap-chap-num">{i + 1}</span>
                  <span className="ap-chap-name">{c.title || `Chapter ${i + 1}`}</span>
                  {i === chapIdx && (
                    <span className="ap-chap-playing">
                      <span className="ap-chap-bar" />
                      <span className="ap-chap-bar" />
                      <span className="ap-chap-bar" />
                    </span>
                  )}
                </button>
              )) : (
                <button className="ap-chap-item active">
                  <span className="ap-chap-num">1</span>
                  <span className="ap-chap-name">{book.title || 'Track'}</span>
                  <span className="ap-chap-playing">
                    <span className="ap-chap-bar" />
                    <span className="ap-chap-bar" />
                    <span className="ap-chap-bar" />
                  </span>
                </button>
              )}
            </div>
          </aside>
        )}

        {/* ── Main ── */}
        <main className="ap-main">

          {/* Audio error banner */}
          {audioError && (
            <div style={{
              background: 'rgba(248,81,73,0.12)', border: '1px solid rgba(248,81,73,0.35)',
              borderRadius: 10, padding: '12px 16px', margin: '0 0 16px',
              display: 'flex', alignItems: 'flex-start', gap: 10,
            }}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, marginTop: 1 }}>
                <circle cx="8" cy="8" r="7" stroke="#f85149" strokeWidth="1.4"/>
                <path d="M8 4.5v4M8 10.5v1" stroke="#f85149" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
              <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.5 }}>
                <strong style={{ display: 'block', marginBottom: 2 }}>Audio not available</strong>
                <span style={{ color: 'var(--textDim)' }}>
                  The audio file could not be loaded from storage. Audio files are too large for local storage —
                  they are only available while the app is open in the same session they were imported.
                  Please re-import the file to listen again.
                </span>
              </div>
            </div>
          )}

          {/* Cover */}
          <div className="ap-cover-wrap">
            <div className={`ap-cover${playing ? ' playing' : ''}`}>
              {hasCover
                ? <img src={book.coverDataUrl} alt="" style={{ width:'100%',height:'100%',objectFit:'cover',borderRadius:14 }} />
                : <div className="ap-cover-placeholder"
                    style={{ width:'100%',height:'100%',background:`linear-gradient(135deg,${c1},${c2})`,borderRadius:14,display:'flex',alignItems:'center',justifyContent:'center' }}>
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
                      <path d="M9 18c0 1.66-1.34 3-3 3H4c-1.66 0-3-1.34-3-3v-1c0-1.66 1.34-3 3-3h2c1.66 0 3 1.34 3 3v1zM22 15c0 1.66-1.34 3-3 3h-2c-1.66 0-3-1.34-3-3v-1c0-1.66 1.34-3 3-3h2c1.66 0 3 1.34 3 3v1z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                      <path d="M9 19V8l13-3v10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </div>
              }
            </div>
          </div>

          {/* Track info */}
          <div className="ap-track-info">
            <div className="ap-track-title">{book.title || 'Audiobook'}</div>
            <div className="ap-track-author">{book.author || ''}</div>
            {chapLabel && <div className="ap-track-chapter">{chapLabel}</div>}
          </div>

          {/* Progress bar */}
          <div className="ap-progress-wrap">
            <span className="ap-time">{timeCur}</span>
            <div
              className="ap-progress-bar-track"
              onPointerDown={onProgressPointerDown}
              style={{ position: 'relative', cursor: 'pointer', userSelect: 'none' }}
            >
              <div className="ap-progress-fill" style={{ width: `${progress * 100}%` }} />
              <div className="ap-progress-thumb" style={{
                position: 'absolute',
                left: `${progress * 100}%`,
                top: '50%',
                transform: 'translate(-50%, -50%)',
                pointerEvents: 'none',
              }} />
            </div>
            <span className="ap-time">{timeDur}</span>
          </div>

          {/* Controls */}
          <div className="ap-controls">
            <button className="ap-ctrl-btn ap-skip" onClick={() => skipBy(-30)} title="Back 30s">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <path d="M12 5V2L7 7l5 5V8a7 7 0 1 1-5.3 11.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                <text x="6" y="16" fontSize="6" fill="currentColor" fontFamily="sans-serif" textAnchor="middle">30</text>
              </svg>
            </button>
            <button className="ap-ctrl-btn ap-prev" onClick={() => chapIdx > 0 && loadAndPlayChapter(chapIdx - 1, true)} title="Previous chapter">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <polygon points="19,5 9,12 19,19" fill="currentColor"/>
                <rect x="5" y="5" width="3" height="14" rx="1" fill="currentColor"/>
              </svg>
            </button>
            <button onClick={togglePlay}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 54, height: 54, borderRadius: 13,
                background: 'var(--surface)',
                color: 'var(--accent)',
                border: '1.5px solid var(--border)',
                outline: '3px solid var(--accent)',
                outlineOffset: '2px',
                cursor: 'pointer', flexShrink: 0,
                boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
                transition: 'transform 0.12s ease, box-shadow 0.12s ease, background 0.12s ease',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--surfaceAlt)' }}
              onMouseDown={e => { e.currentTarget.style.transform='scale(0.93)'; e.currentTarget.style.boxShadow='0 1px 4px rgba(0,0,0,0.15)' }}
              onMouseUp={e => { e.currentTarget.style.transform='scale(1)'; e.currentTarget.style.boxShadow='0 2px 8px rgba(0,0,0,0.2)' }}
              onMouseLeave={e => { e.currentTarget.style.transform='scale(1)'; e.currentTarget.style.boxShadow='0 2px 8px rgba(0,0,0,0.2)'; e.currentTarget.style.background='var(--surface)' }}
            >
              {playing
                ? <svg width="22" height="22" viewBox="0 0 24 24" fill="none" style={{ display:'block' }}>
                    <rect x="6" y="5" width="4" height="14" rx="1.5" fill="currentColor"/>
                    <rect x="14" y="5" width="4" height="14" rx="1.5" fill="currentColor"/>
                  </svg>
                : <svg width="22" height="22" viewBox="0 0 24 24" fill="none" style={{ display:'block', marginLeft: 2 }}>
                    <polygon points="6,4 20,12 6,20" fill="currentColor"/>
                  </svg>
              }
            </button>
            <button className="ap-ctrl-btn ap-next"
              onClick={() => isMulti && chapIdx < chaps.length - 1 && loadAndPlayChapter(chapIdx + 1, true)}
              title="Next chapter">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <polygon points="5,5 15,12 5,19" fill="currentColor"/>
                <rect x="16" y="5" width="3" height="14" rx="1" fill="currentColor"/>
              </svg>
            </button>
            <button className="ap-ctrl-btn ap-skip" onClick={() => skipBy(30)} title="Forward 30s">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <path d="M12 5V2l5 5-5 5V8a7 7 0 1 0 5.3 11.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                <text x="18" y="16" fontSize="6" fill="currentColor" fontFamily="sans-serif" textAnchor="middle">30</text>
              </svg>
            </button>
          </div>

        </main>
        {/* Audio element is a global detached node managed by globalAudio.js */}
      </div>
    </div>
  )
}