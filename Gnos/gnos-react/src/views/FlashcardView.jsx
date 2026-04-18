/* FlashcardView.jsx — Anki/Quizlet-style spaced repetition flashcard view
 *
 * Two modes: Study and Edit
 * - Study: shows cards one at a time with flip animation, rate with SM-2
 * - Edit: list all cards, add/delete/edit inline
 */

import { useState, useEffect, useRef, useCallback, useContext } from 'react'
import useAppStore from '@/store/useAppStore'
import { GnosNavButton } from '@/components/SideNav'
import { PaneContext } from '@/lib/PaneContext'
import { saveNotebookImage } from '@/lib/storage'
import JSZip from 'jszip'
import initSqlJs from 'sql.js/dist/sql-asm.js'

// ─── SM-2 Algorithm ──────────────────────────────────────────────────────────
function sm2(card, quality) {
  const q = [0, 0, 2, 3, 5][quality] ?? 3
  let { interval = 1, ease = 2.5, repetitions = 0 } = card
  if (q < 3) {
    repetitions = 0; interval = 1
  } else {
    repetitions++
    if (repetitions === 1) interval = 1
    else if (repetitions === 2) interval = 6
    else interval = Math.round(interval * ease)
  }
  ease = Math.max(1.3, ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)))
  const nextReview = Date.now() + interval * 24 * 60 * 60 * 1000
  return { ...card, interval, ease, repetitions, nextReview }
}

// ─── Tiny id helper ──────────────────────────────────────────────────────────
function makeId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

// ─── CSS ─────────────────────────────────────────────────────────────────────
const FLASHCARD_CSS = `
  .fc-container {
    display: flex; flex-direction: column; height: 100%;
    background: var(--bg); color: var(--text); overflow: hidden;
  }
  .fc-header {
    display: flex; align-items: center; gap: 12px;
    padding: 12px 18px; border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .fc-header-title {
    font-size: 16px; font-weight: 700; flex: 1;
    background: none; border: none; color: var(--text);
    font-family: inherit; outline: none; padding: 2px 6px;
    border-radius: 6px;
  }
  .fc-header-title:focus {
    background: var(--surfaceAlt); box-shadow: 0 0 0 2px var(--accent);
  }
  .fc-mode-btn {
    padding: 5px 14px; border-radius: 6px; border: 1px solid var(--border);
    background: none; color: var(--textDim); cursor: pointer;
    font-size: 12px; font-weight: 600; font-family: inherit;
    transition: all 0.12s;
  }
  .fc-mode-btn.active {
    background: var(--accent); color: #fff; border-color: var(--accent);
  }
  .fc-mode-btn:hover:not(.active) {
    background: var(--surfaceAlt); color: var(--text);
  }
  .fc-stats {
    font-size: 11px; color: var(--textDim); display: flex; gap: 12px;
  }
  .fc-stats span { font-weight: 600; }

  /* Study mode */
  .fc-study {
    flex: 1; display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    padding: 32px; gap: 24px; overflow-y: auto;
  }
  .fc-card-wrapper {
    perspective: 1000px; width: 100%; max-width: 500px;
    aspect-ratio: 5/3; cursor: pointer;
  }
  .fc-card-inner {
    position: relative; width: 100%; height: 100%;
    transition: transform 0.5s cubic-bezier(0.4, 0, 0.2, 1);
    transform-style: preserve-3d;
  }
  .fc-card-inner.flipped { transform: rotateY(180deg); }
  .fc-card-face {
    position: absolute; inset: 0;
    backface-visibility: hidden; -webkit-backface-visibility: hidden;
    display: flex; align-items: center; justify-content: center;
    padding: 24px; border-radius: 16px;
    font-size: 18px; font-weight: 500; text-align: center;
    line-height: 1.5; word-break: break-word;
    font-family: Georgia, serif;
    box-shadow: 0 4px 20px rgba(0,0,0,0.15);
    border: 1px solid var(--border);
  }
  .fc-card-front {
    background: var(--surface);
    color: var(--text);
  }
  .fc-card-back {
    background: var(--surfaceAlt);
    color: var(--text);
    transform: rotateY(180deg);
  }
  .fc-card-label {
    position: absolute; top: 10px; left: 14px;
    font-size: 10px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.08em; color: var(--textDim); opacity: 0.6;
  }
  .fc-card-html {
    max-width: 100%; overflow-wrap: break-word; text-align: center;
    line-height: 1.5;
  }
  .fc-card-html img {
    max-width: 100%; max-height: 120px; object-fit: contain;
    border-radius: 6px; display: block; margin: 8px auto 0;
  }
  .fc-rating-bar {
    display: flex; gap: 10px;
  }
  .fc-rate-btn {
    padding: 8px 20px; border-radius: 8px; border: 1px solid var(--border);
    background: var(--surface); color: var(--text); cursor: pointer;
    font-size: 13px; font-weight: 600; font-family: inherit;
    transition: all 0.12s; min-width: 70px;
  }
  .fc-rate-btn:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
  .fc-rate-btn.again { border-color: #ef5350; color: #ef5350; }
  .fc-rate-btn.again:hover { background: rgba(239,83,80,0.1); }
  .fc-rate-btn.hard { border-color: #ff9800; color: #ff9800; }
  .fc-rate-btn.hard:hover { background: rgba(255,152,0,0.1); }
  .fc-rate-btn.good { border-color: #4caf50; color: #4caf50; }
  .fc-rate-btn.good:hover { background: rgba(76,175,80,0.1); }
  .fc-rate-btn.easy { border-color: #2196f3; color: #2196f3; }
  .fc-rate-btn.easy:hover { background: rgba(33,150,243,0.1); }
  .fc-hint-text {
    font-size: 12px; color: var(--textDim); opacity: 0.7;
  }
  .fc-done-msg {
    text-align: center; color: var(--textDim);
  }
  .fc-done-msg h3 { font-size: 20px; margin: 0 0 8px; color: var(--text); }
  .fc-done-msg p { font-size: 13px; }

  /* Edit mode */
  .fc-edit {
    flex: 1; overflow-y: auto; padding: 18px;
  }
  .fc-card-row {
    display: flex; gap: 10px; align-items: flex-start;
    padding: 10px 12px; border-radius: 10px;
    border: 1px solid var(--borderSubtle);
    margin-bottom: 8px; background: var(--surface);
    transition: border-color 0.12s;
  }
  .fc-card-row:hover { border-color: var(--border); }
  .fc-card-row .fc-num {
    font-size: 11px; color: var(--textDim); min-width: 22px;
    text-align: right; padding-top: 6px; flex-shrink: 0;
  }
  .fc-card-row .fc-fields { flex: 1; display: flex; flex-direction: column; gap: 4px; }
  .fc-card-input {
    width: 100%; padding: 5px 8px; border-radius: 6px;
    border: 1px solid var(--borderSubtle); background: var(--bg);
    color: var(--text); font-size: 13px; font-family: inherit;
    outline: none; resize: none;
  }
  .fc-card-input:focus { border-color: var(--accent); }
  .fc-card-input::placeholder { color: var(--textDim); opacity: 0.5; }
  .fc-del-btn {
    background: none; border: none; color: var(--textDim); cursor: pointer;
    padding: 4px; border-radius: 4px; opacity: 0; transition: opacity 0.12s;
    flex-shrink: 0; margin-top: 4px;
  }
  .fc-card-row:hover .fc-del-btn { opacity: 0.5; }
  .fc-del-btn:hover { opacity: 1 !important; color: #ef5350; }
  .fc-add-btn {
    width: 100%; padding: 10px; border: 1px dashed var(--border);
    border-radius: 10px; background: none; color: var(--textDim);
    cursor: pointer; font-size: 13px; font-family: inherit;
    transition: all 0.12s; margin-top: 4px;
  }
  .fc-add-btn:hover { border-color: var(--accent); color: var(--accent); }

  /* Card color stripe */
  .fc-card-row[data-color] { border-left: 3px solid; }
  .fc-card-tools {
    display: flex; gap: 4px; margin-top: 4px; flex-wrap: wrap;
  }
  .fc-tool-btn {
    padding: 3px 8px; border-radius: 5px; border: 1px solid var(--borderSubtle);
    background: none; color: var(--textDim); cursor: pointer; font-size: 10px;
    font-family: inherit; transition: all 0.1s; display: flex; align-items: center; gap: 4px;
  }
  .fc-tool-btn:hover { background: var(--surfaceAlt); color: var(--text); border-color: var(--border); }
  .fc-color-dot {
    width: 14px; height: 14px; border-radius: 50%; cursor: pointer;
    border: 2px solid transparent; transition: border-color 0.1s;
  }
  .fc-color-dot:hover, .fc-color-dot.active { border-color: var(--text); }
  .fc-canvas-wrap {
    margin-top: 6px; border: 1px solid var(--border); border-radius: 8px;
    overflow: hidden; background: var(--bg);
  }
  .fc-canvas-wrap canvas { display: block; cursor: crosshair; }
  .fc-img-preview {
    max-width: 100%; max-height: 80px; border-radius: 6px; margin-top: 4px;
    object-fit: contain;
  }
  .fc-audio-row {
    display: flex; align-items: center; gap: 8px; margin-top: 4px;
  }
  .fc-audio-play {
    width: 32px; height: 32px; border-radius: 50%; border: 1px solid var(--border);
    background: var(--surface); color: var(--text); cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: all 0.12s; flex-shrink: 0;
  }
  .fc-audio-play:hover { background: var(--surfaceAlt); border-color: var(--accent); }
  .fc-audio-label { font-size: 10px; color: var(--textDim); }
  .fc-audio-remove {
    background: none; border: none; color: var(--textDim); cursor: pointer;
    font-size: 11px; opacity: 0.5; padding: 2px 4px;
  }
  .fc-audio-remove:hover { opacity: 1; color: #ef5350; }

  /* List mode */
  .fc-list {
    flex: 1; overflow-y: auto; padding: 20px 22px;
  }
  .fc-list-row {
    display: flex; align-items: flex-start; gap: 12px;
    padding: 14px 16px; border-radius: 12px;
    border: 1px solid var(--borderSubtle);
    margin-bottom: 8px; background: var(--surface);
    transition: border-color 0.12s, box-shadow 0.12s;
  }
  .fc-list-row:hover { border-color: var(--border); box-shadow: 0 2px 10px rgba(0,0,0,0.18); }
  .fc-list-status {
    flex-shrink: 0; padding-top: 3px;
    display: flex; flex-direction: column; align-items: center; gap: 4px; min-width: 62px;
  }
  .fc-list-badge {
    font-size: 10px; font-weight: 700; padding: 3px 8px; border-radius: 5px;
    text-transform: uppercase; letter-spacing: 0.05em;
  }
  .fc-list-badge.new { background: rgba(33,150,243,0.15); color: #2196f3; }
  .fc-list-badge.due { background: rgba(255,152,0,0.18); color: #ff9800; }
  .fc-list-badge.learned { background: rgba(76,175,80,0.15); color: #4caf50; }
  .fc-list-due-date {
    font-size: 10px; color: var(--textDim); text-align: center; line-height: 1.3;
  }
  .fc-list-fields { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
  .fc-list-field {
    width: 100%; padding: 7px 10px; border-radius: 7px;
    border: 1px solid transparent; background: transparent;
    color: var(--text); font-size: 14px; font-family: inherit;
    outline: none; resize: none; line-height: 1.5;
    overflow: hidden; box-sizing: border-box;
    transition: background 0.1s, border-color 0.1s;
  }
  .fc-list-field:focus { background: var(--bg); border-color: var(--accent); }
  .fc-list-field::placeholder { color: var(--textDim); opacity: 0.5; }
  .fc-list-field-label {
    font-size: 10px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.06em; color: var(--textDim); padding: 0 10px 1px;
  }
  .fc-list-img { max-height: 64px; border-radius: 7px; object-fit: contain; margin: 4px 10px 6px; }
  .fc-list-del {
    background: none; border: none; color: var(--textDim); cursor: pointer;
    padding: 5px 6px; border-radius: 5px; opacity: 0; transition: opacity 0.12s;
    flex-shrink: 0; font-size: 16px; line-height: 1;
  }
  .fc-list-row:hover .fc-list-del { opacity: 0.4; }
  .fc-list-del:hover { opacity: 1 !important; color: #ef5350; }
  .fc-list-section {
    font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.08em; color: var(--textDim);
    padding: 16px 4px 8px; display: flex; align-items: center; gap: 8px;
  }
  .fc-list-section::after { content: ''; flex: 1; height: 1px; background: var(--borderSubtle); }
`

const CARD_COLORS = ['transparent', '#ef5350', '#ff9800', '#4caf50', '#2196f3', '#9c27b0', '#00bcd4', '#795548']

function ImageUploadBtn({ label, onUpload, style }) {
  return (
    <button className="fc-tool-btn" onClick={() => {
      const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*'
      input.onchange = (e) => { const f = e.target.files?.[0]; if (!f) return; const r = new FileReader(); r.onload = () => onUpload(r.result); r.readAsDataURL(f) }
      input.click()
    }} style={{ fontSize: 10, ...style }}>+ {label || 'Image'}</button>
  )
}

function AudioUploadBtn({ label, onUpload, style }) {
  return (
    <button className="fc-tool-btn" onClick={() => {
      const input = document.createElement('input'); input.type = 'file'; input.accept = 'audio/*,.mp3,.wav,.ogg,.m4a,.aac'
      input.onchange = (e) => { const f = e.target.files?.[0]; if (!f) return; const r = new FileReader(); r.onload = () => onUpload(r.result); r.readAsDataURL(f) }
      input.click()
    }} style={{ fontSize: 10, ...style }}>+ {label || 'Audio'}</button>
  )
}

function AudioPlayBtn({ src }) {
  const audioRef = useRef(null)
  const [playing, setPlaying] = useState(false)
  const play = (e) => {
    e.stopPropagation()
    if (!audioRef.current) {
      audioRef.current = new Audio(src)
      audioRef.current.onended = () => setPlaying(false)
    }
    if (playing) { audioRef.current.pause(); audioRef.current.currentTime = 0; setPlaying(false) }
    else { audioRef.current.play(); setPlaying(true) }
  }
  useEffect(() => () => { if (audioRef.current) { audioRef.current.pause(); audioRef.current = null } }, [])
  return (
    <button className="fc-audio-play" onClick={play} title="Play audio">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        {playing ? <><line x1="6" y1="4" x2="6" y2="20"/><line x1="18" y1="4" x2="18" y2="20"/></> : <polygon points="5,3 19,12 5,21" fill="currentColor" stroke="none"/>}
      </svg>
    </button>
  )
}

/** Strip HTML tags and decode entities, extract [sound:xxx] references */
function stripHtml(html) {
  if (!html) return { text: '', sounds: [] }
  const sounds = []
  let cleaned = html.replace(/\[sound:([^\]]+)\]/g, (_, name) => { sounds.push(name); return '' })
  cleaned = cleaned.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
  const el = document.createElement('div'); el.innerHTML = cleaned
  return { text: el.textContent?.trim() || '', sounds }
}

/** Inline media data URLs into HTML and strip [sound:] refs */
function processCardHtml(html, mediaData) {
  if (!html) return ''
  let out = html.replace(/\[sound:[^\]]+\]/g, '')
  out = out.replace(/<img([^>]*?)src=["']([^"']+)["']([^>]*?)>/g, (match, pre, src, post) => {
    const bare = src.replace(/^.*[/\\]/, '')
    const m = mediaData[src] || mediaData[bare]
    return m?.isImage ? `<img${pre}src="${m.url}"${post}>` : match
  })
  return out
}

/** Parse .apkg file (ZIP containing SQLite) and return { cards, media } */
async function parseApkg(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer)

  // Find the SQLite database file
  let dbFile = zip.file('collection.anki21') || zip.file('collection.anki2')
  if (!dbFile) {
    // Try to find any .anki2/.anki21 file
    const files = Object.keys(zip.files)
    const dbName = files.find(f => f.endsWith('.anki2') || f.endsWith('.anki21'))
    if (dbName) dbFile = zip.file(dbName)
  }
  if (!dbFile) throw new Error('No Anki database found in .apkg file')

  const dbData = await dbFile.async('uint8array')
  const SQL = await initSqlJs()
  const db = new SQL.Database(dbData)

  // Parse media mapping (JSON file mapping numeric keys to filenames)
  let mediaMap = {}
  const mediaFile = zip.file('media')
  if (mediaFile) {
    try {
      const mediaJson = await mediaFile.async('text')
      mediaMap = JSON.parse(mediaJson)
    } catch { /* no media mapping */ }
  }

  // Extract media files as data URLs
  const mediaData = {}
  for (const [key, filename] of Object.entries(mediaMap)) {
    const mf = zip.file(key)
    if (mf) {
      const data = await mf.async('uint8array')
      const ext = filename.split('.').pop()?.toLowerCase() || ''
      const isAudio = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'wma'].includes(ext)
      const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'].includes(ext)
      const mime = isAudio ? `audio/${ext === 'mp3' ? 'mpeg' : ext}` : isImage ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : `application/octet-stream`
      const b64 = btoa(Array.from(data, b => String.fromCharCode(b)).join(''))
      mediaData[filename] = { url: `data:${mime};base64,${b64}`, isAudio, isImage }
    }
  }

  // Query notes table
  let cards = []
  try {
    const results = db.exec('SELECT flds FROM notes')
    if (results.length > 0) {
      for (const row of results[0].values) {
        const fields = (row[0] || '').split('\x1f') // Anki uses unit separator
        const frontHtml = fields[0] || ''
        const backHtml = fields[1] || ''
        const front = stripHtml(frontHtml)
        const back = stripHtml(backHtml)

        const card = {
          id: makeId('fc'),
          front: front.text,
          back: back.text,
          frontHtml: processCardHtml(frontHtml, mediaData),
          backHtml:  processCardHtml(backHtml,  mediaData),
          nextReview: 0, interval: 1, ease: 2.5, repetitions: 0,
        }

        // Attach media from [sound:xxx] references
        for (const s of front.sounds) {
          const m = mediaData[s]
          if (m?.isImage && !card.imageUrl) card.imageUrl = m.url
          if (m?.isAudio && !card.audioUrl) card.audioUrl = m.url
        }
        for (const s of back.sounds) {
          const m = mediaData[s]
          if (m?.isImage && !card.backImageUrl) card.backImageUrl = m.url
          if (m?.isAudio && !card.backAudioUrl) card.backAudioUrl = m.url
        }

        // Helper: look up a media entry by src value, stripping any path prefix
        const lookupMedia = (src) => {
          if (mediaData[src]) return mediaData[src]
          // Strip path prefix (e.g. "collection.media/img.jpg" → "img.jpg")
          const bare = src.replace(/^.*[/\\]/, '')
          return mediaData[bare] ?? null
        }

        // Check for inline images in HTML — front and back separately
        const frontImgMatch = frontHtml.match(/<img[^>]+src=["']([^"']+)["']/g)
        if (frontImgMatch) {
          for (const tag of frontImgMatch) {
            const srcM = tag.match(/src=["']([^"']+)["']/)
            const m = srcM ? lookupMedia(srcM[1]) : null
            if (m?.isImage && !card.imageUrl) card.imageUrl = m.url
          }
        }
        const backImgMatch = backHtml.match(/<img[^>]+src=["']([^"']+)["']/g)
        if (backImgMatch) {
          for (const tag of backImgMatch) {
            const srcM = tag.match(/src=["']([^"']+)["']/)
            const m = srcM ? lookupMedia(srcM[1]) : null
            if (m?.isImage && !card.backImageUrl) card.backImageUrl = m.url
          }
        }
        // Fallback: if no front image but back has one, or vice versa — keep both separated
        // If there's only one image total in the card, put it on the front
        if (!card.imageUrl && card.backImageUrl) {
          card.imageUrl = card.backImageUrl
        }

        cards.push(card)
      }
    }
  } finally {
    db.close()
  }

  return cards
}

export default function FlashcardView() {
  const paneTabId = useContext(PaneContext)
  const deck = useAppStore(s => s.activeFlashcardDeck)
  const flashcardDecks = useAppStore(s => s.flashcardDecks)
  const updateDeck = useAppStore(s => s.updateDeck)
  const persistFlashcardDecks = useAppStore(s => s.persistFlashcardDecks)
  const setView = useAppStore(s => s.setView)
  const activeTabId = useAppStore(s => s.activeTabId)
  const isActivePane = !paneTabId || paneTabId === activeTabId

  const [mode, setMode] = useState(() => {
    const c = (flashcardDecks.find(d => d.id === deck?.id) || deck)?.cards
    return (!c || c.length === 0) ? 'edit' : 'study'
  }) // 'study' | 'edit' | 'list'
  const [flipped, setFlipped] = useState(false)
  const [currentIdx, setCurrentIdx] = useState(0)
  const [title, setTitle] = useState(deck?.title || 'Untitled Deck')
  const [studySide, setStudySide] = useState('front') // 'front' | 'back' — which side shows first
  const titleTimeout = useRef(null)

  // Get the live deck from store (in case cards have been updated)
  const liveDeck = flashcardDecks.find(d => d.id === deck?.id) || deck
  const cards = liveDeck?.cards || []

  // Due cards for study
  const now = Date.now()
  const dueCards = cards.filter(c => !c.nextReview || c.nextReview <= now)

  // Study card
  const studyCard = dueCards[currentIdx] || null

  useEffect(() => {
    setTitle(liveDeck?.title || 'Untitled Deck')
  }, [liveDeck?.title])

  // Keyboard: space/click to flip, 1-4 to rate
  useEffect(() => {
    if (mode !== 'study' || !isActivePane) return
    const handler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      if (e.code === 'Space') {
        e.preventDefault()
        setFlipped(f => !f)
      }
      if (flipped && studyCard) {
        if (e.key === '1') rateCard(1)
        if (e.key === '2') rateCard(2)
        if (e.key === '3') rateCard(3)
        if (e.key === '4') rateCard(4)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, flipped, studyCard, currentIdx, isActivePane])

  function rateCard(quality) {
    if (!studyCard || !liveDeck) return
    const updated = sm2(studyCard, quality)
    const newCards = cards.map(c => c.id === updated.id ? updated : c)

    // Streak tracking
    const today = new Date().toISOString().slice(0, 10)
    const lastDate = liveDeck.lastStudyDate
    let streak = liveDeck.streak || 0
    if (lastDate === today) {
      // already studied today, no change
    } else {
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
      streak = lastDate === yesterday ? streak + 1 : 1
    }

    updateDeck(liveDeck.id, { cards: newCards, updatedAt: new Date().toISOString(), streak, lastStudyDate: today })
    persistFlashcardDecks()
    // Flip to the question side first (hide answer), then advance after animation completes
    setFlipped(false)
    setTimeout(() => {
      const newDue = newCards.filter(c => !c.nextReview || c.nextReview <= now)
      if (currentIdx >= newDue.length) setCurrentIdx(0)
    }, 520) // slightly longer than the 0.5s CSS transition
  }

  function handleTitleChange(val) {
    setTitle(val)
    clearTimeout(titleTimeout.current)
    titleTimeout.current = setTimeout(() => {
      if (liveDeck) {
        updateDeck(liveDeck.id, { title: val, updatedAt: new Date().toISOString() })
        persistFlashcardDecks()
      }
    }, 500)
  }

  // Import — supports CSV/TSV, .apkg (Anki), .colpkg
  async function handleImport() {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const path = await open({ filters: [
      { name: 'Anki Decks', extensions: ['apkg', 'colpkg'] },
      { name: 'CSV/TSV', extensions: ['csv', 'tsv', 'txt'] },
    ]})
    if (!path) return

    const ext = path.split('.').pop()?.toLowerCase()

    if (ext === 'apkg' || ext === 'colpkg') {
      try {
        // Read binary file
        const { readFile } = await import('@tauri-apps/plugin-fs')
        const data = await readFile(path)
        const buf = data instanceof Uint8Array ? data : new Uint8Array(data)
        const newCards = await parseApkg(buf.buffer)
        if (newCards.length) {
          updateDeck(liveDeck.id, { cards: [...cards, ...newCards], updatedAt: new Date().toISOString() })
          persistFlashcardDecks()
        }
      } catch (err) {
        console.error('[Gnos] Anki import error:', err)
        alert(`Failed to import Anki deck: ${err.message}`)
      }
      return
    }

    // CSV/TSV fallback
    const { readTextFile } = await import('@tauri-apps/plugin-fs')
    const text = await readTextFile(path)

    // Detect separator: tab > semicolon > comma
    const sep = text.includes('\t') ? '\t' : text.includes(';') ? ';' : ','

    // Parse respecting quoted fields
    const parseCSVLine = (line) => {
      const fields = []; let cur = ''; let inQ = false
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (ch === '"') { inQ = !inQ; continue }
        if (ch === sep && !inQ) { fields.push(cur.trim()); cur = ''; continue }
        cur += ch
      }
      fields.push(cur.trim())
      return fields
    }
    const rawLines = text.trim().split('\n')
    const rows = rawLines.map(parseCSVLine)

    // Detect header row and column mapping
    const firstRow = rows[0] || []
    const headerKeywords = { front: /front|question|term|word|q\b/i, back: /back|answer|definition|meaning|a\b/i }
    let frontCol = 0, backCol = 1, dataStart = 0

    const headerCandidates = firstRow.map((h, i) => ({ h: h.toLowerCase().trim(), i }))
    const frontMatch = headerCandidates.find(({ h }) => headerKeywords.front.test(h))
    const backMatch  = headerCandidates.find(({ h }) => headerKeywords.back.test(h))

    if (frontMatch || backMatch) {
      dataStart = 1
      frontCol = frontMatch?.i ?? 0
      backCol  = backMatch?.i  ?? (frontCol === 0 ? 1 : 0)
    }

    // If every data row has only one column, try splitting on " - " (dash separator)
    const dataRows = rows.slice(dataStart).filter(r => r[0]?.trim())
    const allSingleCol = dataRows.length > 0 && dataRows.every(r => r.length === 1)

    const newCards = dataRows.filter(r => r[frontCol]?.trim()).map(r => {
      if (allSingleCol) {
        // "Term - Definition" single-column format
        const dashIdx = r[0].indexOf(' - ')
        if (dashIdx !== -1) {
          return { id: makeId('fc'), front: r[0].slice(0, dashIdx).trim(), back: r[0].slice(dashIdx + 3).trim(), nextReview: 0, interval: 1, ease: 2.5, repetitions: 0 }
        }
      }
      return { id: makeId('fc'), front: r[frontCol]?.trim() || '', back: r[backCol]?.trim() || '', nextReview: 0, interval: 1, ease: 2.5, repetitions: 0 }
    })
    if (newCards.length) {
      updateDeck(liveDeck.id, { cards: [...cards, ...newCards], updatedAt: new Date().toISOString() })
      persistFlashcardDecks()
    }
  }

  // Edit mode helpers
  function addCard() {
    if (!liveDeck) return
    const card = { id: makeId('fc'), front: '', back: '', nextReview: 0, interval: 1, ease: 2.5, repetitions: 0 }
    updateDeck(liveDeck.id, { cards: [...cards, card], updatedAt: new Date().toISOString() })
    persistFlashcardDecks()
  }

  function deleteCard(cardId) {
    if (!liveDeck) return
    updateDeck(liveDeck.id, { cards: cards.filter(c => c.id !== cardId), updatedAt: new Date().toISOString() })
    persistFlashcardDecks()
  }

  function updateCard(cardId, patch) {
    if (!liveDeck) return
    const newCards = cards.map(c => c.id === cardId ? { ...c, ...patch } : c)
    updateDeck(liveDeck.id, { cards: newCards, updatedAt: new Date().toISOString() })
    // Debounce persist for typing
    clearTimeout(titleTimeout.current)
    titleTimeout.current = setTimeout(() => persistFlashcardDecks(), 500)
  }

  if (!deck) {
    return (
      <div className="fc-container">
        <style>{FLASHCARD_CSS}</style>
        <div className="fc-header">
          <GnosNavButton onClick={() => setView('library')} />
          <span style={{ color: 'var(--textDim)', fontSize: 14 }}>No deck selected</span>
        </div>
      </div>
    )
  }

  // Streak dot indicator (approximated from streak count + lastStudyDate)
  const fcStreakDots = (() => {
    const streak = liveDeck?.streak || 0
    if (!streak) return null
    const lastDate = liveDeck?.lastStudyDate ? new Date(liveDeck.lastStudyDate) : new Date()
    const today = new Date()
    const startOfWeek = new Date(today)
    startOfWeek.setDate(today.getDate() - ((today.getDay() + 6) % 7))
    const weekActivity = Array.from({ length: 7 }, (_, i) => {
      const day = new Date(startOfWeek)
      day.setDate(startOfWeek.getDate() + i)
      const diffDays = Math.round((+lastDate - +day) / 86400000)
      return diffDays >= 0 && diffDays < streak
    })
    const days = ['M','T','W','T','F','S','S']
    return (
      <div style={{ display:'flex', alignItems:'center', gap:5 }}>
        <span style={{ fontSize:10, fontWeight:700, color:'var(--textDim)', letterSpacing:'0.08em', textTransform:'uppercase' }}>Streak</span>
        <div style={{ display:'flex', gap:3 }}>
          {days.map((d, i) => (
            <div key={i} title={d} style={{
              width:7, height:7, borderRadius:'50%',
              background: weekActivity[i] ? 'var(--accent)' : 'var(--border)',
            }} />
          ))}
        </div>
        <span style={{ fontSize:11, fontWeight:600, color:'var(--textDim)' }}>{streak}d</span>
      </div>
    )
  })()

  return (
    <div className="fc-container">
      <style>{FLASHCARD_CSS}</style>

      {/* Header */}
      <div className="fc-header">
        <GnosNavButton onClick={() => setView('library')} />
        <input
          className="fc-header-title"
          value={title}
          onChange={e => handleTitleChange(e.target.value)}
          onBlur={() => {
            if (liveDeck && title !== liveDeck.title) {
              updateDeck(liveDeck.id, { title, updatedAt: new Date().toISOString() })
              persistFlashcardDecks()
            }
          }}
        />
        <div className="fc-stats">
          <span>{cards.length} cards</span>
          <span style={{ color: dueCards.length > 0 ? '#ff9800' : 'var(--textDim)' }}>
            {dueCards.length} due
          </span>
          {fcStreakDots}
        </div>
        {mode === 'study' && (
          <button
            title={studySide === 'front' ? 'Studying Front→Back (click to flip to Back→Front)' : 'Studying Back→Front (click to flip to Front→Back)'}
            onClick={() => { setStudySide(s => s === 'front' ? 'back' : 'front'); setFlipped(false) }}
            style={{
              width: 28, height: 28, borderRadius: 6, border: '1px solid var(--border)',
              background: 'none', color: 'var(--textDim)', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0, transition: 'all 0.12s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--surfaceAlt)'; e.currentTarget.style.color = 'var(--text)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--textDim)' }}
          >
            {studySide === 'front'
              ? <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                  <rect x="1" y="3" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.4"/>
                  <path d="M5 8h6M9 6l2 2-2 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              : <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                  <rect x="1" y="3" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.4"/>
                  <path d="M11 8H5M7 10L5 8l2-2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
            }
          </button>
        )}
        <button className={`fc-mode-btn${mode === 'study' ? ' active' : ''}`} onClick={() => { setMode('study'); setFlipped(false); setCurrentIdx(0) }}>Study</button>
        <button className={`fc-mode-btn${mode === 'list' ? ' active' : ''}`} onClick={() => setMode('list')}>List</button>
        <button className={`fc-mode-btn${mode === 'edit' ? ' active' : ''}`} onClick={() => setMode('edit')}>Edit</button>
      </div>

      {/* Study Mode */}
      {mode === 'study' && (
        <div className="fc-study">
          {studyCard ? (
            <>
              {/* studySide='front': front face shown first; studySide='back': back face shown first */}
              {(() => {
                // "question" = the side shown first; "answer" = the side revealed on flip
                const qFront = studySide === 'front'
                const qData = qFront
                  ? { text: studyCard.front, html: studyCard.frontHtml, img: studyCard.imageUrl, sketch: studyCard.sketchUrl, audio: studyCard.audioUrl,    label: 'Front' }
                  : { text: studyCard.back,  html: studyCard.backHtml,  img: studyCard.backImageUrl,                           audio: studyCard.backAudioUrl, label: 'Back'  }
                const aData = qFront
                  ? { text: studyCard.back,  html: studyCard.backHtml,  img: studyCard.backImageUrl,                           audio: studyCard.backAudioUrl, label: 'Back'  }
                  : { text: studyCard.front, html: studyCard.frontHtml, img: studyCard.imageUrl, sketch: studyCard.sketchUrl, audio: studyCard.audioUrl,    label: 'Front' }
                const colorStyle = studyCard.color && studyCard.color !== 'transparent'
                  ? { borderLeftColor: studyCard.color, borderLeftWidth: 4 }
                  : {}
                return (
                  <div className="fc-card-wrapper" onClick={() => setFlipped(f => !f)}>
                    <div className={`fc-card-inner${flipped ? ' flipped' : ''}`}>
                      {/* Question face (always visible when not flipped) */}
                      <div className="fc-card-face fc-card-front" style={{ flexDirection: 'column', gap: 8, ...colorStyle }}>
                        <div className="fc-card-label">{qData.label}</div>
                        {qData.html
                          ? <div className="fc-card-html" dangerouslySetInnerHTML={{ __html: qData.html }} />
                          : qData.text || <span style={{ color: 'var(--textDim)', fontStyle: 'italic' }}>Empty card</span>}
                        {!qData.html && qData.img && <img src={qData.img} alt="" style={{ maxWidth: '70%', maxHeight: 100, borderRadius: 8, objectFit: 'contain' }} />}
                        {qData.sketch && <img src={qData.sketch} alt="" style={{ maxWidth: '80%', maxHeight: 80, borderRadius: 6 }} />}
                        {qData.audio && <AudioPlayBtn src={qData.audio} />}
                      </div>
                      {/* Answer face — hidden until flipped to prevent sneak-peek */}
                      <div className="fc-card-face fc-card-back" style={{ flexDirection: 'column', gap: 8, visibility: flipped ? 'visible' : 'hidden' }}>
                        <div className="fc-card-label">{aData.label}</div>
                        {aData.html
                          ? <div className="fc-card-html" dangerouslySetInnerHTML={{ __html: aData.html }} />
                          : aData.text || <span style={{ color: 'var(--textDim)', fontStyle: 'italic' }}>No answer</span>}
                        {!aData.html && aData.img && <img src={aData.img} alt="" style={{ maxWidth: '70%', maxHeight: 100, borderRadius: 8, objectFit: 'contain' }} />}
                        {aData.audio && <AudioPlayBtn src={aData.audio} />}
                      </div>
                    </div>
                  </div>
                )
              })()}
              {flipped ? (
                <div className="fc-rating-bar">
                  <button className="fc-rate-btn again" onClick={() => rateCard(1)}>Again <span style={{ fontSize: 10, opacity: 0.6 }}>(1)</span></button>
                  <button className="fc-rate-btn hard" onClick={() => rateCard(2)}>Hard <span style={{ fontSize: 10, opacity: 0.6 }}>(2)</span></button>
                  <button className="fc-rate-btn good" onClick={() => rateCard(3)}>Good <span style={{ fontSize: 10, opacity: 0.6 }}>(3)</span></button>
                  <button className="fc-rate-btn easy" onClick={() => rateCard(4)}>Easy <span style={{ fontSize: 10, opacity: 0.6 }}>(4)</span></button>
                </div>
              ) : (
                <div className="fc-hint-text">Click card or press Space to flip</div>
              )}
              <div style={{ fontSize: 11, color: 'var(--textDim)', textAlign: 'center' }}>
                Card {currentIdx + 1} of {dueCards.length} due
                {studyCard?.interval > 1 && (
                  <div style={{ marginTop: 4, fontSize: 10, opacity: 0.7 }}>
                    Next review in ~{studyCard.interval} day{studyCard.interval !== 1 ? 's' : ''} if rated Good
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="fc-done-msg">
              <h3>All caught up!</h3>
              <p>No cards are due for review right now.</p>
              <p style={{ marginTop: 8 }}>{cards.length} total cards in this deck</p>
              <button
                className="fc-mode-btn"
                style={{ marginTop: 16 }}
                onClick={() => setMode('edit')}
              >Add more cards</button>
            </div>
          )}
        </div>
      )}

      {/* List Mode */}
      {mode === 'list' && (() => {
        const now2 = Date.now()
        const newCards = cards.filter(c => !c.nextReview || c.nextReview === 0)
        const dueNow = cards.filter(c => c.nextReview > 0 && c.nextReview <= now2)
        const learned = cards.filter(c => c.nextReview > now2)
        const sections = [
          { label: 'Due Now', items: dueNow, badgeClass: 'due' },
          { label: 'New', items: newCards, badgeClass: 'new' },
          { label: 'Learned', items: learned, badgeClass: 'learned' },
        ].filter(s => s.items.length > 0)

        const formatDue = (ts) => {
          if (!ts || ts === 0) return 'New'
          const diff = ts - now2
          if (diff <= 0) return 'Due now'
          const days = Math.ceil(diff / 86400000)
          if (days === 1) return 'Tomorrow'
          if (days < 30) return `${days}d`
          return `${Math.round(days / 30)}mo`
        }

        return (
          <div className="fc-list">
            {cards.length === 0 && (
              <div style={{ textAlign: 'center', color: 'var(--textDim)', paddingTop: 40, fontSize: 14 }}>
                No cards yet. <button className="fc-mode-btn" style={{ marginLeft: 8 }} onClick={() => setMode('edit')}>Add cards</button>
              </div>
            )}
            {sections.map(({ label, items, badgeClass }) => (
              <div key={label}>
                <div className="fc-list-section">{label} ({items.length})</div>
                {items.map(card => (
                  <div key={card.id} className="fc-list-row" style={card.color && card.color !== 'transparent' ? { borderLeft: `3px solid ${card.color}` } : {}}>
                    <div className="fc-list-status">
                      <span className={`fc-list-badge ${badgeClass}`}>{label === 'Due Now' ? 'Due' : label}</span>
                      {card.nextReview > 0 && <span className="fc-list-due-date">{formatDue(card.nextReview)}</span>}
                      {card.interval > 1 && <span className="fc-list-due-date" style={{ opacity: 0.5 }}>~{card.interval}d</span>}
                    </div>
                    <div className="fc-list-fields">
                      <div className="fc-list-field-label">Front</div>
                      <textarea
                        className="fc-list-field"
                        rows={1}
                        value={card.front}
                        placeholder="Front…"
                        onChange={e => updateCard(card.id, { front: e.target.value })}
                        ref={el => { if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' } }}
                        onInput={e => { e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px' }}
                      />
                      {card.imageUrl && <img className="fc-list-img" src={card.imageUrl} alt="" />}
                      <div className="fc-list-field-label" style={{ marginTop: 2 }}>Back</div>
                      <textarea
                        className="fc-list-field"
                        rows={1}
                        value={card.back}
                        placeholder="Back…"
                        onChange={e => updateCard(card.id, { back: e.target.value })}
                        ref={el => { if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' } }}
                        onInput={e => { e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px' }}
                      />
                      {card.backImageUrl && <img className="fc-list-img" src={card.backImageUrl} alt="" />}
                    </div>
                    <button className="fc-list-del" title="Delete card"
                      onClick={() => { deleteCard(card.id) }}>×</button>
                  </div>
                ))}
              </div>
            ))}
            {cards.length > 0 && (
              <button className="fc-add-btn" style={{ marginTop: 8 }} onClick={addCard}>+ Add Card</button>
            )}
          </div>
        )
      })()}

      {/* Edit Mode — card viewport */}
      {mode === 'edit' && (
        <div className="fc-edit" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: cards.length ? 'center' : 'flex-start', gap: 16, paddingTop: 24 }}>
          {cards.length > 0 && (() => {
            const editIdx = Math.min(currentIdx, cards.length - 1)
            const card = cards[editIdx]
            if (!card) return null
            return (
              <>
                {/* Card navigation */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <button className="fc-mode-btn" onClick={() => setCurrentIdx(Math.max(0, editIdx - 1))} disabled={editIdx === 0}>&larr;</button>
                  <span style={{ fontSize: 12, color: 'var(--textDim)' }}>Card {editIdx + 1} of {cards.length}</span>
                  <button className="fc-mode-btn" onClick={() => setCurrentIdx(Math.min(cards.length - 1, editIdx + 1))} disabled={editIdx >= cards.length - 1}>&rarr;</button>
                </div>
                {/* Editable card viewport */}
                <div style={{ width: '100%', maxWidth: 780, display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {/* Front face — notecard proportions */}
                  <div className="fc-card-face fc-card-front" style={{
                    position: 'relative', minHeight: 200, aspectRatio: '5/3', flexDirection: 'column', gap: 8,
                    borderLeft: card.color && card.color !== 'transparent' ? `4px solid ${card.color}` : undefined,
                    borderTop: '3px solid var(--accent)',
                  }}>
                    <div className="fc-card-label">Front</div>
                    <textarea className="fc-card-input" placeholder="Front (question)..."
                      value={card.front} onChange={e => updateCard(card.id, { front: e.target.value })}
                      style={{ background: 'transparent', border: 'none', textAlign: 'center', fontSize: 18, fontWeight: 500, resize: 'none', minHeight: 80, fontFamily: 'Georgia, serif' }} />
                    {card.imageUrl && (
                      <div style={{ position: 'relative', display: 'inline-block' }}>
                        <img src={card.imageUrl} alt="" style={{ maxWidth: '80%', maxHeight: 120, borderRadius: 8, objectFit: 'contain' }} />
                        <button onClick={() => updateCard(card.id, { imageUrl: '' })}
                          style={{ position: 'absolute', top: 2, right: 2, width: 20, height: 20, borderRadius: 10, background: 'rgba(0,0,0,0.5)', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 11 }}>×</button>
                      </div>
                    )}
                    {card.audioUrl && (
                      <div className="fc-audio-row">
                        <AudioPlayBtn src={card.audioUrl} />
                        <span className="fc-audio-label">Audio attached</span>
                        <button className="fc-audio-remove" onClick={() => updateCard(card.id, { audioUrl: '' })}>×</button>
                      </div>
                    )}
                    <div style={{ position: 'absolute', bottom: 8, right: 8, display: 'flex', gap: 4 }}>
                      <AudioUploadBtn label="Audio" onUpload={url => updateCard(card.id, { audioUrl: url })} />
                      <ImageUploadBtn label="Image" onUpload={url => updateCard(card.id, { imageUrl: url })} />
                    </div>
                  </div>
                  {/* Back face — notecard proportions */}
                  <div className="fc-card-face fc-card-back" style={{
                    position: 'relative', minHeight: 200, aspectRatio: '5/3', flexDirection: 'column', gap: 8, transform: 'none',
                    borderTop: '3px solid var(--textDim)',
                  }}>
                    <div className="fc-card-label">Back</div>
                    <textarea className="fc-card-input" placeholder="Back (answer)..."
                      value={card.back} onChange={e => updateCard(card.id, { back: e.target.value })}
                      style={{ background: 'transparent', border: 'none', textAlign: 'center', fontSize: 18, fontWeight: 500, resize: 'none', minHeight: 80, fontFamily: 'Georgia, serif' }} />
                    {card.backImageUrl && (
                      <div style={{ position: 'relative', display: 'inline-block' }}>
                        <img src={card.backImageUrl} alt="" style={{ maxWidth: '80%', maxHeight: 120, borderRadius: 8, objectFit: 'contain' }} />
                        <button onClick={() => updateCard(card.id, { backImageUrl: '' })}
                          style={{ position: 'absolute', top: 2, right: 2, width: 20, height: 20, borderRadius: 10, background: 'rgba(0,0,0,0.5)', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 11 }}>×</button>
                      </div>
                    )}
                    {card.backAudioUrl && (
                      <div className="fc-audio-row">
                        <AudioPlayBtn src={card.backAudioUrl} />
                        <span className="fc-audio-label">Audio attached</span>
                        <button className="fc-audio-remove" onClick={() => updateCard(card.id, { backAudioUrl: '' })}>×</button>
                      </div>
                    )}
                    <div style={{ position: 'absolute', bottom: 8, right: 8, display: 'flex', gap: 4 }}>
                      <AudioUploadBtn label="Audio" onUpload={url => updateCard(card.id, { backAudioUrl: url })} />
                      <ImageUploadBtn label="Image" onUpload={url => updateCard(card.id, { backImageUrl: url })} />
                    </div>
                  </div>
                </div>
                {/* Color + delete row */}
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', maxWidth: 500, width: '100%' }}>
                  {CARD_COLORS.map(c => (
                    <span key={c} className={`fc-color-dot${card.color === c ? ' active' : ''}`}
                      style={{ background: c === 'transparent' ? 'var(--surfaceAlt)' : c }}
                      onClick={() => updateCard(card.id, { color: c })} />
                  ))}
                  <span style={{ flex: 1 }} />
                  <button className="fc-mode-btn" style={{ color: '#ef5350', borderColor: '#ef5350' }}
                    onClick={() => { deleteCard(card.id); setCurrentIdx(Math.max(0, editIdx - 1)) }}>Delete</button>
                </div>
              </>
            )
          })()}
          <button className="fc-add-btn" style={{ maxWidth: 500 }} onClick={addCard}>+ Add Card</button>
          {cards.length === 0 && (
            <button className="fc-add-btn" style={{ maxWidth: 500 }} onClick={handleImport}>↑ Import CSV / Anki deck</button>
          )}
        </div>
      )}
    </div>
  )
}
