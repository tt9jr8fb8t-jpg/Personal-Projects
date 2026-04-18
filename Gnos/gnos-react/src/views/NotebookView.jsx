/* NotebookView.jsx — CodeMirror 6 — v4
 *
 * Changes from v3:
 * ─────────────────
 * • Live view styled identically to preview (same typography, prose spacing,
 *   block padding) — only difference is the cursor / caret.
 * • Both opening AND closing syntax markers are hidden together when the cursor
 *   leaves the span. The cursor-zone now tracks the widest inline ancestor so
 *   **both** EmphasisMarks reveal at once.
 * • KaTeX replaced with MathQuill for inline-editable math. Clicking a rendered
 *   formula opens an in-place MathQuill editor; pressing Escape/Enter commits.
 * • Images render correctly in live view and no longer blank the screen in
 *   preview (line-level block replacement constrained to just the image node).
 * • Math $$…$$ and $…$ render in both live and preview via MathQuill rendering.
 * • Predictive formatting: once one side of a pair is typed (e.g. **) the
 *   partially-wrapped text immediately receives its CSS style via a dedicated
 *   "half-open" pass in the live plugin.
 * • [[ wikilink dropdown now uses a card-style floating panel that mirrors the
 *   library search bar; it is driven by a custom EditorView plugin (not the
 *   generic autocompletion tooltip) so it looks consistent.
 * • Paired-syntax auto-wrap: typing **, *, `, ~~, ==, $ around selected text
 *   (or at end of a word) wraps rather than showing a dropdown.
 * • Generic pair-syntax dropdown removed from autocompletion; only wikilinks
 *   use the autocomplete tooltip.
 */

import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, useContext, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import useAppStore from '@/store/useAppStore'
import { PaneContext } from '@/lib/PaneContext'
import { useIsActiveTab } from '@/lib/useIsActiveTab'
import { loadNotebookContent, saveNotebookContent, saveNotebookImage, getNotebookFolderPath, addReadingMinutes } from '@/lib/storage'
import { GnosNavButton } from '@/components/SideNav'
import { listen } from '@tauri-apps/api/event'


// ─── Tauri convertFileSrc cache (loaded once, used synchronously in widgets) ───
let _convertFileSrc = null
let _invoke = null
let _dialogOpen = null
;(async () => {
  try {
    const { convertFileSrc, invoke } = await import('@tauri-apps/api/core')
    _convertFileSrc = convertFileSrc
    _invoke = invoke
  } catch { /* non-Tauri env — ignore */ }
})()
;(async () => {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    _dialogOpen = open
  } catch { /* non-Tauri env — ignore */ }
})()

// ─── Tiny id helper ───────────────────────────────────────────────────────────
function makeId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}


// ─── CodeMirror lazy bundle ───────────────────────────────────────────────────
let _cmP = null
function loadCM() {
  if (_cmP) return _cmP
  _cmP = Promise.all([
    import('@codemirror/state'),
    import('@codemirror/view'),
    import('@codemirror/commands'),
    import('@codemirror/language'),
    import('@codemirror/lang-markdown'),
    import('@codemirror/autocomplete'),
    import('@codemirror/search'),
    import('@lezer/highlight'),
    import('@lezer/markdown'),
  ]).then(([state, view, commands, language, langMd, autocomplete, search, highlight, lezerMd]) => ({
    state, view, commands, language, langMd, autocomplete, search, highlight, lezerMd,
  }))
  return _cmP
}

// ─── KaTeX lazy loader (static rendering) ────────────────────────────────────
let _ktP = null
function getKaTeX() {
  if (_ktP) return _ktP
  _ktP = (async () => {
    try {
      // Load KaTeX from npm package (bundled, no CDN needed)
      const katex = await import('katex')
      // Inject KaTeX CSS if not already present
      if (!document.getElementById('katex-css')) {
        const css = await import('katex/dist/katex.min.css?inline').catch(() => null)
        if (css?.default) {
          const style = document.createElement('style')
          style.id = 'katex-css'
          style.textContent = css.default
          document.head.appendChild(style)
        }
      }
      return katex.default || katex
    } catch (e) {
      console.warn('[KaTeX] failed to load:', e)
      return null
    }
  })()
  return _ktP
}

// Render LaTeX into a DOM element using KaTeX (synchronous once loaded)
function renderMathStatic(el, latex, displayMode) {
  getKaTeX().then(katex => {
    if (!katex) { el.textContent = latex; return }
    try {
      katex.render(latex, el, { displayMode, throwOnError: false, strict: false })
    } catch { el.textContent = latex }
  })
}

// ─── MathQuill lazy loader (edit popup only) ─────────────────────────────────
let _mqP = null
function getMQ() {
  if (_mqP) return _mqP
  _mqP = (async () => {
    try {
      if (window.MathQuill) return window.MathQuill.getInterface(2)
      if (!window.jQuery) {
        await new Promise((res, rej) => {
          const s = document.createElement('script')
          s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js'
          s.onload = res; s.onerror = rej
          document.head.appendChild(s)
        })
      }
      if (!document.getElementById('mathquill-css')) {
        const link = document.createElement('link')
        link.id = 'mathquill-css'; link.rel = 'stylesheet'
        link.href = 'https://cdnjs.cloudflare.com/ajax/libs/mathquill/0.10.1/mathquill.min.css'
        document.head.appendChild(link)
      }
      await new Promise((res, rej) => {
        const s = document.createElement('script')
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/mathquill/0.10.1/mathquill.min.js'
        s.onload = res; s.onerror = rej
        document.head.appendChild(s)
      })
      return window.MathQuill?.getInterface(2) ?? null
    } catch (e) {
      console.warn('[MathQuill] failed to load:', e)
      return null
    }
  })()
  return _mqP
}

// ─── HTML escape ──────────────────────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')

// ─── Inline markdown → HTML ───────────────────────────────────────────────────
function inlineToHtml(text, notebooks = [], library = [], sketchbooks = [], flashcardDecks = []) {
  const buckets = []
  const ph = html => { const k = `\x02${buckets.length}\x03`; buckets.push(html); return k }

  let s = esc(text)

  // Images  ![alt](src)
  s = s.replace(/!\[([^\]]*)\]\(([^\s)]+)(?:\s+"([^"]*)")?\)/g, (_, alt, src, title) =>
    ph(`<img src="${esc(src)}" alt="${esc(alt)}"${title ? ` title="${esc(title)}"` : ''} class="nb-img" loading="lazy">`))

  // Links  [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^\s)]+)(?:\s+"([^"]*)")?\)/g, (_, txt, url, title) =>
    ph(`<a href="${esc(url)}" target="_blank" rel="noopener"${title ? ` title="${esc(title)}"` : ''}>${txt}</a>`))

  // Inline code  ``…`` then `…`
  s = s.replace(/``([^`]+)``/g, (_, c) => ph(`<code class="nb-ic">${esc(c)}</code>`))
  s = s.replace(/`([^`\n]+)`/g, (_, c) => ph(`<code class="nb-ic">${esc(c)}</code>`))

  // Math  $$…$$ inline  $…$
  s = s.replace(/\$\$(.+?)\$\$/g, (_, m) => ph(`<span class="nb-math nb-math-mq" data-latex="${esc(m)}" data-display="1"></span>`))
  s = s.replace(/\$([^$\n]+)\$/g, (_, m) => ph(`<span class="nb-math nb-math-mq" data-latex="${esc(m)}"></span>`))

  // Bold-italic ***…*** or ___…___
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong class="nb-bold"><em class="nb-italic">$1</em></strong>')
  s = s.replace(/___(.+?)___/g,       '<strong class="nb-bold"><em class="nb-italic">$1</em></strong>')
  // Bold **…** or __…__
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong class="nb-bold">$1</strong>')
  s = s.replace(/__([^_\n]+)__/g,  '<strong class="nb-bold">$1</strong>')
  // Italic *…* or _…_
  s = s.replace(/\*([^*\n]+)\*/g, '<em class="nb-italic">$1</em>')
  s = s.replace(/_([^_\n]+)_/g,   '<em class="nb-italic">$1</em>')
  // Strikethrough ~~…~~
  s = s.replace(/~~(.+?)~~/g, '<del class="nb-strike">$1</del>')
  // Highlight ==…==
  s = s.replace(/==(.+?)==/g, '<mark class="nb-hl">$1</mark>')
  // Superscript ^…^
  s = s.replace(/\^([^\s^]+)\^/g, '<sup class="nb-sup">$1</sup>')
  // Subscript ~…~
  s = s.replace(/~([^\s~]+)~/g, '<sub class="nb-sub">$1</sub>')
  // Footnote refs [^id]
  s = s.replace(/\[\^([^\]\n]+)\]/g, (_, id) =>
    ph(`<sup class="nb-fn-ref"><a href="#fn-${esc(id)}">[${esc(id)}]</a></sup>`))
  // Wikilinks [[Title]] with optional (sketch) or (flash) suffix
  s = s.replace(/\[\[([^\]\n]{1,120})\]\](?:\((sketch|flash)\))?/g, (_, raw, suffix) => {
    const title = raw.trim()
    const nb = notebooks.find(n => n.title?.toLowerCase() === title.toLowerCase())
    const bk = !nb && library.find(b => b.title?.toLowerCase() === title.toLowerCase())
    const sb = !nb && !bk && sketchbooks.find(s => s.title?.toLowerCase() === title.toLowerCase())
    const fd = !nb && !bk && !sb && flashcardDecks.find(d => d.title?.toLowerCase() === title.toLowerCase())
    // Suffix overrides type for new items
    const forceType = suffix === 'sketch' ? 'new-sketch' : suffix === 'flash' ? 'new-flash' : null
    const cls  = nb ? 'wikilink wikilink-nb' : bk ? 'wikilink wikilink-bk' : sb ? 'wikilink wikilink-sb' : fd ? 'wikilink wikilink-fd' : 'wikilink wikilink-new'
    const type = nb ? 'notebook' : bk ? 'book' : sb ? 'sketchbook' : fd ? 'flashcard' : (forceType || 'new')
    const id   = nb ? nb.id : bk ? bk.id : sb ? sb.id : fd ? fd.id : ''
    return ph(`<span class="${cls}" data-wl-type="${type}" data-wl-id="${esc(id)}" data-wl-title="${esc(title)}">${esc(title)}</span>`)
  })

  // Restore placeholders without using control-char regex
  s = s.split('\x02').reduce((acc, part, idx) => {
    if (idx === 0) return part
    const end = part.indexOf('\x03')
    const bucketIdx = parseInt(part.slice(0, end), 10)
    return acc + (buckets[bucketIdx] ?? '') + part.slice(end + 1)
  }, '')
  return s
}

// ─── Block renderer ───────────────────────────────────────────────────────────

function renderList(rawLines, il) {
  let html = ''
  const stack = []
  const openTag = (tag, start) => {
    html += (tag === 'ol' && start > 1) ? `<ol start="${start}">` : `<${tag}>`
  }
  const closeTag = () => { const top = stack.pop(); html += `</${top.tag}>` }

  rawLines.forEach(line => {
    const olM = line.match(/^(\s*)(\d+)[.)]\s+(.*)/)
    const ulM = !olM && line.match(/^(\s*)([-*+])\s+(.*)/)
    const m = olM || ulM
    if (!m) return
    const indent = m[1].length
    const tag    = olM ? 'ol' : 'ul'
    const num    = olM ? parseInt(m[2], 10) : 1
    const item   = m[3]

    if (!stack.length) {
      openTag(tag, num); stack.push({ tag, indent })
    } else if (indent > stack[stack.length - 1].indent) {
      openTag(tag, num); stack.push({ tag, indent })
    } else {
      while (stack.length > 1 && indent < stack[stack.length - 1].indent) closeTag()
      if (stack[stack.length - 1].tag !== tag) {
        closeTag(); openTag(tag, num); stack.push({ tag, indent })
      }
    }
    html += `<li>${il(item)}</li>`
  })
  while (stack.length) closeTag()
  return html
}

function blockToHtml(raw, notebooks, library, footnotesBuf, sketchbooks = [], flashcardDecks = []) {
  const il = t => inlineToHtml(t, notebooks, library, sketchbooks, flashcardDecks)
  const lines = raw.split('\n')
  const first = lines[0]

  const hm = first.match(/^(#{1,6})\s+(.+?)(?:\s+\{#([^}]+)\})?$/)
  if (hm) {
    const lv = hm[1].length
    const id = hm[3] ? ` id="${esc(hm[3])}"` : ''
    return `<h${lv}${id}>${il(hm[2])}</h${lv}>`
  }

  if (/^(---+|\*\*\*+|___+)$/.test(first.trim())) return '<hr>'

  if (/^(`{3,}|~{3,})/.test(first)) {
    const lang = first.replace(/^`{3,}|^~{3,}/, '').trim()
    const body = raw.replace(/^[^\n]*\n/, '').replace(/\n[`~]{3,}\s*$/, '')
    return `<pre class="nb-pre${lang ? ' lang-'+esc(lang) : ''}"><code>${esc(body)}</code></pre>`
  }

  if (/^>\s?/.test(first)) {
    const inner = lines.map(l => l.replace(/^>\s?/, '')).join('\n').trim()
    const callM = inner.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION|INFO|SUCCESS|DANGER)\](.*)/i)
    if (callM) {
      const kind  = callM[1].toUpperCase()
      const title = callM[2].trim() || kind.charAt(0)+kind.slice(1).toLowerCase()
      const palettes = {NOTE:'#388bfd',TIP:'#3fb950',IMPORTANT:'#a371f7',WARNING:'#d29922',CAUTION:'#f85149',INFO:'#388bfd',SUCCESS:'#3fb950',DANGER:'#f85149'}
      const c = palettes[kind] || '#388bfd'
      return `<div class="nb-callout" style="border-left:3px solid ${c};background:${c}18;padding:10px 14px;border-radius:0 6px 6px 0;margin:.6em 0"><div style="font-weight:700;color:${c};margin-bottom:4px;font-size:.93em">${esc(title)}</div><div>${il(inner.replace(/^\[[^\]]+\][^\n]*\n?/, '').trim())}</div></div>`
    }
    return `<blockquote>${il(inner.replace(/\n/g, '<br>'))}</blockquote>`
  }

  if ((/^\s*\|/.test(first) || /^\[[^\]]+\]$/.test(first.trim())) && lines.length >= 2) {
    const parseRow = row => {
      const trimmed = row.trim()
      const inner = trimmed.replace(/^(?<!\\)\|/, '').replace(/(?<!\\)\|$/, '')
      return inner.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'))
    }
    // Extract optional caption line (first or last line matching [caption text])
    let captionText = null
    let tLines = lines
    if (/^\[[^\]]+\]$/.test(lines[lines.length - 1].trim())) {
      captionText = lines[lines.length - 1].trim().slice(1, -1)
      tLines = lines.slice(0, -1)
    } else if (/^\[[^\]]+\]$/.test(lines[0].trim())) {
      captionText = lines[0].trim().slice(1, -1)
      tLines = lines.slice(1)
    }
    if (tLines.length < 2 || !/^\s*\|/.test(tLines[0])) return `<p>${il(raw)}</p>`
    const headers = parseRow(tLines[0])
    const sep     = tLines[1] ? parseRow(tLines[1]) : []
    const aligns  = sep.map(c => /^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : 'left')
    const isSepRow = l => parseRow(l).every(c => /^:?-+:?$/.test(c))
    const rows    = tLines.slice(2).filter(l => /\|/.test(l) && !isSepRow(l))
    const thHtml  = headers.map((h, i) => `<th style="text-align:${aligns[i]||'left'}">${il(h)}</th>`).join('')
    const tbHtml  = rows.map(r => {
      const cells = parseRow(r)
      const norm  = Array.from({ length: headers.length }, (_, i) => cells[i] ?? '')
      return `<tr>${norm.map((c, i) => `<td style="text-align:${aligns[i]||'left'}">${il(c)}</td>`).join('')}</tr>`
    }).join('')
    const tableHtml = `<table class="nb-table"><thead><tr>${thHtml}</tr></thead><tbody>${tbHtml}</tbody></table>`
    return captionText
      ? `<figure class="nb-table-fig">${tableHtml}<figcaption class="nb-table-cap">${il(captionText)}</figcaption></figure>`
      : tableHtml
  }

  if (/^\s*[-*+]\s\[[ xX]\]/.test(first)) {
    let idx = 0
    const items = lines.filter(l => /^\s*[-*+]\s\[[ xX]\]/.test(l)).map(l => {
      const checked = /\[[xX]\]/.test(l)
      const text    = l.replace(/^\s*[-*+]\s\[[ xX]\]\s*/, '')
      return `<li class="nb-task${checked?' checked':''}" data-ti="${idx++}"><span class="nb-cb" data-ti="${idx-1}">${checked?'✓':''}</span><span>${il(text)}</span></li>`
    })
    return `<ul class="nb-tl">${items.join('')}</ul>`
  }

  if (/^\s*[-*+]\s/.test(first)) return renderList(lines, il)
  if (/^\s*\d+[.)]\s/.test(first)) return renderList(lines, il)

  // Definition list: any line followed by ": definition"
  if (lines.length >= 2 && lines.some(l => /^:\s+/.test(l))) {
    let dlHtml = ''; let i = 0
    while (i < lines.length) {
      const l = lines[i]
      if (/^:\s+/.test(l)) {
        dlHtml += `<dd class="nb-dd">${il(l.replace(/^:\s+/, ''))}</dd>`
        i++
      } else if (l.trim()) {
        dlHtml += `<dt class="nb-dt">${il(l.trim())}</dt>`
        i++
      } else { i++ }
    }
    return `<dl class="nb-dl">${dlHtml}</dl>`
  }

  const fnM = first.match(/^\[\^([^\]]+)\]:\s*(.*)/)
  if (fnM) {
    footnotesBuf?.push({ id: fnM[1], text: fnM[2] })
    return `<div class="nb-fn-def" id="fn-${esc(fnM[1])}"><sup>${esc(fnM[1])}</sup> ${il(fnM[2])} <a href="#fnref-${esc(fnM[1])}" class="nb-fn-back">↩</a></div>`
  }

  // Math block $$…$$
  if (/^\$\$/.test(first)) {
    const body = raw.replace(/^\$\$\n?/, '').replace(/\n?\$\$$/, '')
    return `<div class="nb-math nb-math-block nb-math-mq" data-latex="${esc(body)}" data-display="1"></div>`
  }

  // /habits block — render as habit tracker preview
  if (/^\/habits(?::.*)?$/.test(first)) {
    try {
      const m = first.match(/^\/habits(?::(.*))?$/)
      const data = (m && m[1]) ? JSON.parse(m[1]) : { habits: [], log: {} }
      const today = new Date().toISOString().slice(0, 10)
      const rowsHtml = (data.habits || []).map((h, hi) => {
        const done = !!(data.log && data.log[today] && data.log[today][hi])
        return `<div class="cm-habits-preview-row"><span class="cm-habits-name">${esc(h)}</span><span class="cm-habits-cell${done ? ' done' : ''}" style="display:inline-block;width:12px;height:12px;border-radius:3px;margin-left:8px;vertical-align:middle;"></span></div>`
      }).join('')
      return `<div class="cm-habits-widget" style="pointer-events:none"><div class="cm-habits-hdr"><span class="cm-habits-title">Habits</span></div>${rowsHtml || '<div class="cm-habits-empty">No habits yet</div>'}</div>`
    } catch { return '' }
  }

  // /task block — render as a kanban board (matches widget CSS)
  if (/^\/task(?::.*)?$/.test(first)) {
    const block = parseTaskBlock(raw, 0)
    if (block) {
      const colsHtml = block.columns.map(col => {
        const tasksHtml = col.tasks.map(t => {
          return `<div class="cm-task-card-w">
            <div class="cm-task-card-body">
              <span class="cm-task-card-text">${esc(t.text)}</span>
            </div>
          </div>`}).join('')
        return `<div class="cm-task-col-w">
          <div class="cm-task-col-hdr-w">
            <span class="cm-task-col-title">${esc(col.title)}</span>
            <span class="cm-task-col-w-badge">${col.tasks.length}</span>
          </div>
          <div class="cm-task-cards-area">${tasksHtml}</div>
        </div>`
      }).join('')
      const titleHtml = block.boardTitle ? `<div class="cm-task-titlebar"><span class="cm-task-title-w">${esc(block.boardTitle)}</span></div>` : ''
      return `<div class="cm-task-board-w">${titleHtml}<div class="cm-task-cols-w">${colsHtml}</div></div>`
    }
  }

  // /calendar block — render as a simple event summary in preview
  if (/^\/calendar(?::.*)?$/.test(first)) {
    let data = {}
    try { const jsonPart = first.replace(/^\/calendar:/, ''); data = JSON.parse(jsonPart) } catch { /**/ }
    const events = data.events || {}
    const titleText = data.title || 'Calendar'
    const today = new Date()
    const todayKey = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`
    // Show next 7 days of events
    const days = []
    for (let i = 0; i < 7; i++) {
      const d = new Date(today); d.setDate(d.getDate() + i)
      const k = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
      if (events[k]?.length) days.push({ date: d, key: k, evts: events[k] })
    }
    const evtHtml = days.length ? days.map(({ date, evts }) => {
      const label = date.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' })
      return `<div class="cm-cal-prev-day"><span class="cm-cal-prev-date">${esc(label)}</span>${evts.map(e => `<span class="cm-cal-prev-evt">${esc(e)}</span>`).join('')}</div>`
    }).join('') : '<div style="font-size:11px;color:var(--textDim);padding:6px 0">No upcoming events</div>'
    return `<div class="cm-cal-prev-block"><div class="cm-cal-prev-title">${esc(titleText)}</div>${evtHtml}</div>`
  }

  // /pomo block — render as pomodoro status in preview
  if (/^\/pomo$/.test(first)) {
    return `<div class="cm-pomo-prev"><span class="cm-pomo-prev-icon">\u{1F345}</span><span class="cm-pomo-prev-text">Pomodoro Timer</span><span class="cm-pomo-prev-sub">25 min focus · 5 min break</span></div>`
  }

  // /timer block — render as a simple timer display in preview
  if (/^\/timer(?::.*)?$/.test(first)) {
    const m = first.match(/^\/timer:(\d+)(?::(.+))?$/)
    const totalSec = m ? parseInt(m[1]) : 0
    const label = m?.[2] || ''
    const h = Math.floor(totalSec / 3600), min = Math.floor((totalSec % 3600) / 60), sec = totalSec % 60
    const display = totalSec > 0 ? (h > 0 ? `${h}:${String(min).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${min}:${String(sec).padStart(2,'0')}`) : '0:00'
    return `<div class="cm-timer-prev"><span class="cm-timer-prev-time">${esc(display)}</span>${label ? `<span class="cm-timer-prev-label">${esc(label)}</span>` : ''}</div>`
  }

  return `<p>${il(raw.replace(/\n/g, '<br>'))}</p>`
}

function parseBlocks(text) {
  const lines = text.split('\n')
  const blocks = []
  let buf = [], inFence = false, fenceMarker = ''

  const flush = () => {
    const raw = buf.join('\n').trim()
    if (raw) blocks.push(raw)
    buf = []
  }

  for (const line of lines) {
    if (!inFence && /^(`{3,}|~{3,})/.test(line)) {
      flush(); inFence = true; fenceMarker = line.match(/^(`{3,}|~{3,})/)[1]
      buf.push(line); continue
    }
    if (inFence) {
      buf.push(line)
      if (line.startsWith(fenceMarker) && line.trim().length === fenceMarker.length) {
        flush(); inFence = false; fenceMarker = ''
      }
      continue
    }
    if (line.trim() === '$$') { buf.push(line); continue }
    if (line.trim() === '') { flush(); continue }

    // Keep /task block lines together (column headers == ... == and task items - [ ] ...)
    const wasTaskBlock = buf.length > 0 && /^\/task(?::.*)?$/.test(buf[0])
    if (wasTaskBlock) { buf.push(line); continue }

    const isTable   = /^\s*\|/.test(line)
    const wasTable  = buf.length > 0 && /^\s*\|/.test(buf[0])
    if (isTable && wasTable) { buf.push(line); continue }
    if (isTable && !wasTable) { flush(); buf.push(line); continue }
    // Body rows without a leading pipe (optional outer pipes) continue a table block
    if (!isTable && wasTable && /\|/.test(line) && !/^\s*(#{1,6}\s|[-*+]\s|\d+[.)] |>|`{3,}|~{3,})/.test(line)) { buf.push(line); continue }

    const isUl   = /^\s*[-*+]\s/.test(line) && !/^\s*[-*+]\s\[[ xX]\]/.test(line)
    const isOl   = /^\s*\d+[.)]\s/.test(line)
    const isTask = /^\s*[-*+]\s\[[ xX]\]/.test(line)
    const isList = isUl || isOl || isTask
    const wasList = buf.length > 0 && (
      /^\s*[-*+]\s/.test(buf[0]) || /^\s*\d+[.)]\s/.test(buf[0])
    )
    if (isList && wasList) { buf.push(line); continue }
    if (isList) { flush() }

    flush(); buf.push(line)
  }
  flush()
  return blocks
}

function renderMarkdown(text, notebooks = [], library = [], sketchbooks = [], flashcardDecks = []) {
  if (!text?.trim()) return ''
  const footnotes = []
  const blocks = parseBlocks(text)
  // Merge standalone [caption] blocks with adjacent table blocks
  for (let ci = 0; ci < blocks.length; ci++) {
    if (!/^\[[^\]]+\]$/.test(blocks[ci].trim())) continue
    if (ci + 1 < blocks.length && /^\s*\|/.test(blocks[ci + 1])) {
      blocks[ci + 1] = blocks[ci] + '\n' + blocks[ci + 1]
      blocks.splice(ci, 1); ci--
    } else if (ci > 0 && /^\s*\|/.test(blocks[ci - 1])) {
      blocks[ci - 1] = blocks[ci - 1] + '\n' + blocks[ci]
      blocks.splice(ci, 1); ci--
    }
  }
  const html = blocks.map((raw, i) =>
    blockToHtml(raw, notebooks, library, footnotes, sketchbooks, flashcardDecks)
      .replace(/^(<\w+)/, `$1 data-bi="${i}"`)
  ).join('\n')
  if (!footnotes.length) return html
  const fnHtml = `<section class="nb-fns"><hr>${footnotes.map(f =>
    `<div id="fn-${esc(f.id)}" class="nb-fn-def"><sup>${esc(f.id)}</sup> ${inlineToHtml(f.text, notebooks, library, sketchbooks, flashcardDecks)} <a href="#fnref-${esc(f.id)}" class="nb-fn-back">↩</a></div>`
  ).join('')}</section>`
  return html + fnHtml
}

// Hydrate math nodes in a container after innerHTML is set — uses KaTeX
function hydrateMathNodes(container) {
  const nodes = Array.from(container.querySelectorAll('.nb-math-mq'))
  if (!nodes.length) return
  getKaTeX().then(katex => {
    nodes.forEach(el => {
      const latex = el.dataset.latex || ''
      const display = el.dataset.display === '1'
      if (!katex) { el.textContent = latex; return }
      try {
        katex.render(latex, el, { displayMode: display, throwOnError: false, strict: false })
      } catch { el.textContent = latex }
    })
  })
}

// ─── CodeMirror theme ─────────────────────────────────────────────────────────
function makeTheme(cm) {
  const { EditorView } = cm.view
  return EditorView.theme({
    // In live mode we style lines via CSS classes, not the base editor font.
    // Keep base styles minimal so .nb-live CSS classes dominate.
    '&': {
      background: 'transparent',
      color: 'var(--text)',
      height: '100%',
      fontFamily: 'Erode, Georgia, serif',
      fontSize: '15px',
      fontWeight: '450',
    },
    '.cm-content': { caretColor: 'var(--accent)', padding: '16px 0' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      background: 'var(--nb-sel, rgba(56,139,253,0.28)) !important',
    },
    '.cm-activeLine': { background: 'transparent' },
    '.cm-searchMatch': { background: 'rgba(210,153,34,0.35)', borderRadius: '2px' },
    '.cm-searchMatch.cm-searchMatch-selected': { background: 'rgba(56,139,253,0.45)' },
    '.cm-panels': { display: 'none' },
    '.cm-panel': { display: 'none' },
    '.cm-panel button': { background: 'var(--surfaceAlt)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text)', cursor: 'pointer', padding: '3px 8px', fontFamily: 'inherit', fontSize: '12px' },
    '.cm-scroller': { overflow: 'auto', fontFamily: 'inherit' },
  }, { dark: true })
}

function makeHighlight(cm) {
  const { tags } = cm.highlight
  const { HighlightStyle } = cm.language
  return HighlightStyle.define([
    { tag: tags.heading1, color: 'var(--text)', fontWeight: '600', fontSize: '1.6em', fontFamily: 'Erode, Georgia, serif', letterSpacing: '-0.3px' },
    { tag: tags.heading2, color: 'var(--text)', fontWeight: '600', fontSize: '1.35em', fontFamily: 'Erode, Georgia, serif', letterSpacing: '-0.2px' },
    { tag: tags.heading3, color: 'var(--text)', fontWeight: '600', fontSize: '1.15em', fontFamily: 'Satoshi, Author, sans-serif' },
    { tag: tags.heading4, color: 'var(--text)', fontWeight: '600', fontFamily: 'Satoshi, Author, sans-serif' },
    { tag: tags.strong,   color: 'var(--nb-bold-color)', fontWeight: '700' },
    { tag: tags.emphasis, color: 'var(--nb-italic-color)', fontStyle: 'italic' },
    { tag: tags.strikethrough, color: 'var(--textDim)', textDecoration: 'line-through' },
    { tag: tags.link,   color: 'var(--accent)' },
    { tag: tags.url,    color: 'var(--accent)', textDecoration: 'underline' },
    { tag: tags.monospace, color: 'var(--accent)', fontFamily: 'SF Mono,Menlo,Consolas,monospace', fontSize: '0.88em' },
    { tag: tags.meta,   color: 'var(--textDim)', opacity: '0.4' },
    { tag: tags.atom,   color: 'var(--textDim)' },
    { tag: tags.comment, color: 'var(--textDim)', fontStyle: 'italic' },
    { tag: tags.processingInstruction, color: 'var(--textDim)', opacity: '0.6' },
    { tag: tags.keyword, color: '#d2a8ff' },
    { tag: tags.string,  color: '#a5d6ff' },
    { tag: tags.number,  fontWeight: '600' },
    { tag: tags.operator, color: 'var(--textDim)' },
  ])
}

// ─── Wiki-link dropdown (custom React-driven, no CM6 autocompletion) ─────────
// A ViewPlugin detects [[…  before the cursor and pushes state to React via
// a callback. React renders the floating dropdown. The plugin also provides
// a keymap (Tab confirm, ArrowUp/Down navigate, Escape dismiss).
function makeWikiDropdownPlugin(cm, _notebooks, _library, _sketchbooks, _flashcardDecks, onStateChange) {
  const { Prec } = cm.state
  const { ViewPlugin, EditorView, keymap: keymapFacet } = cm.view

  // Shared mutable state the keymap closures can read
  const shared = { active: false, options: [], selectedIdx: 0, from: 0, to: 0 }

  function buildOptions(query) {
    const q = query.toLowerCase()
    // Always read fresh data from the store to avoid stale closures
    const store = typeof useAppStore !== 'undefined' ? useAppStore.getState() : {}
    const notebooks = store.notebooks || _notebooks || []
    const library = store.library || _library || []
    const sketchbooks = store.sketchbooks || _sketchbooks || []
    const flashcardDecks = store.flashcardDecks || _flashcardDecks || []
    const make = (items, detail) =>
      items.filter(i => i.title?.toLowerCase().includes(q))
        .slice(0, 6)
        .map(i => ({ label: i.title, detail, insert: `[[${i.title}]]` }))
    const opts = [
      ...make(notebooks, 'Notebook'),
      ...make(library.filter(b => b.format !== 'audiofolder' && b.format !== 'audio'), 'Book'),
      ...make(library.filter(b => b.format === 'audiofolder' || b.format === 'audio'), 'Audio'),
      ...make(sketchbooks, 'Sketchbook'),
      ...make(flashcardDecks, 'Flashcards'),
    ].slice(0, 8)
    // "Create new" options
    const trimmed = query.trim()
    if (trimmed.length > 0 && !opts.some(o => o.label.toLowerCase() === trimmed.toLowerCase())) {
      opts.push({ label: trimmed, detail: '+ New notebook', insert: `[[${trimmed}]]` })
      opts.push({ label: trimmed, detail: '+ New sketchbook', insert: `[[${trimmed}]](sketch)` })
      opts.push({ label: trimmed, detail: '+ New flashcards', insert: `[[${trimmed}]](flash)` })
    }
    return opts
  }

  function detectWiki(state) {
    const cur = state.selection.main.head
    const line = state.doc.lineAt(cur)
    const col = cur - line.from
    const textBefore = line.text.slice(0, col)
    // Find last [[ that isn't closed
    const idx = textBefore.lastIndexOf('[[')
    if (idx === -1) return null
    const afterBrackets = textBefore.slice(idx + 2)
    // If there's a ]] inside, the wikilink is already closed
    if (afterBrackets.includes(']]')) return null
    // If there's a newline, not valid
    if (afterBrackets.includes('\n')) return null
    return { from: line.from + idx, query: afterBrackets }
  }

  function pushState(view) {
    const result = detectWiki(view.state)
    if (!result) {
      if (shared.active) {
        shared.active = false
        shared.options = []
        onStateChange(null)
      }
      return
    }
    const opts = buildOptions(result.query)
    shared.active = opts.length > 0
    shared.options = opts
    shared.from = result.from
    shared.to = view.state.selection.main.head
    if (shared.selectedIdx >= opts.length) shared.selectedIdx = 0
    if (!shared.active) { onStateChange(null); return }
    // Get cursor coordinates for positioning
    const coords = view.coordsAtPos(view.state.selection.main.head)
    onStateChange({
      options: opts,
      selectedIdx: shared.selectedIdx,
      coords: coords ? { left: coords.left, top: coords.bottom + 4 } : null,
    })
  }

  function confirmSelection(view) {
    if (!shared.active || !shared.options.length) return false
    const opt = shared.options[shared.selectedIdx]
    if (!opt) return false
    view.dispatch({ changes: { from: shared.from, to: shared.to, insert: opt.insert } })
    shared.active = false
    shared.options = []
    onStateChange(null)
    return true
  }

  const plugin = ViewPlugin.fromClass(class {
    constructor(view) { this._raf = null; this._schedule(view) }
    update(upd) { if (upd.docChanged || upd.startState.selection.main.head !== upd.state.selection.main.head) this._schedule(upd.view) }
    _schedule(view) {
      if (this._raf) cancelAnimationFrame(this._raf)
      this._raf = requestAnimationFrame(() => { this._raf = null; pushState(view) })
    }
    destroy() { if (this._raf) cancelAnimationFrame(this._raf); onStateChange(null) }
  })

  const wikiKeymap = Prec.high(keymapFacet.of([
    {
      key: 'Tab',
      run: view => shared.active ? confirmSelection(view) : false,
    },
    {
      key: 'Escape',
      run: _view => {
        if (!shared.active) return false
        shared.active = false; shared.options = []
        onStateChange(null)
        return true
      },
    },
    {
      key: 'ArrowDown',
      run: view => {
        if (!shared.active) return false
        shared.selectedIdx = (shared.selectedIdx + 1) % shared.options.length
        pushState(view)
        return true
      },
    },
    {
      key: 'ArrowUp',
      run: view => {
        if (!shared.active) return false
        shared.selectedIdx = (shared.selectedIdx - 1 + shared.options.length) % shared.options.length
        pushState(view)
        return true
      },
    },
  ]))

  return [plugin, wikiKeymap]
}

// ─── Paired-syntax auto-wrap (transaction filter — no dropdown) ───────────────
// When the user types an opening token, we check if there's a selection or
// a word to the left and wrap it. If nothing is selected, we insert both tokens
// and place the cursor in the middle. This is the Obsidian-style approach.
function makePairInputHandler(cm) {
  // Obsidian-style: only auto-wrap when there's a selection.
  // No selection → just type the character normally (no auto-closing).
  // Exception: backtick and $ get lightweight auto-close (easy to dismiss).
  const WRAP_PAIRS = { '*':'*', '_':'_', '~':'~', '=':'=', '`':'`', '$':'$' }
  return cm.view.EditorView.inputHandler.of((view, _from, _to, text) => {
    if (!WRAP_PAIRS[text]) return false
    const sel = view.state.selection.main

    // ── Selection → wrap it (like Obsidian) ─────────────────────────────
    if (!sel.empty) {
      const selected = view.state.doc.sliceString(sel.from, sel.to)
      // Determine the wrapper based on what's already around the selection
      let open = text, close = WRAP_PAIRS[text]
      // If wrapping with * or _, check if we should use ** or *** based on context
      // Simple: just wrap with whatever the user typed
      view.dispatch({
        changes: [
          { from: sel.from, to: sel.from, insert: open },
          { from: sel.to, to: sel.to, insert: close },
        ],
        selection: cm.state.EditorSelection.range(sel.from + open.length, sel.to + open.length),
      })
      return true
    }

    // ── No selection → skip-over if next char matches (prevents doubled closers) ──
    const after1 = view.state.doc.sliceString(sel.from, sel.from + 1)
    if (after1 === text) {
      // Check if we're inside a pair (simple heuristic: char before us is not whitespace
      // and char after is the same as what we're typing)
      const before1 = sel.from >= 1 ? view.state.doc.sliceString(sel.from - 1, sel.from) : ''
      if (before1 && before1 !== ' ' && before1 !== '\n') {
        // Skip over the existing character
        view.dispatch({ selection: { anchor: sel.from + 1 } })
        return true
      }
    }

    // ── No selection → no auto-close, let character type naturally ──────
    return false
  })
}

function makeSmartEnter(cm) {
  const smartEnterRun = ({ state, dispatch }) => {
    const sel = state.selection.main
    if (!sel.empty) return false // Let default handle selections
    const line = state.doc.lineAt(sel.from)
    const text = line.text

    // Detect unordered list item: leading spaces + marker (- * +) + space
    const ulMatch = text.match(/^(\s*)([-*+]) /)
    // Detect ordered list item: leading spaces + digits + . + space
    const olMatch = text.match(/^(\s*)(\d+)\. /)

    const match = ulMatch || olMatch
    if (!match) return false

    // Content after the marker
    const prefixLen = match[0].length
    const contentStart = line.from + prefixLen
    const isEmpty = sel.from <= contentStart && text.slice(prefixLen).trim() === ''

    if (isEmpty) {
      // Empty list item — clear the line (exit the list)
      dispatch(state.update({
        changes: { from: line.from, to: line.to, insert: '' },
        selection: { anchor: line.from },
        scrollIntoView: true,
      }))
      return true
    }

    // Build next-line prefix: same indent + same marker (or incremented number)
    let nextPrefix
    if (olMatch) {
      const n = parseInt(olMatch[2], 10)
      nextPrefix = olMatch[1] + (n + 1) + '. '
    } else {
      nextPrefix = ulMatch[1] + ulMatch[2] + ' '
    }

    // Insert exactly one newline + list prefix (no blank line)
    const insert = '\n' + nextPrefix
    dispatch(state.update({
      changes: { from: sel.from, to: sel.to, insert },
      selection: { anchor: sel.from + insert.length },
      scrollIntoView: true,
    }))
    return true
  }
  return cm.view.keymap.of([{ key: 'Enter', run: smartEnterRun }])
}

// ─── Inline format shortcuts ──────────────────────────────────────────────────
function makeFormatKeys(cm) {
  const wrap = m => ({ state, dispatch }) => {
    const changes = state.selection.ranges.map(r => {
      const sel = state.doc.sliceString(r.from, r.to)
      return { from: r.from, to: r.to, insert: sel ? `${m}${sel}${m}` : `${m}${m}` }
    })
    dispatch(state.update({ changes, scrollIntoView: true }))
    return true
  }
  const link = ({ state, dispatch }) => {
    const sel = state.doc.sliceString(state.selection.main.from, state.selection.main.to)
    dispatch(state.update({ changes: { from: state.selection.main.from, to: state.selection.main.to, insert: sel ? `[${sel}](url)` : '[link text](url)' }, scrollIntoView: true }))
    return true
  }
  return cm.view.keymap.of([
    { key: 'Mod-b', run: wrap('**') },
    { key: 'Mod-i', run: wrap('*') },
    { key: 'Mod-e', run: wrap('`') },
    { key: 'Mod-k', run: link },
    { key: 'Mod-Shift-h', run: wrap('==') },
  ])
}


// ─── Ghost hint plugin ────────────────────────────────────────────────────────
// Shows placeholder ghost text after typing an opening syntax token.
// Tab accepts. Ghost dismisses automatically when cursor moves away or a space
// is typed. The opening syntax markers are NEVER removed — space after syntax
// means the user intended them as literal text.
function makeGhostHintPlugin(cm) {
  const { ViewPlugin, Decoration, WidgetType } = cm.view

  const HINTS = {
    '***': '***',
    '**':  '**',
    '*':   '*',
    '___': '___',
    '__':  '__',
    '_':   '_',
    '~~':  '~~',
    '==':  '==',
    '`':   '`',
    '$$':  '$$',
    '$':   '$',
  }

  class GhostWidget extends WidgetType {
    constructor(text) { super(); this.text = text }
    toDOM() {
      const span = document.createElement('span')
      span.className = 'cm-ghost-hint'
      span.textContent = this.text
      span.setAttribute('aria-hidden', 'true')
      return span
    }
    eq(o) { return o instanceof GhostWidget && o.text === this.text }
    ignoreEvent() { return true }
  }

  const ghostPlugin = ViewPlugin.fromClass(class {
    constructor(view) { this.deco = Decoration.none; this._hint = null; this._activeToken = null; this._compute(view) }
    update(upd) { if (upd.docChanged || upd.startState.selection.main.head !== upd.state.selection.main.head) this._compute(upd.view) }
    _compute(view) {
      const { state } = view
      const cur = state.selection.main
      if (!cur.empty) { this.deco = Decoration.none; this._hint = null; this._activeToken = null; return }
      const line = state.doc.lineAt(cur.head)
      const col = cur.head - line.from
      const textBefore = line.text.slice(0, col)
      const after = line.text.slice(col)

      let matched = null
      for (const token of ['***', '___', '$$', '**', '__', '~~', '==', '*', '_', '`', '$']) {
        if (textBefore.endsWith(token)) {
          const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const count = (textBefore.match(new RegExp(escaped, 'g')) || []).length
          if (count % 2 === 1 && !after.includes(token)) {
            matched = token; break
          }
        }
      }

      // If we had a ghost and user typed a letter (not space), persist it
      if (!matched && this._activeToken && this._hint) {
        const lastChar = col > 0 ? line.text[col - 1] : ''
        // Space or moving away → dismiss ghost, keep syntax as-is
        if (lastChar === ' ' || lastChar === '') {
          this.deco = Decoration.none; this._hint = null; this._activeToken = null; return
        }
        const close = HINTS[this._activeToken]
        const escaped = this._activeToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const count = (textBefore.match(new RegExp(escaped, 'g')) || []).length
        if (count % 2 === 1 && !after.includes(close)) {
          const builder = new cm.state.RangeSetBuilder()
          try {
            builder.add(cur.head, cur.head, Decoration.widget({ widget: new GhostWidget(close), side: 1 }))
          } catch { /* ignore */ }
          this.deco = builder.finish()
          this._hint = { pos: cur.head, insert: close }
          return
        }
      }

      if (!matched || !HINTS[matched]) { this.deco = Decoration.none; this._hint = null; this._activeToken = null; return }
      const close = HINTS[matched]

      if (after.startsWith(close)) { this.deco = Decoration.none; this._hint = null; this._activeToken = null; return }

      const builder = new cm.state.RangeSetBuilder()
      try {
        builder.add(cur.head, cur.head, Decoration.widget({ widget: new GhostWidget(close), side: 1 }))
      } catch { /* ignore */ }
      this.deco = builder.finish()
      this._hint = { pos: cur.head, insert: close }
      this._activeToken = matched
    }
    get decorations() { return this.deco }
  }, { decorations: v => v.decorations })

  // Only Tab to accept — no Enter handler, no space handler
  // Ghost dismisses automatically when cursor moves away (handled by _compute)
  const ghostKeymap = cm.state.Prec.high(cm.view.keymap.of([
    {
      key: 'Tab',
      run: view => {
        const plugin = view.plugin(ghostPlugin)
        if (!plugin?._hint) return false
        const { pos, insert } = plugin._hint
        if (view.state.selection.main.head !== pos) return false
        view.dispatch({
          changes: { from: pos, to: pos, insert },
          selection: { anchor: pos },
        })
        return true
      },
    },
  ]))

  return [ghostPlugin, ghostKeymap]
}


// ─── Math.js + Algebrite inline calculator (ghost hint for `expr=`) ─────────
// Lazy-loads mathjs and algebrite. Shows result as ghost text after `=`.
let _mathP = null
function getMathjs() {
  if (_mathP) return _mathP
  _mathP = import('mathjs').then(m => m).catch(() => null)
  return _mathP
}
let _algP = null
function getAlgebrite() {
  if (_algP) return _algP
  _algP = import('algebrite').then(m => m.default || m).catch(() => null)
  return _algP
}

function makeMathCalcPlugin(cm) {
  const { ViewPlugin, Decoration, WidgetType } = cm.view

  class MathGhostWidget extends WidgetType {
    constructor(text) { super(); this.text = text }
    toDOM() {
      const span = document.createElement('span')
      span.className = 'cm-ghost-hint cm-math-ghost'
      span.textContent = this.text
      span.setAttribute('aria-hidden', 'true')
      return span
    }
    eq(o) { return o instanceof MathGhostWidget && o.text === this.text }
    ignoreEvent() { return true }
  }

  let mathLib = null
  let algLib = null
  getMathjs().then(m => {
    if (m) {
      try {
        m.import({
          FV: function(rate, nper, pmt, pv) {
            pv = pv || 0
            return pv * Math.pow(1 + rate, nper) + pmt * (Math.pow(1 + rate, nper) - 1) / rate
          },
          PV: function(rate, nper, pmt, fv) {
            fv = fv || 0
            return (pmt * (1 - Math.pow(1 + rate, -nper)) / rate) + fv * Math.pow(1 + rate, -nper)
          },
          PMT: function(rate, nper, pv, fv) {
            fv = fv || 0
            return (pv * rate * Math.pow(1 + rate, nper) + fv * rate) / (Math.pow(1 + rate, nper) - 1)
          },
          NPV: function(rate, ...cashflows) {
            return cashflows.reduce((sum, cf, t) => sum + cf / Math.pow(1 + rate, t + 1), 0)
          },
        }, { override: false })
      } catch { /* ignore */ }
    }
    mathLib = m
  })
  getAlgebrite().then(a => { algLib = a })

  // Patterns that should go directly to Algebrite (symbolic CAS)
  const CAS_RE = /\b(integral|integrate|roots|solve|factor|expand|taylor|defint|laplace)\b/i

  // Comprehensive date/time math
  function tryDateMath(expr) {
    const lower = expr.toLowerCase().trim()
    const DAY_NAMES = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday']
    const UNITS = 'second|seconds|minute|minutes|min|mins|hour|hours|hr|hrs|day|days|week|weeks|month|months|year|years'

    function parseBase(s) {
      s = s.trim()
      const now = new Date()
      const today = new Date(now); today.setHours(0,0,0,0)
      if (s === 'today') return new Date(today)
      if (s === 'tomorrow')  { const d = new Date(today); d.setDate(d.getDate()+1); return d }
      if (s === 'yesterday') { const d = new Date(today); d.setDate(d.getDate()-1); return d }
      if (s === 'now') return new Date(now)
      // next/last/this [weekday]
      const nextDayM = s.match(/^(?:next|this)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/)
      if (nextDayM) {
        const target = DAY_NAMES.indexOf(nextDayM[1])
        const d = new Date(today); let diff = target - d.getDay(); if (diff <= 0) diff += 7
        d.setDate(d.getDate() + diff); return d
      }
      const lastDayM = s.match(/^last\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/)
      if (lastDayM) {
        const target = DAY_NAMES.indexOf(lastDayM[1])
        const d = new Date(today); let diff = d.getDay() - target; if (diff <= 0) diff += 7
        d.setDate(d.getDate() - diff); return d
      }
      // next/last week/month/year
      if (s === 'next week')  { const d = new Date(today); d.setDate(d.getDate()+7); return d }
      if (s === 'last week')  { const d = new Date(today); d.setDate(d.getDate()-7); return d }
      if (s === 'next month') { const d = new Date(today); d.setMonth(d.getMonth()+1); return d }
      if (s === 'last month') { const d = new Date(today); d.setMonth(d.getMonth()-1); return d }
      if (s === 'next year')  { const d = new Date(today); d.setFullYear(d.getFullYear()+1); return d }
      if (s === 'last year')  { const d = new Date(today); d.setFullYear(d.getFullYear()-1); return d }
      // time: "9am", "9:30am", "14:30"
      const timeM = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/)
      if (timeM) {
        const d = new Date(now); let h = parseInt(timeM[1],10); const m = parseInt(timeM[2]||'0',10)
        if (timeM[3]==='pm' && h!==12) h+=12; if (timeM[3]==='am' && h===12) h=0
        d.setHours(h,m,0,0); return d
      }
      const time24M = s.match(/^(\d{1,2}):(\d{2})$/)
      if (time24M) { const d = new Date(now); d.setHours(parseInt(time24M[1],10),parseInt(time24M[2],10),0,0); return d }
      // Try JS date parsing
      const parsed = new Date(s)
      if (!isNaN(parsed.getTime())) return parsed
      return null
    }

    function applyDur(d, sign, n, unit) {
      const r = new Date(d)
      const u = unit.toLowerCase()
      if (u.startsWith('sec')) r.setSeconds(r.getSeconds()+sign*n)
      else if (u.startsWith('min') || u==='min' || u==='mins') r.setMinutes(r.getMinutes()+sign*n)
      else if (u.startsWith('hour') || u==='hr' || u==='hrs') r.setHours(r.getHours()+sign*n)
      else if (u.startsWith('day')) r.setDate(r.getDate()+sign*n)
      else if (u.startsWith('week')) r.setDate(r.getDate()+sign*n*7)
      else if (u.startsWith('month')) r.setMonth(r.getMonth()+sign*n)
      else if (u.startsWith('year')) r.setFullYear(r.getFullYear()+sign*n)
      return r
    }

    function isTimeUnit(u) { return /^(sec|min|hour|hr)/.test(u.toLowerCase()) || u==='mins' || u==='hrs' }

    function fmtDate(d) { return d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric'}) }
    function fmtTime(d) { return d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'})+' @ '+d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}) }
    function fmt(d, wasTime) { return wasTime ? fmtTime(d) : fmtDate(d) }

    // Standalone: "today", "tomorrow", "yesterday", "next monday", etc.
    const base = parseBase(lower)
    if (base) return fmtDate(base)

    // "base +/- N units"
    const durRe = new RegExp(`^(.+?)\\s*([+-])\\s*(\\d+)\\s*(${UNITS})$`)
    const durM = lower.match(durRe)
    if (durM) {
      const b = parseBase(durM[1].trim())
      if (b) {
        const sign = durM[2]==='+' ? 1 : -1
        const n = parseInt(durM[3],10), u = durM[4]
        return fmt(applyDur(b, sign, n, u), isTimeUnit(u))
      }
    }

    // "N units ago"
    const agoM = lower.match(new RegExp(`^(\\d+)\\s*(${UNITS})\\s+ago$`))
    if (agoM) {
      const r = applyDur(new Date(), -1, parseInt(agoM[1],10), agoM[2])
      return fmt(r, isTimeUnit(agoM[2]))
    }
    // "in N units"
    const inM = lower.match(new RegExp(`^in\\s+(\\d+)\\s*(${UNITS})$`))
    if (inM) {
      const r = applyDur(new Date(), 1, parseInt(inM[1],10), inM[2])
      return fmt(r, isTimeUnit(inM[2]))
    }

    // "days until [date]" / "hours until [date]"
    const untilM = lower.match(/^(?:how many )?(days|hours|weeks) until (.+)$/)
    if (untilM) {
      const d = parseBase(untilM[2]) || new Date(untilM[2])
      if (d && !isNaN(d.getTime())) {
        const ms = d.getTime() - Date.now()
        if (untilM[1]==='days')  { const n=Math.ceil(ms/86400000); return `${n} day${Math.abs(n)!==1?'s':''}` }
        if (untilM[1]==='hours') { const n=Math.ceil(ms/3600000); return `${n} hour${Math.abs(n)!==1?'s':''}` }
        if (untilM[1]==='weeks') { const n=Math.ceil(ms/604800000); return `${n} week${Math.abs(n)!==1?'s':''}` }
      }
    }

    // "days/hours since [date]"
    const sinceM = lower.match(/^(?:how many )?(days|hours|weeks) since (.+)$/)
    if (sinceM) {
      const d = parseBase(sinceM[2]) || new Date(sinceM[2])
      if (d && !isNaN(d.getTime())) {
        const ms = Date.now() - d.getTime()
        if (sinceM[1]==='days')  { const n=Math.floor(ms/86400000); return `${n} day${n!==1?'s':''}` }
        if (sinceM[1]==='hours') { const n=Math.floor(ms/3600000); return `${n} hour${n!==1?'s':''}` }
        if (sinceM[1]==='weeks') { const n=Math.floor(ms/604800000); return `${n} week${n!==1?'s':''}` }
      }
    }

    return null
  }

  // Convert natural language math to evaluatable expression
  function naturalLangToExpr(expr) {
    let s = expr.toLowerCase()
    s = s.replace(/^(?:what is|calculate|compute|find|evaluate)\s+/i, '')
    s = s.replace(/\bplus\b/g, '+')
    s = s.replace(/\bminus\b/g, '-')
    s = s.replace(/\btimes\b/g, '*')
    s = s.replace(/\bdivided by\b/g, '/')
    s = s.replace(/\bsquared\b/g, '^2')
    s = s.replace(/\bcubed\b/g, '^3')
    s = s.replace(/\bsquare root of\b/g, 'sqrt(')
    // Close open sqrt( if we added it
    if (s.includes('sqrt(') && !s.includes(')')) s += ')'
    s = s.replace(/\bpercent of\b/g, '/100 *')
    return s
  }

  // ─── Variable name registry ───────────────────────────────────────────────
  // Stable mapping from lowercase display name → internal math.js-safe token.
  // Each editor instance gets its own registry via closure.
  const _nameToToken = new Map()
  let _tokenCtr = 0
  function getVarToken(name) {
    const key = name.toLowerCase()
    if (!_nameToToken.has(key)) _nameToToken.set(key, `_mv${_tokenCtr++}`)
    return _nameToToken.get(key)
  }

  // ─── Document scope scan ──────────────────────────────────────────────────
  // Scans all lines top-to-bottom for "Name: expression" patterns.
  // Returns { varDefs, scope } where scope maps token → numeric value.
  function buildDocScope(state) {
    const varDefs = []  // [{ name, token, value, lineFrom, lineEnd, nameFrom, nameEnd, colonFrom, rhsFrom }]
    const scope   = {}
    for (let ln = 1; ln <= state.doc.lines; ln++) {
      const line = state.doc.line(ln)
      const m    = line.text.match(/^(.+?):\s*(.+)$/)
      if (!m) continue
      const name   = m[1].trim()
      const valStr = m[2].trim()
      // Skip markdown artifacts (headings, lists, blockquotes, URLs, code fences…)
      if (!name || /^[-*#>|`\\]/.test(name) || /[:/\\]/.test(name)) continue
      // Variable names must start with a letter and be reasonably short
      if (!/^[a-zA-Z]/.test(name) || name.length > 50) continue
      // Only treat as a variable definition if the RHS looks numeric-capable:
      // it must contain at least one digit, OR reference an already-defined variable.
      // This prevents plain prose lines like "Note: See above" from being highlighted.
      const hasDigit = /\d/.test(valStr)
      const refsKnownVar = varDefs.some(v => {
        const esc = v.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        return new RegExp(`(?<![_a-zA-Z0-9])${esc}(?![_a-zA-Z0-9])`, 'i').test(valStr)
      })
      if (!hasDigit && !refsKnownVar) continue
      const token       = getVarToken(name)
      const substituted = applyVarSubstitution(valStr, varDefs)
      let value = null
      if (mathLib) {
        try {
          const r = mathLib.evaluate(substituted, { ...scope })
          if (r !== undefined && r !== null && typeof r !== 'function') {
            const n = typeof r === 'number' ? r : parseFloat(String(r))
            if (!isNaN(n)) value = n
          }
        } catch { /* non-numeric def — still register for autocomplete/deco */ }
      }
      // Compute exact character positions for decorations
      const nameFrom  = line.from + m[1].search(/\S/)   // skip any leading spaces
      const nameEnd   = nameFrom + name.length
      const colonFrom = line.from + m[1].length          // position of the ':'
      const rhsFrom   = line.from + m[0].length - m[2].length  // start of RHS text
      varDefs.push({ name, token, value, lineFrom: line.from, lineEnd: line.to, nameFrom, nameEnd, colonFrom, rhsFrom })
      if (value !== null) scope[token] = value
    }
    return { varDefs, scope }
  }

  // ─── Variable substitution ────────────────────────────────────────────────
  // Replaces multi-word variable names (and "per X" sugar) with internal tokens.
  function applyVarSubstitution(expr, varDefs) {
    let result = expr
    // "0.25 per mile" → "0.25 * _mv1"
    result = result.replace(/\bper\s+([a-zA-Z][a-zA-Z0-9 ]*)/g, (_, unit) => {
      const match = varDefs.find(v => v.name.toLowerCase() === unit.trim().toLowerCase() && v.value !== null)
      return match ? `* ${match.token}` : `/ ${unit.trim()}`
    })
    // Replace variable names longest-first to avoid partial matches
    const sorted = [...varDefs].sort((a, b) => b.name.length - a.name.length)
    for (const { name, token } of sorted) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      result = result.replace(new RegExp(`(?<![_a-zA-Z0-9])${escaped}(?![_a-zA-Z0-9])`, 'gi'), token)
    }
    return result
  }

  // ─── Scope state field ───────────────────────────────────────────────────
  // Caches the document scope; rebuilt only on doc changes, not cursor moves.
  const docScopeField = cm.state.StateField.define({
    create: state => buildDocScope(state),
    update: (val, tr) => tr.docChanged ? buildDocScope(tr.state) : val,
  })

  function evalExpr(expr, scope = {}) {
    // Strip thousands-separator commas (e.g. 1,000 → 1000, 1,000,000 → 1000000)
    expr = expr.replace(/\b(\d{1,3}(?:,\d{3})+)\b/g, m => m.replace(/,/g, ''))

    // Try date math first
    const dateResult = tryDateMath(expr)
    if (dateResult !== null) return dateResult

    // Natural language conversion
    const naturalExpr = naturalLangToExpr(expr)

    // Route CAS-like expressions to Algebrite first
    if (algLib && CAS_RE.test(expr)) {
      try {
        const r = algLib.run(expr)
        if (r && r !== 'Stop' && r !== 'nil') return r
      } catch { /* fall through to mathjs */ }
    }
    // Try math.js (also handles unit conversions like "5 km to miles")
    if (mathLib) {
      try {
        const result = mathLib.evaluate(expr, { ...scope })
        if (result === undefined || result === null || typeof result === 'function') return null
        return String(typeof result === 'object' && result.toString ? result.toString() : result)
      } catch { /* try natural language variant */ }
      // Try the natural language converted expression
      if (naturalExpr !== expr) {
        try {
          const result = mathLib.evaluate(naturalExpr, { ...scope })
          if (result !== undefined && result !== null && typeof result !== 'function') {
            return String(typeof result === 'object' && result.toString ? result.toString() : result)
          }
        } catch { /* fall through */ }
      }
    }
    // Algebrite fallback for anything math.js couldn't handle
    if (algLib) {
      try {
        const r = algLib.run(expr)
        if (r && r !== 'Stop' && r !== 'nil') return r
      } catch { /* give up */ }
    }
    return null
  }

  const mathPlugin = ViewPlugin.fromClass(class {
    constructor(view) { this.deco = Decoration.none; this._hint = null; this._compute(view) }
    update(upd) { if (upd.docChanged || upd.selectionSet) this._compute(upd.view) }
    _compute(view) {
      if (!mathLib && !algLib) { this.deco = Decoration.none; this._hint = null; return }
      const { state } = view
      const cur = state.selection.main
      if (!cur.empty) { this.deco = Decoration.none; this._hint = null; return }
      const line = state.doc.lineAt(cur.head)
      const col = cur.head - line.from
      const textBefore = line.text.slice(0, col)

      // Read cached scope (rebuilt by docScopeField only on doc changes)
      const { varDefs, scope } = state.field(docScopeField)

      // Support =:.N precision syntax: "2*32.12321 =:.2" rounds to 2 decimals
      const precMatch = textBefore.match(/^(.*?)([^=\n]+)=:\.(\d+)\s*$/)
      const plainMatch = textBefore.match(/^(.*?)([^=\n]+)=\s*$/)
      const match = precMatch || plainMatch
      if (!match) { this.deco = Decoration.none; this._hint = null; return }
      const precision = precMatch ? parseInt(precMatch[3]) : null
      let rawExpr = match[2].trim()

      // Strip "Name: " prefix from variable definition lines so the RHS is evaluated.
      // e.g. "Catering price: Friends * Food price =" → evaluate "Friends * Food price"
      const colonM = rawExpr.match(/^[^:]+:\s*(.+)$/)
      if (colonM) rawExpr = colonM[1].trim()

      // Strip list prefixes and markdown formatting
      rawExpr = rawExpr.replace(/^(?:[-*+]|\d+\.)\s+/, '')
      rawExpr = rawExpr.replace(/\*{2,}|[_~`]+/g, '')

      // Substitute variable names → tokens
      let expr = applyVarSubstitution(rawExpr, varDefs)

      // Check if this expression references any defined variables
      const hasVarRef = varDefs.some(v => v.value !== null && expr.includes(v.token))

      if (!hasVarRef) {
        // Original math isolation logic for plain numeric expressions
        const mathStart = expr.match(/((?:(?:sin|cos|tan|log|ln|sqrt|abs|ceil|floor|round|exp|pow|FV|PV|PMT|NPV|integral|solve|factor|expand)\s*\(|[-+]?\s*[\d(]).*$)/i)
        if (mathStart) expr = mathStart[1].trim()
        else {
          const mathPart = expr.match(/([\d(][\d\s+\-*/^().,%]*[\d)])\s*$/)
          if (mathPart) expr = mathPart[1].trim()
        }
        if (!expr || /^[a-zA-Z]{4,}$/.test(expr)) { this.deco = Decoration.none; this._hint = null; return }
        if (!/[+\-*/^%()]/.test(expr) && !/\b(sin|cos|tan|log|ln|sqrt|abs|ceil|floor|round|exp|pow|FV|PV|PMT|NPV)\s*\(/i.test(expr) && !/\bto\b/i.test(expr)) {
          this.deco = Decoration.none; this._hint = null; return
        }
      }

      let result = evalExpr(expr, scope)
      if (!result) { this.deco = Decoration.none; this._hint = null; return }

      // Apply precision rounding if =:.N was used
      if (precision !== null) {
        const num = parseFloat(result)
        if (!isNaN(num)) result = num.toFixed(precision)
      }

      const resultStr = ' ' + result
      const builder = new cm.state.RangeSetBuilder()
      try {
        builder.add(cur.head, cur.head, Decoration.widget({ widget: new MathGhostWidget(resultStr), side: 1 }))
      } catch { /* ignore */ }
      this.deco = builder.finish()
      this._hint = { pos: cur.head, insert: resultStr }
    }
    get decorations() { return this.deco }
  }, { decorations: v => v.decorations })

  // ─── Variable definition decorator ───────────────────────────────────────
  // Colors: name (pastel orange), colon (dim orange), var refs everywhere (blue).
  const varDecoPlugin = ViewPlugin.fromClass(class {
    constructor(view) { this.deco = Decoration.none; this._rebuild(view) }
    update(upd) { if (upd.docChanged) this._rebuild(upd.view) }
    _rebuild(view) {
      const { varDefs } = view.state.field(docScopeField)
      if (!varDefs.length) { this.deco = Decoration.none; return }
      const liveVars = varDefs.filter(v => v.value !== null).sort((a, b) => b.name.length - a.name.length)

      // Track which lines are definition lines so we skip them in the ref scan below
      const defLineFroms = new Set(varDefs.map(v => v.lineFrom))

      // Helper: scan a text segment for variable name references, push into ranges[]
      function addRefs(ranges, basePos, text) {
        if (!liveVars.length) return
        const covered = []
        for (const { name } of liveVars) {
          const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const re = new RegExp(`(?<![_a-zA-Z0-9])${escaped}(?![_a-zA-Z0-9])`, 'gi')
          let hit
          while ((hit = re.exec(text)) !== null) {
            const from = basePos + hit.index
            const to   = from + name.length
            if (covered.some(r => from < r.to && to > r.from)) continue
            covered.push({ from, to })
            ranges.push({ from, to, cls: 'cm-math-ref' })
          }
        }
      }

      // Collect all ranges then sort — RangeSetBuilder requires ascending order
      const ranges = []

      // 1. Definition lines: name, colon, RHS references
      for (const { nameFrom, nameEnd, colonFrom, rhsFrom, lineEnd, value } of varDefs) {
        ranges.push({ from: nameFrom, to: nameEnd, cls: value !== null ? 'cm-math-var cm-math-var-live' : 'cm-math-var' })
        ranges.push({ from: colonFrom, to: colonFrom + 1, cls: 'cm-math-colon' })
        if (rhsFrom < lineEnd)
          addRefs(ranges, rhsFrom, view.state.doc.sliceString(rhsFrom, lineEnd))
      }

      // 2. Non-definition lines: highlight any variable references on lines that
      //    look like expressions (contain = or math operators)
      for (let ln = 1; ln <= view.state.doc.lines; ln++) {
        const line = view.state.doc.line(ln)
        if (defLineFroms.has(line.from)) continue  // already handled
        const text = line.text
        if (!text.includes('=') && !/[+\-*/^%]/.test(text)) continue
        addRefs(ranges, line.from, text)
      }

      ranges.sort((a, b) => a.from - b.from || a.to - b.to)
      const builder = new cm.state.RangeSetBuilder()
      for (const { from, to, cls } of ranges) builder.add(from, to, Decoration.mark({ class: cls }))
      this.deco = builder.finish()
    }
    get decorations() { return this.deco }
  }, { decorations: v => v.deco })

  // ─── Variable autocomplete ────────────────────────────────────────────────
  // Triggers on lines containing ":" or "=" and offers defined variable names.
  function varCompleteSource(context) {
    const line     = context.state.doc.lineAt(context.pos)
    const lineText = line.text
    // Only activate on expression/definition lines
    if (!lineText.includes(':') && !lineText.includes('=')) return null
    const { varDefs } = buildDocScope(context.state)
    const liveVars = varDefs.filter(v => v.value !== null)
    if (!liveVars.length) return null
    const word = context.matchBefore(/[a-zA-Z][a-zA-Z0-9 ]{1,40}/)
    if (!word || (word.from === word.to && !context.explicit)) return null
    const typed = word.text.toLowerCase().trimEnd()
    if (typed.length < 2) return null
    const options = liveVars
      .filter(v => v.name.toLowerCase().startsWith(typed) && v.name.toLowerCase() !== typed)
      .map(v => ({ label: v.name, detail: `= ${v.value}`, type: 'variable', apply: v.name }))
    if (!options.length) return null
    return { from: word.from, options, validFor: /^[a-zA-Z][a-zA-Z0-9 ]*$/ }
  }

  const varAutocompletion = cm.autocomplete.autocompletion({
    override: [varCompleteSource],
    icons: false,
    closeOnBlur: true,
  })

  // ─── Update animation ────────────────────────────────────────────────────
  // Tracks which line numbers currently have a live-update animation playing.
  const varUpdateEffect    = cm.state.StateEffect.define()
  const varUpdateField     = cm.state.StateField.define({
    create: () => new Set(),
    update: (val, tr) => {
      for (const e of tr.effects) if (e.is(varUpdateEffect)) return new Set(e.value)
      return val
    },
  })

  // Decorates updated result numbers with the shimmer animation class.
  const varResultDecoPlugin = ViewPlugin.fromClass(class {
    constructor(view) { this.deco = Decoration.none }
    update(upd) {
      const updatedLines = upd.state.field(varUpdateField)
      if (!updatedLines.size) { this.deco = Decoration.none; return }
      const builder = new cm.state.RangeSetBuilder()
      const sorted = [...updatedLines].sort((a, b) => a - b)
      for (const ln of sorted) {
        if (ln > upd.state.doc.lines) continue
        const line = upd.state.doc.line(ln)
        const m = line.text.match(/^(.*?\S)(\s*=\s*)(-?\d+(?:\.\d+)?)/)
        if (!m) continue
        const numFrom = line.from + m[1].length + m[2].length
        builder.add(numFrom, numFrom + m[3].length, Decoration.mark({ class: 'cm-math-live-updated' }))
      }
      this.deco = builder.finish()
    }
    get decorations() { return this.deco }
  }, { decorations: v => v.deco })

  // ─── Live result updater ─────────────────────────────────────────────────
  // When a variable value changes, auto-updates any Tab-accepted results in the doc.
  const liveResultAnnotation = cm.state.Annotation.define()

  const liveResultPlugin = ViewPlugin.fromClass(class {
    constructor() { this._clearTimer = null }
    update(upd) {
      if (!upd.docChanged) return
      if (upd.transactions.some(tr => tr.annotation(liveResultAnnotation))) return
      if (!mathLib) return
      const { varDefs, scope } = upd.state.field(docScopeField)
      if (!varDefs.length) return
      const curLine = upd.state.doc.lineAt(upd.state.selection.main.head).number
      const changes = []
      const updatedLineNums = []
      for (let ln = 1; ln <= upd.state.doc.lines; ln++) {
        if (ln === curLine) continue  // skip line being typed on
        const line = upd.state.doc.line(ln)
        // Match lines ending with "= <number>" — a previously accepted ghost result
        const m = line.text.match(/^(.*?\S)(\s*=\s*)(-?\d+(?:\.\d+)?)(\s*)$/)
        if (!m) continue
        let rawExpr = m[1].trim()
        const colonM = rawExpr.match(/^[^:]+:\s*(.+)$/)
        if (colonM) rawExpr = colonM[1].trim()
        rawExpr = rawExpr.replace(/^(?:[-*+]|\d+\.)\s+/, '').replace(/\*{2,}|[_~`]+/g, '')
        const expr = applyVarSubstitution(rawExpr, varDefs)
        if (!varDefs.some(v => v.value !== null && expr.includes(v.token))) continue
        const result = evalExpr(expr, scope)
        if (!result) continue
        const newNum    = parseFloat(result)
        const storedNum = parseFloat(m[3])
        if (isNaN(newNum) || isNaN(storedNum) || Math.abs(newNum - storedNum) < 1e-10) continue
        const numFrom = line.from + m[1].length + m[2].length
        changes.push({ from: numFrom, to: numFrom + m[3].length, insert: result })
        updatedLineNums.push(ln)
      }
      if (!changes.length) return
      const view = upd.view
      // Defer dispatch to avoid mutating state inside an update cycle
      setTimeout(() => {
        try {
          view.dispatch({
            changes,
            annotations: liveResultAnnotation.of(true),
            effects: [varUpdateEffect.of(new Set(updatedLineNums))],
          })
          // Guard: cancel any pending clear so rapid updates don't retrigger the animation
          clearTimeout(this._clearTimer)
          this._clearTimer = setTimeout(() => {
            try { view.dispatch({ effects: [varUpdateEffect.of(new Set())] }) } catch {}
          }, 1800)  // matches animation duration + buffer
        } catch { /* view destroyed */ }
      }, 0)
    }
  })

  const mathKeymap = cm.view.keymap.of([{
    key: 'Tab',
    run: view => {
      const plugin = view.plugin(mathPlugin)
      if (!plugin?._hint) return false
      const { pos, insert } = plugin._hint
      if (view.state.selection.main.head !== pos) return false
      view.dispatch({
        changes: { from: pos, to: pos, insert },
        selection: { anchor: pos + insert.length },
      })
      return true
    },
  }])

  // ─── Prose number decorator ───────────────────────────────────────────────
  // Applies uniform tabular-nums + slightly heavier weight to all digit sequences
  // in editor text (the highlight style only fires inside code contexts).
  const _numRE   = /(?<![_a-zA-Z#])\d+(?:[.,]\d+)*/g
  const _numMark = Decoration.mark({ class: 'cm-nb-num' })
  const numberDecoPlugin = ViewPlugin.fromClass(class {
    constructor(view) { this.deco = this._build(view) }
    update(upd) { if (upd.docChanged || upd.viewportChanged) this.deco = this._build(upd.view) }
    _build(view) {
      const builder = new cm.state.RangeSetBuilder()
      for (const { from, to } of view.visibleRanges) {
        let pos = from
        while (pos <= to) {
          const line = view.state.doc.lineAt(pos)
          const end  = Math.min(line.to, to)
          _numRE.lastIndex = 0
          const text = line.text.slice(pos - line.from, end - line.from)
          let m
          while ((m = _numRE.exec(text)) !== null) {
            const s = pos + m.index
            try { builder.add(s, s + m[0].length, _numMark) } catch {}
          }
          pos = line.to + 1
        }
      }
      return builder.finish()
    }
    get decorations() { return this.deco }
  }, { decorations: v => v.deco })

  return [docScopeField, varUpdateField, mathPlugin, varDecoPlugin, varResultDecoPlugin, numberDecoPlugin, liveResultPlugin, mathKeymap, varAutocompletion]
}

// ─── /table slash command ────────────────────────────────────────────────────
// Typing `/table` or `/table NxM` then Enter inserts a markdown table template.
function makeTableCommand(cm) {
  const { Prec } = cm.state
  return Prec.high(cm.view.keymap.of([{
    key: 'Enter',
    run: (view) => {
      const { state } = view
      const line = state.doc.lineAt(state.selection.main.head)
      const match = line.text.match(/^\s*\/table(?:\s+(\d+)x(\d+))?\s*$/)
      if (!match) return false
      const cols = Math.min(parseInt(match[1]) || 3, 10)
      const rows = Math.min(parseInt(match[2]) || 2, 20)
      const header = '| ' + Array.from({ length: cols }, (_, i) => `Header ${i + 1}`).join(' | ') + ' |'
      const sep = '| ' + Array.from({ length: cols }, () => '---').join(' | ') + ' |'
      const row = '| ' + Array.from({ length: cols }, () => '   ').join(' | ') + ' |'
      const table = [header, sep, ...Array(rows).fill(row)].join('\n')
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: table },
        selection: { anchor: line.from + 2 },
      })
      return true
    },
  }]))
}

// ─── Widgets ─────────────────────────────────────────────────────────────────
class HRWidget {
  toDOM() {
    const d = document.createElement('div')
    d.className = 'cm-hr'
    return d
  }
  eq(o) { return o instanceof HRWidget }
  compare(o) { return o instanceof HRWidget }
  destroy() {}
  ignoreEvent() { return true }
  get estimatedHeight() { return 2 }
  coordsAt() { return null }
}

class CheckboxWidget {
  constructor(checked, pos) { this.checked = checked; this.pos = pos }
  toDOM() {
    const s = document.createElement('span')
    s.className = 'cm-cb' + (this.checked ? ' cm-cb-on' : '')
    s.textContent = this.checked ? '✓' : ''
    s.dataset.pos = String(this.pos)
    return s
  }
  eq(o) { return o instanceof CheckboxWidget && o.checked === this.checked && o.pos === this.pos }
  compare(o) { return o instanceof CheckboxWidget && o.checked === this.checked && o.pos === this.pos }
  destroy() {}
  ignoreEvent() { return false }
  coordsAt() { return null }
}

class ImgWidget {
  constructor(src, alt, notebookDir = null, from = -1, width = 0, align = null) {
    this.src = src; this.alt = alt; this.notebookDir = notebookDir
    this.from = from  // doc offset for write-back on resize
    this.width = width  // user-set pixel width (0 = auto)
    this.align = align  // null | 'left' | 'right' | 'center'
  }
  _applyAlign(wrap) {
    wrap.style.float = ''
    wrap.style.marginLeft = ''
    wrap.style.marginRight = ''
    wrap.style.marginBottom = ''
    wrap.style.display = ''
    if (this.align === 'left')   { wrap.style.float = 'left';  wrap.style.marginRight = '1em'; wrap.style.marginBottom = '0.5em' }
    if (this.align === 'right')  { wrap.style.float = 'right'; wrap.style.marginLeft  = '1em'; wrap.style.marginBottom = '0.5em' }
    if (this.align === 'center') { wrap.style.display = 'block'; wrap.style.marginLeft = 'auto'; wrap.style.marginRight = 'auto' }
  }
  toDOM(view) {
    const wrap = document.createElement('div')
    wrap.className = 'cm-img-wrap'
    this._applyAlign(wrap)
    const img = document.createElement('img')
    // Resolve relative paths (./images/...) or absolute paths to Tauri asset:// URLs
    let resolvedSrc = this.src
    if (this.src.startsWith('./') && this.notebookDir && _convertFileSrc) {
      resolvedSrc = _convertFileSrc(this.notebookDir + '/' + this.src.slice(2))
    } else if (_convertFileSrc && (this.src.startsWith('/') || /^[A-Za-z]:\\/.test(this.src))) {
      resolvedSrc = _convertFileSrc(this.src)
    }
    img.src = resolvedSrc; img.alt = this.alt; img.loading = 'lazy'
    img.className = 'cm-img'
    img.draggable = false
    img.setAttribute('draggable', 'false')
    if (this.width) img.style.width = this.width + 'px'
    img.onerror = () => {
      img.style.display = 'none'
      const ph = document.createElement('span')
      ph.className = 'cm-img-err'
      ph.textContent = this.alt || this.src || 'image'
      wrap.appendChild(ph)
    }
    wrap.appendChild(img)

    // ── Resize handle ──────────────────────────────────────────────────────
    if (view && this.from >= 0) {
      const handle = document.createElement('div')
      handle.className = 'cm-img-resize-handle'
      handle.title = 'Drag to resize'
      let startX = 0, startW = 0
      handle.addEventListener('pointerdown', e => {
        e.preventDefault(); e.stopPropagation()
        startX = e.clientX
        startW = img.offsetWidth || this.width || 200
        handle.setPointerCapture(e.pointerId)
        const onMove = ev => {
          const newW = Math.max(60, startW + (ev.clientX - startX))
          img.style.width = newW + 'px'
        }
        const onUp = () => {
          handle.removeEventListener('pointermove', onMove)
          const newW = Math.max(60, Math.round(img.offsetWidth || startW))
          if (!view.state || this.from >= view.state.doc.length) return
          const line = view.state.doc.lineAt(this.from)
          const raw = line.text
          // Remove existing =Nx spec then append new width before closing )
          const base = raw.replace(/\s+=\d+x(?=\s*\))/, '')
          const updated = base.replace(/\)(\s*)$/, ` =${newW}x)$1`)
          if (updated !== raw) {
            view.dispatch({ changes: { from: line.from, to: line.to, insert: updated }, scrollIntoView: false })
          }
        }
        handle.addEventListener('pointermove', onMove)
        handle.addEventListener('pointerup', onUp, { once: true })
      })
      wrap.appendChild(handle)
    }

    return wrap
  }
  eq(o) { return o instanceof ImgWidget && o.src === this.src && o.notebookDir === this.notebookDir && o.width === this.width && o.align === this.align }
  compare(o) { return o instanceof ImgWidget && o.src === this.src && o.notebookDir === this.notebookDir && o.width === this.width && o.align === this.align }
  // Called when eq() is false — update DOM in-place to avoid flash
  updateDOM(dom) {
    const img = dom.querySelector('.cm-img')
    if (!img) return false
    let resolvedSrc = this.src
    if (this.src.startsWith('./') && this.notebookDir && _convertFileSrc) {
      resolvedSrc = _convertFileSrc(this.notebookDir + '/' + this.src.slice(2))
    } else if (_convertFileSrc && (this.src.startsWith('/') || /^[A-Za-z]:\\/.test(this.src))) {
      resolvedSrc = _convertFileSrc(this.src)
    }
    img.src = resolvedSrc
    img.style.width = this.width ? this.width + 'px' : ''
    this._applyAlign(dom)
    return true  // reuse DOM, no remount flash
  }
  destroy() {}
  ignoreEvent() { return false }
  get estimatedHeight() { return 160 }
  coordsAt() { return null }
}

// ─── Timer persistence — survives widget reconstruction within a session ──────
const _timerPersist = new Map() // rawLine → { remaining: number, paused: boolean }

// ─── Due-date helpers ────────────────────────────────────────────────────────
function parseDueDate(expr) {
  try {
    if (!expr) return null
    // Relative: +2d, +3h
    const rel = expr.match(/^\+(\d+)([dh])$/)
    if (rel) {
      const n = parseInt(rel[1]), unit = rel[2]
      const d = new Date()
      if (unit === 'd') d.setDate(d.getDate() + n)
      else d.setHours(d.getHours() + n)
      return d
    }
    // HH:MM (time today)
    const tod = expr.match(/^(\d{1,2}):(\d{2})$/)
    if (tod) {
      const d = new Date()
      d.setHours(parseInt(tod[1]), parseInt(tod[2]), 0, 0)
      return d
    }
    // YYYY-MM-DD or YYYY-MM-DD,HH:MM
    const ymd = expr.match(/^(\d{4}-\d{2}-\d{2})(?:,(\d{1,2}:\d{2}))?$/)
    if (ymd) return new Date(ymd[2] ? `${ymd[1]}T${ymd[2]}` : `${ymd[1]}T00:00`)
    // DD-MM-YYYY or DD-MM-YYYY,HH:MM
    const dmy4 = expr.match(/^(\d{2})-(\d{2})-(\d{4})(?:,(\d{1,2}:\d{2}))?$/)
    if (dmy4) {
      const [, dd, mm, yyyy, t] = dmy4
      return new Date(t ? `${yyyy}-${mm}-${dd}T${t}` : `${yyyy}-${mm}-${dd}T00:00`)
    }
    // DD-MM-YY or DD-MM-YY,HH:MM (2-digit year → 2000s)
    const dmy2 = expr.match(/^(\d{2})-(\d{2})-(\d{2})(?:,(\d{1,2}:\d{2}))?$/)
    if (dmy2) {
      const [, dd, mm, yy, t] = dmy2
      const yyyy = 2000 + parseInt(yy)
      return new Date(t ? `${yyyy}-${mm}-${dd}T${t}` : `${yyyy}-${mm}-${dd}T00:00`)
    }
    return null
  } catch { return null }
}
function formatDueBadge(expr) {
  const d = parseDueDate(expr)
  if (!d) return expr
  // Relative: +2d or +2h → show as-is
  if (/^\+\d+[dh]$/.test(expr)) return expr
  // Time-only: @HH:MM
  if (/^\d{1,2}:\d{2}$/.test(expr)) {
    const [h, m] = expr.split(':')
    return `@${h.padStart(2, '0')}:${m}`
  }
  // Any format with time (contains comma) → "Mar 18 @14:30"
  const timeMatch = expr.match(/,(\d{1,2}:\d{2})$/)
  if (timeMatch) return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} @${timeMatch[1]}`
  // Date-only → "Mar 18"
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

class DueDateWidget {
  constructor(expr) { this.expr = expr }
  toDOM() {
    const span = document.createElement('span')
    const d = parseDueDate(this.expr)
    const now = new Date()
    const isOverdue = d && d < now
    const isSoon = d && !isOverdue && (d - now) < 1000 * 60 * 60 * 24
    span.className = 'cm-due-badge' + (isOverdue ? ' cm-due-overdue' : isSoon ? ' cm-due-today' : '')
    span.textContent = formatDueBadge(this.expr)
    return span
  }
  eq(o) { return o instanceof DueDateWidget && o.expr === this.expr }
  compare(o) { return o instanceof DueDateWidget && o.expr === this.expr }
  destroy() {}
  ignoreEvent() { return true }
  get estimatedHeight() { return -1 }
  coordsAt() { return null }
}

// ─── ?[question](ref) — review/flashcard question widget ─────────────────────
class QuestionWidget {
  constructor(fullAlt, ref, rawText, from) {
    // Parse "question:answer" — colon separates front from back of card
    const sep = fullAlt.indexOf(':')
    this.question = (sep >= 0 ? fullAlt.slice(0, sep) : fullAlt).trim()
    this.answer   = (sep >= 0 ? fullAlt.slice(sep + 1) : '').trim()
    this.fullAlt  = fullAlt   // preserved for write-back
    this.ref = ref            // '' | 'YYYY-MM-DD' | deck-id
    this.rawText = rawText
    this.from = from
  }
  toDOM(cmView) {
    const wrap = document.createElement('span')
    wrap.className = 'cm-question-widget'

    const isDate = /^\d{4}-\d{2}-\d{2}$/.test(this.ref)
    const decks = (typeof useAppStore !== 'undefined' ? useAppStore.getState().flashcardDecks : null) || []
    const linkedDeck = this.ref && !isDate ? decks.find(d => d.id === this.ref) : null

    const badge = document.createElement('span')
    const qText = this.question || '…'
    const mkSpan = (cls, text) => { const s = document.createElement('span'); s.className = cls; s.textContent = text; return s }
    if (linkedDeck) {
      badge.className = 'cm-question-badge cm-question-flash'
      badge.appendChild(mkSpan('cm-q-text', qText))
      badge.appendChild(mkSpan('cm-q-ref', `\uD83C\uDFA0 ${linkedDeck.title}`))
    } else if (isDate) {
      badge.className = 'cm-question-badge cm-question-date'
      badge.appendChild(mkSpan('cm-q-text', qText))
      badge.appendChild(mkSpan('cm-q-ref', `\uD83D\uDDD3 ${this.ref}`))
    } else {
      badge.className = 'cm-question-badge cm-question-open'
      badge.appendChild(mkSpan('cm-q-mark', '?'))
      badge.appendChild(mkSpan('cm-q-text', qText))
    }

    badge.onclick = (e) => {
      e.preventDefault(); e.stopPropagation()
      const existing = document.querySelector('.cm-question-dropdown')
      if (existing) {
        const isSame = existing._sourceBadge === badge
        existing.remove()
        if (isSame) return
      }

      const dropdown = document.createElement('div')
      dropdown.className = 'cm-question-dropdown'
      dropdown._sourceBadge = badge

      // ── Section: Answer reveal ────────────────────────────
      const answerSection = document.createElement('div')
      answerSection.className = 'cm-qd-section cm-qd-answer-section'
      const answerLabel = document.createElement('div')
      answerLabel.className = 'cm-qd-label'
      answerLabel.textContent = 'Answer'
      answerSection.appendChild(answerLabel)
      if (this.answer) {
        const answerBody = document.createElement('div')
        answerBody.className = 'cm-qd-answer-body cm-qd-answer-hidden'
        answerBody.textContent = this.answer
        const revealBtn = document.createElement('button')
        revealBtn.className = 'cm-qd-reveal-btn'
        revealBtn.textContent = 'Reveal'
        revealBtn.onclick = () => {
          answerBody.classList.toggle('cm-qd-answer-hidden')
          revealBtn.textContent = answerBody.classList.contains('cm-qd-answer-hidden') ? 'Reveal' : 'Hide'
        }
        answerSection.appendChild(answerBody)
        answerSection.appendChild(revealBtn)
      } else {
        const noAnswer = document.createElement('div')
        noAnswer.className = 'cm-qd-none'
        noAnswer.textContent = 'No answer — add one with ?[question:answer]()'
        answerSection.appendChild(noAnswer)
      }
      dropdown.appendChild(answerSection)

      // ── Divider ───────────────────────────────────────────
      const divider = document.createElement('div')
      divider.className = 'cm-qd-divider'
      dropdown.appendChild(divider)

      // ── Section: Set review date ──────────────────────────
      const dateSection = document.createElement('div')
      dateSection.className = 'cm-qd-section'
      const dateLabel = document.createElement('div')
      dateLabel.className = 'cm-qd-label'
      dateLabel.textContent = 'Set review date'
      const dateRow = document.createElement('div')
      dateRow.className = 'cm-qd-row'
      const dateInp = document.createElement('input')
      dateInp.type = 'date'
      dateInp.className = 'cm-qd-date-inp'
      dateInp.value = isDate ? this.ref : ''
      const dateConfirm = document.createElement('button')
      dateConfirm.className = 'cm-qd-confirm'
      dateConfirm.textContent = 'Set'
      dateConfirm.onclick = () => {
        const v = dateInp.value
        if (!v) return
        _replaceInDoc(cmView, this.rawText, `?[${this.fullAlt}](${v})`)
        dropdown.remove()
      }
      dateRow.appendChild(dateInp)
      dateRow.appendChild(dateConfirm)
      dateSection.appendChild(dateLabel)
      dateSection.appendChild(dateRow)

      // ── Section: Add to flashcard deck ────────────────────
      const flashSection = document.createElement('div')
      flashSection.className = 'cm-qd-section'
      const flashLabel = document.createElement('div')
      flashLabel.className = 'cm-qd-label'
      flashLabel.textContent = 'Add to flashcard deck'
      flashSection.appendChild(flashLabel)

      const freshDecks = (typeof useAppStore !== 'undefined' ? useAppStore.getState().flashcardDecks : null) || []
      if (freshDecks.length === 0) {
        const none = document.createElement('div')
        none.className = 'cm-qd-none'
        none.textContent = 'No flashcard decks yet'
        flashSection.appendChild(none)
      } else {
        freshDecks.forEach(deck => {
          const btn = document.createElement('button')
          btn.className = 'cm-qd-deck-btn' + (deck.id === this.ref ? ' cm-qd-deck-active' : '')
          btn.textContent = deck.title || 'Untitled Deck'
          btn.onclick = () => {
            const store = useAppStore.getState()
            const card = {
              id: `fc-${Date.now()}`,
              front: this.question,
              back: this.answer,    // answer after ':' becomes the card back
              nextReview: 0, interval: 1, ease: 2.5, repetitions: 0
            }
            const curDeck = store.flashcardDecks.find(d => d.id === deck.id)
            if (curDeck) {
              store.updateDeck(deck.id, { cards: [...(curDeck.cards || []), card], updatedAt: new Date().toISOString() })
              store.persistFlashcardDecks?.()
            }
            _replaceInDoc(cmView, this.rawText, `?[${this.fullAlt}](${deck.id})`)
            dropdown.remove()
          }
          flashSection.appendChild(btn)
        })
      }

      dropdown.appendChild(dateSection)
      dropdown.appendChild(flashSection)
      document.body.appendChild(dropdown)

      const rect = badge.getBoundingClientRect()
      const ddW = 240
      let left = rect.left
      if (left + ddW > window.innerWidth - 8) left = window.innerWidth - ddW - 8
      dropdown.style.cssText = `position:fixed;top:${rect.bottom + 6}px;left:${left}px;z-index:9999;`

      const close = (ev) => {
        if (!dropdown.contains(ev.target) && ev.target !== badge) {
          dropdown.remove()
          document.removeEventListener('mousedown', close, true)
        }
      }
      setTimeout(() => document.addEventListener('mousedown', close, true), 10)
    }

    wrap.appendChild(badge)
    return wrap
  }
  eq(o) { return o instanceof QuestionWidget && o.fullAlt === this.fullAlt && o.ref === this.ref }
  compare(o) { return this.eq(o) }
  destroy() { document.querySelector('.cm-question-dropdown')?.remove() }
  ignoreEvent() { return true }
  get estimatedHeight() { return -1 }
  coordsAt() { return null }
}

// Time reference widget — renders @HH:MM or @hh:mmam/pm as a styled time badge
class TimeRefWidget {
  constructor(raw, display) { this.raw = raw; this.display = display }
  toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-time-badge'
    span.textContent = this.display
    return span
  }
  eq(o) { return o instanceof TimeRefWidget && o.raw === this.raw }
  compare(o) { return o instanceof TimeRefWidget && o.raw === this.raw }
  destroy() {}
  ignoreEvent() { return true }
  get estimatedHeight() { return -1 }
  coordsAt() { return null }
}

// Tag widget — renders ::tagname as a subtle #tag badge
class TagWidget {
  constructor(tag) { this.tag = tag }
  toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-tag-badge'
    span.textContent = this.tag
    return span
  }
  eq(o) { return o instanceof TagWidget && o.tag === this.tag }
  compare(o) { return o instanceof TagWidget && o.tag === this.tag }
  destroy() {}
  ignoreEvent() { return true }
  get estimatedHeight() { return -1 }
  coordsAt() { return null }
}

// List marker widget — shows styled bullet or number when cursor is off the line
class ListMarkerWidget {
  constructor(text, isOrdered) { this.text = text; this.isOrdered = isOrdered }
  toDOM() {
    const span = document.createElement('span')
    span.className = this.isOrdered ? 'cm-list-marker cm-list-marker-ord' : 'cm-list-marker'
    span.textContent = this.isOrdered ? this.text : '•'
    return span
  }
  eq(w) { return w instanceof ListMarkerWidget && w.text === this.text && w.isOrdered === this.isOrdered }
  compare(w) { return w instanceof ListMarkerWidget && w.text === this.text && w.isOrdered === this.isOrdered }
  destroy() {}
  ignoreEvent() { return true }
  get estimatedHeight() { return -1 }
  coordsAt() { return null }
}

// MathQuill-backed widget — renders math, clicking opens an inline MathQuill editor
class MathWidget {
  constructor(tex, display, from, to) {
    this.tex = tex
    this.display = display
    this.from = from   // doc position — used to commit edits back
    this.to = to
  }
  toDOM() {
    const wrap = document.createElement(this.display ? 'div' : 'span')
    wrap.className = this.display ? 'cm-math-block cm-math-mq' : 'cm-math-inline cm-math-mq'
    wrap.dataset.latex = this.tex
    wrap.dataset.display = this.display ? '1' : '0'
    wrap.title = 'Click to edit'
    // Render static math immediately
    const staticSpan = document.createElement('span')
    wrap.appendChild(staticSpan)
    renderMathStatic(staticSpan, this.tex, this.display)
    return wrap
  }
  eq(o) { return o instanceof MathWidget && o.tex === this.tex && o.display === this.display }
  compare(o) { return o instanceof MathWidget && o.tex === this.tex && o.display === this.display }
  destroy() {}
  ignoreEvent() { return false }
  get estimatedHeight() { return this.display ? 44 : 22 }
  coordsAt() { return null }
}

class WikiWidget {
  constructor(title, cls, type, id) { this.title = title; this.cls = cls; this.type = type; this.id = id }
  toDOM() {
    const s = document.createElement('span')
    s.className = this.cls
    s.textContent = this.title
    s.dataset.wlType = this.type; s.dataset.wlId = this.id; s.dataset.wlTitle = this.title
    s.title = this.type.startsWith('new') ? `Create: ${this.title}` : `Open ${this.type}`
    return s
  }
  eq(o) { return o instanceof WikiWidget && o.title === this.title && o.cls === this.cls }
  compare(o) { return o instanceof WikiWidget && o.title === this.title && o.cls === this.cls }
  destroy() {}
  ignoreEvent() { return false }
  coordsAt() { return null }
}

class LinkWidget {
  constructor(text, href) { this.text = text; this.href = href }
  toDOM() {
    const a = document.createElement('a')
    a.className = 'cm-link-widget'
    a.textContent = this.text || this.href
    a.href = this.href
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    a.title = this.href
    a.addEventListener('click', e => {
      e.preventDefault()
      const href = this.href
      if (/^https?:\/\//i.test(href)) {
        if (_invoke) _invoke('plugin:shell|open', { path: href }).catch(() => window.open(href, '_blank'))
        else window.open(href, '_blank')
      } else if (_invoke) {
        _invoke('open_in_finder', { path: href }).catch(() => {})
      }
    })
    return a
  }
  eq(o) { return o instanceof LinkWidget && o.text === this.text && o.href === this.href }
  compare(o) { return o instanceof LinkWidget && o.text === this.text && o.href === this.href }
  destroy() {}
  ignoreEvent() { return true }
  coordsAt() { return null }
}

// ─── Widget helpers ───────────────────────────────────────────────────────────

// Custom date/time picker popup
const _MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
function showDateTimePicker(anchorEl, currentDate, currentTime, onChange) {
  document.querySelectorAll('.gnos-dtp').forEach(e => e.remove())
  const todayD = new Date()
  const todayStr = `${todayD.getFullYear()}-${String(todayD.getMonth()+1).padStart(2,'0')}-${String(todayD.getDate()).padStart(2,'0')}`
  let selDate = currentDate || '', selTime = currentTime || ''
  let viewYear = todayD.getFullYear(), viewMonth = todayD.getMonth()
  if (selDate) { try { const d = new Date(selDate + 'T00:00'); viewYear = d.getFullYear(); viewMonth = d.getMonth() } catch {} }

  const popup = document.createElement('div')
  popup.className = 'gnos-dtp'

  const render = () => {
    popup.innerHTML = ''
    // Nav row
    const nav = document.createElement('div'); nav.className = 'gnos-dtp-nav'
    const prev = document.createElement('button'); prev.className = 'gnos-dtp-nav-btn'; prev.textContent = '‹'
    prev.onclick = e => { e.stopPropagation(); if (--viewMonth < 0) { viewMonth = 11; viewYear-- }; render() }
    const lbl = document.createElement('span'); lbl.className = 'gnos-dtp-month-label'
    lbl.textContent = `${_MONTHS[viewMonth]} ${viewYear}`
    const next = document.createElement('button'); next.className = 'gnos-dtp-nav-btn'; next.textContent = '›'
    next.onclick = e => { e.stopPropagation(); if (++viewMonth > 11) { viewMonth = 0; viewYear++ }; render() }
    nav.appendChild(prev); nav.appendChild(lbl); nav.appendChild(next); popup.appendChild(nav)
    // Grid
    const grid = document.createElement('div'); grid.className = 'gnos-dtp-grid'
    for (const d of ['Su','Mo','Tu','We','Th','Fr','Sa']) {
      const h = document.createElement('div'); h.className = 'gnos-dtp-wday'; h.textContent = d; grid.appendChild(h)
    }
    const firstDay = new Date(viewYear, viewMonth, 1).getDay()
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate()
    for (let i = 0; i < firstDay; i++) grid.appendChild(Object.assign(document.createElement('div'), { className: 'gnos-dtp-day gnos-dtp-empty' }))
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${viewYear}-${String(viewMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`
      const el = document.createElement('div'); el.className = 'gnos-dtp-day'; el.textContent = String(d)
      if (ds === selDate) el.classList.add('gnos-dtp-selected')
      if (ds === todayStr) el.classList.add('gnos-dtp-today')
      el.onclick = ev => { ev.stopPropagation(); selDate = selDate === ds ? '' : ds; render() }
      grid.appendChild(el)
    }
    popup.appendChild(grid)
    // Time row
    const tr = document.createElement('div'); tr.className = 'gnos-dtp-time-row'
    const tl = document.createElement('span'); tl.className = 'gnos-dtp-time-label'; tl.textContent = 'Time'
    const ti = document.createElement('input'); ti.className = 'gnos-dtp-time-inp'; ti.type = 'time'; ti.value = selTime
    ti.onchange = e => { selTime = e.target.value || '' }
    tr.appendChild(tl); tr.appendChild(ti); popup.appendChild(tr)
    // Actions
    const acts = document.createElement('div'); acts.className = 'gnos-dtp-actions'
    const clr = document.createElement('button'); clr.className = 'gnos-dtp-clear'; clr.textContent = 'Clear'
    clr.onclick = e => { e.stopPropagation(); onChange('', ''); popup.remove() }
    const done = document.createElement('button'); done.className = 'gnos-dtp-done'; done.textContent = 'Done'
    done.onclick = e => { e.stopPropagation(); onChange(selDate, selTime); popup.remove() }
    acts.appendChild(clr); acts.appendChild(done); popup.appendChild(acts)
  }
  render()
  // Position
  const rect = anchorEl.getBoundingClientRect()
  let left = rect.left, top = rect.bottom + 6
  if (left + 222 > window.innerWidth) left = window.innerWidth - 228
  if (top + 300 > window.innerHeight) top = rect.top - 306
  popup.style.cssText = `position:fixed;left:${left}px;top:${Math.max(4, top)}px;z-index:10000;`
  document.body.appendChild(popup)
  const outside = e => { if (!popup.contains(e.target) && e.target !== anchorEl) { popup.remove(); document.removeEventListener('mousedown', outside) } }
  setTimeout(() => document.addEventListener('mousedown', outside), 0)
}
function _replaceInDoc(view, oldText, newText, hintFrom = -1) {
  if (!view) return false
  const doc = view.state.doc.toString()
  // Try near the known position first (most reliable), then fall back to full scan
  let idx = -1
  if (hintFrom >= 0) {
    const window = 200
    const start = Math.max(0, hintFrom - window)
    const end = Math.min(doc.length, hintFrom + oldText.length + window)
    const slice = doc.slice(start, end)
    const local = slice.indexOf(oldText)
    if (local !== -1) idx = start + local
  }
  if (idx === -1) idx = doc.indexOf(oldText)
  if (idx === -1) return false
  view.dispatch({ changes: { from: idx, to: idx + oldText.length, insert: newText }, scrollIntoView: false })
  return true
}

// ─── /habits widget (habit tracker with day grid + line graph) ───────────────
class HabitsWidget {
  constructor(rawData, rawLine, blockFrom = -1) {
    this.rawLine = rawLine; this.blockFrom = blockFrom
    try { this.data = rawData ? JSON.parse(rawData) : {} }
    catch { this.data = {} }
    if (!this.data.habits) this.data.habits = []
    if (!this.data.log) this.data.log = {}
    if (!this.data.startDate) {
      const logKeys = Object.keys(this.data.log || {}).sort()
      this.data.startDate = logKeys.length > 0 ? logKeys[0] : new Date().toISOString().slice(0, 10)
    }
    if (!this.data.length) this.data.length = 30
    if (!this.data.view) this.data.view = 'grid'
    if (!this.data.title) this.data.title = 'Habits'
  }
  _serialize() { return `/habits:${JSON.stringify(this.data)}` }
  _dk(d) { return d.toISOString().slice(0, 10) }
  toDOM(cmView) {
    const data = this.data, widget = this
    const wrap = document.createElement('div')
    wrap.className = 'cm-habits-widget'

    const save = () => {
      const newLine = widget._serialize()
      if (_replaceInDoc(cmView, widget.rawLine, newLine, widget.blockFrom)) widget.rawLine = newLine
    }

    const render = () => {
      wrap.innerHTML = ''
      const today = new Date(); today.setHours(0, 0, 0, 0)
      const todayKey = widget._dk(today)

      const start = new Date(data.startDate + 'T00:00:00')
      const dates = []
      for (let i = 0; i < data.length; i++) {
        const d = new Date(start); d.setDate(start.getDate() + i); dates.push(d)
      }

      // ── Header ────────────────────────────────────────────────────────────
      const hdr = document.createElement('div')
      hdr.className = 'cm-habits-hdr'
      const titleEl = document.createElement('span')
      titleEl.className = 'cm-habits-title'
      titleEl.textContent = data.title || 'Habits'
      titleEl.title = 'Click to rename'
      titleEl.style.cursor = 'pointer'
      titleEl.onclick = e => {
        e.stopPropagation()
        const inp = document.createElement('input')
        inp.className = 'cm-habits-title-inp'
        inp.value = data.title || 'Habits'
        inp.style.cssText = 'font-size:13px;font-weight:700;background:transparent;border:none;border-bottom:1px solid var(--accent);outline:none;color:var(--text);width:120px;font-family:var(--font-ui);'
        hdr.replaceChild(inp, titleEl)
        inp.focus(); inp.select()
        const commit = () => {
          const v = inp.value.trim() || 'Habits'
          data.title = v; save(); render()
        }
        inp.onkeydown = ev => { ev.stopPropagation(); if (ev.key === 'Enter') { ev.preventDefault(); commit() } else if (ev.key === 'Escape') render() }
        inp.onblur = commit
      }
      hdr.appendChild(titleEl)

      // ── Animated view toggle ─────────────────────────────────────────────
      const toggleBtn = document.createElement('button')
      toggleBtn.className = 'cm-habits-view-toggle'
      toggleBtn.dataset.view = data.view
      toggleBtn.title = data.view === 'grid' ? 'Switch to graph' : 'Switch to grid'
      toggleBtn.innerHTML = `<svg class="cm-habits-toggle-icon" data-for="grid" width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="1" width="4" height="4" rx="1"/><rect x="7" y="1" width="4" height="4" rx="1"/><rect x="1" y="7" width="4" height="4" rx="1"/><rect x="7" y="7" width="4" height="4" rx="1"/></svg><svg class="cm-habits-toggle-icon" data-for="graph" width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="1,10 3.5,6 6,8 8.5,3.5 11,1.5"/></svg>`
      toggleBtn.onclick = e => { e.stopPropagation(); data.view = data.view === 'grid' ? 'graph' : 'grid'; save(); render() }
      hdr.appendChild(toggleBtn)

      // ── Delete widget button ──────────────────────────────────────────────
      const deleteBtn = document.createElement('button')
      deleteBtn.className = 'cm-habits-delete-btn'
      deleteBtn.title = 'Delete habits tracker'
      deleteBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>'
      deleteBtn.onclick = e => {
        e.stopPropagation()
        if (!cmView) return
        const doc = cmView.state.doc.toString()
        let idx = -1
        if (widget.blockFrom >= 0) {
          const s = Math.max(0, widget.blockFrom - 200)
          const slice = doc.slice(s, Math.min(doc.length, s + widget.rawLine.length + 400))
          const li = slice.indexOf(widget.rawLine)
          if (li !== -1) idx = s + li
        }
        if (idx === -1) idx = doc.indexOf(widget.rawLine)
        if (idx === -1) return
        const end = idx + widget.rawLine.length
        const to = end < doc.length && doc[end] === '\n' ? end + 1 : end
        cmView.dispatch({ changes: { from: idx, to }, scrollIntoView: false })
      }
      hdr.appendChild(deleteBtn)
      wrap.appendChild(hdr)

      // ── Content ───────────────────────────────────────────────────────────
      if (data.view === 'graph') {
        // Line graph view
        if (!data.habits.length) {
          const e = document.createElement('div'); e.className = 'cm-habits-empty'
          e.textContent = 'No habits yet'; wrap.appendChild(e)
        } else {
          const graphWrap = document.createElement('div')
          graphWrap.className = 'cm-habits-graph-wrap'
          const W = 600, H = 130, PAD_L = 28, PAD_R = 10, PAD_T = 10, PAD_B = 22
          const innerW = W - PAD_L - PAD_R, innerH = H - PAD_T - PAD_B
          const maxY = data.habits.length
          const NS = 'http://www.w3.org/2000/svg'
          const svg = document.createElementNS(NS, 'svg')
          svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
          svg.style.cssText = 'width:100%;height:130px;display:block;overflow:visible'

          // Y gridlines + labels
          for (let y = 0; y <= maxY; y++) {
            const yPx = PAD_T + innerH - (y / maxY) * innerH
            const gl = document.createElementNS(NS, 'line')
            gl.setAttribute('x1', PAD_L); gl.setAttribute('x2', W - PAD_R)
            gl.setAttribute('y1', yPx); gl.setAttribute('y2', yPx)
            gl.setAttribute('stroke', 'var(--borderSubtle)'); gl.setAttribute('stroke-width', '1')
            svg.appendChild(gl)
            const lt = document.createElementNS(NS, 'text')
            lt.setAttribute('x', PAD_L - 4); lt.setAttribute('y', yPx + 4)
            lt.setAttribute('text-anchor', 'end'); lt.setAttribute('font-size', '9')
            lt.setAttribute('fill', 'var(--textDim)'); lt.textContent = String(y)
            svg.appendChild(lt)
          }

          // Data points
          const pts = dates.map((d, i) => {
            const k = widget._dk(d)
            const logRow = data.log[k]
            const count = logRow ? logRow.reduce((s, v) => s + (v ? 1 : 0), 0) : 0
            const x = PAD_L + (data.length <= 1 ? innerW / 2 : (i / (data.length - 1)) * innerW)
            const y = PAD_T + innerH - (maxY > 0 ? (count / maxY) * innerH : 0)
            return { x, y, count, k, d }
          })

          if (pts.length > 1) {
            // Area
            const area = document.createElementNS(NS, 'path')
            area.setAttribute('d', `M${pts[0].x},${PAD_T + innerH} ` + pts.map(p => `L${p.x},${p.y}`).join(' ') + ` L${pts[pts.length-1].x},${PAD_T + innerH} Z`)
            area.setAttribute('fill', 'var(--accent)'); area.setAttribute('fill-opacity', '0.12')
            svg.appendChild(area)
            // Line
            const lp = document.createElementNS(NS, 'path')
            lp.setAttribute('d', `M${pts.map(p => `${p.x},${p.y}`).join(' L')}`)
            lp.setAttribute('stroke', 'var(--accent)'); lp.setAttribute('stroke-width', '2')
            lp.setAttribute('fill', 'none'); lp.setAttribute('stroke-linejoin', 'round'); lp.setAttribute('stroke-linecap', 'round')
            svg.appendChild(lp)
          }

          // Dots
          pts.forEach(p => {
            const c = document.createElementNS(NS, 'circle')
            c.setAttribute('cx', p.x); c.setAttribute('cy', p.y)
            c.setAttribute('r', '3'); c.setAttribute('fill', 'var(--accent)')
            const t = document.createElementNS(NS, 'title')
            t.textContent = `${p.k}: ${p.count}/${maxY}`
            c.appendChild(t); svg.appendChild(c)
          })

          // X labels (sparse)
          const step = Math.max(1, Math.ceil(data.length / 7))
          pts.forEach((p, i) => {
            if (i % step !== 0 && i !== pts.length - 1) return
            const xt = document.createElementNS(NS, 'text')
            xt.setAttribute('x', p.x); xt.setAttribute('y', H - 4)
            xt.setAttribute('text-anchor', 'middle'); xt.setAttribute('font-size', '9')
            xt.setAttribute('fill', 'var(--textDim)')
            xt.textContent = `${p.d.getMonth()+1}/${p.d.getDate()}`
            svg.appendChild(xt)
          })

          graphWrap.appendChild(svg)
          wrap.appendChild(graphWrap)
        }
      } else {
        // Grid view
        if (!data.habits.length) {
          const e = document.createElement('div'); e.className = 'cm-habits-empty'
          e.textContent = 'No habits yet'; wrap.appendChild(e)
        } else {
          const grid = document.createElement('div')
          grid.className = 'cm-habits-grid'

          // Date header row
          const dateRow = document.createElement('div')
          dateRow.className = 'cm-habits-row date-hdr-row'
          const corner = document.createElement('div')
          corner.className = 'cm-habits-name-cell'
          dateRow.appendChild(corner)
          dates.forEach(d => {
            const k = widget._dk(d), lbl = document.createElement('div')
            lbl.className = 'cm-habits-day-lbl' + (k === todayKey ? ' cm-habits-today-lbl' : '')
            lbl.textContent = k === todayKey ? '•' : String(d.getDate())
            lbl.title = k
            dateRow.appendChild(lbl)
          })
          grid.appendChild(dateRow)

          // Habit rows — mouse-event-based reorder (avoids CodeMirror's capture-phase
          // dragover interception which prevents HTML5 DnD from working in live mode).
          data.habits.forEach((hName, hi) => {
            const row = document.createElement('div')
            row.className = 'cm-habits-row'
            row.dataset.hi = String(hi)
            const nameWrap = document.createElement('div')
            nameWrap.className = 'cm-habits-name-cell'
            // Drag handle — uses mousedown/mousemove/mouseup to bypass CM's
            // capture-phase dragover intercept that blocks HTML5 DnD in live mode.
            const dragHandle = document.createElement('span')
            dragHandle.className = 'cm-habits-drag-handle'
            dragHandle.innerHTML = '<svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor"><circle cx="3" cy="3" r="1.3"/><circle cx="7" cy="3" r="1.3"/><circle cx="3" cy="7" r="1.3"/><circle cx="7" cy="7" r="1.3"/><circle cx="3" cy="11" r="1.3"/><circle cx="7" cy="11" r="1.3"/></svg>'
            dragHandle.title = 'Drag to reorder'
            dragHandle.addEventListener('mousedown', e => {
              e.preventDefault(); e.stopPropagation()
              const allRows = [...grid.querySelectorAll('.cm-habits-row[data-hi]')]
              let targetIdx = hi

              const indicator = document.createElement('div')
              indicator.style.cssText = 'position:fixed;left:0;right:0;height:2px;background:var(--accent);pointer-events:none;z-index:99999;border-radius:2px;display:none;'
              document.body.appendChild(indicator)
              row.style.opacity = '0.4'

              const onMove = ev => {
                let newTarget = hi
                for (let i = 0; i < allRows.length; i++) {
                  const r = allRows[i]
                  const rect = r.getBoundingClientRect()
                  if (ev.clientY <= rect.top + rect.height / 2) { newTarget = parseInt(r.dataset.hi, 10); break }
                  newTarget = parseInt(r.dataset.hi, 10)
                }
                targetIdx = newTarget
                // Show insertion line above the target row
                const targetRow = allRows.find(r => parseInt(r.dataset.hi, 10) === targetIdx)
                if (targetRow && targetIdx !== hi) {
                  const rect = targetRow.getBoundingClientRect()
                  const insertBefore = ev.clientY <= rect.top + rect.height / 2
                  indicator.style.display = 'block'
                  indicator.style.top = (insertBefore ? rect.top : rect.bottom) - 1 + 'px'
                } else {
                  indicator.style.display = 'none'
                }
              }

              const onUp = () => {
                document.removeEventListener('mousemove', onMove)
                document.removeEventListener('mouseup', onUp)
                indicator.remove()
                row.style.opacity = ''
                if (targetIdx !== hi) {
                  const from = hi, to = targetIdx
                  const [movedH] = data.habits.splice(from, 1)
                  data.habits.splice(to, 0, movedH)
                  for (const k of Object.keys(data.log)) {
                    if (Array.isArray(data.log[k])) {
                      const [movedL] = data.log[k].splice(from, 1)
                      data.log[k].splice(to, 0, movedL ?? 0)
                    }
                  }
                  save(); render()
                }
              }

              document.addEventListener('mousemove', onMove)
              document.addEventListener('mouseup', onUp)
            })
            nameWrap.appendChild(dragHandle)
            const nameSpan = document.createElement('span')
            nameSpan.className = 'cm-habits-name'; nameSpan.textContent = hName; nameSpan.title = hName
            nameSpan.onclick = e => {
              e.stopPropagation()
              const inp = document.createElement('input')
              inp.className = 'cm-habits-name-inp'; inp.value = hName; inp.type = 'text'
              nameWrap.innerHTML = ''; nameWrap.appendChild(inp)
              inp.focus(); inp.select()
              const commit = () => { const v = inp.value.trim(); if (v) data.habits[hi] = v; save(); render() }
              inp.onkeydown = ev => { ev.stopPropagation(); if (ev.key === 'Enter') { ev.preventDefault(); commit() } else if (ev.key === 'Escape') render() }
              inp.onblur = commit
            }
            const delBtn = document.createElement('button')
            delBtn.className = 'cm-habits-del'; delBtn.textContent = '×'; delBtn.title = 'Remove'
            delBtn.onclick = e => {
              e.stopPropagation()
              data.habits.splice(hi, 1)
              for (const k of Object.keys(data.log)) { if (Array.isArray(data.log[k])) data.log[k].splice(hi, 1) }
              save(); render()
            }
            nameWrap.appendChild(nameSpan); nameWrap.appendChild(delBtn)
            row.appendChild(nameWrap)

            dates.forEach(d => {
              const k = widget._dk(d)
              const done = !!(data.log[k] && data.log[k][hi])
              const isToday = k === todayKey
              const cell = document.createElement('div')
              cell.className = 'cm-habits-cell' + (done ? ' done' : '') + (isToday ? ' today' : '')
              cell.title = `${hName} — ${k}`
              cell.onclick = e => {
                e.stopPropagation()
                if (!data.log[k]) data.log[k] = []
                while (data.log[k].length <= hi) data.log[k].push(0)
                data.log[k][hi] = data.log[k][hi] ? 0 : 1
                save(); render()
              }
              row.appendChild(cell)
            })
            grid.appendChild(row)
          })
          wrap.appendChild(grid)
        }
      }

      // ── Date/days meta row (right-aligned) ────────────────────────────────
      const metaRow = document.createElement('div')
      metaRow.className = 'cm-habits-meta-row'

      const sdFormatted = new Date(data.startDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      const endD = new Date(data.startDate + 'T00:00:00'); endD.setDate(endD.getDate() + data.length - 1)
      const edFormatted = endD.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

      const sdChip = document.createElement('button')
      sdChip.className = 'cm-habits-meta-chip'; sdChip.title = 'Change start date'
      const sdHiddenInp = document.createElement('input')
      sdHiddenInp.type = 'date'; sdHiddenInp.value = data.startDate
      sdHiddenInp.style.cssText = 'position:absolute;opacity:0;width:1px;height:1px;pointer-events:none;'
      sdHiddenInp.onchange = e => { e.stopPropagation(); data.startDate = sdHiddenInp.value; save(); render() }
      sdHiddenInp.onkeydown = e => e.stopPropagation()
      sdChip.appendChild(document.createTextNode(sdFormatted)); sdChip.appendChild(sdHiddenInp)
      sdChip.onclick = e => { e.stopPropagation(); sdHiddenInp.showPicker ? sdHiddenInp.showPicker() : sdHiddenInp.click() }

      const metaArrow = document.createElement('span'); metaArrow.className = 'cm-habits-meta-sep'; metaArrow.textContent = '→'
      const edSpan = document.createElement('span'); edSpan.className = 'cm-habits-meta-text'; edSpan.textContent = edFormatted
      const metaDot = document.createElement('span'); metaDot.className = 'cm-habits-meta-sep'; metaDot.textContent = '·'

      const lenChip = document.createElement('button')
      lenChip.className = 'cm-habits-meta-chip'; lenChip.title = 'Edit number of days'
      lenChip.textContent = `${data.length}d`
      lenChip.onclick = e => {
        e.stopPropagation()
        const inp = document.createElement('input')
        inp.type = 'number'; inp.value = String(data.length); inp.min = '1'; inp.max = '365'
        inp.className = 'cm-habits-meta-inp'; lenChip.replaceWith(inp); inp.focus(); inp.select()
        const commit = () => { const v = parseInt(inp.value); if (v > 0) { data.length = v; save(); render() } else render() }
        inp.onkeydown = ev => { ev.stopPropagation(); if (ev.key === 'Enter') { ev.preventDefault(); commit() } else if (ev.key === 'Escape') render() }
        inp.onblur = commit
      }

      metaRow.appendChild(sdChip); metaRow.appendChild(metaArrow); metaRow.appendChild(edSpan)
      metaRow.appendChild(metaDot); metaRow.appendChild(lenChip)
      wrap.appendChild(metaRow)

      // ── Add habit row ──────────────────────────────────────────────────────
      const addRow = document.createElement('div')
      addRow.className = 'cm-habits-add-row'
      const addInput = document.createElement('input')
      addInput.className = 'cm-habits-add-inp'; addInput.type = 'text'; addInput.placeholder = 'New habit…'
      const addBtn = document.createElement('button')
      addBtn.className = 'cm-habits-add-btn'; addBtn.textContent = '+'
      const doAdd = () => {
        const v = addInput.value.trim(); if (!v) return
        addInput.value = ''; data.habits.push(v); save(); render()
        const ni = wrap.querySelector('.cm-habits-add-inp'); if (ni) ni.focus()
      }
      addInput.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); doAdd() } }
      addBtn.onclick = e => { e.stopPropagation(); doAdd() }
      addRow.appendChild(addInput); addRow.appendChild(addBtn)
      wrap.appendChild(addRow)
    }

    wrap._habitsRender = render
    wrap._habitsData = data
    render()
    return wrap
  }
  eq(o) {
    return o instanceof HabitsWidget &&
      o.blockFrom === this.blockFrom &&
      o.data.view === this.data.view &&
      o.data.title === this.data.title &&
      o.data.startDate === this.data.startDate &&
      o.data.length === this.data.length &&
      JSON.stringify(o.data.habits) === JSON.stringify(this.data.habits) &&
      JSON.stringify(o.data.log) === JSON.stringify(this.data.log)
  }
  compare(o) { return this.eq(o) }
  updateDOM(dom) {
    if (!dom._habitsRender || !dom._habitsData) return false
    Object.assign(dom._habitsData, this.data)
    dom._habitsRender()
    return true
  }
  destroy() {}
  ignoreEvent() { return true }
  get estimatedHeight() { return 80 + (this.data?.habits?.length || 0) * 26 }
  coordsAt() { return null }
}

// ─── /task mini calendar date picker ─────────────────────────────────────────
function _makeTaskDatePicker(anchor, currentDate, onPick) {
  document.querySelectorAll('.cm-task-date-picker').forEach(el => el.remove())
  const today = new Date()
  let viewYear  = currentDate ? parseInt(currentDate.slice(0,4)) : today.getFullYear()
  let viewMonth = currentDate ? parseInt(currentDate.slice(5,7)) - 1 : today.getMonth()

  const picker = document.createElement('div')
  picker.className = 'cm-task-date-picker'

  const positionPicker = () => {
    const rect = anchor.getBoundingClientRect()
    const ph = picker.offsetHeight || 240
    const pw = picker.offsetWidth  || 214
    const top = (window.innerHeight - rect.bottom >= ph + 8)
      ? rect.bottom + 4
      : rect.top - ph - 4
    picker.style.top  = `${Math.max(4, top)}px`
    picker.style.left = `${Math.min(rect.left, window.innerWidth - pw - 8)}px`
  }

  const render = () => {
    picker.innerHTML = ''
    // Header
    const hdr = document.createElement('div'); hdr.className = 'cm-cal-header'
    const prev = document.createElement('button'); prev.className = 'cm-cal-nav'; prev.textContent = '‹'
    prev.onclick = e => { e.stopPropagation(); viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear-- }; render(); positionPicker() }
    const lbl = document.createElement('span'); lbl.className = 'cm-cal-month'
    lbl.textContent = `${_MONTHS[viewMonth]} ${viewYear}`
    const next = document.createElement('button'); next.className = 'cm-cal-nav'; next.textContent = '›'
    next.onclick = e => { e.stopPropagation(); viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++ }; render(); positionPicker() }
    hdr.appendChild(prev); hdr.appendChild(lbl); hdr.appendChild(next)
    picker.appendChild(hdr)
    // Grid
    const grid = document.createElement('div'); grid.className = 'cm-cal-grid'
    for (const d of ['Su','Mo','Tu','We','Th','Fr','Sa']) {
      const dh = document.createElement('div'); dh.className = 'cm-cal-day-hdr cm-task-date-hdr'; dh.textContent = d; grid.appendChild(dh)
    }
    const firstDay = new Date(viewYear, viewMonth, 1).getDay()
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate()
    for (let i = 0; i < firstDay; i++) {
      const b = document.createElement('div'); b.className = 'cm-task-date-blank'; grid.appendChild(b)
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${viewYear}-${String(viewMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`
      const cell = document.createElement('div'); cell.className = 'cm-task-date-cell'
      const isToday = today.getFullYear() === viewYear && today.getMonth() === viewMonth && today.getDate() === d
      if (isToday) cell.classList.add('cm-task-date-today')
      if (currentDate === ds) cell.classList.add('cm-task-date-selected')
      cell.textContent = String(d)
      cell.onclick = e => { e.stopPropagation(); onPick(ds); picker.remove(); document.removeEventListener('mousedown', outside) }
      grid.appendChild(cell)
    }
    picker.appendChild(grid)
  }

  render()
  document.body.appendChild(picker)
  positionPicker()

  const outside = e => { if (!picker.contains(e.target) && e.target !== anchor) { picker.remove(); document.removeEventListener('mousedown', outside) } }
  setTimeout(() => document.addEventListener('mousedown', outside), 0)
}

// ─── /task single-block widget (interactive kanban) ───────────────────────────
// Module-level pointer drag state for kanban boards
let _kbDrag = null

class TaskBlockWidget {
  constructor(boardTitle, columns, rawMd, blockFrom = -1) {
    this.boardTitle = boardTitle
    // Default kanban columns when empty
    this.columns = columns.length ? columns : [
      { title: 'To Do', tasks: [] },
      { title: 'In Progress', tasks: [] },
      { title: 'Done', tasks: [] },
    ]
    this.rawMd = rawMd
    this.blockFrom = blockFrom
    this._needsDefault = !columns.length
  }
  _serialize(title, cols) {
    const lines = [`/task${title ? ':' + title : ''}`]
    for (const col of cols) {
      lines.push(`== ${col.title} ==`)
      for (const t of col.tasks) {
        lines.push(`- [ ] ${t.text}${t.date ? ' {date:' + t.date + '}' : ''}`)
      }
    }
    return lines.join('\n')
  }
  toDOM(cmView) {
    const wrap = document.createElement('div')
    wrap.className = 'cm-task-board-w'
    try {
    const cols = this.columns.map(c => ({
      title: c.title,
      tasks: c.tasks.map(t => ({ text: t.text, date: t.date || null })),
    }))
    const bt = this.boardTitle
    const save = () => {
      const newMd = this._serialize(bt, cols)
      if (_replaceInDoc(cmView, this.rawMd, newMd, this.blockFrom)) { this.rawMd = newMd; this.blockFrom = -1 }
    }

    if (this._needsDefault) {
      this._needsDefault = false
      setTimeout(() => save(), 0)
    }

    const render = () => {
      wrap.innerHTML = ''

      // Board title bar
      if (bt) {
        const titleBar = document.createElement('div')
        titleBar.className = 'cm-task-titlebar'
        const titleEl = document.createElement('span')
        titleEl.className = 'cm-task-title-w'
        titleEl.textContent = bt
        titleBar.appendChild(titleEl)
        wrap.appendChild(titleBar)
      }

      const colsRow = document.createElement('div')
      colsRow.className = 'cm-task-cols-w'

      cols.forEach((col, ci) => {
        const colDiv = document.createElement('div')
        colDiv.className = 'cm-task-col-w'

        // Column header
        const _colColors = ['#f59e0b99','#3b82f699','#10b98199','#8b5cf699','#ef444499','#06b6d499']
        const colHdr = document.createElement('div')
        colHdr.className = 'cm-task-col-hdr-w'
        colHdr.style.background = _colColors[ci % _colColors.length]
        const colTitleEl = document.createElement('span')
        colTitleEl.className = 'cm-task-col-title'
        colTitleEl.textContent = col.title
        colTitleEl.onclick = () => {
          const inp = document.createElement('input')
          inp.className = 'cm-task-col-title-inp'
          inp.value = col.title; inp.type = 'text'
          colTitleEl.textContent = ''; colTitleEl.appendChild(inp)
          inp.focus(); inp.select()
          const commit = () => { col.title = inp.value.trim() || col.title; save(); render() }
          inp.onkeydown = ev => { ev.stopPropagation(); if (ev.key === 'Enter') { ev.preventDefault(); commit() } if (ev.key === 'Escape') render() }
          inp.onblur = commit
        }

        const hdrRight = document.createElement('div')
        hdrRight.className = 'cm-task-col-hdr-right'
        const badge = document.createElement('span')
        badge.className = 'cm-task-col-w-badge'
        badge.textContent = String(col.tasks.length)

        const delCol = document.createElement('button')
        delCol.className = 'cm-task-col-del'
        delCol.textContent = '\u00d7'
        delCol.title = 'Delete column'
        delCol.onclick = e => { e.stopPropagation(); cols.splice(ci, 1); save(); render() }

        hdrRight.appendChild(badge)
        hdrRight.appendChild(delCol)
        colHdr.appendChild(colTitleEl)
        colHdr.appendChild(hdrRight)
        colDiv.appendChild(colHdr)

        // Cards area
        const cardsArea = document.createElement('div')
        cardsArea.className = 'cm-task-cards-area'
        col.tasks.forEach((task, ti) => {
          const card = document.createElement('div')
          card.className = 'cm-task-card-w'
          card.style.touchAction = 'none'

          // Pointer-based drag
          card.onpointerdown = e => {
            if (e.button !== 0) return
            e.stopPropagation()
            if (e.target.closest('.cm-task-card-date-row')) return
            if (e.target.closest('.cm-task-card-del-btn')) return
            if (e.target.closest('.cm-task-card-text')) return
            e.preventDefault()
            const rect = card.getBoundingClientRect()
            const ghost = card.cloneNode(true)
            ghost.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;pointer-events:none;z-index:9999;opacity:0.85;transform:rotate(1.5deg);box-shadow:0 8px 24px rgba(0,0,0,.3);border-radius:6px;`
            document.body.appendChild(ghost)
            card.classList.add('cm-task-card-dragging')
            _kbDrag = { wrap, ci, ti, ghost, offX: e.clientX - rect.left, offY: e.clientY - rect.top }
            card.setPointerCapture(e.pointerId)
          }
          card.onpointermove = e => {
            if (!_kbDrag || _kbDrag.wrap !== wrap) return
            _kbDrag.ghost.style.left = `${e.clientX - _kbDrag.offX}px`
            _kbDrag.ghost.style.top = `${e.clientY - _kbDrag.offY}px`
            const el = document.elementFromPoint(e.clientX, e.clientY)
            const targetCol = el?.closest('.cm-task-col-w')
            wrap.querySelectorAll('.cm-task-col-w').forEach(c => c.classList.remove('cm-task-col-drop'))
            if (targetCol && wrap.contains(targetCol)) targetCol.classList.add('cm-task-col-drop')
          }
          const endDrag = e => {
            if (!_kbDrag || _kbDrag.wrap !== wrap) return
            _kbDrag.ghost.remove()
            wrap.querySelectorAll('.cm-task-col-w').forEach(c => c.classList.remove('cm-task-col-drop'))
            card.classList.remove('cm-task-card-dragging')
            if (e.type === 'pointerup') {
              const el = document.elementFromPoint(e.clientX, e.clientY)
              const targetColEl = el?.closest('.cm-task-col-w')
              if (targetColEl && wrap.contains(targetColEl)) {
                const colEls = [...wrap.querySelectorAll('.cm-task-col-w')]
                const targetCi = colEls.indexOf(targetColEl)
                if (targetCi !== -1 && targetCi !== _kbDrag.ci) {
                  const [moved] = cols[_kbDrag.ci].tasks.splice(_kbDrag.ti, 1)
                  cols[targetCi].tasks.push(moved)
                  _kbDrag = null; save(); render(); return
                }
              }
            }
            _kbDrag = null
          }
          card.onpointerup = endDrag
          card.onpointercancel = endDrag

          const cardBody = document.createElement('div')
          cardBody.className = 'cm-task-card-body'

          const txt = document.createElement('span')
          txt.className = 'cm-task-card-text'
          txt.textContent = task.text
          txt.onclick = e => {
            e.stopPropagation()
            const inp = document.createElement('input')
            inp.className = 'cm-task-card-edit'
            inp.value = task.text; inp.type = 'text'
            txt.textContent = ''; txt.appendChild(inp)
            inp.focus(); inp.select()
            const commit = () => { const v = inp.value.trim(); if (v) { task.text = v; save() } render() }
            inp.onkeydown = ev => { ev.stopPropagation(); if (ev.key === 'Enter') { ev.preventDefault(); commit() } if (ev.key === 'Escape') render() }
            inp.onblur = commit
          }

          const del = document.createElement('button')
          del.className = 'cm-task-card-del-btn'
          del.title = 'Delete'
          del.textContent = '\u00d7'
          del.onclick = e => { e.stopPropagation(); cols[ci].tasks.splice(ti, 1); save(); render() }

          cardBody.appendChild(txt)
          cardBody.appendChild(del)
          card.appendChild(cardBody)

          // Date row
          const dateRow = document.createElement('div')
          dateRow.className = 'cm-task-card-date-row'
          if (task.date) {
            const badge = document.createElement('span')
            badge.className = 'cm-task-card-date-badge'
            badge.textContent = task.date
            badge.onclick = e => { e.stopPropagation(); _makeTaskDatePicker(badge, task.date, ds => { task.date = ds; save(); render() }) }
            const clearBtn = document.createElement('button')
            clearBtn.className = 'cm-task-card-date-clear'
            clearBtn.textContent = '\u00d7'
            clearBtn.title = 'Remove date'
            clearBtn.onclick = e => { e.stopPropagation(); task.date = null; save(); render() }
            dateRow.appendChild(badge)
            dateRow.appendChild(clearBtn)
          } else {
            const addDateBtn = document.createElement('button')
            addDateBtn.className = 'cm-task-card-add-date'
            addDateBtn.textContent = '+ date'
            addDateBtn.onclick = e => { e.stopPropagation(); _makeTaskDatePicker(addDateBtn, null, ds => { task.date = ds; save(); render() }) }
            dateRow.appendChild(addDateBtn)
          }
          card.appendChild(dateRow)
          cardsArea.appendChild(card)
        })
        // Add task input — sits between header and cards
        const addRow = document.createElement('div')
        addRow.className = 'cm-task-add-row'
        const addInput = document.createElement('input')
        addInput.className = 'cm-task-add-input'
        addInput.type = 'text'
        addInput.placeholder = '+ Add a card...'
        addInput.onkeydown = (e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            const val = addInput.value.trim()
            if (!val) return
            addInput.value = ''
            cols[ci].tasks.push({ text: val, done: false, label: null, date: null })
            save(); render()
            const col = wrap.querySelectorAll('.cm-task-add-input')[ci]
            if (col) col.focus()
          }
        }
        addRow.appendChild(addInput)
        colDiv.appendChild(cardsArea)
        colDiv.appendChild(addRow)
        colsRow.appendChild(colDiv)
      })

      // Add-column button
      const addCol = document.createElement('div')
      addCol.className = 'cm-task-add-col'
      const addColBtn = document.createElement('button')
      addColBtn.className = 'cm-task-add-col-btn'
      addColBtn.textContent = '+'
      addColBtn.onclick = () => {
        cols.push({ title: 'New List', tasks: [], color: null })
        save(); render()
        // After render, open title edit on the new column
        setTimeout(() => {
          const titles = wrap.querySelectorAll('.cm-task-col-title')
          const last = titles[titles.length - 1]
          if (last) last.click()
        }, 0)
      }
      addCol.appendChild(addColBtn)
      colsRow.appendChild(addCol)
      wrap.appendChild(colsRow)
    }
    render()
    } catch (err) {
      wrap.innerHTML = ''
      const errEl = document.createElement('div')
      errEl.style.cssText = 'padding:8px 12px;color:var(--textDim,#888);font-size:12px;border-left:3px solid var(--border,#ccc);margin:4px 0;'
      errEl.textContent = '/task — render error: ' + (err?.message || err)
      wrap.appendChild(errEl)
    }
    return wrap
  }
  eq(o) {
    if (!(o instanceof TaskBlockWidget) || o.boardTitle !== this.boardTitle || o.columns.length !== this.columns.length) return false
    return this.columns.every((col, ci) => {
      const oc = o.columns[ci]
      if (oc.title !== col.title || oc.tasks.length !== col.tasks.length) return false
      return col.tasks.every((t, ti) => oc.tasks[ti].text === t.text && oc.tasks[ti].date === t.date)
    })
  }
  compare(o) { return this.eq(o) }
  destroy() {}
  ignoreEvent() { return true }
  get estimatedHeight() { return 38 + 32 + Math.max(...this.columns.map(c => c.tasks.length), 1) * 56 }
  coordsAt() { return null }
}

// ─── Helpers for parsing inline block commands ────────────────────────────────
/** Parse /todo block: returns { listName, items:[{text,checked,dateStr,timeStr,lineIdx}], startLine, endLine } or null */

/** Parse /task block: returns { boardTitle, columns, startLine, endLine } */
function parseTaskBlock(docStr, startLineIdx) {
  const lines = docStr.split('\n')
  const hdrLine = lines[startLineIdx]
  const hdrM = hdrLine.match(/^\/task(?::(.*))?$/)
  if (!hdrM) return null
  const boardTitle = (hdrM[1] || '').trim()
  let endLine = startLineIdx + 1
  const columns = []
  let currentCol = null

  while (endLine < lines.length) {
    const l = lines[endLine]
    if (l.trim() === '') break // empty line ends the block
    const colM = l.match(/^==\s*(.*?)\s*==(?:\{color:(\d+)\})?$/)
    if (colM) {
      currentCol = { title: colM[1], tasks: [], lineIdx: endLine, color: colM[2] != null ? parseInt(colM[2]) : null }
      columns.push(currentCol)
    } else if (currentCol && /^\s*[-*+]\s\[[ xX]\]/.test(l)) {
      const done = /\[[xX]\]/.test(l)
      const raw = l.replace(/^\s*[-*+]\s\[[ xX]\]\s*/, '').trim()
      const lblM = raw.match(/\{label:(\d+)\}/)
      const label = lblM ? parseInt(lblM[1]) : null
      const dateM = raw.match(/\{date:(\d{4}-\d{2}-\d{2})\}/)
      const date = dateM ? dateM[1] : null
      const text = raw.replace(/\{label:\d+\}/, '').replace(/\{date:\d{4}-\d{2}-\d{2}\}/, '').trim()
      currentCol.tasks.push({ text, done, lineIdx: endLine, label, date })
    } else if (!currentCol && /^\s*[-*+]\s\[[ xX]\]/.test(l)) {
      currentCol = { title: 'Tasks', tasks: [], lineIdx: endLine, color: null }
      columns.push(currentCol)
      const done = /\[[xX]\]/.test(l)
      const raw = l.replace(/^\s*[-*+]\s\[[ xX]\]\s*/, '').trim()
      const lblM = raw.match(/\{label:(\d+)\}/)
      const label = lblM ? parseInt(lblM[1]) : null
      const dateM = raw.match(/\{date:(\d{4}-\d{2}-\d{2})\}/)
      const date = dateM ? dateM[1] : null
      const text = raw.replace(/\{label:\d+\}/, '').replace(/\{date:\d{4}-\d{2}-\d{2}\}/, '').trim()
      currentCol.tasks.push({ text, done, lineIdx: endLine, label, date })
    } else {
      break // non-task content ends the block
    }
    endLine++
  }

  return { boardTitle, columns, startLine: startLineIdx, endLine: endLine - 1 }
}

/** Serialize a parsed task board back to markdown lines */
function serializeTaskBlock(boardTitle, columns) {
  const lines = [`/task${boardTitle ? ':' + boardTitle : ''}`]
  for (const col of columns) {
    lines.push(`== ${col.title} ==`)
    for (const t of col.tasks) {
      lines.push(`- ${t.done ? '[x]' : '[ ]'} ${t.text}${t.date ? ' {date:' + t.date + '}' : ''}`)
    }
  }
  return lines.join('\n')
}

// Pending Tab/Enter focus across widget rebuilds (set before dispatch, read in new toDOM)
let _tablePendingFocus = null // { rawText, rowIdx, colIdx } | null

// Table widget — renders markdown table as a contenteditable HTML table.
// All events are stopped at the wrap boundary (bubble phase) so CM6 never sees
// typing or mouse activity inside the table. CM6's MutationObserver already
// ignores widget DOM by default, so contenteditable cells work without interference.
class TableWidget {
  constructor(html, rawText) { this.html = html; this.rawText = rawText }

  toDOM(cmView) {
    // outer has padding (counted in offsetHeight by CM6) instead of margin (not counted)
    // This prevents the widget from visually overlapping adjacent text lines.
    const outer = document.createElement('div')
    outer.className = 'cm-table-outer'

    const wrap = document.createElement('div')
    wrap.className = 'cm-table-wrap'
    wrap.innerHTML = this.html
    outer.appendChild(wrap)

    // Make every cell contenteditable and store its original text for change detection
    wrap.querySelectorAll('td, th').forEach(cell => {
      cell.contentEditable = 'true'
      cell.spellcheck = false
      cell._nbRaw = cell.textContent
    })

    // Resume Tab/Enter navigation after a cell write triggered a widget rebuild
    if (_tablePendingFocus) {
      const full = cmView.state.doc.toString()
      const myFrom = full.indexOf(this.rawText)
      if (myFrom !== -1 && myFrom === _tablePendingFocus.tableFrom) {
        const pf = _tablePendingFocus
        _tablePendingFocus = null
        requestAnimationFrame(() => {
          const rows = Array.from(wrap.querySelectorAll('tr'))
          const cell = rows[pf.rowIdx]?.querySelectorAll('td, th')[pf.colIdx]
          if (cell) { cell.focus(); this._selectAll(cell) }
        })
      }
    }

    // Stop all events from bubbling past the wrap to CM6's cm-content listeners
    ;['keydown','keyup','keypress','input','beforeinput',
      'compositionstart','compositionend','compositionupdate',
      'mousedown','mouseup','click','contextmenu','paste','cut','copy','dragstart','drop'
    ].forEach(type => wrap.addEventListener(type, e => e.stopPropagation()))

    // Force plain-text paste (no rich HTML)
    wrap.addEventListener('paste', e => {
      e.preventDefault()
      const text = (e.clipboardData || window.clipboardData).getData('text/plain')
      document.execCommand('insertText', false, text)
    })

    // Commit cell when focus leaves the table entirely
    wrap.addEventListener('focusout', e => {
      if (wrap.contains(e.relatedTarget)) return // focus still inside table
      const cell = e.target.closest('td, th')
      if (!cell) return
      const { rowIdx, colIdx } = this._indices(wrap, cell)
      if (rowIdx !== -1) this._commitCell(cmView, cell, rowIdx, colIdx, null)
    })

    // Right-click context menu for row/column management
    wrap.addEventListener('contextmenu', e => {
      e.preventDefault()
      const cell = e.target.closest('td, th')
      if (!cell) return
      const { rowIdx, colIdx } = this._indices(wrap, cell)
      if (rowIdx !== -1) this._showContextMenu(e, cmView, rowIdx, colIdx)
    })

    // Keyboard navigation: Enter (next row), Tab (next/prev cell), Escape (revert)
    wrap.addEventListener('keydown', e => {
      const cell = e.target.closest('td, th')
      if (!cell || !wrap.contains(cell)) return
      const { rowIdx, colIdx } = this._indices(wrap, cell)
      if (rowIdx === -1) return

      if (e.key === 'Escape') {
        e.preventDefault()
        cell.textContent = cell._nbRaw
        cell.blur()
        return
      }

      if (e.key === 'Enter') {
        e.preventDefault()
        const rows = Array.from(wrap.querySelectorAll('tr'))
        const nRow = rowIdx + 1 < rows.length ? rowIdx + 1 : null
        const dispatched = this._commitCell(cmView, cell, rowIdx, colIdx,
          nRow !== null ? { rowIdx: nRow, colIdx } : null)
        if (!dispatched && nRow !== null) {
          const next = rows[nRow].querySelectorAll('td, th')[colIdx]
          if (next) { next.focus(); this._selectAll(next) }
        }
        return
      }

      if (e.key === 'Tab') {
        e.preventDefault()
        const rows = Array.from(wrap.querySelectorAll('tr'))
        const cols = rows[rowIdx]?.querySelectorAll('td, th').length ?? 0
        let nRow = rowIdx, nCol = colIdx + (e.shiftKey ? -1 : 1)
        if (nCol >= cols)  { nRow++; nCol = 0 }
        else if (nCol < 0) { nRow--; nCol = Math.max(0, cols - 1) }
        const valid = nRow >= 0 && nRow < rows.length
        const dispatched = this._commitCell(cmView, cell, rowIdx, colIdx,
          valid ? { rowIdx: nRow, colIdx: nCol } : null)
        if (!dispatched && valid) {
          const next = rows[nRow].querySelectorAll('td, th')[nCol]
          if (next) { next.focus(); this._selectAll(next) }
        }
      }
    })

    return outer
  }

  // Select all content in a contenteditable cell
  _selectAll(cell) {
    const range = document.createRange()
    range.selectNodeContents(cell)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
  }

  // Return { rowIdx, colIdx } of a cell within its table wrap
  _indices(wrap, cell) {
    const row  = cell.parentElement
    const rows = Array.from(wrap.querySelectorAll('tr'))
    return {
      rowIdx: rows.indexOf(row),
      colIdx: Array.from(row.querySelectorAll('td, th')).indexOf(cell),
    }
  }

  // Write the cell's current textContent back to the CM6 doc if it changed.
  // Returns true if a dispatch was made (widget will rebuild).
  _commitCell(cmView, cell, rowIdx, colIdx, pendingNext) {
    const newValue = cell.textContent
    const rawValue = cell._nbRaw ?? ''
    if (newValue.trim() === rawValue.trim()) return false

    const full = cmView.state.doc.toString()
    const tIdx = full.indexOf(this.rawText)
    if (tIdx === -1) return false

    // Widget will rebuild — store pending focus using table start position as key
    // (rawText changes after the edit, but the table's document position stays the same)
    if (pendingNext) {
      _tablePendingFocus = { tableFrom: tIdx, rowIdx: pendingNext.rowIdx, colIdx: pendingNext.colIdx }
      setTimeout(() => { _tablePendingFocus = null }, 500)
    }

    const lines   = this.rawText.split('\n')
    const lineIdx = rowIdx === 0 ? 0 : rowIdx + 1
    if (lineIdx >= lines.length) return false
    const line = lines[lineIdx]
    const r = this._cellRange(line, colIdx)
    if (!r) return false

    let lineStart = tIdx
    for (let i = 0; i < lineIdx; i++) lineStart += lines[i].length + 1

    const old    = line.slice(r[0], r[1])
    const lead   = old.match(/^\s*/)[0]
    const trail  = old.match(/\s*$/)[0]
    const insert = lead + newValue.trim() + trail

    cmView.dispatch({ changes: { from: lineStart + r[0], to: lineStart + r[1], insert } })
    return true
  }

  _cellRange(line, colIdx) {
    let pipe = -1, start = -1
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '\\' && line[i + 1] === '|') { i++; continue } // skip escaped pipe
      if (line[i] !== '|') continue
      pipe++
      if (pipe === colIdx) start = i + 1
      else if (pipe === colIdx + 1) return [start, i]
    }
    return start !== -1 ? [start, line.length] : null
  }

  _parseRowRaw(row) {
    const trimmed = row.trim()
    const inner = trimmed.replace(/^(?<!\\)\|/, '').replace(/(?<!\\)\|$/, '')
    return inner.split(/(?<!\\)\|/).map(c => c.trim())
  }

  _replaceRaw(cmView, newRaw) {
    const full = cmView.state.doc.toString()
    const from = full.indexOf(this.rawText)
    if (from === -1) return
    cmView.dispatch({ changes: { from, to: from + this.rawText.length, insert: newRaw } })
  }

  _insertRow(cmView, rowIdx, below) {
    const lines = this.rawText.split('\n')
    const numCols = this._parseRowRaw(lines[0]).length
    const newRow = '|' + Array(numCols).fill('    ').join('|') + '|'
    // rowIdx 0 = header; body rows map to lines[rowIdx + 1] (separator is at lines[1])
    const insertAt = rowIdx === 0 ? 2 : (below ? rowIdx + 2 : rowIdx + 1)
    lines.splice(insertAt, 0, newRow)
    this._replaceRaw(cmView, lines.join('\n'))
  }

  _deleteRow(cmView, rowIdx) {
    if (rowIdx === 0) return // never delete header
    const lines = this.rawText.split('\n')
    const lineIdx = rowIdx + 1 // separator at 1, body rows at 2+
    if (lineIdx >= lines.length) return
    lines.splice(lineIdx, 1)
    this._replaceRaw(cmView, lines.join('\n'))
  }

  _insertCol(cmView, colIdx, right) {
    const insertAt = right ? colIdx + 1 : colIdx
    const lines = this.rawText.split('\n')
    const newLines = lines.map((line, li) => {
      if (!line.trim()) return line
      const cells = this._parseRowRaw(line)
      cells.splice(insertAt, 0, li === 1 ? '---' : '')
      return '| ' + cells.join(' | ') + ' |'
    })
    this._replaceRaw(cmView, newLines.join('\n'))
  }

  _deleteCol(cmView, colIdx) {
    const lines = this.rawText.split('\n')
    const newLines = lines.map(line => {
      if (!line.trim()) return line
      const cells = this._parseRowRaw(line)
      if (cells.length <= 1) return line
      cells.splice(colIdx, 1)
      return '| ' + cells.join(' | ') + ' |'
    })
    this._replaceRaw(cmView, newLines.join('\n'))
  }

  _showContextMenu(e, cmView, rowIdx, colIdx) {
    document.querySelectorAll('.nb-table-ctx').forEach(m => m.remove())
    const numCols = this._parseRowRaw(this.rawText.split('\n')[0]).length
    const isHeader = rowIdx === 0
    const menu = document.createElement('div')
    menu.className = 'nb-table-ctx'

    const items = [
      !isHeader && { label: 'Add row above', fn: () => this._insertRow(cmView, rowIdx, false) },
      { label: isHeader ? 'Add row below header' : 'Add row below', fn: () => this._insertRow(cmView, rowIdx, true) },
      !isHeader && { label: 'Delete row', fn: () => this._deleteRow(cmView, rowIdx), danger: true },
      null,
      { label: 'Add column left',  fn: () => this._insertCol(cmView, colIdx, false) },
      { label: 'Add column right', fn: () => this._insertCol(cmView, colIdx, true) },
      numCols > 1 && { label: 'Delete column', fn: () => this._deleteCol(cmView, colIdx), danger: true },
    ].filter(Boolean)

    for (const item of items) {
      if (item === null) {
        const sep = document.createElement('div'); sep.className = 'nb-table-ctx-sep'; menu.appendChild(sep); continue
      }
      const el = document.createElement('div')
      el.className = 'nb-table-ctx-item' + (item.danger ? ' nb-table-ctx-danger' : '')
      el.textContent = item.label
      el.addEventListener('mousedown', ev => { ev.preventDefault(); menu.remove(); item.fn() })
      menu.appendChild(el)
    }

    document.body.appendChild(menu)
    const mw = menu.offsetWidth, mh = menu.offsetHeight
    const safeX = Math.max(8, Math.min(e.clientX, window.innerWidth - mw - 8))
    const safeY = Math.max(60, Math.min(e.clientY, window.innerHeight - mh - 8))
    menu.style.left = safeX + 'px'
    menu.style.top  = safeY + 'px'
    const dismiss = ev => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', dismiss) } }
    setTimeout(() => document.addEventListener('mousedown', dismiss), 0)
  }

  eq(o) { return o instanceof TableWidget && o.rawText === this.rawText }
  compare(o) { return this.eq(o) }
  destroy() {}
  ignoreEvent() { return true }
  get estimatedHeight() { return 80 }
  coordsAt() { return null }
}

class SupWidget {
  constructor(text) { this.text = text }
  toDOM() {
    const el = document.createElement('sup')
    el.className = 'nb-sup'
    el.textContent = this.text
    return el
  }
  eq(o) { return o instanceof SupWidget && o.text === this.text }
  compare(o) { return o instanceof SupWidget && o.text === this.text }
  destroy() {}
  ignoreEvent() { return true }
  coordsAt() { return null }
}

class SubWidget {
  constructor(text) { this.text = text }
  toDOM() {
    const el = document.createElement('sub')
    el.className = 'nb-sub'
    el.textContent = this.text
    return el
  }
  eq(o) { return o instanceof SubWidget && o.text === this.text }
  compare(o) { return o instanceof SubWidget && o.text === this.text }
  destroy() {}
  ignoreEvent() { return true }
  coordsAt() { return null }
}

// ─── Footnote reference widget [^id] ─────────────────────────────────────────
class FnRefWidget {
  constructor(id) { this.id = id }
  toDOM() {
    const sup = document.createElement('sup')
    sup.className = 'cm-fn-ref-widget'
    sup.textContent = this.id
    return sup
  }
  eq(o) { return o instanceof FnRefWidget && o.id === this.id }
  compare(o) { return this.eq(o) }
  destroy() {}
  ignoreEvent() { return false }
  coordsAt() { return null }
}

// ─── /timer widget (interactive: pause/resume/edit) ───────────────────────────
class TimerWidget {
  constructor(totalSec, label, rawLine) {
    this.totalSec = totalSec; this.label = label; this.rawLine = rawLine
    this._ref = { interval: null, remaining: -1, paused: false }
  }
  toDOM(cmView) {
    const wrap = document.createElement('div')
    wrap.className = 'cm-timer-widget'
    try {
    const ref = this._ref
    const fmt = (s) => {
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
      if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
      return `${m}:${String(sec).padStart(2,'0')}`
    }

    // ── Empty state: show editable 00:00 timer ────────────
    if (this.totalSec === 0) {
      let editing = true
      let localSec = 0
      let localPaused = true

      const row = document.createElement('div')
      row.className = 'cm-timer-row'

      const timeText = document.createElement('div')
      timeText.className = 'cm-timer-time cm-timer-time-editable'
      timeText.textContent = '0:00'

      // Clicking time opens an inline input to set the time
      const showEdit = () => {
        const inp = document.createElement('input')
        inp.className = 'cm-timer-edit-input'
        inp.value = ''
        inp.type = 'text'
        inp.placeholder = 'mm:ss'
        timeText.textContent = ''
        timeText.appendChild(inp)
        inp.focus()
        const commit = () => {
          const v = inp.value.trim()
          if (!v) { timeText.textContent = fmt(localSec); return }
          let ns = 0
          const hms = v.match(/^(\d+):(\d{2}):(\d{2})$/)
          const ms = v.match(/^(\d+):(\d{2})$/)
          const mn = v.match(/^(\d+)$/)
          if (hms) ns = +hms[1]*3600 + +hms[2]*60 + +hms[3]
          else if (ms) ns = +ms[1]*60 + +ms[2]
          else if (mn) ns = +mn[1]*60
          if (ns > 0) {
            _replaceInDoc(cmView, this.rawLine, `/timer ${v}`)
          } else {
            timeText.textContent = fmt(localSec)
          }
        }
        inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); commit() } if (e.key === 'Escape') { timeText.textContent = fmt(localSec) } }
        inp.onblur = commit
      }
      timeText.onclick = showEdit

      row.appendChild(timeText)
      wrap.appendChild(row)
      return wrap
    }

    // ── Active timer ─────────────────────────────────────
    const total = this.totalSec
    // Restore state — pick up time ticked by background interval while widget was unmounted
    const _tp = _timerPersist.get(this.rawLine)
    if (_tp?.bgInterval) { clearInterval(_tp.bgInterval); _tp.bgInterval = null }
    let remaining = (_tp && _tp.remaining >= 0) ? _tp.remaining : total
    let paused = _tp ? _tp.paused : false
    // Live shared entry — both DOM interval and destroy's background interval mutate this
    const entry = { remaining, paused, bgInterval: null }
    _timerPersist.set(this.rawLine, entry)

    if (this.label) {
      const lbl = document.createElement('div')
      lbl.className = 'cm-timer-label'
      lbl.textContent = this.label
      wrap.appendChild(lbl)
    }

    const row = document.createElement('div')
    row.className = 'cm-timer-row'
    const timeText = document.createElement('div')
    timeText.className = 'cm-timer-time'
    timeText.textContent = fmt(remaining)

    // Click time to edit (only when paused) — this is the only path that writes to doc
    timeText.onclick = () => {
      if (!paused) return
      const inp = document.createElement('input')
      inp.className = 'cm-timer-edit-input'
      inp.value = fmt(remaining)
      inp.type = 'text'
      timeText.textContent = ''
      timeText.appendChild(inp)
      inp.focus(); inp.select()
      const commit = () => {
        const v = inp.value.trim()
        let ns = 0
        const hms = v.match(/^(\d+):(\d{2}):(\d{2})$/)
        const ms = v.match(/^(\d+):(\d{2})$/)
        const mn = v.match(/^(\d+)$/)
        if (hms) ns = +hms[1]*3600 + +hms[2]*60 + +hms[3]
        else if (ms) ns = +ms[1]*60 + +ms[2]
        else if (mn) ns = +mn[1]*60
        if (ns > 0) {
          // Clear persist so new widget starts fresh at the edited value
          _timerPersist.delete(this.rawLine)
          const newLine = this.label ? `/timer ${v} ${this.label}` : `/timer ${v}`
          _replaceInDoc(cmView, this.rawLine, newLine)
        } else {
          timeText.textContent = fmt(remaining)
        }
      }
      inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); commit() } if (e.key === 'Escape') timeText.textContent = fmt(remaining) }
      inp.onblur = commit
    }

    const pauseBtn = document.createElement('button')
    pauseBtn.className = 'cm-timer-btn'
    pauseBtn.textContent = paused ? '\u25b6' : '\u23f8'
    const resetBtn = document.createElement('button')
    resetBtn.className = 'cm-timer-btn'
    resetBtn.textContent = '\u21ba'

    row.appendChild(timeText)
    row.appendChild(pauseBtn)
    row.appendChild(resetBtn)
    wrap.appendChild(row)

    const bar = document.createElement('div')
    bar.className = 'cm-timer-bar'
    const fill = document.createElement('div')
    fill.className = 'cm-timer-fill'
    fill.style.width = `${(remaining / total) * 100}%`
    bar.appendChild(fill)
    wrap.appendChild(bar)

    const playTimerSound = () => {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)()
        const playTone = (freq, start, dur) => {
          const osc = ctx.createOscillator()
          const gain = ctx.createGain()
          osc.connect(gain); gain.connect(ctx.destination)
          osc.frequency.value = freq; osc.type = 'sine'
          gain.gain.setValueAtTime(0.3, ctx.currentTime + start)
          gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + start + dur)
          osc.start(ctx.currentTime + start); osc.stop(ctx.currentTime + start + dur)
        }
        playTone(880, 0, 0.15); playTone(880, 0.2, 0.15); playTone(1100, 0.45, 0.3)
      } catch { /* no audio context available */ }
    }

    const tick = () => {
      remaining--
      entry.remaining = remaining
      if (remaining <= 0) {
        remaining = 0; entry.remaining = 0
        clearInterval(ref.interval); ref.interval = null
        timeText.textContent = 'Done!'
        timeText.classList.add('cm-timer-done')
        fill.style.width = '0%'
        pauseBtn.textContent = '\u23f8'
        _timerPersist.delete(this.rawLine)
        playTimerSound()
        return
      }
      timeText.textContent = fmt(remaining)
      fill.style.width = `${(remaining / total) * 100}%`
    }

    if (!paused) {
      ref.interval = setInterval(tick, 1000)
    }

    pauseBtn.onclick = () => {
      if (remaining <= 0) return
      if (paused) {
        paused = false; pauseBtn.textContent = '\u23f8'
        entry.paused = false
        ref.interval = setInterval(tick, 1000)
      } else {
        paused = true; pauseBtn.textContent = '\u25b6'
        entry.paused = true
        if (ref.interval) { clearInterval(ref.interval); ref.interval = null }
      }
    }
    resetBtn.onclick = () => {
      remaining = total; paused = false
      entry.remaining = total; entry.paused = false
      timeText.textContent = fmt(remaining)
      timeText.classList.remove('cm-timer-done')
      fill.style.width = '100%'
      pauseBtn.textContent = '\u23f8'
      if (ref.interval) clearInterval(ref.interval)
      ref.interval = setInterval(tick, 1000)
    }

    } catch (err) {
      wrap.innerHTML = ''
      const errEl = document.createElement('div')
      errEl.style.cssText = 'padding:8px 12px;color:var(--textDim,#888);font-size:12px;border-left:3px solid var(--border,#ccc);margin:4px 0;'
      errEl.textContent = '/timer — render error: ' + (err?.message || err)
      wrap.appendChild(errEl)
    }
    return wrap
  }
  eq(o) { return o instanceof TimerWidget && o.totalSec === this.totalSec && o.label === this.label }
  compare(o) { return this.eq(o) }
  destroy() {
    if (this._ref.interval) { clearInterval(this._ref.interval); this._ref.interval = null }
    // If still running, hand off to a background interval so time keeps ticking while unmounted
    const entry = _timerPersist.get(this.rawLine)
    if (entry && !entry.paused && entry.remaining > 0) {
      entry.bgInterval = setInterval(() => {
        if (!entry || entry.paused || entry.remaining <= 0) {
          clearInterval(entry.bgInterval); entry.bgInterval = null; return
        }
        entry.remaining = Math.max(0, entry.remaining - 1)
        if (entry.remaining <= 0) { clearInterval(entry.bgInterval); entry.bgInterval = null }
      }, 1000)
    }
  }
  ignoreEvent() { return true }
  get estimatedHeight() { return this.totalSec === 0 ? 48 : 72 }
  coordsAt() { return null }
}

// ─── /pomo widget (pomodoro timer) ───────────────────────────────────────────
class PomoWidget {
  constructor(rawLine) {
    this.rawLine = rawLine
    this._ref = { interval: null }
  }
  toDOM() {
    const wrap = document.createElement('div')
    wrap.className = 'cm-pomo-widget'
    const ref = this._ref

    const WORK = 25 * 60, SHORT = 5 * 60, LONG = 15 * 60
    let phase = 'work' // 'work' | 'short' | 'long'
    let remaining = WORK
    let paused = true
    let sessions = 0

    const fmt = (s) => {
      const m = Math.floor(s / 60), sec = s % 60
      return `${m}:${String(sec).padStart(2, '0')}`
    }

    const playSound = () => {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)()
        const playTone = (freq, start, dur) => {
          const osc = ctx.createOscillator()
          const gain = ctx.createGain()
          osc.connect(gain); gain.connect(ctx.destination)
          osc.frequency.value = freq; osc.type = 'sine'
          gain.gain.setValueAtTime(0.3, ctx.currentTime + start)
          gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + start + dur)
          osc.start(ctx.currentTime + start); osc.stop(ctx.currentTime + start + dur)
        }
        playTone(660, 0, 0.12); playTone(880, 0.15, 0.12); playTone(1100, 0.3, 0.25)
      } catch { /* */ }
    }

    // Header
    const hdr = document.createElement('div')
    hdr.className = 'cm-pomo-hdr'
    const title = document.createElement('span')
    title.className = 'cm-pomo-title'
    title.textContent = 'Pomodoro'
    const sessionBadge = document.createElement('span')
    sessionBadge.className = 'cm-pomo-sessions'
    sessionBadge.textContent = '0 sessions'
    hdr.appendChild(title)
    hdr.appendChild(sessionBadge)
    wrap.appendChild(hdr)

    // Phase indicator
    const phaseRow = document.createElement('div')
    phaseRow.className = 'cm-pomo-phase-row'
    const phases = ['work', 'short', 'long']
    const phaseLabels = { work: 'Focus', short: 'Short Break', long: 'Long Break' }
    const phaseBtns = {}
    phases.forEach(p => {
      const btn = document.createElement('button')
      btn.className = `cm-pomo-phase-btn${p === phase ? ' active' : ''}`
      btn.textContent = phaseLabels[p]
      btn.onclick = () => {
        phase = p
        remaining = p === 'work' ? WORK : p === 'short' ? SHORT : LONG
        paused = true
        if (ref.interval) { clearInterval(ref.interval); ref.interval = null }
        update()
      }
      phaseBtns[p] = btn
      phaseRow.appendChild(btn)
    })
    wrap.appendChild(phaseRow)

    // Time display
    const timeText = document.createElement('div')
    timeText.className = 'cm-pomo-time'
    timeText.textContent = fmt(remaining)
    wrap.appendChild(timeText)

    // Progress bar
    const bar = document.createElement('div')
    bar.className = 'cm-pomo-bar'
    const fill = document.createElement('div')
    fill.className = 'cm-pomo-fill'
    fill.style.width = '100%'
    bar.appendChild(fill)
    wrap.appendChild(bar)

    // Controls
    const controls = document.createElement('div')
    controls.className = 'cm-pomo-controls'
    const playBtn = document.createElement('button')
    playBtn.className = 'cm-pomo-btn cm-pomo-play'
    playBtn.textContent = '\u25b6'
    const resetBtn = document.createElement('button')
    resetBtn.className = 'cm-pomo-btn'
    resetBtn.textContent = '\u21ba'
    const skipBtn = document.createElement('button')
    skipBtn.className = 'cm-pomo-btn'
    skipBtn.textContent = '\u23ed'
    skipBtn.title = 'Skip to next phase'
    controls.appendChild(playBtn)
    controls.appendChild(resetBtn)
    controls.appendChild(skipBtn)
    wrap.appendChild(controls)

    const getTotal = () => phase === 'work' ? WORK : phase === 'short' ? SHORT : LONG

    const update = () => {
      timeText.textContent = fmt(remaining)
      const total = getTotal()
      fill.style.width = `${(remaining / total) * 100}%`
      fill.className = `cm-pomo-fill ${phase === 'work' ? 'cm-pomo-fill-work' : 'cm-pomo-fill-break'}`
      playBtn.textContent = paused ? '\u25b6' : '\u23f8'
      sessionBadge.textContent = `${sessions} session${sessions !== 1 ? 's' : ''}`
      phases.forEach(p => {
        phaseBtns[p].className = `cm-pomo-phase-btn${p === phase ? ' active' : ''}`
      })
    }

    const nextPhase = () => {
      playSound()
      if (phase === 'work') {
        sessions++
        phase = sessions % 4 === 0 ? 'long' : 'short'
      } else {
        phase = 'work'
      }
      remaining = getTotal()
      paused = true
      if (ref.interval) { clearInterval(ref.interval); ref.interval = null }
      update()
    }

    const tick = () => {
      remaining--
      if (remaining <= 0) {
        remaining = 0
        if (ref.interval) { clearInterval(ref.interval); ref.interval = null }
        update()
        nextPhase()
        return
      }
      update()
    }

    playBtn.onclick = () => {
      if (remaining <= 0) return
      if (paused) {
        paused = false
        ref.interval = setInterval(tick, 1000)
      } else {
        paused = true
        if (ref.interval) { clearInterval(ref.interval); ref.interval = null }
      }
      update()
    }

    resetBtn.onclick = () => {
      remaining = getTotal()
      paused = true
      if (ref.interval) { clearInterval(ref.interval); ref.interval = null }
      update()
    }

    skipBtn.onclick = nextPhase

    update()
    return wrap
  }
  eq(o) { return o instanceof PomoWidget }
  compare(o) { return this.eq(o) }
  destroy() { if (this._ref.interval) clearInterval(this._ref.interval) }
  ignoreEvent() { return true }
  get estimatedHeight() { return 140 }
  coordsAt() { return null }
}

// ─── /calendar widget (full-width, day/week/month, inline events) ─────────────
class CalendarWidget {
  constructor(rawData, rawLine) { this.rawData = rawData || ''; this.rawLine = rawLine; this._root = null }
  toDOM() {
    const wrap = document.createElement('div')
    wrap.className = 'cm-calendar-widget'
    wrap.style.minHeight = '400px'
    // Dynamically import FullCalendar (avoids circular-dep at module load time)
    import('./LibraryView').then(({ FullCalendar }) => {
      if (this._root) return // already mounted
      this._root = createRoot(wrap)
      this._root.render(createElement(FullCalendar, null))
    })
    return wrap
  }
  eq(o) { return o instanceof CalendarWidget }
  compare(o) { return this.eq(o) }
  destroy() {
    if (this._root) {
      const r = this._root; this._root = null
      // Defer unmount to avoid React warning about unmounting during render
      setTimeout(() => { try { r.unmount() } catch { /**/ } }, 0)
    }
  }
  ignoreEvent() { return true }
  get estimatedHeight() { return 400 }
  coordsAt() { return null }
}

// ─── Inline link widgets (/linkf, /linkw, /linkv) ────────────────────────────

// SVG icon strings keyed by category
const _LINK_ICONS = {
  image:  `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="2" width="14" height="12" rx="1.5"/><circle cx="5.5" cy="6.5" r="1.5"/><path d="M1.5 12l3.5-3 3 3 2.5-2 4 3.5"/></svg>`,
  audio:  `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3L5 6.5H2.5a1 1 0 00-1 1v1a1 1 0 001 1H5L9 13V3z"/><path d="M12 5.5c.9.8 1.5 1.9 1.5 2.5S12.9 9.7 12 10.5"/></svg>`,
  video:  `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3.5" width="10" height="9" rx="1.5"/><path d="M11 6.5l4-2v7l-4-2"/></svg>`,
  pdf:    `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 1H3a1 1 0 00-1 1v12a1 1 0 001 1h10a1 1 0 001-1V6L9.5 1z"/><path d="M9.5 1v5H14.5"/><path d="M5 10.5h2a1 1 0 010 2H5V9h2a1 1 0 010 2"/></svg>`,
  doc:    `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 1H3a1 1 0 00-1 1v12a1 1 0 001 1h10a1 1 0 001-1V6L9.5 1z"/><path d="M9.5 1v5H14.5"/><path d="M5 8.5h6M5 11h6M5 13.5h4"/></svg>`,
  sheet:  `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="12" height="12" rx="1"/><path d="M2 6h12M2 10h12M7 2v12"/></svg>`,
  archive:`<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="5" width="14" height="9" rx="1"/><path d="M1 5l2-4h10l2 4"/><path d="M6 9h4"/></svg>`,
  code:   `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4L1 8l4 4M11 4l4 4-4 4M9.5 2l-3 12"/></svg>`,
  text:   `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h10M8 3v10M5 13h6"/></svg>`,
  config: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.2 3.2l1.4 1.4M11.4 11.4l1.4 1.4M3.2 12.8l1.4-1.4M11.4 4.6l1.4-1.4"/></svg>`,
  file:   `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 1H3a1 1 0 00-1 1v12a1 1 0 001 1h10a1 1 0 001-1V6L9.5 1z"/><path d="M9.5 1v5H14.5"/></svg>`,
}

function _fileLinkIcon(ext) {
  const e = (ext || '').toLowerCase()
  if (['jpg','jpeg','png','gif','webp','svg','bmp','ico','avif','tiff'].includes(e)) return _LINK_ICONS.image
  if (['mp3','wav','ogg','flac','aac','m4a','opus'].includes(e))                     return _LINK_ICONS.audio
  if (['mp4','mov','avi','mkv','webm','flv','wmv','m4v'].includes(e))               return _LINK_ICONS.video
  if (e === 'pdf')                                                                   return _LINK_ICONS.pdf
  if (['doc','docx','rtf'].includes(e))                                              return _LINK_ICONS.doc
  if (['xls','xlsx','csv'].includes(e))                                              return _LINK_ICONS.sheet
  if (['zip','gz','tar','rar','7z'].includes(e))                                     return _LINK_ICONS.archive
  if (['js','ts','jsx','tsx','py','rb','go','rs','java','c','cpp','h','css','html'].includes(e)) return _LINK_ICONS.code
  if (['md','txt'].includes(e))                                                      return _LINK_ICONS.text
  if (['json','yaml','yml','xml','toml'].includes(e))                                return _LINK_ICONS.config
  return _LINK_ICONS.file
}

// SVG icon for the web link widget
const _GLOBE_ICON = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="7"/><path d="M8 1c-2 2-3 4.5-3 7s1 5 3 7M8 1c2 2 3 4.5 3 7s-1 5-3 7"/><path d="M1 8h14"/></svg>`
const _OPEN_ICON  = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3H3a1 1 0 00-1 1v9a1 1 0 001 1h9a1 1 0 001-1V9"/><path d="M10 2h4v4"/><path d="M14 2L8 8"/></svg>`

class FileLinkWidget {
  constructor(path, name) { this.path = path; this.name = name }
  toDOM() {
    const ext = (this.path || '').split('.').pop()
    const wrap = document.createElement('span')
    wrap.className = 'cm-linkf-badge'
    wrap.dataset.linkfPath = this.path
    wrap.title = this.path

    const iconEl = document.createElement('span')
    iconEl.className = 'cm-linkf-icon'
    iconEl.innerHTML = _fileLinkIcon(ext)

    const nameEl = document.createElement('span')
    nameEl.className = 'cm-linkf-name'
    nameEl.textContent = this.name || this.path.split(/[/\\]/).pop() || this.path

    wrap.appendChild(iconEl)
    wrap.appendChild(nameEl)
    return wrap
  }
  eq(o) { return o instanceof FileLinkWidget && o.path === this.path && o.name === this.name }
  compare(o) { return this.eq(o) }
  destroy() {}
  ignoreEvent() { return false }
  coordsAt() { return null }
}

let _webviewCounter = 0

class WebLinkWidget {
  constructor(url, title) {
    this.url = url
    this.title = title
    this._label = `gnos-wv-${++_webviewCounter}`
    this._wv = null
    this._cleanup = null
  }

  toDOM() {
    const urlObj = (() => { try { return new URL(this.url) } catch { return null } })()
    const domain = urlObj?.hostname || this.url

    const wrap = document.createElement('div')
    wrap.className = 'cm-linkw-wrap'

    // ── Header bar (single line) ────────────────────────────
    const header = document.createElement('div')
    header.className = 'cm-linkw-header'

    const iconEl = document.createElement('span')
    iconEl.className = 'cm-linkw-glob'
    iconEl.innerHTML = _GLOBE_ICON

    const titleEl = document.createElement('span')
    titleEl.className = 'cm-linkw-title'
    titleEl.textContent = this.title || domain

    const domainEl = document.createElement('span')
    domainEl.className = 'cm-linkw-url'
    domainEl.textContent = this.title ? ` — ${domain}` : ''

    const info = document.createElement('div')
    info.className = 'cm-linkw-info'
    info.appendChild(titleEl); info.appendChild(domainEl)

    const openBtn = document.createElement('button')
    openBtn.className = 'cm-linkw-open-btn'
    openBtn.dataset.linkwUrl = this.url
    openBtn.dataset.linkwTitle = this.title || domain
    openBtn.title = 'Open in new window'
    openBtn.innerHTML = _OPEN_ICON + ' Open'

    header.appendChild(iconEl); header.appendChild(info); header.appendChild(openBtn)

    // ── Native webview area (lazy — thumbnail preview until clicked) ───────
    const viewArea = document.createElement('div')
    viewArea.className = 'cm-linkw-view-area'

    const loadOverlay = document.createElement('div')
    loadOverlay.className = 'cm-linkw-load-overlay'

    // Thumbnail — src set once fetch_og_image resolves
    const thumbImg = document.createElement('img')
    thumbImg.className = 'cm-linkw-thumb'
    thumbImg.alt = ''
    thumbImg.onerror = () => { thumbImg.style.display = 'none' }

    // Favicon badge pinned bottom-left, always visible as fallback
    const faviconBadge = document.createElement('div')
    faviconBadge.className = 'cm-linkw-favicon-badge'
    const faviconImg = document.createElement('img')
    faviconImg.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`
    faviconImg.alt = ''
    faviconImg.onerror = () => { faviconBadge.style.display = 'none' }
    faviconBadge.appendChild(faviconImg)

    loadOverlay.appendChild(thumbImg)
    loadOverlay.appendChild(faviconBadge)
    viewArea.appendChild(loadOverlay)

    // Fetch og:image via Rust (bypasses CORS)
    if (_invoke) {
      _invoke('fetch_og_image', { url: this.url }).then(ogUrl => {
        if (ogUrl && loadOverlay.isConnected) thumbImg.src = ogUrl
      }).catch(() => {})
    }

    loadOverlay.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
    loadOverlay.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      loadOverlay.remove()
      this._mountWebview(viewArea)
    }, { once: true })

    wrap.appendChild(header)
    wrap.appendChild(viewArea)

    return wrap
  }

  _mountWebview(viewArea) {
    const url = this.url
    const label = this._label
    let attempts = 0

    const getHeaderBottom = () => {
      const hdr = document.querySelector('.nb-header') || document.querySelector('.gnos-header')
      return hdr ? Math.ceil(hdr.getBoundingClientRect().bottom) : 0
    }

    const clampedBounds = (r) => {
      const minY = getHeaderBottom()
      const rawTop = Math.round(r.top)
      const clampedTop = Math.max(rawTop, minY)
      const clampedHeight = Math.max(60, Math.round(r.height) - (clampedTop - rawTop))
      return { x: Math.round(r.left), y: clampedTop, width: Math.max(100, Math.round(r.width)), height: clampedHeight }
    }

    const tryCreate = async () => {
      if (!viewArea.isConnected) {
        if (++attempts < 40) requestAnimationFrame(tryCreate)
        return
      }
      if (!_invoke) {
        // Not in a Tauri context — the card header with Open button is the fallback
        return
      }
      const rect = viewArea.getBoundingClientRect()
      try {
        await _invoke('create_inline_webview', { label, url, ...clampedBounds(rect) })
        this._created = true
      } catch (err) {
        console.warn('[linkw] embedded webview failed:', err)
        return
      }

      let rafId = null
      const reposition = () => {
        if (!viewArea.isConnected || !this._created) return
        const r = viewArea.getBoundingClientRect()
        _invoke('reposition_inline_webview', { label, ...clampedBounds(r) }).catch(() => {})
      }
      const scheduleRepos = () => {
        if (rafId) return
        rafId = requestAnimationFrame(() => { rafId = null; reposition() })
      }

      document.addEventListener('scroll', scheduleRepos, { capture: true, passive: true })
      window.addEventListener('resize', scheduleRepos, { passive: true })

      this._cleanup = () => {
        document.removeEventListener('scroll', scheduleRepos, { capture: true })
        window.removeEventListener('resize', scheduleRepos)
        if (rafId) { cancelAnimationFrame(rafId); rafId = null }
      }
    }
    requestAnimationFrame(tryCreate)
  }

  eq(o) { return o instanceof WebLinkWidget && o.url === this.url && o.title === this.title }
  compare(o) { return this.eq(o) }
  get estimatedHeight() { return 500 }

  destroy() {
    if (this._cleanup) { this._cleanup(); this._cleanup = null }
    if (this._created && _invoke) {
      _invoke('close_inline_webview', { label: this._label }).catch(() => {})
      this._created = false
    }
  }

  ignoreEvent() { return false }
  coordsAt() { return null }
}

class VideoLinkWidget {
  constructor(src, title) { this.src = src; this.title = title }
  toDOM() {
    const wrap = document.createElement('div')
    wrap.className = 'cm-linkv-wrap'

    // ── Single-line header ──────────────────────────────────
    const header = document.createElement('div')
    header.className = 'cm-linkv-header'

    const iconEl = document.createElement('span')
    iconEl.className = 'cm-linkv-icon'
    iconEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>'

    const titleText = (() => {
      if (this.title) return this.title
      const parts = this.src.split(/[\\/]/)
      return parts[parts.length - 1] || this.src
    })()

    const titleEl = document.createElement('span')
    titleEl.className = 'cm-linkv-title'
    titleEl.textContent = titleText

    header.appendChild(iconEl)
    header.appendChild(titleEl)
    wrap.appendChild(header)

    // ── Video element ───────────────────────────────────────
    const video = document.createElement('video')
    video.className = 'cm-linkv-video'
    video.controls = true
    video.preload = 'metadata'
    let resolvedSrc = this.src
    if (_convertFileSrc && !this.src.startsWith('http') && !this.src.startsWith('blob:')) {
      try { resolvedSrc = _convertFileSrc(this.src) } catch { /**/ }
    }
    video.src = resolvedSrc

    // Seek to first frame once metadata is loaded so it shows as a thumbnail
    video.addEventListener('loadedmetadata', () => {
      video.currentTime = 0.001
    }, { once: true })

    wrap.appendChild(video)

    return wrap
  }
  eq(o) { return o instanceof VideoLinkWidget && o.src === this.src && o.title === this.title }
  compare(o) { return this.eq(o) }
  get estimatedHeight() { return 220 }
  destroy() {}
  ignoreEvent() { return false }
  coordsAt() { return null }
}

// ─── /linkf, /linkw, /linkv — Enter key notifies React to open picker/modal ───
// onPickRef is a React ref whose .current is set to a callback each render.
// Calling native dialogs from inside CM keymaps can crash the app on macOS —
// so we just signal React and let the effect/JSX handle the actual dialog.
function makeLinkCommands(cm, onPickRef) {
  const { Prec } = cm.state
  return Prec.high(cm.view.keymap.of([{
    key: 'Enter',
    run: (view) => {
      const { state } = view
      const line = state.doc.lineAt(state.selection.main.head)
      const txt = line.text.trim()
      const onPick = typeof onPickRef === 'function' ? onPickRef : onPickRef?.current
      if (txt === '/linkf') { onPick?.({ type: 'file',  lineFrom: line.from, lineTo: line.to }); return true }
      if (txt === '/linkw') { onPick?.({ type: 'web',   lineFrom: line.from, lineTo: line.to }); return true }
      if (txt === '/linkv') { onPick?.({ type: 'video', lineFrom: line.from, lineTo: line.to }); return true }
      return false
    },
  }]))
}

// ─── /color, /font, /spacing, /size — keymap only ────────────────────────────
// Detection + coord lookup lives in the EditorView.updateListener (see below).
// This function only provides the Prec.high keymap so Enter/Tab/↑↓ work.
function makeInlineCmdPlugin(cm, navRef) {
  const { Prec } = cm.state
  const { keymap: keymapFacet } = cm.view

  const CMD_RE = /^\s*\/(color|font|spacing|size)(?::([^\s]*))?$/
  const shared = { selectedIdx: 0, type: null }

  function detect(state) {
    const cur = state.selection.main.head
    const line = state.doc.lineAt(cur)
    const m = line.text.match(CMD_RE)
    if (!m) return null
    return { type: m[1], hint: (m[2] || '').toLowerCase(), lineFrom: line.from, lineTo: line.to }
  }

  return Prec.high(keymapFacet.of([
    {
      key: 'Escape',
      run: _view => {
        const result = detect(_view.state)
        if (!result) return false
        _inlineCmdSelectedIdx.current = 0
        shared.selectedIdx = 0; shared.type = null
        navRef?.current?.()
        return false  // let Escape propagate
      },
    },
    {
      key: 'Tab',
      run: view => {
        const result = detect(view.state)
        if (!result) return false
        _confirmInlineCmd(view, result.type, _inlineCmdSelectedIdx.current, result.hint, result.lineFrom, result.lineTo)
        shared.selectedIdx = 0; shared.type = null; _inlineCmdSelectedIdx.current = 0
        return true
      },
    },
    {
      key: 'Enter',
      run: view => {
        const result = detect(view.state)
        if (!result) return false
        _confirmInlineCmd(view, result.type, _inlineCmdSelectedIdx.current, result.hint, result.lineFrom, result.lineTo)
        shared.selectedIdx = 0; shared.type = null; _inlineCmdSelectedIdx.current = 0
        return true
      },
    },
  ]))
}

// Shared mutable ref for selectedIdx — written by the keymap, read by React render
const _inlineCmdSelectedIdx = { current: 0 }

const INLINE_COLORS = [
  { name: 'Red',     value: '#e53935' },
  { name: 'Orange',  value: '#f4511e' },
  { name: 'Amber',   value: '#f59f00' },
  { name: 'Yellow',  value: '#e6c20a' },
  { name: 'Green',   value: '#2e7d32' },
  { name: 'Teal',    value: '#00796b' },
  { name: 'Cyan',    value: '#0097a7' },
  { name: 'Blue',    value: '#1565c0' },
  { name: 'Indigo',  value: '#3949ab' },
  { name: 'Violet',  value: '#6a1b9a' },
  { name: 'Purple',  value: '#8e24aa' },
  { name: 'Pink',    value: '#d81b60' },
  { name: 'Rose',    value: '#c2185b' },
  { name: 'Brown',   value: '#6d4c41' },
  { name: 'Slate',   value: '#546e7a' },
  { name: 'Gray',    value: '#757575' },
  { name: 'Silver',  value: '#9e9e9e' },
  { name: 'Muted',   value: 'var(--textDim)' },
  { name: 'Accent',  value: 'var(--accent)' },
  { name: 'Default', value: 'inherit' },
]

const INLINE_FONTS = [
  { name: 'Default',       value: 'var(--nb-ff)' },
  { name: 'Georgia',       value: 'Georgia, serif' },
  { name: 'Palatino',      value: '"Palatino Linotype", Palatino, serif' },
  { name: 'Garamond',      value: '"EB Garamond", Garamond, serif' },
  { name: 'Times',         value: '"Times New Roman", Times, serif' },
  { name: 'Arial',         value: 'Arial, sans-serif' },
  { name: 'Helvetica',     value: 'Helvetica, Arial, sans-serif' },
  { name: 'Verdana',       value: 'Verdana, Geneva, sans-serif' },
  { name: 'Trebuchet',     value: '"Trebuchet MS", sans-serif' },
  { name: 'Optima',        value: '"Optima", "Segoe UI", sans-serif' },
  { name: 'Gill Sans',     value: '"Gill Sans", "Gill Sans MT", sans-serif' },
  { name: 'Futura',        value: '"Futura", "Century Gothic", sans-serif' },
  { name: 'Courier',       value: '"Courier New", Courier, monospace' },
  { name: 'Menlo',         value: 'Menlo, Monaco, Consolas, monospace' },
  { name: 'SF Mono',       value: '"SF Mono", "Fira Code", monospace' },
]

const INLINE_SPACINGS = [
  { name: 'Tight',    value: '1.3', preview: '1.3×' },
  { name: 'Compact',  value: '1.5', preview: '1.5×' },
  { name: 'Normal',   value: '1.8', preview: '1.8×' },
  { name: 'Relaxed',  value: '2.2', preview: '2.2×' },
  { name: 'Double',   value: '2.8', preview: '2.8×' },
]

const INLINE_SIZES = [
  { name: 'XS',     value: '0.72em', preview: 'Aa' },
  { name: 'Small',  value: '0.85em', preview: 'Aa' },
  { name: 'Normal', value: '1em',    preview: 'Aa' },
  { name: 'Large',  value: '1.2em',  preview: 'Aa' },
  { name: 'XL',     value: '1.5em',  preview: 'Aa' },
  { name: 'XXL',    value: '2em',    preview: 'Aa' },
  { name: 'Huge',   value: '2.8em',  preview: 'Aa' },
]

function _getOptionCount(type) {
  if (type === 'color') return INLINE_COLORS.length
  if (type === 'font') return INLINE_FONTS.length
  if (type === 'spacing') return INLINE_SPACINGS.length
  if (type === 'size') return INLINE_SIZES.length
  return 0
}

function _confirmInlineCmd(view, type, selectedIdx, hint, lineFrom, lineTo) {
  let marker = ''
  if (type === 'color') {
    // If hint matches a named color, use it; otherwise use selected
    const byName = INLINE_COLORS.find(c => c.name.toLowerCase() === hint)
    const opt = byName || INLINE_COLORS[Math.min(selectedIdx, INLINE_COLORS.length - 1)]
    if (opt) marker = `{color:${opt.value}}`
  } else if (type === 'font') {
    const byName = INLINE_FONTS.find(f => f.name.toLowerCase().startsWith(hint))
    const opt = byName || INLINE_FONTS[Math.min(selectedIdx, INLINE_FONTS.length - 1)]
    if (opt) marker = `{font:${opt.value}}`
  } else if (type === 'spacing') {
    const byName = INLINE_SPACINGS.find(s => s.name.toLowerCase().startsWith(hint))
    const opt = byName || INLINE_SPACINGS[Math.min(selectedIdx, INLINE_SPACINGS.length - 1)]
    if (opt) marker = `{spacing:${opt.value}}`
  } else if (type === 'size') {
    const byName = INLINE_SIZES.find(s => s.name.toLowerCase().startsWith(hint))
    const opt = byName || INLINE_SIZES[Math.min(selectedIdx, INLINE_SIZES.length - 1)]
    if (opt) marker = `{size:${opt.value}}`
  }
  if (!marker) return
  view.dispatch({
    changes: { from: lineFrom, to: lineTo, insert: marker },
    selection: { anchor: lineFrom + marker.length },
  })
}

// ─── Auto-close {//} when user types // after an open inline-cmd span ────────
function makeInlineCmdCloseHandler(cm) {
  return cm.view.EditorView.inputHandler.of((view, from, to, text) => {
    if (text !== '/') return false
    const { state } = view
    const docText = state.doc.toString()
    const charBefore = from > 0 ? docText[from - 1] : ''
    // Only trigger on second slash (user just typed the second /)
    if (charBefore !== '/') return false
    // Don't convert if preceded by : (e.g., https://)
    if (from >= 2 && docText[from - 2] === ':') return false
    // Check if there's an unclosed {color:...}, {font:...}, or {spacing:...} before cursor
    const textBefore = docText.slice(0, from - 1) // text before the first slash
    const openRe = /\{(color|font|spacing|size):[^}]+\}/g
    const closeRe = /\{\/\/\}/g
    let openCount = 0, closeCount = 0
    let m
    while ((m = openRe.exec(textBefore)) !== null) openCount++
    while ((m = closeRe.exec(textBefore)) !== null) closeCount++
    if (openCount <= closeCount) return false // no unclosed span
    // Replace the first / and insert {//}
    view.dispatch({
      changes: { from: from - 1, to, insert: '{//}' },
      selection: { anchor: from - 1 + 4 },
    })
    return true
  })
}

// ─── Live preview plugin ──────────────────────────────────────────────────────
function makeLivePlugin(cm, RangeSetBuilder, notebooks, library, sketchbooks = [], flashcardDecks = [], notebookDir = null, isPreview = false) {
  const { ViewPlugin, Decoration, WidgetType } = cm.view
  const { StateField } = cm.state
  const { syntaxTree } = cm.language

  // Patch widget classes to extend WidgetType so CM6 properly handles them
  for (const Cls of [HRWidget, CheckboxWidget, ImgWidget, ListMarkerWidget, MathWidget, WikiWidget, LinkWidget, TableWidget, HabitsWidget, TaskBlockWidget, SupWidget, SubWidget, TimerWidget, CalendarWidget, TimeRefWidget, FnRefWidget, DueDateWidget, TagWidget, QuestionWidget, FileLinkWidget, WebLinkWidget, VideoLinkWidget]) {
    if (!(Cls.prototype instanceof WidgetType)) {
      Object.setPrototypeOf(Cls.prototype, WidgetType.prototype)
    }
  }

  const PUNCT_NODES = new Set([
    'EmphasisMark', 'HeaderMark', 'CodeMark', 'StrikethroughMark',
    'LinkMark', 'ImageMark', 'QuoteMark', 'TaskMarker',
    'TableDelimiter',
  ])

  const SPAN_MAP = {
    StrongEmphasis: null, // handled specially
    Emphasis:       'cm-lv-i',
    Strikethrough:  'cm-lv-s',
    InlineCode:     'cm-lv-c',
    Highlight:      'cm-lv-hl',
    Link:           'cm-lv-lnk',
    Image:          'cm-lv-lnk',
  }

  const LINE_MAP = {
    ATXHeading1: 'cm-lv-h1', ATXHeading2: 'cm-lv-h2', ATXHeading3: 'cm-lv-h3',
    ATXHeading4: 'cm-lv-h4', ATXHeading5: 'cm-lv-h5', ATXHeading6: 'cm-lv-h6',
  }
  const CODE_BLOCKS = new Set(['FencedCode', 'CodeBlock', 'IndentedCode'])

  // The set of nodes whose marks we want to hide/show as a unit
  const INLINE_ANCESTORS = new Set(['Emphasis','StrongEmphasis','Strikethrough','InlineCode','Link','Image','Highlight'])

  /** Shared: parse markdown table text and push a TableWidget decoration */
  function _renderTableDeco(doc, from, to, inCur, inlines) {
    const tableText = doc.sliceString(from, to)
    const tableLines = tableText.split('\n').filter(l => l.trim())
    if (tableLines.length < 2) return
    // Must have a separator row (|---|---|)
    if (!/^[\s|:-]+$/.test(tableLines[1])) return
    const parseRow = row => {
      const trimmed = row.trim()
      const inner = trimmed.replace(/^(?<!\\)\|/, '').replace(/(?<!\\)\|$/, '')
      return inner.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'))
    }
    const headers = parseRow(tableLines[0])
    const sep = parseRow(tableLines[1])
    const aligns = sep.map(c => /^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : 'left')
    const isSepRow = l => parseRow(l).every(c => /^:?-+:?$/.test(c))
    const rows = tableLines.slice(2).filter(l => /\|/.test(l) && !isSepRow(l))
    const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    const thHtml = headers.map((h, i) => `<th style="text-align:${aligns[i]||'left'}">${esc(h)}</th>`).join('')
    const tbHtml = rows.map(r => {
      const cells = parseRow(r)
      const norm  = Array.from({ length: headers.length }, (_, i) => cells[i] ?? '')
      return `<tr>${norm.map((c, i) => `<td style="text-align:${aligns[i]||'left'}">${esc(c)}</td>`).join('')}</tr>`
    }).join('')
    const html = `<table class="nb-table"><thead><tr>${thHtml}</tr></thead><tbody>${tbHtml}</tbody></table>`
    // block: true requires both positions to be line starts
    const tLineFrom = doc.lineAt(from).from
    const lastLine = doc.lineAt(Math.max(from, Math.min(to - 1, doc.length - 1)))
    // Position after the last table line's \n = start of next line (a valid line start)
    const tLineTo = lastLine.to < doc.length ? lastLine.to + 1 : doc.length
    inlines.push({ from: tLineFrom, to: tLineTo, deco: Decoration.replace({ widget: new TableWidget(html) }) })
  }

  /** Build a RangeSet of block-replace table decorations for a given EditorState.
   *  Must live in a StateField because block: true is forbidden in ViewPlugin.
   *  Tables always render as widgets; editing is done via inline cell inputs. */
  function _buildTableDecos(state) {
    const builder = new RangeSetBuilder()
    const doc  = state.doc
    const full = doc.toString()
    const decos = []
    // Match header row \n separator row \n optional body rows
    const tableRe = /^(\|?.+\|.+)\n(\|?[\s:|-]+\|[\s:|-]*)((?:\n\|?.+\|.+)*)/gm
    let tm
    while ((tm = tableRe.exec(full)) !== null) {
      const tFrom   = tm.index
      const tTo     = tm.index + tm[0].length
      const rawText = tm[0]
      const tableLines = rawText.split('\n').filter(l => l.trim())
      if (tableLines.length < 2) continue
      if (!/^[\s|:-]+$/.test(tableLines[1])) continue
      const parseRow = row => {
        const trimmed = row.trim()
        const inner = trimmed.replace(/^(?<!\\)\|/, '').replace(/(?<!\\)\|$/, '')
        return inner.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'))
      }
      const headers = parseRow(tableLines[0])
      const sep     = parseRow(tableLines[1])
      const aligns  = sep.map(c => /^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : 'left')
      const isSepRow = l => parseRow(l).every(c => /^:?-+:?$/.test(c))
      const rows    = tableLines.slice(2).filter(l => /\|/.test(l) && !isSepRow(l))
      const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      const thHtml = headers.map((h, i) => `<th style="text-align:${aligns[i]||'left'}">${esc(h)}</th>`).join('')
      const tbHtml = rows.map(r => {
        const cells = parseRow(r)
        const norm  = Array.from({ length: headers.length }, (_, i) => cells[i] ?? '')
        return `<tr>${norm.map((c, i) => `<td style="text-align:${aligns[i]||'left'}">${esc(c)}</td>`).join('')}</tr>`
      }).join('')
      const html = `<table class="nb-table"><thead><tr>${thHtml}</tr></thead><tbody>${tbHtml}</tbody></table>`
      const tLineFrom = doc.lineAt(tFrom).from
      const lastLine  = doc.lineAt(Math.max(tFrom, Math.min(tTo - 1, doc.length - 1)))
      const tLineTo   = lastLine.to < doc.length ? lastLine.to + 1 : doc.length
      if (tLineTo > tLineFrom) decos.push({ from: tLineFrom, to: tLineTo, html, rawText })
    }
    decos.sort((a, b) => a.from - b.from)
    for (const { from, to, html, rawText } of decos) {
      try { builder.add(from, to, Decoration.replace({ widget: new TableWidget(html, rawText), block: true })) } catch { /**/ }
    }
    try { return builder.finish() } catch { return Decoration.none }
  }

  function build(view) {
    const { state } = view
    const cur = state.selection.main.head
    const doc = state.doc
    const inCur = isPreview ? () => false : (f, t) => cur >= f && cur <= t
    const fullDoc = doc.toString()

    const inlines  = []
    const lineDecs = []

    try {
      syntaxTree(state).iterate({
        enter(node) {
          const { from, to, name } = node
          if (from >= to) return

          // ── Code block ──────────────────────────────────────────────────
          if (CODE_BLOCKS.has(name)) {
            const ls = doc.lineAt(from).number
            const le = doc.lineAt(Math.min(to, doc.length - 1)).number
            for (let n = ls; n <= le; n++) {
              try { lineDecs.push({ pos: doc.line(n).from, cls: 'cm-lv-cb' }) } catch { /**/ }
            }
            return false
          }

          // ── Horizontal rule ─────────────────────────────────────────────
          if (name === 'HorizontalRule') {
            const ln = doc.lineAt(from)
            if (!inCur(ln.from, ln.to)) {
              inlines.push({ from: ln.from, to: ln.to, deco: Decoration.replace({ widget: new HRWidget() }) })
            }
            return false
          }

          // ── Table — handled in tableDecoField (block: true requires StateField) ──
          if (name === 'Table') return false

          // ── Task checkbox ────────────────────────────────────────────────
          if (name === 'TaskMarker') {
            const raw = doc.sliceString(from, to)
            const ck  = /\[[xX]\]/.test(raw)
            if (!inCur(from, to)) {
              inlines.push({ from, to, deco: Decoration.replace({ widget: new CheckboxWidget(ck, from) }) })
            } else {
              inlines.push({ from, to, deco: Decoration.mark({ class: 'cm-lv-p' }) })
            }
            return false
          }

          // ── Image — replace entire image node (not the line) ────────────
          if (name === 'Image') {
            const raw = doc.sliceString(from, to)
            // Match ![alt](src =Nx) — optional =Nx width spec
            const m   = raw.match(/!\[([^\]]*)\]\(([^\s)]+)(?:\s+=(\d+)x)?/)
            if (m) {
              if (!inCur(from, to)) {
                const imgWidth = m[3] ? parseInt(m[3]) : 0
                // Parse alignment from end of alt text: :left, :right, :center
                const alignMatch = m[1].match(/:(?:left|right|center)$/i)
                const align = alignMatch ? alignMatch[0].slice(1).toLowerCase() : null
                // Replace only the image syntax, not the whole line
                inlines.push({ from, to, deco: Decoration.replace({ widget: new ImgWidget(m[2], m[1], notebookDir, from, imgWidth, align), block: false }) })
                return false
              }
            }
          }

          // ── Math: inline $…$ and block $$…$$ ───────────────────────────
          if (name === 'InlineMath' || name === 'BlockMath' || name === 'MathSpan') {
            const raw = doc.sliceString(from, to)
            const isBlock = name === 'BlockMath'
            const tex = raw.replace(/^\$+\n?/, '').replace(/\n?\$+$/, '')
            if (!inCur(from, to)) {
              inlines.push({ from, to, deco: Decoration.replace({ widget: new MathWidget(tex, isBlock, from, to) }) })
            } else {
              inlines.push({ from, to, deco: Decoration.mark({ class: 'cm-lv-p' }) })
            }
            return false
          }

          // ── List marker ─────────────────────────────────────────────────
          if (name === 'ListMark') {
            const ln = doc.lineAt(from)
            if (!inCur(ln.from, ln.to)) {
              // Don't show bullet for task list items — they have their own checkbox widget
              let isTaskItem = false
              const parentItem = node.node.parent // ListItem
              if (parentItem && parentItem.name === 'ListItem') {
                let sib = parentItem.firstChild
                while (sib) {
                  if (sib.name === 'TaskMarker') { isTaskItem = true; break }
                  sib = sib.nextSibling
                }
              }
              if (isTaskItem) {
                // Hide '- ' (dash + trailing space) so only the checkbox shows
                const spaceAfter = to < doc.length && doc.sliceString(to, to + 1) === ' ' ? 1 : 0
                inlines.push({ from, to: to + spaceAfter, deco: Decoration.mark({ class: 'cm-lv-hidden' }) })
              } else {
                let isOrdered = false
                let p = node.node.parent
                while (p) {
                  if (p.name === 'OrderedList') { isOrdered = true; break }
                  if (p.name === 'BulletList') break
                  p = p.parent
                }
                const markerText = isOrdered ? doc.sliceString(from, to) : '•'
                // Include the trailing space in the replace range so the widget
                // controls the full "marker + gap" width, preventing text jump
                const spaceAfter = to < doc.length && doc.sliceString(to, to + 1) === ' ' ? 1 : 0
                inlines.push({ from, to: to + spaceAfter, deco: Decoration.replace({ widget: new ListMarkerWidget(markerText, isOrdered) }) })
              }
            } else {
              inlines.push({ from, to, deco: Decoration.mark({ class: 'cm-lv-p' }) })
            }
            return false
          }

          // ── Heading line decoration ──────────────────────────────────────
          if (LINE_MAP[name]) {
            try { lineDecs.push({ pos: doc.lineAt(from).from, cls: LINE_MAP[name] }) } catch { /**/ }
            // Hide heading marks (# / ## / etc.) when cursor is not on this heading line
            try {
              const headingLine = doc.lineAt(from)
              const cursorOnLine = cur >= headingLine.from && cur <= headingLine.to
              let child = node.node.firstChild
              while (child) {
                if (child.name === 'HeaderMark') {
                  // +1 to also hide the space after the #
                  const markTo = Math.min(child.to + 1, headingLine.to)
                  inlines.push({
                    from: child.from, to: markTo,
                    deco: Decoration.mark({ class: cursorOnLine ? 'cm-lv-p' : 'cm-lv-hidden' }),
                  })
                }
                child = child.nextSibling
              }
            } catch { /**/ }
          }

          // ── Blockquote line decoration ───────────────────────────────────
          if (name === 'Blockquote') {
            const ls = doc.lineAt(from).number
            const le = doc.lineAt(Math.min(to, doc.length - 1)).number
            for (let n = ls; n <= le; n++) {
              try { lineDecs.push({ pos: doc.line(n).from, cls: 'cm-lv-bq' }) } catch { /**/ }
            }
            // Hide QuoteMark (>) when cursor is not inside the blockquote
            try {
              const cursorInBq = inCur(from, to)
              node.node.cursor().iterate(inner => {
                if (inner.name === 'QuoteMark') {
                  // +1 to consume the space after '>'
                  const markTo = Math.min(inner.to + 1, doc.lineAt(inner.from).to)
                  inlines.push({
                    from: inner.from, to: markTo,
                    deco: Decoration.mark({ class: cursorInBq ? 'cm-lv-p' : 'cm-lv-hidden' }),
                  })
                }
              })
            } catch { /**/ }
          }

          // ── List item: depth + ordered/unordered ─────────────────────────
          if (name === 'ListItem') {
            try {
              const linePos = doc.lineAt(from).from
              let p = node.node.parent
              let depth = 0
              let isOrdered = false
              while (p) {
                if (p.name === 'BulletList' || p.name === 'OrderedList') {
                  if (depth === 0) isOrdered = p.name === 'OrderedList'
                  depth++
                }
                p = p.parent
              }
              const depthCls = `cm-lv-depth-${Math.min(depth, 4)}`
              const cls = isOrdered
                ? `cm-lv-li cm-lv-oli ${depthCls}`
                : `cm-lv-li ${depthCls}`
              lineDecs.push({ pos: linePos, cls })
            } catch { /**/ }
          }

          // ── Inline content span ──────────────────────────────────────────
          // Obsidian approach: marks inside a span are NEVER replaced — they
          // are styled with font-size:0 via cm-lv-p (cursor off) or shown
          // dimly (cursor on). This avoids the RangeSetBuilder overlap-skip
          // issue that causes the opening ** to remain visible.
          if (name === 'StrongEmphasis') {
            const cursorInSpan = inCur(from, to)
            // Check if this contains an Emphasis child (making it bold-italic)
            let hasEmphasis = false
            let child = node.node.firstChild
            while (child) {
              if (child.name === 'Emphasis') { hasEmphasis = true; break }
              child = child.nextSibling
            }
            // Check if there's actual non-whitespace text content between markers
            const rawContent = doc.sliceString(from, to)
            const markerLen = hasEmphasis ? 3 : 2
            const innerText = rawContent.slice(markerLen, rawContent.length - markerLen)
            const hasRealContent = innerText.trim().length > 0

            if (hasRealContent) {
              const cls = hasEmphasis ? 'cm-lv-bi' : 'cm-lv-b'
              inlines.push({ from, to, deco: Decoration.mark({ class: cls }) })

              // Hide ALL EmphasisMark nodes (covers **, ***, etc.)
              child = node.node.firstChild
              while (child) {
                if (child.name === 'EmphasisMark') {
                  inlines.push({
                    from: child.from, to: child.to,
                    deco: Decoration.mark({ class: cursorInSpan ? 'cm-lv-p' : 'cm-lv-hidden' }),
                  })
                }
                if (child.name === 'Emphasis') {
                  let grandchild = child.firstChild
                  while (grandchild) {
                    if (grandchild.name === 'EmphasisMark') {
                      inlines.push({
                        from: grandchild.from, to: grandchild.to,
                        deco: Decoration.mark({ class: cursorInSpan ? 'cm-lv-p' : 'cm-lv-hidden' }),
                      })
                    }
                    grandchild = grandchild.nextSibling
                  }
                }
                child = child.nextSibling
              }
            }
            // If no real content, don't hide syntax — show as-is
            return false
          } else if (SPAN_MAP[name] !== undefined) {
            if (SPAN_MAP[name]) {
              const cursorInSpan = inCur(from, to)
              // Check if Emphasis wraps StrongEmphasis (bold-italic: ***text***)
              let emphCls = SPAN_MAP[name]
              if (name === 'Emphasis') {
                let ch = node.node.firstChild
                while (ch) {
                  if (ch.name === 'StrongEmphasis') { emphCls = 'cm-lv-bi'; break }
                  ch = ch.nextSibling
                }
              }
              // Check if there's actual non-whitespace text wrapped
              const rawContent = doc.sliceString(from, to)
              const markLen = name === 'InlineCode' ? 1 : name === 'Strikethrough' || name === 'Highlight' ? 2 : 1
              const innerText = rawContent.slice(markLen, rawContent.length - markLen)
              const hasRealContent = innerText.trim().length > 0 || name === 'Link' || name === 'Image'

              if (!hasRealContent) {
                // No real content — don't format or hide, show syntax as-is
                return false
              }

              // For Link: replace whole syntax with a widget when cursor is off (no mark needed)
              if (name === 'Link' && !cursorInSpan) {
                const raw = doc.sliceString(from, to)
                const lm = raw.match(/^\[([^\]]*)\]\(([^\s)]*)\)$/)
                if (lm) {
                  // Skip — let QuestionWidget own the whole ?[...](...)  range
                  const prevChar = from > 0 ? doc.sliceString(from - 1, from) : ''
                  if (prevChar !== '?') {
                    inlines.push({ from, to, deco: Decoration.replace({ widget: new LinkWidget(lm[1], lm[2]) }) })
                  }
                  return false
                }
              }
              inlines.push({ from, to, deco: Decoration.mark({ class: emphCls }) })
              // Hide marks as zero-width (Obsidian style) rather than replace
              let child = node.node.firstChild
              while (child) {
                if (PUNCT_NODES.has(child.name)) {
                  inlines.push({
                    from: child.from, to: child.to,
                    deco: Decoration.mark({ class: cursorInSpan ? 'cm-lv-p' : 'cm-lv-hidden' }),
                  })
                }
                // Also hide marks inside nested StrongEmphasis (for ***text***)
                if (child.name === 'StrongEmphasis') {
                  let gc = child.firstChild
                  while (gc) {
                    if (gc.name === 'EmphasisMark') {
                      inlines.push({
                        from: gc.from, to: gc.to,
                        deco: Decoration.mark({ class: cursorInSpan ? 'cm-lv-p' : 'cm-lv-hidden' }),
                      })
                    }
                    gc = gc.nextSibling
                  }
                }
                child = child.nextSibling
              }
              return false
            }
          }

          // ── Heading mark (# ## ### …) hiding ────────────────────────────
          if (name === 'HeaderMark') {
            const ln = doc.lineAt(from)
            const cls = inCur(ln.from, ln.to) ? 'cm-lv-p' : 'cm-lv-hidden'
            inlines.push({ from, to, deco: Decoration.mark({ class: cls }) })
            return false
          }

          // ── Cursor-aware punctuation hiding (inline spans only) ──────────
          // Marks belonging to StrongEmphasis, Emphasis, Link, etc. are already
          // handled in their parent's branch above with return false — this
          // fallback only catches orphaned or unrecognised marks.
          if (PUNCT_NODES.has(name) && name !== 'ListMark' && name !== 'TaskMarker'
              && name !== 'EmphasisMark' && name !== 'HeaderMark'
              && name !== 'LinkMark' && name !== 'ImageMark'
              && name !== 'CodeMark' && name !== 'StrikethroughMark') {
            const parent = node.node.parent
            if (!parent || !INLINE_ANCESTORS.has(parent.name)) return

            let ancestor = parent
            while (ancestor.parent && INLINE_ANCESTORS.has(ancestor.parent.name)) {
              ancestor = ancestor.parent
            }
            const af = ancestor.from
            const at = ancestor.to
            if (inCur(af, at)) {
              inlines.push({ from, to, deco: Decoration.mark({ class: 'cm-lv-p' }) })
            } else {
              inlines.push({ from, to, deco: Decoration.replace({}) })
            }
          }
        },
      })
    } catch (e) {
      console.warn('[LivePreview] tree walk error (suppressed):', e?.message)
    }

    // ── Headings without space (e.g. #Title treated same as # Title) ──────
    try {
      for (let li = 1; li <= doc.lines; li++) {
        const ln = doc.line(li)
        const m = ln.text.match(/^(#{1,6})([^\s#])/)
        if (!m) continue
        const level = m[1].length
        // Skip if tree already handled this as ATXHeading
        const alreadyDecorated = lineDecs.some(d => d.pos === ln.from)
        if (alreadyDecorated) continue
        lineDecs.push({ pos: ln.from, cls: `cm-lv-h${level}` })
        const hashEnd = ln.from + m[1].length
        const hashCls = inCur(ln.from, ln.to) ? 'cm-lv-p' : 'cm-lv-hidden'
        inlines.push({ from: ln.from, to: hashEnd, deco: Decoration.mark({ class: hashCls }) })
      }
    } catch { /**/ }

    // ── Math via regex fallback ───────────────────────────────────────────
    try {
      const full = fullDoc
      const reBlock = /\$\$([\s\S]*?)\$\$/gm
      let mb
      while ((mb = reBlock.exec(full)) !== null) {
        const bf = mb.index, bt = mb.index + mb[0].length
        const already = inlines.some(d => d.from <= bf && d.to >= bt && d.deco.spec?.widget instanceof MathWidget)
        if (!already) {
          if (!inCur(bf, bt)) {
            inlines.push({ from: bf, to: bt, deco: Decoration.replace({ widget: new MathWidget(mb[1].trim(), true, bf, bt) }) })
          }
        }
      }
      const reInline = /\$([^$\n]+)\$/g
      let mi
      while ((mi = reInline.exec(full)) !== null) {
        const mf = mi.index, mt = mi.index + mi[0].length
        const already = inlines.some(d => d.from <= mf && d.to >= mt && d.deco.spec?.widget instanceof MathWidget)
        if (!already) {
          if (!inCur(mf, mt)) {
            inlines.push({ from: mf, to: mt, deco: Decoration.replace({ widget: new MathWidget(mi[1], false, mf, mt) }) })
          }
        }
      }
    } catch { /**/ }

    // ── Wikilinks via regex (with optional (sketch)/(flash) suffix) ─────
    try {
      const full = fullDoc
      const re = /\[\[([^\]\n]{1,120})\]\](?:\((sketch|flash)\))?/g
      let m
      while ((m = re.exec(full)) !== null) {
        const wf = m.index, wt = m.index + m[0].length
        const title = m[1].trim()
        const suffix = m[2] // 'sketch', 'flash', or undefined
        const nb = notebooks.find(n => n.title?.toLowerCase() === title.toLowerCase())
        const bk = !nb && library.find(b => b.title?.toLowerCase() === title.toLowerCase())
        const sb = !nb && !bk && sketchbooks.find(s => s.title?.toLowerCase() === title.toLowerCase())
        const fd = !nb && !bk && !sb && flashcardDecks.find(d => d.title?.toLowerCase() === title.toLowerCase())
        if (inCur(wf, wt)) {
          inlines.push({ from: wf, to: wt, deco: Decoration.mark({ class: 'cm-lv-p' }) })
        } else {
          const forceType = suffix === 'sketch' ? 'new-sketch' : suffix === 'flash' ? 'new-flash' : null
          const type = nb ? 'notebook' : bk ? 'book' : sb ? 'sketchbook' : fd ? 'flashcard' : (forceType || 'new')
          const id   = nb ? nb.id : bk ? bk.id : sb ? sb.id : fd ? fd.id : ''
          const cls  = nb ? 'cm-wl cm-wl-nb' : bk ? 'cm-wl cm-wl-bk' : sb ? 'cm-wl cm-wl-sb' : fd ? 'cm-wl cm-wl-fd' : 'cm-wl cm-wl-new'
          inlines.push({ from: wf, to: wt, deco: Decoration.replace({ widget: new WikiWidget(title, cls, type, id) }) })
        }
      }
    } catch { /**/ }

    // ── Superscript ^text^ and subscript ~text~ via regex ─────────────────
    try {
      const full = fullDoc
      const reSup = /\^([^\^\n]+)\^/g
      let sm
      while ((sm = reSup.exec(full)) !== null) {
        const sf = sm.index, st = sm.index + sm[0].length
        if (!inCur(sf, st)) {
          inlines.push({ from: sf, to: st, deco: Decoration.replace({ widget: new SupWidget(sm[1]) }) })
        }
      }
      const reSub = /(?<!~)~([^~\n]+)~(?!~)/g
      let sbm
      while ((sbm = reSub.exec(full)) !== null) {
        const sbf = sbm.index, sbt = sbm.index + sbm[0].length
        if (!inCur(sbf, sbt)) {
          inlines.push({ from: sbf, to: sbt, deco: Decoration.replace({ widget: new SubWidget(sbm[1]) }) })
        }
      }
    } catch { /**/ }

    // ── Hide =:.N precision specifier in accepted equations ────────────────
    try {
      const fullEq = fullDoc
      const precRe = /=:\.(\d+)\s/g
      let pm
      while ((pm = precRe.exec(fullEq)) !== null) {
        const hideFrom = pm.index + 1 // after the '='
        const hideTo = pm.index + pm[0].length - 1 // before the trailing space
        if (!inCur(pm.index, hideTo + 1)) {
          inlines.push({ from: hideFrom, to: hideTo, deco: Decoration.mark({ class: 'cm-lv-hidden' }) })
        }
      }
    } catch { /**/ }

    // ── Definition lists (dt / dd lines) ─────────────────────────────────────
    try {
      for (let n = 1; n <= doc.lines; n++) {
        const ln = doc.line(n)
        const t  = ln.text
        if (/^:\s+/.test(t)) {
          // Definition ": text" — indent + muted border-left style
          lineDecs.push({ pos: ln.from, cls: 'cm-lv-dd' })
          const colonEnd = ln.from + t.match(/^:\s+/)[0].length
          if (!inCur(ln.from, ln.to)) {
            inlines.push({ from: ln.from, to: colonEnd, deco: Decoration.mark({ class: 'cm-lv-hidden' }) })
          }
        } else if (
          t.trim() && !/^[#\-*+>|`~\d]/.test(t) && !/^\//.test(t) &&
          n < doc.lines && /^:\s+/.test(doc.line(n + 1).text)
        ) {
          // Term — line before a definition
          lineDecs.push({ pos: ln.from, cls: 'cm-lv-dt' })
        }
      }
    } catch { /**/ }

    // ── Footnote refs [^id] inline ────────────────────────────────────────────
    try {
      const full = fullDoc
      const fnRe = /\[\^([^\]\n]+)\]/g
      let fm
      while ((fm = fnRe.exec(full)) !== null) {
        const ff = fm.index, ft = fm.index + fm[0].length
        // Skip if it's a definition line [^id]: (starts the line)
        const lineAtPos = doc.lineAt(ff)
        if (/^\[\^/.test(lineAtPos.text) && lineAtPos.text.includes(']: ')) continue
        const already = inlines.some(d => d.from <= ff && d.to >= ft)
        if (!already && !inCur(ff, ft)) {
          inlines.push({ from: ff, to: ft, deco: Decoration.replace({ widget: new FnRefWidget(fm[1]) }) })
        }
      }
      // Style footnote definition lines
      for (let n = 1; n <= doc.lines; n++) {
        const ln = doc.line(n)
        if (/^\[\^[^\]]+\]:/.test(ln.text)) {
          lineDecs.push({ pos: ln.from, cls: 'cm-lv-fn-def' })
        }
      }
    } catch { /**/ }

    // ── /habits block widget ─────────────────────────────────────────────
    try {
      const habitsRe = /^\/habits(?::(.*))?$/gm
      let hm
      while ((hm = habitsRe.exec(fullDoc)) !== null) {
        const hLine = doc.lineAt(hm.index)
        const hFrom = hLine.from
        const hTo = hLine.to
        // Never collapse — user edits via widget UI (same as /calendar)
        inlines.push({ from: hFrom, to: hTo, deco: Decoration.replace({ widget: new HabitsWidget(hm[1] || '', hm[0], hFrom) }) })
      }
    } catch { /**/ }

    // ── /timer block widget ─────────────────────────────────────────────
    try {
      const timerRe = /^\/timer(?:\s+(.+))?$/gm
      let tm
      while ((tm = timerRe.exec(fullDoc)) !== null) {
        const timerLine = doc.lineAt(tm.index)
        const tFrom = timerLine.from
        const tTo = timerLine.to
        if (inCur(tFrom, tTo)) continue
        if (!tm[1]) {
          inlines.push({ from: tFrom, to: tTo, deco: Decoration.replace({ widget: new TimerWidget(0, '', tm[0]) }) })
        } else {
          const raw = tm[1].trim()
          const parts = raw.match(/^(\S+)(?:\s+(.+))?$/)
          if (parts) {
            const timeStr = parts[1], label = parts[2] || ''
            let totalSec = 0
            const hms = timeStr.match(/^(\d+):(\d{2}):(\d{2})$/)
            const ms = timeStr.match(/^(\d+):(\d{2})$/)
            const m = timeStr.match(/^(\d+)$/)
            if (hms) totalSec = parseInt(hms[1]) * 3600 + parseInt(hms[2]) * 60 + parseInt(hms[3])
            else if (ms) totalSec = parseInt(ms[1]) * 60 + parseInt(ms[2])
            else if (m) totalSec = parseInt(m[1]) * 60
            if (totalSec > 0) {
              inlines.push({ from: tFrom, to: tTo, deco: Decoration.replace({ widget: new TimerWidget(totalSec, label, tm[0]) }) })
            } else {
              // Invalid/unrecognized time format — show as empty editable timer
              inlines.push({ from: tFrom, to: tTo, deco: Decoration.replace({ widget: new TimerWidget(0, '', tm[0]) }) })
            }
          }
        }
      }
    } catch { /**/ }

    // ── /pomo block widget ──────────────────────────────────────────────
    try {
      const pomoRe = /^\/pomo$/gm
      let pm
      while ((pm = pomoRe.exec(fullDoc)) !== null) {
        const pomoLine = doc.lineAt(pm.index)
        const pFrom = pomoLine.from
        const pTo = pomoLine.to
        if (inCur(pFrom, pTo)) continue
        inlines.push({ from: pFrom, to: pTo, deco: Decoration.replace({ widget: new PomoWidget(pm[0]) }) })
      }
    } catch { /**/ }

    // ── /calendar block widget ──────────────────────────────────────────
    try {
      const calRe = /^\/calendar(?::([^\n]*))?$/gm
      let cm2
      while ((cm2 = calRe.exec(fullDoc)) !== null) {
        const cFrom = doc.lineAt(cm2.index).from
        const cTo = doc.lineAt(cm2.index + cm2[0].length).to
        // Never collapse calendar — user edits via widget UI, not raw markdown
        const rawData = cm2[1] || ''
        inlines.push({ from: cFrom, to: cTo, deco: Decoration.replace({ widget: new CalendarWidget(rawData, cm2[0]) }) })
      }
    } catch { /**/ }

    // ── /linkf file badge ────────────────────────────────────────────────────
    try {
      const linkfRe = /^\/linkf:(.+)$/gm
      let lf
      while ((lf = linkfRe.exec(fullDoc)) !== null) {
        const lfLine = doc.lineAt(lf.index)
        const lfFrom = lfLine.from, lfTo = lfLine.to
        if (inCur(lfFrom, lfTo)) continue
        const parts = lf[1].split('|')
        const path = parts[0].trim()
        const name = parts[1]?.trim() || path.split(/[/\\]/).pop() || path
        inlines.push({ from: lfFrom, to: lfTo, deco: Decoration.replace({ widget: new FileLinkWidget(path, name) }) })
      }
    } catch { /**/ }

    // ── /linkw web viewer ────────────────────────────────────────────────────
    try {
      const linkwRe = /^\/linkw:(.+)$/gm
      let lw
      while ((lw = linkwRe.exec(fullDoc)) !== null) {
        const lwLine = doc.lineAt(lw.index)
        const lwFrom = lwLine.from, lwTo = lwLine.to
        if (inCur(lwFrom, lwTo)) continue
        const parts = lw[1].split('|')
        const url = parts[0].trim()
        const title = parts[1]?.trim() || ''
        inlines.push({ from: lwFrom, to: lwTo, deco: Decoration.replace({ widget: new WebLinkWidget(url, title) }) })
      }
    } catch { /**/ }

    // ── /linkv video player ──────────────────────────────────────────────────
    try {
      const linkvRe = /^\/linkv:(.+)$/gm
      let lv
      while ((lv = linkvRe.exec(fullDoc)) !== null) {
        const lvLine = doc.lineAt(lv.index)
        const lvFrom = lvLine.from, lvTo = lvLine.to
        if (inCur(lvFrom, lvTo)) continue
        const parts = lv[1].split('|')
        const src = parts[0].trim()
        const title = parts[1]?.trim() || ''
        inlines.push({ from: lvFrom, to: lvTo, deco: Decoration.replace({ widget: new VideoLinkWidget(src, title) }) })
      }
    } catch { /**/ }

    // ── Predictive formatting from opening syntax ─────────────────────────
    // When the cursor is on a line with unclosed formatting tokens,
    // apply the formatting class from the opening token to the cursor position
    try {
      const curLine = doc.lineAt(cur)
      const lineText = curLine.text
      const colPos = cur - curLine.from
      const textBeforeCursor = lineText.slice(0, colPos)

      const OPEN_TOKENS = [
        { token: '***', cls: 'cm-lv-bi' },
        { token: '___', cls: 'cm-lv-bi' },
        { token: '**',  cls: 'cm-lv-b' },
        { token: '__',  cls: 'cm-lv-b' },
        { token: '*',   cls: 'cm-lv-i' },
        { token: '_',   cls: 'cm-lv-i' },
        { token: '~~',  cls: 'cm-lv-s' },
        { token: '==',  cls: 'cm-lv-hl' },
      ]

      for (const { token, cls } of OPEN_TOKENS) {
        const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const count = (textBeforeCursor.match(new RegExp(escaped, 'g')) || []).length
        if (count % 2 === 1) {
          // Found unclosed opening token — apply formatting from token to cursor
          const lastIdx = textBeforeCursor.lastIndexOf(token)
          if (lastIdx >= 0) {
            // If the character immediately after the opening token is a space,
            // don't treat it as formatting (user rejected formatting)
            const charAfterToken = lineText[lastIdx + token.length]
            if (charAfterToken === ' ' || charAfterToken === undefined) break

            const fmtFrom = curLine.from + lastIdx + token.length
            const fmtTo = cur
            if (fmtFrom < fmtTo) {
              // Check if this range isn't already decorated
              const alreadyDeco = inlines.some(d => d.from <= fmtFrom && d.to >= fmtTo && d.deco.spec?.class === cls)
              if (!alreadyDeco) {
                inlines.push({ from: fmtFrom, to: fmtTo, deco: Decoration.mark({ class: cls }) })
                // Also dim the opening token
                const tokenFrom = curLine.from + lastIdx
                const tokenTo = tokenFrom + token.length
                inlines.push({ from: tokenFrom, to: tokenTo, deco: Decoration.mark({ class: 'cm-lv-p' }) })
              }
            }
          }
          break // only match the first (longest) unclosed token
        }
      }
    } catch { /**/ }

    // ── Due-date tokens ::YYYY-MM-DD or ::+2d etc. ───────────────────────
    try {
      const full = fullDoc
      const duRe = /::(\d{4}-\d{2}-\d{2}(?:,\d{1,2}:\d{2})?|\d{2}-\d{2}-(?:\d{4}|\d{2})(?:,\d{1,2}:\d{2})?|\d{1,2}:\d{2}|\+\d+[dh])/g
      let dm
      while ((dm = duRe.exec(full)) !== null) {
        const from = dm.index, to = dm.index + dm[0].length
        if (inCur(from, to)) {
          inlines.push({ from, to: from + 2, deco: Decoration.mark({ class: 'cm-lv-p' }) })
        } else {
          inlines.push({ from, to, deco: Decoration.replace({ widget: new DueDateWidget(dm[1]) }) })
        }
      }
    } catch { /**/ }

    // ── Tag tokens ::tagname (letter-start, not a due-date) ──────────────
    try {
      const full = fullDoc
      const tagRe = /::([a-zA-Z][a-zA-Z0-9_-]*)/g
      let tm
      while ((tm = tagRe.exec(full)) !== null) {
        const from = tm.index, to = tm.index + tm[0].length
        if (inCur(from, to)) {
          inlines.push({ from, to: from + 2, deco: Decoration.mark({ class: 'cm-lv-p' }) })
        } else {
          inlines.push({ from, to, deco: Decoration.replace({ widget: new TagWidget(tm[1]) }) })
        }
      }
    } catch { /**/ }

    // ── ?[question](ref) review/flashcard widgets ────────────────────────
    try {
      const qRe = /\?\[([^\]]*)\]\(([^)]*)\)/g
      let qm
      while ((qm = qRe.exec(fullDoc)) !== null) {
        const from = qm.index, to = qm.index + qm[0].length
        if (inCur(from, to)) {
          inlines.push({ from, to: from + 1, deco: Decoration.mark({ class: 'cm-lv-p' }) })
        } else {
          inlines.push({ from, to, deco: Decoration.replace({ widget: new QuestionWidget(qm[1], qm[2], qm[0], from) }) })
        }
      }
    } catch { /**/ }

    // ── @time references (@HH:MM, @hh:mmam/pm, @HH, @Hham/pm) ─────────
    try {
      const full = fullDoc
      // Match @14:30, @2:30pm, @14, @2pm, @2am, etc.
      const timeRefRe = /(?<!\w)@(\d{1,2})(?::(\d{2}))?\s*(am|pm|AM|PM)?(?!\w)/g
      let trm
      while ((trm = timeRefRe.exec(full)) !== null) {
        const from = trm.index, to = trm.index + trm[0].length
        let h = parseInt(trm[1])
        const m = trm[2] ? parseInt(trm[2]) : null
        const ampm = trm[3]?.toLowerCase()
        // Skip bare numbers that aren't valid times (e.g. @999)
        if (!ampm && h > 23) continue
        if (ampm && (h < 1 || h > 12)) continue
        if (m !== null && m > 59) continue
        let display
        if (ampm) {
          // 12h format — display as-is
          display = m !== null
            ? `${h}:${String(m).padStart(2,'0')} ${ampm.toUpperCase()}`
            : `${h} ${ampm.toUpperCase()}`
        } else {
          // 24h format — convert to 12h display
          const suffix = h >= 12 ? 'PM' : 'AM'
          const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h
          display = m !== null
            ? `${h12}:${String(m).padStart(2,'0')} ${suffix}`
            : `${h12} ${suffix}`
        }
        if (inCur(from, to)) {
          inlines.push({ from, to: from + 1, deco: Decoration.mark({ class: 'cm-lv-p' }) })
        } else {
          inlines.push({ from, to, deco: Decoration.replace({ widget: new TimeRefWidget(trm[0], display) }) })
        }
      }
    } catch { /**/ }

    // ── {color:X}...{//}, {font:X}...{//}, {spacing:X}...{//}, {size:X}...{//} ──
    try {
      function inlineStyleAttr(type, value) {
        if (type === 'color')   return `color:${value}`
        if (type === 'font')    return `font-family:${value}`
        if (type === 'spacing') return `line-height:${value}`
        if (type === 'size')    return `font-size:${value}`
        return ''
      }

      // ── Pass 1: closed spans — full {type:val}...{//} pairs ──────────────
      const spanRe = /\{(color|font|spacing|size):([^}]+)\}([\s\S]*?)\{\/\/\}/g
      const closedOpenStarts = new Set()  // open-tag start positions handled here
      let sm
      while ((sm = spanRe.exec(fullDoc)) !== null) {
        const type     = sm[1]
        const rawVal   = sm[2]
        const value    = rawVal.trim()
        const spanStart = sm.index
        const spanEnd  = sm.index + sm[0].length
        const openLen  = 1 + type.length + 1 + rawVal.length + 1  // {type:rawVal}
        const openEnd  = spanStart + openLen
        const closeStart = spanEnd - 4  // {//} is 4 chars

        if (openEnd > spanEnd || closeStart < openEnd) continue
        closedOpenStarts.add(spanStart)

        // Opening marker — hide unless cursor is inside it
        if (inCur(spanStart, openEnd)) {
          inlines.push({ from: spanStart, to: openEnd, deco: Decoration.mark({ class: 'cm-lv-p' }) })
        } else {
          inlines.push({ from: spanStart, to: openEnd, deco: Decoration.mark({ class: 'cm-lv-hidden' }) })
        }

        // Content — apply inline style
        if (openEnd < closeStart) {
          const s = inlineStyleAttr(type, value)
          if (s) inlines.push({ from: openEnd, to: closeStart, deco: Decoration.mark({ attributes: { style: s } }) })
        }

        // Closing marker — hide unless cursor is inside it
        if (inCur(closeStart, spanEnd)) {
          inlines.push({ from: closeStart, to: spanEnd, deco: Decoration.mark({ class: 'cm-lv-p' }) })
        } else {
          inlines.push({ from: closeStart, to: spanEnd, deco: Decoration.mark({ class: 'cm-lv-hidden' }) })
        }
      }

      // ── Pass 2: open (unclosed) spans — live preview to end of document ─────
      // Scans for {type:val} markers that have no matching {//} closer.
      // Styles everything from the marker to the end of the document so the user
      // sees the formatting immediately — no need to wait for {//}.
      const openTagRe = /\{(color|font|spacing|size):([^}]+)\}/g
      let ot
      while ((ot = openTagRe.exec(fullDoc)) !== null) {
        const oStart = ot.index
        const oEnd   = ot.index + ot[0].length
        const type   = ot[1]
        const value  = ot[2].trim()

        // Skip tags that were already matched by Pass 1
        if (closedOpenStarts.has(oStart)) continue

        // Hide/show the opening marker based on cursor position
        if (inCur(oStart, oEnd)) {
          inlines.push({ from: oStart, to: oEnd, deco: Decoration.mark({ class: 'cm-lv-p' }) })
        } else {
          inlines.push({ from: oStart, to: oEnd, deco: Decoration.mark({ class: 'cm-lv-hidden' }) })
        }

        // Apply style from end of marker to end of document
        if (oEnd < doc.length) {
          const s = inlineStyleAttr(type, value)
          if (s) inlines.push({ from: oEnd, to: doc.length, deco: Decoration.mark({ attributes: { style: s } }) })
        }
      }
    } catch { /**/ }

    // ── Sort and build ────────────────────────────────────────────────────
    inlines.sort((a, b) => a.from !== b.from ? a.from - b.from : a.to - b.to)

    // Remove mark decorations that overlap with replace-widget ranges.
    // Overlapping mark+replace in a CM6 RangeSet causes errors that silently drop widgets.
    const replRanges = inlines.filter(d => d.deco.spec?.widget).map(d => [d.from, d.to])
    const safeInlines = replRanges.length === 0 ? inlines : inlines.filter(({ from, to, deco }) => {
      if (deco.spec?.widget) return true  // always keep replace widgets
      for (const [rf, rt] of replRanges) {
        if (from >= rf && from < rt) return false   // mark starts inside a replace
        if (from < rf && to > rf) return false      // mark overlaps replace's left edge
      }
      return true
    })

    const sb = new RangeSetBuilder()
    let lastReplTo = -1
    for (const { from, to, deco } of safeInlines) {
      if (from < 0 || to > doc.length || from >= to) continue
      const isReplace = !!deco.spec?.widget
      if (from < lastReplTo) continue
      try {
        sb.add(from, to, deco)
        if (isReplace) lastReplTo = to
      } catch { /**/ }
    }

    lineDecs.sort((a, b) => a.pos - b.pos)
    const lb = new RangeSetBuilder()
    const seen = new Set()
    for (const { pos, cls } of lineDecs) {
      const k = `${pos}:${cls}`
      if (seen.has(k)) continue; seen.add(k)
      try { lb.add(pos, pos, Decoration.line({ class: cls })) } catch { /**/ }
    }

    let spans, lines
    try { spans = sb.finish() } catch { spans = Decoration.none }
    try { lines = lb.finish() } catch { lines = Decoration.none }
    return { spans, lines }
  }

  // ── /task block decorations live in a StateField (multi-line replace forbidden in ViewPlugin) ──
  const taskDecoField = StateField.define({
    create(state) { return _buildTaskDecos(state.doc.toString(), Decoration, RangeSetBuilder) },
    update(decos, tr) {
      if (!tr.docChanged) return decos
      return _buildTaskDecos(tr.newDoc.toString(), Decoration, RangeSetBuilder)
    },
    provide: f => cm.view.EditorView.decorations.from(f),
  })

  // ── Table decorations also live in a StateField (block: true, multi-line) ──
  const tableDecoField = StateField.define({
    create(state) { return _buildTableDecos(state) },
    update(decos, tr) {
      if (!tr.docChanged) return decos
      return _buildTableDecos(tr.state)
    },
    provide: f => cm.view.EditorView.decorations.from(f),
  })

  return [taskDecoField, tableDecoField, ViewPlugin.fromClass(
    class {
      constructor(view) {
        try { const r = build(view); this.decorations = r.spans; this.lineDecos = r.lines }
        catch { this.decorations = Decoration.none; this.lineDecos = Decoration.none }
      }
      update(upd) {
        if (upd.docChanged || upd.selectionSet) {
          try { const r = build(upd.view); this.decorations = r.spans; this.lineDecos = r.lines }
          catch { this.decorations = Decoration.none; this.lineDecos = Decoration.none }
        }
      }
    },
    {
      decorations: v => v.decorations,
      provide: plugin => [
        cm.view.EditorView.decorations.of(v => {
          try { return v.plugin(plugin)?.lineDecos ?? Decoration.none }
          catch { return Decoration.none }
        }),
      ],
    }
  )]
}

// ─── /task block decoration builder (StateField — multi-line replace forbidden in ViewPlugin) ───
function _buildTaskDecos(fullDoc, Decoration, RangeSetBuilder) {
  const builder = new RangeSetBuilder()
  try {
    const lines = fullDoc.split('\n')
    const lineStarts = []
    let pos = 0
    for (const l of lines) { lineStarts.push(pos); pos += l.length + 1 }

    const decos = []
    for (let li = 0; li < lines.length; li++) {
      if (!lines[li].match(/^\/task(?::.*)?$/)) continue
      const block = parseTaskBlock(fullDoc, li)
      if (!block) continue

      const blockFrom = lineStarts[block.startLine]
      const blockTo   = lineStarts[block.endLine] + lines[block.endLine].length

      const columns = block.columns.map(col => ({
        title: col.title,
        tasks: col.tasks.map(task => {
          const cbIdx = lines[task.lineIdx].search(/\[[ xX]\]/)
          return { text: task.text, done: task.done, date: task.date || null, cbPos: lineStarts[task.lineIdx] + (cbIdx >= 0 ? cbIdx : 0) }
        }),
      }))
      const rawMd = fullDoc.slice(blockFrom, blockTo)
      decos.push({ from: blockFrom, to: blockTo, widget: new TaskBlockWidget(block.boardTitle, columns, rawMd, blockFrom) })
      li = block.endLine
    }
    decos.sort((a, b) => a.from - b.from)
    for (const { from, to, widget } of decos) {
      builder.add(from, to, Decoration.replace({ widget }))
    }
  } catch { /**/ }
  return builder.finish()
}

// ─── Checkbox click handler (live mode) ──────────────────────────────────────
function makeCheckboxHandler(cm) {
  return cm.view.EditorView.domEventHandlers({
    mousedown(e, view) {
      const el = e.target
      if (!el.classList.contains('cm-cb')) return false
      const pos = parseInt(el.dataset.pos || '0', 10)
      if (!pos && el.dataset.pos !== '0') return false
      try {
        const line = view.state.doc.lineAt(pos)
        const txt  = line.text
        const newTxt = /\[[xX]\]/.test(txt)
          ? txt.replace(/\[[xX]\]/, '[ ]')
          : txt.replace(/\[ \]/, '[x]')
        view.dispatch({ changes: { from: line.from, to: line.to, insert: newTxt } })
        e.preventDefault()
        return true
      } catch { return false }
    },
  })
}

// ─── Hyperlink + file/web/video link click handler ───────────────────────────
function makeLinkHandler(cm) {
  return cm.view.EditorView.domEventHandlers({
    mousedown(e) {
      // Prevent CM from claiming cursor-placement on these widgets
      if (e.target.closest('.cm-linkv-wrap') || e.target.closest('.cm-linkw-wrap') || e.target.closest('.cm-linkf-badge')) {
        e.preventDefault()
        return true
      }
      return false
    },
    click(e, view) {
      // /linkf — open file with default app
      const badge = e.target.closest('.cm-linkf-badge')
      if (badge) {
        const path = badge.dataset.linkfPath
        if (path && _invoke) {
          _invoke('open_in_finder', { path }).catch(console.warn)
        }
        e.preventDefault(); return true
      }

      // /linkw — open in the user's native browser (safe, sandboxed)
      const wOpen = e.target.closest('.cm-linkw-open-btn')
      if (wOpen) {
        e.preventDefault()
        const url = wOpen.dataset.linkwUrl
        if (url) {
          import('@tauri-apps/api/core').then(({ invoke }) => {
            invoke('plugin:shell|open', { path: url }).catch(() => window.open(url, '_blank'))
          }).catch(() => window.open(url, '_blank'))
        }
        return true
      }

      // Handle clicks on .cm-lv-lnk inline decorations (when cursor is on the link)
      const el = e.target.closest('.cm-lv-lnk')
      if (!el) return false
      // Try to find URL from the line's markdown source — look for [text](url)
      const pos = view.posAtDOM(el)
      if (pos == null) return false
      const line = view.state.doc.lineAt(pos)
      const lineText = line.text
      // Match markdown link pattern [text](url)
      const linkRe = /\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g
      let m, href = null
      while ((m = linkRe.exec(lineText)) !== null) {
        const linkStart = line.from + m.index
        const linkEnd   = linkStart + m[0].length
        if (pos >= linkStart && pos <= linkEnd) { href = m[2]; break }
      }
      // Also try bare URLs
      if (!href) {
        const bareRe = /(https?:\/\/[^\s)>\]]+)/g
        while ((m = bareRe.exec(lineText)) !== null) {
          const urlStart = line.from + m.index
          const urlEnd   = urlStart + m[0].length
          if (pos >= urlStart && pos <= urlEnd) { href = m[1]; break }
        }
      }
      if (!href) return false
      e.preventDefault()
      e.stopPropagation()
      import('@tauri-apps/api/core').then(({ invoke }) => {
        invoke('plugin:shell|open', { path: href }).catch(() => window.open(href, '_blank'))
      }).catch(() => window.open(href, '_blank'))
      return true
    },
  })
}

// ─── Wikilink click handler (live mode) ──────────────────────────────────────
function makeWikiHandler(cm, onNavRef) {
  return cm.view.EditorView.domEventHandlers({
    click(e) {
      const el = e.target.closest('.cm-wl')
      if (!el) return false
      const fn = typeof onNavRef === 'function' ? onNavRef : onNavRef?.current
      if (fn) fn(el.dataset.wlTitle, el.dataset.wlType, el.dataset.wlId)
      e.preventDefault(); return true
    },
    mousedown(e) {
      // Also handle mousedown for replace-decoration widgets where click may not fire
      const el = e.target.closest('.cm-wl')
      if (!el) return false
      e.preventDefault()
      const fn = typeof onNavRef === 'function' ? onNavRef : onNavRef?.current
      if (fn) fn(el.dataset.wlTitle, el.dataset.wlType, el.dataset.wlId)
      return true
    },
  })
}

// ─── /todo checkbox click handler ────────────────────────────────────────────
function makeTodoHandler(cm) {
  return cm.view.EditorView.domEventHandlers({
    mousedown(e, view) {
      if (!e.target.closest('.cm-todo-block-w')) return false
      e.preventDefault()
      const cb = e.target.closest('.cm-cb[data-pos]')
      if (!cb) return true
      const pos = parseInt(cb.dataset.pos || '0', 10)
      if (isNaN(pos)) return true
      try {
        const line = view.state.doc.lineAt(pos)
        const txt  = line.text
        const newTxt = /\[[xX]\]/.test(txt)
          ? txt.replace(/\[[xX]\]/, '[ ]')
          : txt.replace(/\[ \]/, '[x]')
        view.dispatch({ changes: { from: line.from, to: line.to, insert: newTxt } })
      } catch { /**/ }
      return true
    },
  })
}

// ─── /task board interaction handler ─────────────────────────────────────────
function makeTaskHandler(cm) {
  return cm.view.EditorView.domEventHandlers({
    mousedown(e, view) {
      if (!e.target.closest('.cm-task-board-w')) return false
      e.preventDefault()
      const cb = e.target.closest('.cm-cb[data-pos]')
      if (cb) {
        const pos = parseInt(cb.dataset.pos || '0', 10)
        if (!isNaN(pos)) {
          try {
            const line = view.state.doc.lineAt(pos)
            const txt  = line.text
            const newTxt = /\[[xX]\]/.test(txt)
              ? txt.replace(/\[[xX]\]/, '[ ]')
              : txt.replace(/\[ \]/, '[x]')
            view.dispatch({ changes: { from: line.from, to: line.to, insert: newTxt } })
          } catch { /**/ }
        }
      }
      return true
    },
    keydown(e, view) {
      const inp = e.target
      if (inp.tagName !== 'INPUT' || !inp.classList.contains('cm-task-add-input')) return false
      if (e.key !== 'Enter') return false
      const text = inp.value.trim()
      if (!text) return false
      const board = inp.closest('.cm-task-board')
      if (!board) return false
      const colIdx   = parseInt(inp.dataset.colIdx || '0', 10)
      const blockFrom = parseInt(board.dataset.blockFrom || '0', 10)
      const blockTo   = parseInt(board.dataset.blockTo   || '0', 10)

      const docStr = view.state.doc.toString()
      const block = parseTaskBlock(docStr, view.state.doc.lineAt(blockFrom).number - 1)
      if (!block) return false

      const cols = block.columns.map(c => ({ ...c, tasks: [...c.tasks] }))
      if (colIdx >= 0 && colIdx < cols.length) {
        cols[colIdx].tasks.push({ text, done: false })
      }
      const newText = serializeTaskBlock(block.boardTitle, cols)
      const lineFrom = view.state.doc.lineAt(blockFrom).from
      const lineTo   = view.state.doc.lineAt(Math.min(blockTo, view.state.doc.length - 1)).to
      view.dispatch({ changes: { from: lineFrom, to: lineTo, insert: newText } })
      inp.value = ''
      e.preventDefault()
      return true
    },
  })
}

// ─── Math click → inline MathQuill editing ───────────────────────────────────
function makeMathClickHandler(cm) {
  return cm.view.EditorView.domEventHandlers({
    click(e, view) {
      const el = e.target.closest('.cm-math-mq')
      if (!el) return false

      const latex   = el.dataset.latex ?? ''
      const display = el.dataset.display === '1'

      // Build overlay anchored to the widget position
      const rect = el.getBoundingClientRect()

      const overlay = document.createElement('div')
      overlay.className = 'nb-math-editor-overlay'
      overlay.style.cssText = `
        position: fixed;
        top: ${rect.top - 6}px;
        left: ${rect.left - 8}px;
        min-width: ${Math.max(rect.width + 16, 160)}px;
        background: var(--surface, #161b22);
        border: 1.5px solid var(--accent, #388bfd);
        border-radius: 8px;
        padding: 6px 10px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.55);
        z-index: 99999;
        display: flex;
        align-items: center;
        gap: 8px;
      `

      const mqSpan = document.createElement('span')
      mqSpan.style.cssText = 'display:inline-block; min-width:60px; flex:1;'
      overlay.appendChild(mqSpan)

      const doneBtn = document.createElement('button')
      doneBtn.textContent = '✓'
      doneBtn.style.cssText = `
        background: var(--accent, #388bfd); color: #fff;
        border: none; border-radius: 5px; padding: 2px 8px;
        cursor: pointer; font-size: 12px; flex-shrink: 0;
      `
      overlay.appendChild(doneBtn)

      document.body.appendChild(overlay)

      getMQ().then(MQ => {
        if (!MQ) { overlay.remove(); return }

        let mqField = null
        try {
          mqField = MQ.MathField(mqSpan, {
            spaceBehavesLikeTab: true,
            handlers: { enter: commit },
          })
          mqField.latex(latex)
          mqField.focus()
        } catch {
          overlay.remove()
          return
        }

        function commit() {
          if (!mqField) return
          const newLatex = mqField.latex()
          overlay.remove()
          // Find the original syntax in the document and replace it
          const docStr = view.state.doc.toString()
          const wrap = display ? `$$${latex}$$` : `$${latex}$`
          const idx = docStr.indexOf(wrap)
          if (idx >= 0) {
            const newWrap = display ? `$$${newLatex}$$` : `$${newLatex}$`
            view.dispatch({ changes: { from: idx, to: idx + wrap.length, insert: newWrap } })
          }
          view.focus()
        }

        doneBtn.onclick = commit

        const handleKey = (ev) => {
          if (ev.key === 'Escape') { overlay.remove(); view.focus(); document.removeEventListener('keydown', handleKey) }
        }
        document.addEventListener('keydown', handleKey)

        const handleOutside = (ev) => {
          if (!overlay.contains(ev.target)) {
            commit()
            document.removeEventListener('mousedown', handleOutside)
            document.removeEventListener('keydown', handleKey)
          }
        }
        setTimeout(() => document.addEventListener('mousedown', handleOutside), 80)
      })

      return true
    }
  })
}

// ─── Source mode formatting plugin (mark decorations only, no syntax hiding) ──
function makeSourcePlugin(cm) {
  const { ViewPlugin, Decoration } = cm.view
  const { RangeSetBuilder } = cm.state
  const { syntaxTree } = cm.language

  const SPAN_MAP = {
    StrongEmphasis: 'cm-lv-b',
    Emphasis:       'cm-lv-i',
    Strikethrough:  'cm-lv-s',
    InlineCode:     'cm-lv-c',
    Highlight:      'cm-lv-hl',
    Link:           'cm-lv-lnk',
    Image:          'cm-lv-lnk',
  }
  const LINE_MAP = {
    ATXHeading1: 'cm-lv-h1', ATXHeading2: 'cm-lv-h2', ATXHeading3: 'cm-lv-h3',
    ATXHeading4: 'cm-lv-h4', ATXHeading5: 'cm-lv-h5', ATXHeading6: 'cm-lv-h6',
  }
  const CODE_BLOCKS = new Set(['FencedCode', 'CodeBlock', 'IndentedCode'])

  function build(view) {
    const { state } = view
    const doc = state.doc
    const marks = []
    const lineDecs = []

    try {
      syntaxTree(state).iterate({
        enter(node) {
          const { from, to, name } = node
          if (from >= to) return

          if (CODE_BLOCKS.has(name)) {
            const ls = doc.lineAt(from).number
            const le = doc.lineAt(Math.min(to, doc.length - 1)).number
            for (let n = ls; n <= le; n++) {
              try { lineDecs.push({ pos: doc.line(n).from, cls: 'cm-lv-cb' }) } catch { /**/ }
            }
            return false
          }

          if (name === 'Blockquote') {
            const ls = doc.lineAt(from).number
            const le = doc.lineAt(Math.min(to, doc.length - 1)).number
            for (let n = ls; n <= le; n++) {
              try { lineDecs.push({ pos: doc.line(n).from, cls: 'cm-lv-bq' }) } catch { /**/ }
            }
            return false
          }

          const lineCls = LINE_MAP[name]
          if (lineCls) {
            try { lineDecs.push({ pos: doc.lineAt(from).from, cls: lineCls }) } catch { /**/ }
            return // descend into children
          }

          const spanCls = SPAN_MAP[name]
          if (spanCls) marks.push({ from, to, cls: spanCls })
        }
      })
    } catch { /**/ }

    marks.sort((a, b) => a.from !== b.from ? a.from - b.from : b.to - a.to)
    const sb = new RangeSetBuilder()
    for (const { from, to, cls } of marks) {
      if (from < 0 || to > doc.length || from >= to) continue
      try { sb.add(from, to, Decoration.mark({ class: cls })) } catch { /**/ }
    }

    lineDecs.sort((a, b) => a.pos - b.pos)
    const lb = new RangeSetBuilder()
    const seen = new Set()
    for (const { pos, cls } of lineDecs) {
      const k = `${pos}:${cls}`
      if (seen.has(k)) continue; seen.add(k)
      try { lb.add(pos, pos, Decoration.line({ class: cls })) } catch { /**/ }
    }

    return { spans: sb.finish(), lines: lb.finish() }
  }

  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        try { const r = build(view); this.decorations = r.spans; this.lineDecos = r.lines }
        catch { this.decorations = Decoration.none; this.lineDecos = Decoration.none }
      }
      update(upd) {
        if (upd.docChanged || upd.viewportChanged) {
          try { const r = build(upd.view); this.decorations = r.spans; this.lineDecos = r.lines }
          catch { /**/ }
        }
      }
    },
    {
      decorations: v => v.decorations,
      provide: plugin => [
        cm.view.EditorView.decorations.of(v => {
          try { return v.plugin(plugin)?.lineDecos ?? Decoration.none }
          catch { return Decoration.none }
        }),
      ],
    }
  )
}

// ─── View mode button ─────────────────────────────────────────────────────────
const VIEW_MODE_CYCLE = ['live', 'source', 'preview']
const IconSrc = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
    <path d="M11.5 2.5l2 2-8 8H3.5v-2l8-8z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round"/>
    <path d="M3.5 13.5h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
  </svg>
)
const IconPrev = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
    <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
    <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4"/>
  </svg>
)
const IconLive = () => (
  <svg width="15" height="15" viewBox="0 0 32 32" fill="none">
    <path d="M26 3C22 5 14 10 10 18C8 22 7 25 6.5 28" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
    <path d="M26 3C24 8 18 15 10 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.6" />
    <path d="M26 3C25 6 22 10 16 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.45" />
    <path d="M6.5 28L9 23" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
    <path d="M3 30h26" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" opacity="0.55" />
  </svg>
)
const MODE_META = {
  live:    { icon: <IconLive />, label: 'Live',    title: 'Live preview' },
  source:  { icon: <IconSrc />,  label: 'Source',  title: 'Source mode' },
  preview: { icon: <IconPrev />, label: 'Preview', title: 'Reading view' },
}

function ViewModeBtn({ viewMode, setViewMode }) {
  const [phase,    setPhase]    = useState('visible')
  const [shown,    setShown]    = useState(viewMode)
  const [dropOpen, setDropOpen] = useState(false)
  const holdTimer = useRef(null)
  const didLong   = useRef(false)
  const wrapRef   = useRef(null)
  const prevRef   = useRef(viewMode)

  useEffect(() => {
    const prev = prevRef.current; prevRef.current = viewMode
    if (prev === viewMode) return
    const t0 = setTimeout(() => setPhase('exiting'),  0)
    const t1 = setTimeout(() => { setShown(viewMode); setPhase('entering') }, 150)
    const t2 = setTimeout(() => setPhase('visible'),  300)
    return () => { clearTimeout(t0); clearTimeout(t1); clearTimeout(t2) }
  }, [viewMode])

  useEffect(() => {
    if (!dropOpen) return
    const h = e => { if (!wrapRef.current?.contains(e.target)) setDropOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [dropOpen])

  return (
    <div style={{ position:'relative', flexShrink:0 }} ref={wrapRef}>
      <button style={{ width:30, height:30, background:'none', border:'1px solid var(--border)', borderRadius:6, color:'var(--textDim)', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', transition:'background .12s,color .12s' }}
        title={MODE_META[viewMode].title}
        onMouseDown={() => { didLong.current=false; holdTimer.current=setTimeout(()=>{ didLong.current=true; setDropOpen(d=>!d) },300) }}
        onMouseUp={() => clearTimeout(holdTimer.current)}
        onMouseLeave={() => clearTimeout(holdTimer.current)}
        onClick={() => { if(didLong.current)return; setViewMode(viewMode === 'source' ? 'live' : 'source'); setDropOpen(false) }}
      >
        <span style={{ display:'flex', alignItems:'center', justifyContent:'center', transition:'opacity .18s,transform .18s', ...(phase==='exiting'?{opacity:0,transform:'scale(.6) rotate(-15deg)',position:'absolute'}:phase==='entering'?{opacity:0,transform:'scale(.6) rotate(15deg)'}:{opacity:1,transform:'none'}) }}>
          {MODE_META[shown].icon}
        </span>
      </button>
      {dropOpen && (
        <div style={{ position:'absolute', top:'calc(100% + 6px)', right:0, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:10, overflow:'hidden', boxShadow:'0 12px 40px rgba(0,0,0,.45)', minWidth:130, zIndex:9300, animation:'vm-drop .12s cubic-bezier(.4,0,.2,1)' }}>
          {VIEW_MODE_CYCLE.map(m => (
            <button key={m} onMouseDown={e => { e.preventDefault(); setViewMode(m); setDropOpen(false) }}
              style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 14px', border:'none', background:'none', width:'100%', cursor:'pointer', textAlign:'left', fontSize:13, fontFamily:'inherit', color: viewMode===m?'var(--accent)':'var(--text)', transition:'background .08s' }}>
              {MODE_META[m].icon}
              <span style={{ flex:1, fontWeight:500 }}>{MODE_META[m].label}</span>
              {viewMode===m && <span style={{ fontSize:11, opacity:.7 }}>✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// NotebookView
// ─────────────────────────────────────────────────────────────────────────────
export default function NotebookView() {
  const themeKey        = useAppStore(s => s.themeKey ?? 'dark')
  const paneTabId      = useContext(PaneContext)
  const isActive       = useIsActiveTab()
  const notebook       = useAppStore(useCallback(
    s => {
      const tab = paneTabId ? s.tabs.find(t => t.id === paneTabId) : null
      return tab?.activeNotebook ?? s.activeNotebook
    },
    [paneTabId]
  ))
  const notebooks      = useAppStore(s => s.notebooks)
  const updateNotebook = useAppStore(s => s.updateNotebook)
  const nbFontSize     = useAppStore(s => s.nbFontSize ?? 15)
  const setPref        = useAppStore(s => s.setPref)
  const persistPreferences = useAppStore(s => s.persistPreferences)
  const setView        = useAppStore(s => s.setView)
  const updateTab      = useAppStore(s => s.updateTab)
  const activeTabId    = useAppStore(s => s.activeTabId)
  const library        = useAppStore(s => s.library)
  const sketchbooks    = useAppStore(s => s.sketchbooks)
  const flashcardDecks = useAppStore(s => s.flashcardDecks)
  const addNotebook    = useAppStore(s => s.addNotebook)

  const notebookId    = notebook?.id
  const notebookTitle = notebook?.title || ''

  const [viewMode,  setVM]       = useState('live')
  const [content,   setContent]  = useState('')
  const [noteTitle, setTitle]    = useState('')
  const [loaded,    setLoaded]   = useState(false)
  const [coverImage,  setCoverImage]  = useState(null)
  const [coverPos,    setCoverPos]    = useState({ x: 50, y: 50 })
  const [coverScale,  setCoverScale]  = useState(1)   // zoom factor ≥ 1
  const coverDragRef = useRef(null)
  const [coverPicker, setCoverPicker] = useState(null)
  const pickerImgRef = useRef(null)
  const [linkPicker, setLinkPicker] = useState(null)   // { type:'file'|'web'|'video', lineFrom, lineTo }
  const [linkWebUrl, setLinkWebUrl]  = useState('')
  const linkPickRef  = useRef(null)
  const [, setSaving]            = useState(false)
  const [findQ,     setFindQ]    = useState('')
  const [findCount, setFindCount]= useState(0)
  const [findCurD,  setFindCurD] = useState(0)
  const [selectionWC, setSelectionWC] = useState(0)
  const [editModal, setEditModal]= useState(false)

  const editorRef     = useRef(null)
  const cmRef         = useRef(null)
  const coverInputRef = useRef(null)
  const cmMods     = useRef(null)
  const saveTimer  = useRef(null)
  const saveVisT   = useRef(null)
  const contentRef = useRef('')
  const titleRef   = useRef('')
  const findRef    = useRef(null)
  const previewRef = useRef(null)
  const hitsRef    = useRef([])
  const hitIdxRef  = useRef(0)
  const loadedFor  = useRef(null)
  const wikiNavRef = useRef(null)
  const notebookDirRef = useRef(null)
  // Timestamp set by DOM drop handler when it inserts an image; checked by the
  // Tauri drag-drop handler to skip processing if DOM already handled the drop.
  const domDropRef = useRef(0)
  const [wikiDrop, setWikiDrop] = useState(null) // { options, selectedIdx, coords }
  const [inlineCmd, setInlineCmd] = useState(null) // { type, hint, selectedIdx, coords, lineFrom, lineTo }
  const inlineCmdRef = useRef(null)
  const inlineCmdNavRef = useRef(null)  // called by CM6 keymap to push selectedIdx into React state
  const [cursorPos, setCursorPos] = useState(0)
  // Keep nav callback fresh every render so it always closes over the latest setInlineCmd
  inlineCmdNavRef.current = () => {
    setInlineCmd(prev => prev ? { ...prev, selectedIdx: _inlineCmdSelectedIdx.current } : prev)
  }

  contentRef.current = content
  titleRef.current   = noteTitle

  const isLoaded = loaded && loadedFor.current === notebookId

  // ── Cross-tab content sync — when another tab saves the same notebook, apply here ──
  const nbCacheEntry = useAppStore(s => notebookId ? s.notebookContentCache?.[notebookId] : undefined)
  useEffect(() => {
    if (!nbCacheEntry || !isLoaded) return
    const { text: cachedText } = nbCacheEntry
    // Skip if this instance is already showing this content (we're the one who saved)
    if (cachedText === contentRef.current) return
    contentRef.current = cachedText; setContent(cachedText)
    // Push the new text into the live CM6 editor if mounted
    if (cmRef.current) {
      const view = cmRef.current
      const current = view.state.doc.toString()
      if (current !== cachedText) {
        // Preserve cursor position so a cross-tab save doesn't jump the caret
        const head = Math.min(view.state.selection.main.head, cachedText.length)
        view.dispatch({
          changes: { from: 0, to: current.length, insert: cachedText },
          selection: { anchor: head },
          scrollIntoView: false,
        })
      }
    }
  }, [nbCacheEntry, isLoaded]) // eslint-disable-line react-hooks/exhaustive-deps

  const previewHtml = useMemo(
    () => renderMarkdown(content, notebooks, library, sketchbooks, flashcardDecks),
    [content, notebooks, library, sketchbooks, flashcardDecks]
  )

  // Hydrate MathQuill after preview renders
  useEffect(() => {
    if (viewMode !== 'preview' || !previewRef.current) return
    hydrateMathNodes(previewRef.current)
  }, [viewMode, previewHtml])

  // Pre-load KaTeX and MathQuill so they're ready when live mode starts
  useEffect(() => { getKaTeX(); getMQ() }, [])

  // ── Load ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!notebookId) return
    let gone = false
    setLoaded(false)
    const nb = notebook
    Promise.all([
      loadNotebookContent(notebookId),
      nb ? getNotebookFolderPath(nb).catch(() => null) : Promise.resolve(null),
    ]).then(([raw, folderPath]) => {
      if (gone) return
      notebookDirRef.current = folderPath
      let text  = typeof raw === 'string' ? raw : ''
      let title = notebookTitle
      const hm  = text.match(/^# (.+)\n/)
      if (hm) { title = hm[1]; text = text.slice(hm[0].length) }
      titleRef.current = title; setTitle(title)
      contentRef.current = text; setContent(text)
      // Restore cover image if one was saved with this notebook
      const savedCover = nb?.coverImage || null
      if (savedCover && _convertFileSrc && folderPath) {
        try {
          const absPath = savedCover.startsWith('./') ? folderPath + '/' + savedCover.slice(2) : savedCover
          setCoverImage(_convertFileSrc(absPath))
        } catch { setCoverImage(null) }
      } else {
        setCoverImage(null)
      }
      setCoverPos(nb?.coverPos || { x: 50, y: 50 })
      setCoverScale(nb?.coverScale ?? 1)
      setLoaded(true)
      loadedFor.current = notebookId
    })
    return () => { gone = true }
  }, [notebookId, notebookTitle]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Wikilink navigation ───────────────────────────────────────────────────
  const handleWikiNav = useCallback((title, type, id) => {
    // Always read fresh state from the store to avoid stale closures
    const s = useAppStore.getState()
    const tabId = paneTabId || s.activeTabId
    const nbs = s.notebooks || []
    const lib = s.library || []
    const sbs = s.sketchbooks || []
    const fds = s.flashcardDecks || []
    if (type === 'notebook') {
      const nb = nbs.find(n => n.id === id)
      if (nb) { s.openNewTab({ view: 'notebook', activeNotebook: nb }) }
      else createAndOpenItem(title, 'notebook')
    } else if (type === 'book') {
      const bk = lib.find(b => b.id === id)
      if (bk) {
        const v = bk.format === 'audiofolder' || bk.format === 'audio' ? 'audio-player' : (bk.format === 'pdf' ? 'pdf' : 'reader')
        s.setActiveBook(bk); s.updateTab(tabId, { view: v, activeBook: bk }); s.setView(v)
      }
    } else if (type === 'sketchbook') {
      const sb = sbs.find(n => n.id === id)
      if (sb) { s.setActiveSketchbook(sb); s.updateTab(tabId, { view: 'sketchbook', activeSketchbook: sb }); s.setView('sketchbook') }
    } else if (type === 'flashcard') {
      const deck = fds.find(d => d.id === id)
      if (deck) { s.setActiveFlashcardDeck(deck); s.updateTab(tabId, { view: 'flashcard', activeFlashcardDeck: deck }); s.setView('flashcard') }
    } else if (type === 'new-sketch') {
      createAndOpenItem(title, 'sketchbook')
    } else if (type === 'new-flash') {
      createAndOpenItem(title, 'flashcard')
    } else {
      createAndOpenItem(title, 'notebook')
    }
  }, [setView, paneTabId]) // eslint-disable-line react-hooks/exhaustive-deps
  wikiNavRef.current  = handleWikiNav
  linkPickRef.current = info => setLinkPicker(info)
  inlineCmdRef.current = inlineCmd  // kept in sync for the stable window keydown listener

  function createAndOpenItem(title, kind) {
    const s = useAppStore.getState()
    const tabId = paneTabId || s.activeTabId
    const now = new Date().toISOString()
    if (kind === 'sketchbook') {
      const newSb = { id: makeId('sb'), title, createdAt: now, updatedAt: now, _isSketchbook: true }
      s.addSketchbook?.(newSb)
      s.persistSketchbooks?.()
      s.setActiveSketchbook(newSb)
      s.updateTab(tabId, { view: 'sketchbook', activeSketchbook: newSb })
      s.setView('sketchbook')
    } else if (kind === 'flashcard') {
      const newFd = { id: makeId('fd'), title, createdAt: now, updatedAt: now, cards: [] }
      s.addDeck?.(newFd)
      s.persistFlashcardDecks?.()
      s.setActiveFlashcardDeck(newFd)
      s.updateTab(tabId, { view: 'flashcard', activeFlashcardDeck: newFd })
      s.setView('flashcard')
    } else {
      const newNb = { id: makeId('nb'), title, createdAt: now, updatedAt: now, wordCount: 0 }
      s.addNotebook?.(newNb) || addNotebook(newNb)
      s.persistNotebooks?.()
      s.setActiveNotebook(newNb)
      s.updateTab(tabId, { view: 'notebook', activeNotebook: newNb })
      s.setView('notebook')
    }
  }

  // ── Study timer — tracks minutes spent in notebook for streak/stats ────────
  useEffect(() => {
    if (!notebook || !isActive) return
    const TICK_MS = 60_000
    const IDLE_MS = 120_000
    let lastActive = Date.now()
    let accumulated = 0
    const onActivity = () => { lastActive = Date.now() }
    window.addEventListener('mousemove', onActivity, { passive: true })
    window.addEventListener('keydown',   onActivity, { passive: true })
    const interval = setInterval(() => {
      if (Date.now() - lastActive < IDLE_MS) {
        accumulated += TICK_MS / 60_000
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
      if (accumulated >= 0.1) addReadingMinutes(Math.max(1, Math.round(accumulated))).catch(() => {})
    }
  }, [notebook, isActive])

  // ── Cmd/Ctrl + +/- font size zoom ─────────────────────────────────────────
  useEffect(() => {
    if (!isActive) return
    const handler = (e) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key !== '+' && e.key !== '=' && e.key !== '-') return
      e.preventDefault()
      const current = useAppStore.getState().nbFontSize ?? 15
      const next = e.key === '-' ? Math.max(11, current - 1) : Math.min(24, current + 1)
      if (next === current) return
      setPref('nbFontSize', next)
      persistPreferences()
    }
    window.addEventListener('keydown', handler, { capture: true })
    return () => window.removeEventListener('keydown', handler, { capture: true })
  }, [isActive, setPref, persistPreferences])

  // ── Inline cmd dropdown arrow-key navigation ─────────────────────────────
  // Capture phase on window so we fire before CM6 — prevents cursor movement
  // in the editor while the /color /font /spacing /size dropdown is open.
  useEffect(() => {
    const onKey = (e) => {
      const cmd = inlineCmdRef.current
      if (!cmd) return
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      e.stopPropagation()
      const delta = e.key === 'ArrowDown' ? 1 : -1
      setInlineCmd(prev => {
        if (!prev) return prev
        const count = _getOptionCount(prev.type)
        const newIdx = ((prev.selectedIdx ?? 0) + delta + count) % count
        _inlineCmdSelectedIdx.current = newIdx
        return { ...prev, selectedIdx: newIdx }
      })
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [])

  // ── Mount CodeMirror ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!isLoaded || !editorRef.current) return
    let dead = false

    loadCM().then(cm => {
      if (dead || !editorRef.current) return
      cmMods.current = cm
      const {
        state: { EditorState, RangeSetBuilder, Prec },
        view: { EditorView, drawSelection, dropCursor, keymap, placeholder },
        commands: { defaultKeymap, indentWithTab, history, historyKeymap },
        language: { indentOnInput, syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldKeymap },
        langMd, lezerMd,
        search: { search: searchExt, searchKeymap },
      } = cm

      const isLive    = viewMode === 'live' || viewMode === 'preview'
      const isPreview = viewMode === 'preview'
      const gfmExts = lezerMd?.GFM ? [lezerMd.GFM] : [lezerMd?.Strikethrough, lezerMd?.Table, lezerMd?.TaskList].filter(Boolean)

      const extensions = [
        makeTheme(cm),
        syntaxHighlighting(makeHighlight(cm)),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        drawSelection(), dropCursor(),
        indentOnInput(), bracketMatching(), history(),
        langMd.markdown({ extensions: gfmExts }),
        // Wikilink dropdown (custom React-driven — bypasses CM6 autocompletion)
        ...makeWikiDropdownPlugin(cm, notebooks, library, sketchbooks, flashcardDecks, setWikiDrop),
        searchExt({ top: false }),
        makeFormatKeys(cm),
        // /table, /linkf, /linkw, /linkv slash commands (must be before smartEnter)
        makeTableCommand(cm),
        makeLinkCommands(cm, linkPickRef),
        // /color, /font, /spacing, /size inline command keymap
        makeInlineCmdPlugin(cm, inlineCmdNavRef),
        // {//} auto-close for inline-cmd spans
        makeInlineCmdCloseHandler(cm),
        makeSmartEnter(cm),
        // Pair auto-wrap via input handler
        makePairInputHandler(cm),
        // Ghost hint — Tab to accept, any other key dismisses
        ...makeGhostHintPlugin(cm),
        // Math.js inline calculator — shows result after `expr=`
        ...makeMathCalcPlugin(cm),
        // Live decorations (widgets, hiding syntax) — shared between live + preview
        ...(isLive ? makeLivePlugin(cm, RangeSetBuilder, notebooks, library, sketchbooks, flashcardDecks, notebookDirRef.current, viewMode === 'preview') : []),
        // Interaction handlers — live mode only (preview is read-only)
        ...(viewMode === 'live' ? [
          makeCheckboxHandler(cm),
          makeWikiHandler(cm, wikiNavRef),
          makeMathClickHandler(cm),
          makeTodoHandler(cm),
          makeTaskHandler(cm),
          makeLinkHandler(cm),
        ] : []),
        // Source mode: style-only formatting (bold/italic/etc.) without hiding syntax or expanding widgets
        ...(viewMode === 'source' ? [makeSourcePlugin(cm)] : []),
        // Let macOS window management shortcuts pass through to the OS.
        // ctrl+arrow = switch spaces; fn+ctrl+arrow = window tiling (Ctrl-Home/End/PageUp/PageDown)
        Prec.highest(keymap.of([
          { key: 'Ctrl-ArrowLeft',  run: () => true, preventDefault: false },
          { key: 'Ctrl-ArrowRight', run: () => true, preventDefault: false },
          { key: 'Ctrl-ArrowUp',    run: () => true, preventDefault: false },
          { key: 'Ctrl-ArrowDown',  run: () => true, preventDefault: false },
          { key: 'Ctrl-Home',       run: () => true, preventDefault: false },
          { key: 'Ctrl-End',        run: () => true, preventDefault: false },
          { key: 'Ctrl-PageUp',     run: () => true, preventDefault: false },
          { key: 'Ctrl-PageDown',   run: () => true, preventDefault: false },
        ])),
        keymap.of([
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          indentWithTab,
          { key: 'Mod-s', run: () => { flushSave(); return true } },
          { key: 'Mod-f', run: () => { findRef.current?.focus(); findRef.current?.select(); return true } },
        ]),
        EditorView.updateListener.of(upd => {
          if (dead) return
          if (upd.docChanged) {
            const t = upd.state.doc.toString()
            contentRef.current = t; setContent(t); scheduleSave(t)
          }
          if (upd.selectionSet || upd.docChanged) {
            const sel = upd.state.selection.main
            if (sel && !sel.empty) {
              const selectedText = upd.state.sliceDoc(sel.from, sel.to)
              const wc = (selectedText.match(/\b\w+\b/g) || []).length
              setSelectionWC(wc)
            } else {
              setSelectionWC(0)
            }
          }
          // Track cursor position so the inline-cmd useLayoutEffect can fire
          if (upd.selectionSet || upd.docChanged) {
            setCursorPos(upd.state.selection.main.head)
          }
        }),
        EditorView.lineWrapping,
        placeholder('Create something…'),
        // Image drag-and-drop + paste handler
        // Preview mode — disable keyboard input while keeping programmatic dispatch working
        ...(isPreview ? [EditorView.editable.of(false)] : []),
        EditorView.domEventHandlers({
          drop(e, view) {
            // Capture ALL data transfer payloads synchronously — dataTransfer clears after event
            const dt = e.dataTransfer
            const uriList  = dt?.getData('text/uri-list') || ''
            const htmlData = dt?.getData('text/html') || ''
            const plainData = dt?.getData('text/plain') || ''
            const safariUrl = dt?.getData('URL') || ''          // WKWebView / Safari single-URL type

            // Extract a URL from any available source (in priority order)
            const fromUri  = uriList.trim().split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#') && /^https?:\/\//i.test(s))[0] || null
            const fromSafari = /^https?:\/\//i.test(safariUrl) ? safariUrl : null
            const htmlSrcMatch = htmlData.match(/<img[^>]+src="(https?:\/\/[^"]+)"/i) || htmlData.match(/<img[^>]+src='(https?:\/\/[^']+)'/i)
            const fromHtml = htmlSrcMatch ? htmlSrcMatch[1] : null
            const fromPlain = /^https?:\/\//i.test(plainData.trim()) ? plainData.trim() : null
            const webUrl = fromUri || fromSafari || fromHtml || fromPlain || null

            const files = e.dataTransfer?.files
            const imgFile = files?.length ? Array.from(files).find(f => f.type.startsWith('image/')) : null

            // Nothing useful to handle
            if (!imgFile && !webUrl) return false
            e.preventDefault()

            const dropPos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head

            if (imgFile) {
              const name = imgFile.name || 'image'
              // Tauri exposes .path on File objects from Finder drag-drop —
              // let the Tauri drag-drop event handle those to avoid duplicate insertion
              const filePath = imgFile.path
              if (Date.now() - domDropRef.current < 2000) {
                return true // Tauri handler already inserted this drop
              }
              if (filePath || (_invoke && !webUrl)) {
                return true // Tauri handler will insert the markdown with the correct asset URL
              } else if (webUrl) {
                // Web image file with no local path — use the URL
                domDropRef.current = Date.now()
                view.dispatch({ changes: { from: dropPos, insert: `![${name}](${webUrl})` } })
              } else if (notebook?.id) {
                domDropRef.current = Date.now()
                ;(async () => {
                  try {
                    const buf = new Uint8Array(await imgFile.arrayBuffer())
                    const fname = `${Date.now()}_${imgFile.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`
                    const relPath = await saveNotebookImage(notebook.id, fname, buf)
                    view.dispatch({ changes: { from: dropPos, insert: `![${name}](${relPath || name})` } })
                  } catch {
                    view.dispatch({ changes: { from: dropPos, insert: `![${name}](${name})` } })
                  }
                })()
              } else {
                domDropRef.current = Date.now()
                view.dispatch({ changes: { from: dropPos, insert: `![${name}](${name})` } })
              }
            } else if (webUrl) {
              // Pure URL drop (no file object) — image dragged from browser
              const name = webUrl.split('/').pop().split('?')[0] || 'image'
              domDropRef.current = Date.now()
              view.dispatch({ changes: { from: dropPos, insert: `![${name}](${webUrl})` } })
            }
            return true
          },
          paste(e, view) {
            const items = e.clipboardData?.items
            if (!items) return false
            // If clipboard has text, let the default paste handle it
            const hasText = Array.from(items).some(i => i.type === 'text/plain')
            if (hasText) return false
            const imgItem = Array.from(items).find(i => i.type.startsWith('image/'))
            if (!imgItem || !notebook?.id) return false
            const blob = imgItem.getAsFile()
            if (!blob) return false
            e.preventDefault()
            // Handle async image save without blocking — already prevented default
            ;(async () => {
              const buf = new Uint8Array(await blob.arrayBuffer())
              const fname = `${Date.now()}_paste.${blob.type.split('/')[1] || 'png'}`
              const relPath = await saveNotebookImage(notebook.id, fname, buf)
              if (relPath) {
                const pos = view.state.selection.main.head
                const md = `![pasted image](${relPath})`
                view.dispatch({ changes: { from: pos, insert: md } })
              }
            })()
            return true  // synchronously return true — we've already called preventDefault
          },
        }),
      ]

      if (cmRef.current) { cmRef.current.destroy(); cmRef.current = null }
      const state = EditorState.create({ doc: contentRef.current, extensions })
      const view  = new EditorView({ state, parent: editorRef.current })
      cmRef.current = view
      if (!isPreview) view.focus()
    })

    return () => {
      dead = true
      if (cmRef.current) { cmRef.current.destroy(); cmRef.current = null }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, viewMode, notebook?.id])

  // ── Inline command dropdown detection ─────────────────────────────────────
  // useLayoutEffect fires after React's DOM mutations, before paint — exactly
  // when coordsAtPos is reliable. cursorPos changes on every keystroke/cursor move.
  const INLINE_CMD_RE = /^\s*\/(color|font|spacing|size)(?::([^\s]*))?$/
  useLayoutEffect(() => {
    const view = cmRef.current
    if (!view) { setInlineCmd(null); return }
    const cur = view.state.selection.main.head
    const line = view.state.doc.lineAt(cur)
    const m = line.text.match(INLINE_CMD_RE)
    if (!m) {
      setInlineCmd(prev => prev ? null : prev)
      return
    }
    const coords = view.coordsAtPos(cur)
    const type = m[1]
    setInlineCmd(prev => ({
      type,
      hint: (m[2] || '').toLowerCase(),
      selectedIdx: prev?.type === type ? (prev.selectedIdx ?? 0) : 0,
      lineFrom: line.from,
      lineTo: line.to,
      coords: coords
        ? { left: coords.left, top: coords.bottom + 6 }
        : { left: 120, top: 160 },
    }))
  }, [cursorPos]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Save ──────────────────────────────────────────────────────────────────
  const animateSave = useCallback(() => {
    const el = document.getElementById('nb-save-icon')
    if (!el) return
    el.classList.remove('anim', 'vis', 'closing'); void el.offsetWidth
    el.classList.add('anim', 'vis')
    clearTimeout(saveVisT.current)
    saveVisT.current = setTimeout(() => {
      el.classList.remove('anim')
      el.classList.add('closing')
      saveVisT.current = setTimeout(() => el.classList.remove('vis', 'closing'), 450)
    }, 600)
  }, [])

  const doSave = useCallback(async (text, title) => {
    if (!notebook) return
    setSaving(true)
    await saveNotebookContent(notebook, title ? `# ${title}\n${text}` : text)
    const wc = (text.match(/\b\w+\b/g) || []).length
    // Extract earliest due date from content
    const duRe = /::(\d{4}-\d{2}-\d{2}(?:,\d{1,2}:\d{2})?|\d{2}-\d{2}-(?:\d{4}|\d{2})(?:,\d{1,2}:\d{2})?|\d{1,2}:\d{2}|\+\d+[dh])/g
    let dueDate = null, dm
    while ((dm = duRe.exec(text)) !== null) {
      const d = parseDueDate(dm[1])
      if (d && (!dueDate || d < dueDate)) dueDate = d
    }
    // Extract tags ::tagname (letter-start tokens that aren't due dates)
    const tagRe = /::([a-zA-Z][a-zA-Z0-9_-]*)/g
    const tagSet = new Set()
    let tm
    while ((tm = tagRe.exec(text)) !== null) tagSet.add(tm[1].toLowerCase())
    const tags = tagSet.size ? [...tagSet] : null
    const newTitle = title || notebook.title
    const patch = { updatedAt: new Date().toISOString(), wordCount: wc, dueDate: dueDate?.toISOString() || null, tags }
    if (newTitle !== notebook.title) {
      patch.title = newTitle
      // Propagate the rename to wikilinks in all other notebooks
      const oldTitle = notebook.title
      if (oldTitle) {
        const allNbs = useAppStore.getState().notebooks
        const escaped = oldTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const wikilinkRe = new RegExp(`\\[\\[${escaped}\\]\\]`, 'gi')
        for (const nb of allNbs) {
          if (nb.id === notebook.id) continue
          try {
            const raw = await loadNotebookContent(nb.id)
            if (!raw || !wikilinkRe.test(raw)) continue
            wikilinkRe.lastIndex = 0
            const updated = raw.replace(wikilinkRe, `[[${newTitle}]]`)
            await saveNotebookContent(nb, updated)
          } catch { /* non-fatal — skip this notebook */ }
        }
      }
    }
    updateNotebook(notebook.id, patch)
    useAppStore.getState().persistNotebooks?.()
    // Signal other tabs showing the same notebook to pull in the new content
    useAppStore.getState().setNotebookContentCache?.(notebook.id, text)
    setSaving(false); animateSave()
  }, [notebook, updateNotebook, animateSave])

  const scheduleSave = useCallback(text => {
    clearTimeout(saveTimer.current)
    // Show save icon immediately so the user gets instant feedback
    const el = document.getElementById('nb-save-icon')
    if (el && !el.classList.contains('vis')) {
      el.classList.remove('anim', 'closing'); void el.offsetWidth
      el.classList.add('vis')
    }
    saveTimer.current = setTimeout(() => doSave(text, titleRef.current), 800)
  }, [doSave])

  const flushSave = useCallback(() => {
    clearTimeout(saveTimer.current)
    doSave(contentRef.current, titleRef.current)
  }, [doSave])

  // ── /linkf and /linkv — open Tauri dialog from React effect (NOT from CM handler) ──
  useEffect(() => {
    if (!linkPicker || linkPicker.type === 'web') return
    if (!_dialogOpen) { setLinkPicker(null); return }
    const isVideo = linkPicker.type === 'video'
    const opts = isVideo
      ? { multiple: false, filters: [{ name: 'Video', extensions: ['mp4','mov','avi','mkv','webm','flv','wmv','m4v'] }] }
      : { multiple: false }
    _dialogOpen(opts)
      .then(path => {
        if (path && cmRef.current) {
          const p = String(path)
          const name = p.split(/[/\\]/).pop() || p
          const prefix = isVideo ? 'linkv' : 'linkf'
          cmRef.current.dispatch({
            changes: { from: linkPicker.lineFrom, to: linkPicker.lineTo, insert: `/${prefix}:${p}|${name}` },
          })
        }
      })
      .catch(console.warn)
      .finally(() => setLinkPicker(null))
  }, [linkPicker]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Cover picker ──────────────────────────────────────────────────────────
  const cancelPicker = useCallback(() => {
    setCoverPicker(p => {
      if (p?.objectUrl && !p.isEdit) URL.revokeObjectURL(p.objectUrl)
      return null
    })
  }, [])

  const openPickerForEdit = useCallback(() => {
    if (!coverImage) return
    setCoverPicker({
      objectUrl: coverImage,
      file: null,
      isEdit: true,
      pos: { ...coverPos },
      scale: coverScale,
    })
  }, [coverImage, coverPos, coverScale])

  const applyPicker = useCallback(async () => {
    const picker = coverPicker
    if (!picker) return
    const { file, objectUrl, isEdit, pos, scale } = picker
    const newScale = Math.max(1, scale ?? 1)
    try {
      if (!isEdit) {
        const buf = await file.arrayBuffer()
        const ext = file.name.split('.').pop() || 'jpg'
        const relPath = await saveNotebookImage(notebookId, `cover.${ext}`, new Uint8Array(buf))
        if (relPath && _convertFileSrc && notebookDirRef.current) {
          const absPath = relPath.startsWith('./') ? notebookDirRef.current + '/' + relPath.slice(2) : relPath
          setCoverImage(_convertFileSrc(absPath) + `?v=${Date.now()}`)
        }
        updateNotebook(notebookId, { coverImage: relPath, coverPos: pos, coverScale: newScale })
      } else {
        updateNotebook(notebookId, { coverPos: pos, coverScale: newScale })
      }
      setCoverPos(pos)
      setCoverScale(newScale)
      useAppStore.getState().persistNotebooks?.()
    } catch (err) {
      console.error('[NotebookView] cover apply failed:', err)
    }
    if (!isEdit) URL.revokeObjectURL(objectUrl)
    setCoverPicker(null)
  }, [coverPicker, notebookId, updateNotebook])

  // ── Ctrl+F ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isActive) return
    const h = e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault(); findRef.current?.focus(); findRef.current?.select()
      }

    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [isActive])

  // ── Tauri native file drop (Finder drag-and-drop) ───────────────────────────
  useEffect(() => {
    if (!notebook?.id) return
    let mounted = true
    const unlisteners = []
    let lastDropTime = 0

    const handleDrop = async (event) => {
      const now = Date.now()
      if (now - lastDropTime < 300) return
      if (now - domDropRef.current < 2000) return  // DOM handler already inserted this drop
      lastDropTime = now
      const payload = event.payload
      // Tauri 2 drag-drop payload: { paths: string[], position: {x,y} }
      const paths = payload?.paths || (Array.isArray(payload) ? payload : null)
      const dropPos2d = payload?.position ?? null
      if (!paths?.length || !cmRef.current) return
      const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i
      for (const p of paths) {
        if (!IMG_EXT.test(p)) continue
        try {
          const name = p.split('/').pop().split('\\').pop()
          // Use drop coordinates if available (Finder drag-drop), else cursor position
          let pos = cmRef.current.state.selection.main.head
          if (dropPos2d) {
            const fromCoords = cmRef.current.posAtCoords({ x: dropPos2d.x, y: dropPos2d.y })
            if (fromCoords != null) pos = fromCoords
          }
          // Copy the file into the notebook's images folder for portable storage
          let mdPath = null
          if (notebook?.id) {
            try {
              const { readFile } = await import('@tauri-apps/plugin-fs')
              const bytes = await readFile(p)
              const fname = `${Date.now()}_${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`
              mdPath = await saveNotebookImage(notebook.id, fname, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
            } catch (copyErr) { console.warn('[Gnos] image copy failed:', copyErr) }
          }
          const ref = mdPath || (_convertFileSrc ? _convertFileSrc(p) : p)
          const md = `![${name}](${ref})\n`
          domDropRef.current = Date.now()
          cmRef.current.dispatch({ changes: { from: pos, insert: md } })
        } catch (err) { console.warn('[Gnos] File drop error:', p, err) }
      }
    }

    // Tauri 2 drag-drop event (tauri://drag-drop is the correct v2 name)
    listen('tauri://drag-drop', handleDrop).then(u => { if (mounted) unlisteners.push(u); else u() }).catch(() => {})
    listen('tauri://drag', () => {}).then(u => { if (mounted) unlisteners.push(u); else u() }).catch(() => {})

    return () => { mounted = false; unlisteners.forEach(u => u?.()) }
  }, [notebook?.id])

  // ── Find in preview / live ──────────────────────────────────────────────────
  function doFind(q) {
    // Live / preview mode — use CodeMirror's built-in search highlighting
    if ((viewMode === 'live' || viewMode === 'preview') && cmRef.current && cmMods.current) {
      const searchMod = cmMods.current.search
      const view = cmRef.current
      if (!q) {
        view.dispatch({ effects: searchMod.setSearchQuery.of(new searchMod.SearchQuery({ search: '' })) })
        setFindCount(0); setFindCurD(0)
        hitsRef.current = []; return
      }
      const query = new searchMod.SearchQuery({ search: q, caseSensitive: false })
      view.dispatch({ effects: searchMod.setSearchQuery.of(query) })
      // Count matches by iterating the query cursor
      const cursor = query.getCursor(view.state.doc)
      let count = 0
      while (!cursor.next().done) count++
      hitsRef.current = Array(count) // placeholder array for length
      hitIdxRef.current = 0
      setFindCount(count)
      setFindCurD(0)
      if (count > 0) searchMod.findNext(view)
      return
    }

    // Preview mode — DOM text search
    const el = previewRef.current
    if (!el || !q) {
      el?.querySelectorAll('mark.nb-fhl').forEach(m => m.replaceWith(document.createTextNode(m.textContent)))
      hitsRef.current = []; return
    }
    el.querySelectorAll('mark.nb-fhl').forEach(m => m.replaceWith(document.createTextNode(m.textContent)))
    el.normalize()
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    const hits = []; let node
    while ((node = walker.nextNode())) {
      const text = node.nodeValue
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'gi')
      let m, last = 0; const frags = []
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) frags.push(document.createTextNode(text.slice(last, m.index)))
        const mark = document.createElement('mark'); mark.className = 'nb-fhl'; mark.textContent = m[0]
        frags.push(mark); hits.push(mark); last = m.index + m[0].length
      }
      if (frags.length) {
        if (last < text.length) frags.push(document.createTextNode(text.slice(last)))
        node.parentNode?.replaceChild(frags.reduce((f, n2) => { const df = document.createDocumentFragment(); df.appendChild(f instanceof DocumentFragment ? f : (() => { const ff = document.createDocumentFragment(); ff.appendChild(f); return ff })()) ; df.appendChild(n2); return df }, document.createDocumentFragment()), node)
      }
    }
    hitsRef.current = hits; hitIdxRef.current = 0
    setFindCount(hits.length); setFindCurD(0)
    if (hits[0]) { hits[0].classList.add('nb-fhl-a'); hits[0].scrollIntoView({ block:'center', behavior:'smooth' }) }
  }

  function findNav(dir) {
    // Live / preview mode — use CodeMirror findNext / findPrevious
    if ((viewMode === 'live' || viewMode === 'preview') && cmRef.current && cmMods.current) {
      const searchMod = cmMods.current.search
      const view = cmRef.current
      if (dir > 0) searchMod.findNext(view)
      else searchMod.findPrevious(view)
      hitIdxRef.current = (hitIdxRef.current + dir + findCount) % Math.max(findCount, 1)
      setFindCurD(hitIdxRef.current)
      return
    }
    // Preview mode
    const hits = hitsRef.current
    if (!hits.length) return
    hits[hitIdxRef.current]?.classList.remove('nb-fhl-a')
    hitIdxRef.current = (hitIdxRef.current + dir + hits.length) % hits.length
    setFindCurD(hitIdxRef.current)
    hits[hitIdxRef.current]?.classList.add('nb-fhl-a')
    hits[hitIdxRef.current]?.scrollIntoView({ block:'center', behavior:'smooth' })
  }

  const wordCount = useMemo(() => (content.match(/\b\w+\b/g) || []).length, [content])

  const switchMode = useCallback((m) => {
    if (m === viewMode) return
    if (cmRef.current) {
      const t = cmRef.current.state.doc.toString()
      contentRef.current = t; setContent(t)
    }
    setVM(m)
  }, [viewMode])

  const handlePreviewClick = useCallback(e => {
    const wl = e.target.closest('[data-wl-type]')
    if (wl) handleWikiNav(wl.dataset.wlTitle, wl.dataset.wlType, wl.dataset.wlId)
    const cb = e.target.closest('.nb-cb')
    if (cb && previewRef.current) {
      const ti = parseInt(cb.dataset.ti, 10)
      const lines = contentRef.current.split('\n')
      let taskIdx = 0
      const newLines = lines.map(l => {
        if (!/^\s*[-*+]\s\[[ xX]\]/.test(l)) return l
        if (taskIdx++ !== ti) return l
        return /\[[xX]\]/.test(l) ? l.replace(/\[[xX]\]/, '[ ]') : l.replace(/\[ \]/, '[x]')
      })
      const newContent = newLines.join('\n')
      contentRef.current = newContent; setContent(newContent)
      scheduleSave(newContent)
    }
  }, [handleWikiNav, scheduleSave])

  // ─── CSS ──────────────────────────────────────────────────────────────────
  const CSS = `
    /* ── KaTeX theming ─────────────────────────────────── */
    .katex { color: var(--text) !important; font-size: 1.05em; }
    .katex-display { margin: 0.4em 0 !important; }
    .katex-display > .katex { color: var(--text) !important; }

    /* ── MathQuill / KaTeX ─────────────────────────────── */
    .mq-math-mode { color: var(--text) !important; }
    .mq-root-block, .mq-math-mode * { font-family: 'KaTeX_Main', 'Times New Roman', serif !important; }
    @keyframes vm-drop { from{opacity:0;transform:translateY(-6px) scale(.96)} to{opacity:1;transform:none} }

    /* ── Light-mode selection fix ──────────────────────── */
    .nb-root ::selection { background: var(--nb-sel, rgba(56,139,253,0.28)); }
    [data-theme="light"] .nb-root, .light .nb-root { --nb-sel: rgba(9,105,218,0.22); }

    /* ══════════════════════════════════════════════════════
       SHARED PROSE VARIABLES
       Both live and preview inherit these so typography
       is controlled from one place.
    ══════════════════════════════════════════════════════ */
    .nb-root {
      --nb-fs:   15px;
      --nb-lh:   1.8;
      --nb-ff:   'Erode', Georgia, serif;
      --nb-max:  780px;
      --nb-px:   48px;
      --nb-py:   28px;
      --nb-color: var(--readerText, var(--text));
      --nb-h1: 1.7em; --nb-h2: 1.4em; --nb-h3: 1.15em;
      --nb-h4: 1.05em; --nb-h5: 0.95em; --nb-h6: 0.88em;
      --nb-para-gap: 0.72em;
      /* ── Syntax color palette — defaults, overridden per-theme below ── */
      --nb-bold-color:     var(--text);
      --nb-italic-color:   var(--accent);
      --nb-strike-color:   var(--textDim);
      --nb-h1-color:       var(--text);
      --nb-h2-color:       var(--text);
      --nb-h3-color:       var(--text);
      --nb-h4-color:       var(--text);
      --nb-h5-color:       var(--text);
      --nb-h6-color:       var(--text);
      --nb-quote-color:    var(--textDim);
      --nb-quote-bg:       transparent;
      --nb-quote-border:   var(--accent);
      --nb-link-color:     var(--accent);
      --nb-wikilink-color: var(--accent);
      --nb-hl-bg:          rgba(210,153,34,.28);
      --nb-code-color:     var(--accent);
      --nb-code-bg:        rgba(56,139,253,.12);
    }

    /* ── CM host ───────────────────────────────────────── */
    .nb-cm { flex:1; overflow:hidden; position:relative; display:flex; flex-direction:column; }
    .nb-cm .cm-editor { height:100%; flex:1; }
    .nb-cm .cm-scroller { padding: var(--nb-py) 0 60px; box-sizing:border-box; overflow-x: hidden; overflow-y: auto; }
    .nb-cm .cm-content {
      max-width: var(--nb-max); margin: 0 auto;
      padding: 0 var(--nb-px);
      box-sizing: border-box; width: 100%;
      font-family: var(--nb-ff);
      font-size: var(--nb-fs);
      line-height: var(--nb-lh);
      color: var(--nb-color);
    }
    .nb-cm .cm-line { padding: 0; min-height: calc(var(--nb-fs) * var(--nb-lh)); }
    /* Blank lines between paragraphs get the right rhythm */
    .nb-cm .cm-line:empty { min-height: 0.5em; }
    .nb-cm .cm-placeholder { color:var(--textDim); opacity:.45; }
    /* Collapse widget buffer gaps without hiding from layout — display:none breaks block widget height */
    .cm-widgetBuffer { height: 0 !important; overflow: hidden; pointer-events: none; }
    /* Hide cursor on lines that contain only block widgets */
    .nb-cm .cm-line:has(.cm-timer-widget),
    .nb-cm .cm-line:has(.cm-pomo-widget),
    .nb-cm .cm-line:has(.cm-todo-block-w),
    .nb-cm .cm-line:has(.cm-task-board-w),
    .nb-cm .cm-line:has(.cm-calendar-widget),
    .nb-cm .cm-line:has(.cm-table-wrap),
    .nb-cm .cm-line:has(.cm-img-wrap) {
      caret-color: transparent;
    }

    /* ── Preview mode — hide cursor, disable interaction ── */
    .nb-preview .cm-content { caret-color: transparent; user-select: none; -webkit-user-select: none; pointer-events: none; cursor: default; }
    .nb-preview .cm-cursor, .nb-preview .cm-cursor-primary { display: none !important; }
    .nb-preview .cm-selectionBackground { display: none !important; }

    /* ── Source mode — same visual classes as live, no hiding ── */
    .nb-source .cm-lv-h1 { font-size: var(--nb-h1); font-weight: 600; line-height: 1.25; font-family: 'Erode', Georgia, serif; color: var(--nb-h1-color); padding-top: 0.4em; padding-bottom: 0.1em; letter-spacing: -0.3px; }
    .nb-source .cm-lv-h2 { font-size: var(--nb-h2); font-weight: 600; line-height: 1.3; font-family: 'Erode', Georgia, serif; color: var(--nb-h2-color); padding-top: 0.35em; padding-bottom: 0.1em; letter-spacing: -0.2px; }
    .nb-source .cm-lv-h3 { font-size: var(--nb-h3); font-weight: 600; line-height: 1.4; color: var(--nb-h3-color); font-family: 'Satoshi', 'Author', sans-serif; padding-top: 0.3em; }
    .nb-source .cm-lv-h4 { font-size: var(--nb-h4); font-weight: 600; color: var(--nb-h4-color); font-family: 'Satoshi', 'Author', sans-serif; }
    .nb-source .cm-lv-h5 { font-size: var(--nb-h5); font-weight: 600; color: var(--nb-h5-color); font-family: 'Satoshi', 'Author', sans-serif; }
    .nb-source .cm-lv-h6 { font-size: var(--nb-h6); font-weight: 600; opacity:.65; color: var(--nb-h6-color); font-family: 'Satoshi', 'Author', sans-serif; }
    .nb-source .cm-lv-b   { font-weight:700; color: var(--nb-bold-color); }
    .nb-source .cm-lv-i   { font-style:italic; color: var(--nb-italic-color); }
    .nb-source .cm-lv-s   { text-decoration:line-through; opacity:.75; color: var(--nb-strike-color); }
    .nb-source .cm-lv-c   { font-family: SF Mono,Menlo,Consolas,monospace; font-size:.87em; background: var(--nb-code-bg); border-radius:4px; padding:1px 4px; color: var(--nb-code-color); }
    .nb-source .cm-lv-lnk { color: var(--nb-link-color); text-decoration:underline; text-underline-offset:2px; }
    .nb-source .cm-lv-hl  { background: var(--nb-hl-bg); border-radius:2px; padding:0 2px; }
    .nb-source .cm-lv-bq  { border-left: 3px solid var(--nb-quote-border); padding-left: 14px; color: var(--nb-quote-color); background: var(--nb-quote-bg); font-style: italic; }
    .nb-source .cm-lv-cb  { background: var(--surfaceAlt); font-family: SF Mono,Menlo,Consolas,monospace; font-size:.87em; padding: 0 8px; border-radius: 3px; color: var(--text); }

    /* ── Hidden syntax markers (Obsidian style — font-size:0 not replace) ── */
    .nb-live .cm-lv-hidden {
      font-size: 0 !important;
      line-height: 0 !important;
      display: inline-block;
      width: 0;
      overflow: hidden;
    }

    /* ── Inline styled spans ({color:X}, {font:X}, {spacing:X}) ── */
    .cm-inline-styled { /* styles applied via inline style attribute */ }

    /* ══════════════════════════════════════════════════════
       LIVE VIEW — line-level class decorations
       These must match the .nb-prev selectors exactly.
    ══════════════════════════════════════════════════════ */

    /* Headings — weight, size, rhythm identical to preview */
    .nb-live .cm-lv-h1 {
      font-size: var(--nb-h1); font-weight: 600; line-height: 1.25;
      font-family: 'Erode', Georgia, serif; color: var(--nb-h1-color);
      margin-top: 0; padding-top: 0.4em; padding-bottom: 0.1em;
      letter-spacing: -0.3px;
    }
    .nb-live .cm-lv-h2 {
      font-size: var(--nb-h2); font-weight: 600; line-height: 1.3;
      font-family: 'Erode', Georgia, serif; color: var(--nb-h2-color);
      padding-top: 0.35em; padding-bottom: 0.1em;
      letter-spacing: -0.2px;
    }
    .nb-live .cm-lv-h3 {
      font-size: var(--nb-h3); font-weight: 600; line-height: 1.4; color: var(--nb-h3-color);
      font-family: 'Satoshi', 'Author', sans-serif;
      padding-top: 0.3em;
    }
    .nb-live .cm-lv-h4 { font-size: var(--nb-h4); font-weight: 600; color: var(--nb-h4-color); font-family: 'Satoshi', 'Author', sans-serif; }
    .nb-live .cm-lv-h5 { font-size: var(--nb-h5); font-weight: 600; color: var(--nb-h5-color); font-family: 'Satoshi', 'Author', sans-serif; }
    .nb-live .cm-lv-h6 { font-size: var(--nb-h6); font-weight: 600; opacity:.65; color: var(--nb-h6-color); font-family: 'Satoshi', 'Author', sans-serif; }

    /* Inline formats — exact match to preview */
    .nb-live .cm-lv-b  { font-weight:700; color: var(--nb-bold-color); }
    .nb-live .cm-lv-i  { font-style:italic; color: var(--nb-italic-color); }
    .nb-live .cm-lv-bi { font-weight:700; font-style:italic; color: var(--nb-bi-color); }
    .nb-live .cm-lv-s  { text-decoration:line-through; opacity:.75; color: var(--nb-strike-color); }
    .nb-live .cm-lv-c  {
      font-family: SF Mono,Menlo,Consolas,monospace; font-size:.87em;
      background: var(--nb-code-bg); border-radius:4px; padding:1px 4px; color: var(--nb-code-color);
    }
    .nb-live .cm-lv-lnk { color: var(--nb-link-color); text-decoration:underline; text-underline-offset:2px; }
    .nb-live .cm-lv-hl  { background: var(--nb-hl-bg); border-radius:2px; padding:0 2px; }

    /* Due-date badge */
    .cm-due-badge {
      display: inline-flex; align-items: center;
      font-size: 0.7em; font-weight: 700; letter-spacing: .04em;
      padding: 1px 7px 2px; border-radius: 6px; line-height: 1.7;
      background: rgba(80,100,255,0.18); color: var(--accent);
      border: 1.5px solid rgba(80,100,255,0.40); vertical-align: middle;
      cursor: default; user-select: none; font-family: inherit;
    }
    .cm-due-badge.cm-due-today {
      background: rgba(190,100,0,0.18); color: #b87000;
      border-color: rgba(190,100,0,0.42);
    }
    .cm-due-badge.cm-due-overdue {
      background: rgba(200,30,30,0.18); color: #c02020;
      border-color: rgba(200,30,30,0.42);
    }
    .cm-tag-badge {
      display: inline-flex; align-items: center;
      font-size: 0.7em; font-weight: 600; letter-spacing: .02em;
      padding: 1px 6px 2px; border-radius: 5px; line-height: 1.7;
      background: var(--surfaceAlt); color: var(--textDim);
      border: 1px solid var(--border); vertical-align: middle;
      cursor: default; user-select: none; font-family: inherit;
    }

    .cm-time-badge {
      display: inline-flex; align-items: center;
      font-size: 0.7em; font-weight: 700; letter-spacing: .02em;
      padding: 1px 6px 2px; border-radius: 5px; line-height: 1.7;
      background: rgba(56,139,253,0.1); color: var(--accent);
      border: 1px solid rgba(56,139,253,0.25); vertical-align: middle;
      cursor: default; user-select: none; font-family: inherit;
    }

    /* Blockquote — left border + italic + dim, matching preview */
    .nb-live .cm-lv-bq {
      border-left: 3px solid var(--nb-quote-border);
      padding-left: 14px;
      color: var(--nb-quote-color);
      background: var(--nb-quote-bg);
      margin-left: 0;
      font-style: italic;
    }

    /* Code block lines — monospace, slightly dimmed bg */
    .nb-live .cm-lv-cb {
      background: var(--surfaceAlt);
      font-family: SF Mono,Menlo,Consolas,monospace;
      font-size: .87em;
      padding: 0 8px;
      border-radius: 3px;
      color: var(--text);
    }

    /* ── Visible syntax markers when cursor is on them ── */
    .nb-live .cm-lv-p  { opacity: 0.32; color: var(--textDim); font-size: .88em; }

    /* Heading # shown dim when cursor on that line */
    .nb-live .cm-lv-h1 .cm-lv-p,
    .nb-live .cm-lv-h2 .cm-lv-p,
    .nb-live .cm-lv-h3 .cm-lv-p,
    .nb-live .cm-lv-h4 .cm-lv-p,
    .nb-live .cm-lv-h5 .cm-lv-p,
    .nb-live .cm-lv-h6 .cm-lv-p {
      color: var(--accent); opacity: 0.45; font-size: 0.68em;
      vertical-align: middle; font-weight: 400;
    }
    /* Bold markers shown */
    .nb-live .cm-lv-b  .cm-lv-p,
    .nb-live .cm-lv-bi .cm-lv-p { color: var(--nb-bold-color); font-weight:700; opacity: 0.38; font-size: 1em; }
    /* Italic markers shown */
    .nb-live .cm-lv-i  .cm-lv-p { color: var(--nb-italic-color); font-style:italic; opacity: 0.42; font-size: 1em; }
    /* Code markers shown */
    .nb-live .cm-lv-c  .cm-lv-p { color: var(--accent); opacity: 0.45; font-size: 1em; }
    /* Strikethrough shown */
    .nb-live .cm-lv-s  .cm-lv-p { color: var(--textDim); opacity: 0.42; font-size: 1em; }
    /* Highlight shown */
    .nb-live .cm-lv-hl .cm-lv-p { color: #d29922; opacity: 0.48; font-size: 1em; }
    /* Link markers shown */
    .nb-live .cm-lv-lnk .cm-lv-p { color: var(--accent); opacity: 0.42; font-size: 1em; }

    /* ── Widgets ─────────────────────────────────────── */
    /* HR widget */
    .cm-hr  { display:block; height:1px; background:var(--border); margin:8px 0; width:100%; pointer-events:none; }

    /* Image widget */
    .cm-img-wrap { display:block; margin:6px 0; line-height:0; background:none; box-shadow:none; }
    .cm-img { max-width:100%; max-height:340px; border-radius:6px; object-fit:contain; display:block; background:none; }
    .cm-img-err { display:inline-block; padding:4px 8px; background:var(--surfaceAlt); border:1px dashed var(--border); border-radius:4px; font-size:12px; color:var(--textDim); }

    /* Checkbox widget */
    .cm-cb  { display:inline-flex; align-items:center; justify-content:center; width:14px; height:14px; border:1.5px solid var(--border); border-radius:3px; font-size:9px; vertical-align:middle; margin-right:5px; cursor:pointer; flex-shrink:0; color:transparent; transition:background .1s; }
    .cm-cb-on { background:var(--accent); border-color:var(--accent); color:#fff; }

    /* Wikilink widget */
    .cm-wl { color:var(--nb-wikilink-color,var(--accent)); border-bottom:1px solid var(--nb-wikilink-color,var(--accent)); cursor:pointer; border-radius:2px; padding:0 1px; }
    .cm-wl:hover { opacity:.8; }
    .cm-wl-new { color:var(--textDim); border-bottom-color:var(--textDim); opacity:.75; }

    /* Link widget — rendered as a proper anchor when cursor is off it */
    .cm-link-widget {
      color: var(--accent);
      text-decoration: underline;
      text-underline-offset: 2px;
      cursor: pointer;
      border-radius: 2px;
      padding: 0 1px;
    }
    .cm-link-widget:hover { opacity: .75; }

    /* Math widgets */
    .cm-math-mq { cursor: pointer; padding: 0 2px; }
    .cm-math-inline {
      display:inline-block; vertical-align:middle;
      color:var(--text); cursor:pointer;
      padding: 0 2px;
    }
    .cm-math-inline:hover { background: rgba(56,139,253,.1); border-radius:3px; }
    .cm-math-block {
      display:block; text-align:center; margin:0.5em 0;
      overflow-x:auto; color:var(--text); padding:4px 0;
      cursor:pointer;
    }
    .cm-math-block:hover { background: rgba(56,139,253,.06); border-radius:4px; }

    /* ── Table widget in live view ── */
    .cm-table-outer { padding: 5px 0 7px; }
    .cm-table-wrap {
      overflow-x: auto; border-radius: 6px;
      border: 1px solid var(--border);
    }
    .cm-table-wrap table.nb-table {
      border-collapse: collapse; width: auto; min-width: 100%; font-size: .92em;
    }
    .cm-table-wrap table.nb-table th,
    .cm-table-wrap table.nb-table td {
      border-right: 1px solid var(--borderSubtle);
      border-bottom: 1px solid var(--borderSubtle);
      padding: 5px 10px; text-align: left;
      white-space: nowrap; min-width: 80px;
    }
    .cm-table-wrap table.nb-table th:last-child,
    .cm-table-wrap table.nb-table td:last-child { border-right: none; }
    .cm-table-wrap table.nb-table tr:last-child td { border-bottom: none; }
    .cm-table-wrap table.nb-table th {
      background: var(--surfaceAlt); font-weight: 600; font-size: .85em;
      text-transform: uppercase; letter-spacing: .04em; color: var(--textDim);
      border-bottom: 1px solid var(--border);
    }
    .cm-table-wrap table.nb-table tbody tr:hover td {
      background: color-mix(in srgb, var(--surfaceAlt) 60%, transparent);
    }
    .cm-table-wrap td, .cm-table-wrap th { cursor: text; }
    .cm-table-wrap td:focus, .cm-table-wrap th:focus {
      outline: 2px solid var(--accent); outline-offset: -2px;
      background: color-mix(in srgb, var(--accent) 8%, transparent) !important;
      white-space: pre-wrap;
    }

    /* ── /todo block widget ── */
    .cm-todo-block-w {
      margin: 0.6em 0; border-radius: 10px; overflow: hidden;
      border: 1px solid var(--border); background: var(--surface);
    }
    .cm-todo-hdr-w {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 12px 6px;
    }
    .cm-todo-title {
      font-size: 13px; font-weight: 600; color: var(--text); cursor: pointer;
      padding: 1px 3px; border-radius: 3px; transition: background .1s;
      font-family: 'Satoshi', 'Author', sans-serif;
    }
    .cm-todo-title:hover { background: rgba(128,128,128,.08); }
    .cm-todo-title-inp {
      background: none; border: none; outline: none; font-size: 13px;
      font-weight: 600; color: var(--text); font-family: inherit; width: 100%;
    }
    .cm-todo-hdr-right { display: flex; align-items: center; gap: 6px; }
    .cm-todo-count {
      font-size: 10px; font-weight: 600; color: var(--textDim);
      opacity: .7;
    }
    .cm-todo-progress {
      height: 2px; background: var(--borderSubtle); overflow: hidden;
    }
    .cm-todo-progress-fill {
      height: 100%; background: var(--accent); border-radius: 0 1px 1px 0;
      transition: width .3s ease;
    }
    .cm-todo-progress-done { background: #3fb950; }
    .cm-todo-row {
      display: flex; align-items: center; gap: 8px; padding: 5px 12px;
      transition: background .08s; position: relative;
    }
    .cm-todo-row:hover { background: rgba(128,128,128,.04); }
    .cm-todo-cb {
      width: 16px; height: 16px; border-radius: 4px; flex-shrink: 0;
      border: 1.5px solid var(--border); cursor: pointer; display: flex;
      align-items: center; justify-content: center;
      transition: background .15s, border-color .15s;
    }
    .cm-todo-cb:hover { border-color: var(--accent); }
    .cm-todo-cb-on {
      background: var(--accent); border-color: var(--accent);
    }
    .cm-todo-text-wrap { flex: 1; min-width: 0; }
    .cm-todo-row-text {
      font-size: 13px; color: var(--text); line-height: 1.5; cursor: default;
    }
    .cm-todo-row-done .cm-todo-row-text { text-decoration: line-through; opacity: .35; color: var(--textDim); }
    .cm-todo-edit-inp {
      background: none; border: none; outline: none; font-size: 13px;
      color: var(--text); font-family: inherit; width: 100%;
    }
    .cm-todo-meta { display: flex; gap: 4px; align-items: center; margin-top: 2px; }
    .cm-todo-date, .cm-todo-time {
      font-size: 9.5px; color: var(--textDim); opacity: .7;
    }
    .cm-todo-actions {
      display: flex; gap: 2px; flex-shrink: 0; align-items: center;
      opacity: 0; transition: opacity .12s;
    }
    .cm-todo-row:hover .cm-todo-actions { opacity: 1; }
    .cm-todo-row:has(.cm-todo-date-btn-set) .cm-todo-actions { opacity: 1; }
    .cm-todo-date-btn {
      background: none; border: none; color: var(--textDim); cursor: pointer;
      padding: 0 2px; border-radius: 3px; line-height: 1; display: flex; align-items: center;
      transition: color .1s; opacity: .5;
    }
    .cm-todo-date-btn:hover { color: var(--accent); opacity: 1; }
    .cm-todo-date-btn.cm-todo-date-btn-set { color: var(--accent); opacity: 0.8; }
    .cm-todo-del-btn {
      background: none; border: none; color: var(--textDim); cursor: pointer;
      font-size: 15px; line-height: 1; padding: 0 2px; border-radius: 3px;
      transition: color .1s;
    }
    .cm-todo-del-btn:hover { color: #f85149; }
    .cm-todo-add-row {
      display: flex; align-items: center; gap: 6px;
      padding: 5px 12px 7px;
    }
    .cm-todo-add-btn {
      width: 22px; height: 22px; border-radius: 5px; flex-shrink: 0;
      background: none; border: 1.5px solid var(--border); color: var(--textDim); cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: border-color .12s, color .12s;
    }
    .cm-todo-add-btn:hover { border-color: var(--accent); color: var(--accent); }
    .cm-todo-add-input {
      flex: 1; background: none; border: none; outline: none;
      font-size: 12px; color: var(--text); padding: 2px 0;
      font-family: inherit;
    }
    .cm-todo-add-input::placeholder { color: var(--textDim); opacity: .4; }
    .cm-todo-empty {
      padding: 10px 12px; text-align: center; font-size: 11px;
      color: var(--textDim); opacity: .5;
    }

    /* ── /task board widget (kanban) ── */
    .cm-task-board-w {
      margin: 0.6em 0;
    }
    .cm-task-titlebar {
      display: flex; align-items: center; padding: 10px 14px 6px;
    }
    .cm-task-title-w {
      font-size: 13px; font-weight: 600; color: var(--text);
      font-family: 'Erode', Georgia, serif; letter-spacing: -0.1px;
    }
    .cm-task-cols-w {
      display: flex; gap: 6px; padding: 0 8px 10px;
      align-items: flex-start; overflow: hidden;
    }
    .cm-task-col-w {
      flex: 1; min-width: 0; display: flex; flex-direction: column;
      border-radius: 6px; transition: background .15s;
      overflow: hidden; border: 1px solid var(--borderSubtle);
    }
    .cm-task-col-drop { outline: 2px dashed var(--accent); outline-offset: -2px; }
    .cm-task-col-hdr-w {
      display: flex; align-items: center; justify-content: space-between;
      padding: 6px 8px 5px; position: relative;
      font-size: 10px; font-weight: 600; text-transform: uppercase;
      letter-spacing: .05em; color: var(--text);
      font-family: 'Author', system-ui, sans-serif;
      border-bottom: 1px solid var(--borderSubtle);
    }
    .cm-task-col-title { cursor: pointer; }
    .cm-task-col-title:hover { opacity: .7; }
    .cm-task-col-title-inp {
      background: none; border: none; outline: none; font-size: 10px;
      font-weight: 600; text-transform: uppercase; letter-spacing: .05em;
      color: var(--text); font-family: inherit; width: 100%;
    }
    .cm-task-col-hdr-right {
      display: flex; align-items: center; gap: 4px;
    }
    .cm-task-col-w-badge {
      font-size: 9px; background: rgba(128,128,128,.12); color: var(--textDim);
      border-radius: 8px; padding: 1px 6px; font-weight: 500;
    }
    .cm-task-col-del {
      background: none; border: none; color: var(--textDim); cursor: pointer;
      font-size: 14px; line-height: 1; padding: 0 2px; opacity: 0;
      transition: opacity .1s;
    }
    .cm-task-col-hdr-w:hover .cm-task-col-del { opacity: .6; }
    .cm-task-col-del:hover { color: #f85149 !important; opacity: 1 !important; }
    .cm-task-cards-area { padding: 4px 5px 2px; }
    .cm-task-card-w {
      background: var(--surface); border-radius: 7px; margin-bottom: 5px;
      border: 1px solid var(--border);
      font-size: 12px; color: var(--text); transition: box-shadow .12s, opacity .15s;
      cursor: grab; user-select: none;
      font-family: 'Author', system-ui, sans-serif;
      box-shadow: 0 1px 3px rgba(0,0,0,.06);
    }
    .cm-task-card-w:hover { box-shadow: 0 2px 8px rgba(0,0,0,.12); }
    .cm-task-card-dragging { opacity: .35; cursor: grabbing; }
    .cm-task-card-body {
      display: flex; align-items: center; gap: 6px; padding: 8px 10px;
    }
    .cm-task-card-text { flex: 1; min-width: 0; line-height: 1.45; font-size: 12px; }
    .cm-task-card-edit {
      background: var(--bg); border: 1px solid var(--accent); outline: none;
      border-radius: 4px; padding: 1px 4px; font-size: 12px;
      color: var(--text); font-family: inherit; width: 100%;
    }
    .cm-task-card-del-btn {
      background: none; border: none; color: var(--textDim); cursor: pointer;
      font-size: 14px; padding: 0 2px; border-radius: 4px; opacity: 0;
      transition: opacity .1s; line-height: 1; flex-shrink: 0;
    }
    .cm-task-card-w:hover .cm-task-card-del-btn { opacity: 0.5; }
    .cm-task-card-del-btn:hover { opacity: 1 !important; color: #f85149; }
    .cm-task-card-date-row {
      display: flex; align-items: center; gap: 4px;
      padding: 0 10px 6px;
    }
    .cm-task-card-date-badge {
      font-size: 10px; color: var(--accent); cursor: pointer;
      background: rgba(var(--accentRgb, 99,102,241),.1);
      border-radius: 4px; padding: 1px 6px; font-family: 'Author', system-ui, sans-serif;
    }
    .cm-task-card-date-badge:hover { opacity: .8; }
    .cm-task-card-date-clear {
      background: none; border: none; color: var(--textDim); cursor: pointer;
      font-size: 12px; padding: 0 2px; opacity: 0; line-height: 1;
      transition: opacity .1s;
    }
    .cm-task-card-w:hover .cm-task-card-date-clear { opacity: 0.5; }
    .cm-task-card-date-clear:hover { opacity: 1 !important; color: #f85149; }
    .cm-task-card-add-date {
      background: none; border: none; color: var(--textDim); cursor: pointer;
      font-size: 10px; padding: 0; opacity: 0; transition: opacity .1s;
      font-family: 'Author', system-ui, sans-serif;
    }
    .cm-task-card-w:hover .cm-task-card-add-date { opacity: 0.45; }
    .cm-task-card-add-date:hover { opacity: 1 !important; color: var(--accent); }
    .cm-task-date-picker {
      position: fixed; z-index: 99999;
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 10px; padding: 10px; min-width: 210px;
      box-shadow: 0 8px 24px rgba(0,0,0,.2);
    }
    .cm-task-date-hdr { min-height: unset !important; padding: 4px 0 !important; }
    .cm-task-date-blank { background: var(--surface); height: 28px; }
    .cm-task-date-cell {
      text-align: center; height: 28px; line-height: 28px; font-size: 11px;
      color: var(--text); cursor: pointer; border-radius: 0;
      transition: background .1s; background: var(--surface);
      font-family: 'Satoshi', 'Author', sans-serif;
    }
    .cm-task-date-cell:hover { background: var(--surfaceAlt); }
    .cm-task-date-today { color: var(--accent); font-weight: 700; }
    .cm-task-date-selected { background: rgba(56,139,253,.15) !important; color: var(--accent); font-weight: 600; }
    .cm-task-add-row { padding: 3px 5px 6px; }
    .cm-task-add-input {
      width: 100%; background: transparent; border: 1px dashed var(--borderSubtle);
      border-radius: 5px; outline: none; font-size: 11px; color: var(--text);
      padding: 5px 8px; font-family: 'Author', system-ui, sans-serif; box-sizing: border-box;
      transition: border-color .15s, background .15s;
    }
    .cm-task-add-input:focus { border-color: var(--accent); border-style: solid; background: var(--bg); }
    .cm-task-add-input::placeholder { color: var(--textDim); opacity: .4; }
    .cm-task-add-col {
      min-width: 36px; max-width: 36px; display: flex; align-items: flex-start;
      justify-content: center; padding-top: 6px; flex-shrink: 0;
      position: relative;
    }
    .cm-task-add-col-btn {
      background: transparent; border: 1px dashed var(--borderSubtle); border-radius: 6px;
      color: var(--textDim); font-size: 16px; cursor: pointer; padding: 6px 0;
      transition: color .1s, background .1s, border-color .1s; width: 100%;
    }
    .cm-task-add-col-btn:hover { color: var(--text); background: var(--surfaceAlt); border-color: var(--border); }
    .cm-task-add-col-input {
      width: 140px; background: var(--surface); border: 1px solid var(--accent);
      border-radius: 8px; outline: none; font-size: 12px; color: var(--text);
      padding: 8px 10px; font-family: inherit; box-sizing: border-box;
      position: absolute; right: 0; top: 8px; z-index: 10;
    }

    /* ── Date/time picker popup ── */
    .gnos-dtp {
      position: fixed; z-index: 99999;
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 12px; padding: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,.22), 0 2px 8px rgba(0,0,0,.12);
      font-family: 'Author', system-ui, sans-serif; font-size: 13px;
      color: var(--text); min-width: 240px; user-select: none;
    }
    .gnos-dtp-nav {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 8px;
    }
    .gnos-dtp-nav-btn {
      background: none; border: none; color: var(--textDim); cursor: pointer;
      font-size: 18px; padding: 2px 8px; border-radius: 6px;
      transition: background .1s, color .1s; line-height: 1;
    }
    .gnos-dtp-nav-btn:hover { background: var(--surfaceAlt); color: var(--text); }
    .gnos-dtp-month-label { font-size: 13px; font-weight: 600; color: var(--text); }
    .gnos-dtp-grid {
      display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px;
      margin-bottom: 10px;
    }
    .gnos-dtp-wday {
      text-align: center; font-size: 10px; font-weight: 600;
      color: var(--textDim); padding: 2px 0; letter-spacing: .04em;
    }
    .gnos-dtp-day {
      text-align: center; padding: 5px 2px; border-radius: 6px;
      cursor: pointer; font-size: 12px; color: var(--text);
      transition: background .1s, color .1s;
    }
    .gnos-dtp-day:not(.gnos-dtp-empty):hover { background: var(--surfaceAlt); }
    .gnos-dtp-empty { cursor: default; }
    .gnos-dtp-today { color: var(--accent); font-weight: 700; }
    .gnos-dtp-selected {
      background: var(--accent) !important; color: #fff !important;
      font-weight: 600; border-radius: 6px;
    }
    .gnos-dtp-time-row {
      display: flex; align-items: center; gap: 8px;
      border-top: 1px solid var(--border); padding-top: 8px; margin-bottom: 8px;
    }
    .gnos-dtp-time-label { font-size: 12px; color: var(--textDim); min-width: 32px; }
    .gnos-dtp-time-inp {
      flex: 1; background: var(--bg); border: 1px solid var(--border);
      border-radius: 6px; color: var(--text); font-size: 12px;
      padding: 5px 8px; outline: none; font-family: inherit;
    }
    .gnos-dtp-time-inp:focus { border-color: var(--accent); }
    .gnos-dtp-actions {
      display: flex; justify-content: space-between; gap: 6px;
      border-top: 1px solid var(--border); padding-top: 8px;
    }
    .gnos-dtp-clear {
      background: none; border: 1px solid var(--border); border-radius: 7px;
      color: var(--textDim); font-size: 12px; cursor: pointer; padding: 5px 14px;
      font-family: inherit; transition: background .1s, color .1s;
    }
    .gnos-dtp-clear:hover { background: var(--surfaceAlt); color: var(--text); }
    .gnos-dtp-done {
      background: var(--accent); border: none; border-radius: 7px;
      color: #fff; font-size: 12px; font-weight: 600; cursor: pointer;
      padding: 5px 18px; font-family: inherit; transition: opacity .1s;
    }
    .gnos-dtp-done:hover { opacity: .85; }

    /* ── Timer widget ── */
    .cm-timer-widget {
      margin: 0.6em 0; padding: 10px 14px; border-radius: 10px;
      border: 1px solid var(--border); background: var(--surface);
      display: flex; flex-direction: column; gap: 4px; max-width: 320px;
    }
    .cm-timer-label { font-size: 11px; font-weight: 600; color: var(--textDim); letter-spacing: .03em; }
    .cm-timer-row { display: flex; align-items: center; gap: 8px; }
    .cm-timer-time {
      font-size: 22px; font-weight: 700; color: var(--text);
      font-variant-numeric: tabular-nums; cursor: pointer; flex: 1;
    }
    .cm-timer-time.cm-timer-done { color: var(--accent); }
    .cm-timer-btn {
      background: none; border: 1px solid var(--border); border-radius: 6px;
      color: var(--text); cursor: pointer; width: 30px; height: 30px;
      display: flex; align-items: center; justify-content: center;
      font-size: 14px; transition: background .1s;
    }
    .cm-timer-btn:hover { background: var(--surfaceAlt); }
    .cm-timer-start { width: auto; padding: 0 14px; font-size: 12px; font-weight: 600; }
    .cm-timer-bar {
      height: 4px; border-radius: 2px; background: var(--border); overflow: hidden; margin-top: 2px;
    }
    .cm-timer-fill {
      height: 100%; border-radius: 2px; background: var(--accent);
      transition: width 1s linear;
    }
    .cm-timer-setup { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .cm-timer-input {
      background: none; border: 1px solid var(--border); border-radius: 6px;
      color: var(--text); font-size: 13px; padding: 6px 10px; outline: none;
      font-family: inherit; width: 90px;
    }
    .cm-timer-label-inp { width: 140px; }
    .cm-timer-input:focus { border-color: var(--accent); }
    .cm-timer-edit-input {
      background: none; border: none; outline: none;
      font-size: 22px; font-weight: 700; color: var(--text);
      font-variant-numeric: tabular-nums; width: 120px; font-family: inherit;
    }

    .cm-timer-time-editable { cursor: text; opacity: 0.5; }
    .cm-timer-time-editable:hover { opacity: 0.8; }

    /* ── Pomodoro widget ── */
    .cm-pomo-widget {
      margin: 0.6em 0; padding: 14px 16px; border-radius: 12px;
      border: 1px solid var(--border); background: var(--surface);
      display: flex; flex-direction: column; gap: 8px; max-width: 340px;
    }
    .cm-pomo-hdr {
      display: flex; align-items: center; justify-content: space-between;
    }
    .cm-pomo-title {
      font-size: 13px; font-weight: 700; color: var(--text);
      font-family: 'Satoshi', 'Author', sans-serif;
    }
    .cm-pomo-sessions {
      font-size: 10px; font-weight: 600; color: var(--textDim);
      background: var(--surfaceAlt); border: 1px solid var(--borderSubtle);
      border-radius: 4px; padding: 2px 6px;
    }
    .cm-pomo-phase-row { display: flex; gap: 4px; }
    .cm-pomo-phase-btn {
      flex: 1; padding: 4px 0; border-radius: 6px; border: 1px solid var(--borderSubtle);
      background: none; color: var(--textDim); cursor: pointer;
      font-size: 11px; font-weight: 600; font-family: inherit;
      transition: all 0.12s;
    }
    .cm-pomo-phase-btn:hover { background: var(--surfaceAlt); color: var(--text); }
    .cm-pomo-phase-btn.active {
      background: var(--accent); color: #fff; border-color: var(--accent);
    }
    .cm-pomo-time {
      font-size: 36px; font-weight: 700; color: var(--text);
      font-variant-numeric: tabular-nums; text-align: center;
      letter-spacing: 2px; padding: 4px 0;
    }
    .cm-pomo-bar {
      height: 4px; border-radius: 2px; background: var(--borderSubtle); overflow: hidden;
    }
    .cm-pomo-fill {
      height: 100%; border-radius: 2px; transition: width 1s linear;
    }
    .cm-pomo-fill-work { background: var(--accent); }
    .cm-pomo-fill-break { background: #3fb950; }
    .cm-pomo-controls { display: flex; gap: 6px; justify-content: center; }
    .cm-pomo-btn {
      background: none; border: 1px solid var(--border); border-radius: 8px;
      color: var(--text); cursor: pointer; width: 36px; height: 36px;
      display: flex; align-items: center; justify-content: center;
      font-size: 16px; transition: background .1s;
    }
    .cm-pomo-btn:hover { background: var(--surfaceAlt); }
    .cm-pomo-play { width: 48px; }
    .cm-pomo-prev {
      display: flex; align-items: center; gap: 8px; padding: 10px 14px;
      border-radius: 10px; border: 1px solid var(--border); background: var(--surface);
      margin: 0.6em 0; max-width: 320px;
    }
    .cm-pomo-prev-icon { font-size: 18px; }
    .cm-pomo-prev-text { font-size: 13px; font-weight: 600; color: var(--text); }
    .cm-pomo-prev-sub { font-size: 10px; color: var(--textDim); margin-left: auto; }

    /* ── Calendar widget ── */
    .cm-calendar-widget {
      margin: 0.6em 0; border-radius: 10px; border: 1px solid var(--border);
      background: var(--surface); padding: 12px; width: 100%; box-sizing: border-box;
    }

    /* ── Calendar topbar & mode toggle ── */
    .cm-cal-topbar {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 6px;
    }
    .cm-cal-main-title {
      font-size: 13px; font-weight: 600; color: var(--text); cursor: pointer;
      padding: 2px 4px; border-radius: 3px; transition: background .1s;
      font-family: 'Satoshi', 'Author', sans-serif;
    }
    .cm-cal-main-title:hover { background: rgba(128,128,128,.08); }
    .cm-cal-title-input {
      background: none; border: none; outline: none;
      font-size: 13px; font-weight: 600; color: var(--text);
      font-family: inherit; width: 100%;
    }
    .cm-cal-mode-bar {
      display: flex; gap: 1px; background: var(--borderSubtle); border-radius: 5px; padding: 1px;
    }
    .cm-cal-mode-btn {
      background: none; border: none; color: var(--textDim); cursor: pointer;
      font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 4px;
      transition: background .1s, color .1s;
    }
    .cm-cal-mode-btn:hover { color: var(--text); }
    .cm-cal-mode-active { background: var(--surface); color: var(--text); }

    /* ── Calendar nav ── */
    .cm-cal-header {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 8px;
    }
    .cm-cal-nav {
      background: none; border: none; border-radius: 4px;
      color: var(--textDim); cursor: pointer; width: 24px; height: 24px;
      display: flex; align-items: center; justify-content: center; font-size: 16px;
      transition: background .1s, color .1s;
    }
    .cm-cal-nav:hover { background: var(--surfaceAlt); color: var(--text); }
    .cm-cal-month {
      font-size: 12px; font-weight: 600; color: var(--text);
      font-family: 'Satoshi', 'Author', sans-serif;
    }

    /* ── Calendar month grid ── */
    .cm-cal-grid {
      display: grid; grid-template-columns: repeat(7, 1fr); gap: 1px;
      background: var(--borderSubtle); border-radius: 6px; overflow: hidden;
      border: 1px solid var(--borderSubtle);
    }
    .cm-cal-day-hdr {
      font-size: 9px; font-weight: 700; color: var(--textDim); text-align: center;
      padding: 5px 0; text-transform: uppercase; letter-spacing: .08em;
      background: var(--surface);
    }
    .cm-cal-blank { min-height: 72px; background: var(--surface); }
    .cm-cal-day {
      text-align: left; padding: 4px 5px; font-size: 11px;
      color: var(--text); cursor: pointer; transition: background .1s;
      position: relative; min-height: 72px; background: var(--surface);
    }
    .cm-cal-day:hover { background: var(--surfaceAlt); }
    .cm-cal-today { color: var(--accent); }
    .cm-cal-today > span:first-child {
      background: var(--accent); color: #fff; border-radius: 50%; width: 20px; height: 20px;
      display: inline-flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700;
    }
    .cm-cal-selected { background: rgba(56,139,253,0.06) !important; }
    .cm-cal-has-event::after {
      content: ''; position: absolute; top: 5px; right: 5px;
      width: 4px; height: 4px; border-radius: 50%; background: var(--accent);
    }

    /* ── Month view day event labels ── */
    .cm-cal-day-evt {
      font-size: 9px; color: var(--text); white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis; margin-top: 2px; line-height: 1.2;
      background: rgba(56,139,253,.08); border-radius: 2px; padding: 1px 3px;
      border-left: 2px solid var(--accent);
    }

    /* ── Calendar event panel (month view selected day) ── */
    .cm-cal-event-panel {
      margin-top: 8px; padding: 8px 10px; background: var(--surfaceAlt);
      border-radius: 6px; max-height: 400px; overflow-y: auto;
    }
    .cm-cal-event-panel-hdr {
      font-size: 11px; font-weight: 600; color: var(--text); margin-bottom: 4px;
      font-family: 'Satoshi', 'Author', sans-serif;
    }

    /* ── Calendar event rows (shared across views) ── */
    .cm-cal-evt-row {
      display: flex; align-items: center; gap: 5px; padding: 2px 4px;
      border-radius: 3px; transition: background .1s;
    }
    .cm-cal-evt-row:hover { background: rgba(128,128,128,.06); }
    .cm-cal-evt-row:hover .cm-todo-del { opacity: 1; }
    .cm-cal-evt-dot {
      width: 5px; height: 5px; border-radius: 50%; background: var(--accent); flex-shrink: 0;
    }
    .cm-cal-evt-text { font-size: 11px; color: var(--text); flex: 1; min-width: 0; }
    .cm-cal-evt-add {
      width: 100%; background: none; border: none; border-bottom: 1px solid var(--borderSubtle);
      padding: 4px 2px; font-size: 11px; color: var(--text); font-family: inherit;
      outline: none; margin-top: 3px; transition: border-color .15s;
    }
    .cm-cal-evt-add:focus { border-color: var(--accent); }
    .cm-cal-evt-add::placeholder { color: var(--textDim); opacity: .4; }

    /* ── 24-hour time grid (shared by day/week/expanded month) ── */
    .cm-cal-time-grid {
      max-height: 360px; overflow-y: auto;
    }
    .cm-cal-time-row {
      display: flex; min-height: 28px; border-bottom: 1px solid var(--borderSubtle);
    }
    .cm-cal-time-label {
      width: 48px; flex-shrink: 0; font-size: 9px; color: var(--textDim);
      text-align: right; padding: 2px 6px 0 0; font-weight: 500;
      font-family: 'Author', system-ui, sans-serif;
    }
    .cm-cal-time-slot {
      flex: 1; min-height: 28px; cursor: pointer; padding: 1px 4px;
      transition: background .1s; position: relative;
    }
    .cm-cal-time-slot:hover { background: rgba(56,139,253,.04); }
    .cm-cal-time-evt {
      font-size: 10px; color: var(--text); background: rgba(56,139,253,.1);
      border-left: 2px solid var(--accent); border-radius: 2px;
      padding: 1px 6px; margin: 1px 0; display: flex; align-items: center; gap: 4px;
    }
    .cm-cal-time-evt .cm-todo-del { margin-left: auto; }
    .cm-cal-time-add {
      width: 100%; background: none; border: none; border-bottom: 1px solid var(--accent);
      padding: 2px 2px; font-size: 10px; color: var(--text); font-family: inherit;
      outline: none;
    }
    .cm-cal-time-add::placeholder { color: var(--textDim); opacity: .4; }

    /* ── Week view (time-grid version) ── */
    .cm-cal-week-hdr-row {
      display: flex; border-bottom: 1px solid var(--border);
    }
    .cm-cal-week-time-gutter {
      width: 48px; flex-shrink: 0;
    }
    .cm-cal-week-col-hdr {
      flex: 1; text-align: center; font-size: 9px; font-weight: 600;
      color: var(--textDim); text-transform: uppercase; letter-spacing: .05em;
      padding: 4px 0; font-family: 'Author', system-ui, sans-serif;
    }
    .cm-cal-week-col-hdr.cm-cal-week-today { color: var(--accent); }
    .cm-cal-week-body {
      max-height: 360px; overflow-y: auto;
    }
    .cm-cal-week-time-row {
      display: flex; min-height: 28px; border-bottom: 1px solid var(--borderSubtle);
    }
    .cm-cal-week-cell {
      flex: 1; min-height: 28px; cursor: pointer; padding: 1px 2px;
      border-left: 1px solid var(--borderSubtle);
      transition: background .1s; position: relative;
    }
    .cm-cal-week-cell:hover { background: rgba(56,139,253,.04); }

    /* ── Day view ── */
    .cm-cal-day-panel {
      background: var(--surfaceAlt); border-radius: 6px; padding: 4px 0;
    }

    /* ── Wiki dropdown rendered by React (positioned fixed) ── */

    /* ── Live list items ── */
    .nb-live .cm-lv-li { position: relative; }
    .cm-list-marker {
      display: inline-block; color: var(--textDim); min-width: 0.7em; margin-right: 0;
    }
    .cm-list-marker-ord { font-weight: 600; color: var(--text); opacity: 0.6; }

    /* ══════════════════════════════════════════════════════
       PREVIEW — identical typography to live
    ══════════════════════════════════════════════════════ */
    .nb-prev {
      flex: 1; overflow: auto;
      padding: var(--nb-py) var(--nb-px);
      font-size: var(--nb-fs);
      line-height: var(--nb-lh);
      font-family: var(--nb-ff);
      color: var(--nb-color);
      max-width: var(--nb-max); margin: 0 auto; width: 100%;
      box-sizing: border-box;
    }
    /* Headings — match live exactly */
    .nb-prev h1 { font-size:var(--nb-h1); font-weight:600; margin:1.15em 0 .45em; font-family:'Erode',Georgia,serif; color:var(--nb-h1-color); line-height:1.25; letter-spacing:-0.3px; }
    .nb-prev h2 { font-size:var(--nb-h2); font-weight:600; margin:1.1em 0 .4em;  font-family:'Erode',Georgia,serif; color:var(--nb-h2-color); line-height:1.3; letter-spacing:-0.2px; }
    .nb-prev h3 { font-size:var(--nb-h3); font-weight:600; margin:1em 0 .35em;   font-family:'Satoshi','Author',sans-serif; color:var(--nb-h3-color); line-height:1.4; }
    .nb-prev h4 { font-size:var(--nb-h4); font-weight:600; margin:.9em 0 .3em;   font-family:'Satoshi','Author',sans-serif; color:var(--nb-h4-color); }
    .nb-prev h5 { font-size:var(--nb-h5); font-weight:600; margin:.85em 0 .25em; font-family:'Satoshi','Author',sans-serif; color:var(--nb-h5-color); }
    .nb-prev h6 { font-size:var(--nb-h6); font-weight:600; margin:.8em 0 .25em;  font-family:'Satoshi','Author',sans-serif; color:var(--nb-h6-color); opacity:.65; }
    .nb-prev p  { margin: 0 0 var(--nb-para-gap); }
    .nb-prev blockquote {
      border-left: 3px solid var(--nb-quote-border); margin: .8em 0; padding: 8px 14px;
      color: var(--nb-quote-color); border-radius: 0 4px 4px 0;
      background: var(--nb-quote-bg); font-style: italic;
    }
    .nb-prev pre.nb-pre { background:var(--surfaceAlt); border:1px solid var(--border); border-radius:8px; padding:14px 16px; overflow-x:auto; margin:.8em 0; }
    .nb-prev code { font-family:SF Mono,Menlo,Consolas,monospace; font-size:.87em; }
    .nb-ic { background:var(--nb-code-bg); border-radius:4px; padding:1px 5px; font-family:SF Mono,Menlo,Consolas,monospace; font-size:.87em; color:var(--nb-code-color); }
    .nb-prev table.nb-table { border-collapse:collapse; width:100%; margin:.8em 0; font-size:.93em; }
    .nb-prev table.nb-table th,.nb-prev table.nb-table td { border:1px solid var(--border); padding:6px 10px; }
    .nb-prev table.nb-table th { background:var(--surfaceAlt); font-weight:600; }
    .nb-prev ul,.nb-prev ol { margin:0 0 .75em; padding-left:1.6em; list-style-position: outside; }
    .nb-prev li { margin-bottom:.25em; }
    .nb-prev ul ul,.nb-prev ol ol,.nb-prev ul ol,.nb-prev ol ul { margin:.2em 0; padding-left:1.4em; }
    .nb-prev ul.nb-tl { list-style:none; padding-left:.4em; }
    .nb-prev li.nb-task { display:flex; gap:8px; align-items:baseline; cursor:pointer; }
    .nb-prev li.nb-task:hover { opacity:.85; }
    .nb-prev .nb-cb { display:inline-flex; align-items:center; justify-content:center; width:14px; height:14px; border:1.5px solid var(--border); border-radius:3px; font-size:10px; flex-shrink:0; cursor:pointer; user-select:none; transition:background .1s,border-color .1s; }
    .nb-prev li.checked .nb-cb { background:var(--accent); border-color:var(--accent); color:#fff; }
    .nb-prev li.checked>span:last-child { text-decoration:line-through; opacity:.55; }
    .nb-hl { background:var(--nb-hl-bg); border-radius:2px; padding:0 2px; }
    /* Inline text formats — match live */
    .nb-bold   { font-weight:700; color:var(--nb-bold-color); }
    .nb-italic { font-style:italic; color:var(--nb-italic-color); }
    .nb-strike { text-decoration:line-through; color:var(--nb-strike-color); opacity:.75; }
    .nb-sup    { font-size:.75em; vertical-align:super; color:var(--nb-link-color); }
    .nb-sub    { font-size:.75em; vertical-align:sub;   color:var(--nb-link-color); }
    .wikilink     { border-bottom:1px solid var(--nb-wikilink-color); cursor:pointer; color:var(--nb-wikilink-color); }
    .wikilink:hover { opacity:.8; }
    .wikilink-new { color:var(--textDim); border-bottom-color:var(--textDim); }
    /* Images in preview */
    .nb-img {
      max-width:100%; max-height:500px; border-radius:6px;
      margin:.75em 0; display:block; object-fit:contain;
      box-shadow:0 2px 12px rgba(0,0,0,.2);
    }
    .nb-img[src=""],
    .nb-img:not([src]) { display: none; }
    .nb-prev a { color:var(--nb-link-color); text-decoration:underline; }
    .nb-prev hr { border:none; border-top:1px solid var(--border); margin:1.2em 0; }
    /* MathQuill static display in preview */
    .nb-math { display:inline-block; }
    .nb-math-block { display:block; text-align:center; margin:1em 0; overflow-x:auto; }
    .nb-math-mq .mq-root-block { color: var(--text) !important; }
    /* Preview-mode calendar block */
    .cm-cal-prev-block { border: 1px solid var(--borderSubtle); border-radius: 8px; overflow: hidden; margin: .6em 0; }
    .cm-cal-prev-title { font-size: 11px; font-weight: 600; padding: 6px 10px; background: var(--surface); color: var(--text); border-bottom: 1px solid var(--borderSubtle); font-family: 'Erode',Georgia,serif; }
    .cm-cal-prev-day { display: flex; align-items: baseline; gap: 8px; padding: 4px 10px; border-bottom: 1px solid var(--borderSubtle); flex-wrap: wrap; }
    .cm-cal-prev-day:last-child { border-bottom: none; }
    .cm-cal-prev-date { font-size: 10px; font-weight: 600; color: var(--textDim); min-width: 80px; font-family: 'Author',system-ui,sans-serif; }
    .cm-cal-prev-evt { font-size: 11px; color: var(--text); background: rgba(56,139,253,.08); border-left: 2px solid var(--accent); border-radius: 2px; padding: 1px 6px; }
    /* Preview-mode timer block */
    .cm-timer-prev { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border: 1px solid var(--borderSubtle); border-radius: 8px; margin: .4em 0; background: var(--surfaceAlt); }
    .cm-timer-prev-time { font-size: 18px; font-weight: 600; color: var(--text); font-family: 'Satoshi','Author',sans-serif; font-variant-numeric: tabular-nums; }
    .cm-timer-prev-label { font-size: 11px; color: var(--textDim); }
    .nb-fn-ref sup { font-size:.75em; }
    .nb-fn-ref a { color:var(--accent); text-decoration:none; }
    .nb-fn-def { font-size:12px; color:var(--textDim); padding:4px 0; border-top:1px solid var(--borderSubtle); margin-top:8px; }
    .nb-fn-back { color:var(--accent); text-decoration:none; margin-left:4px; }
    .nb-fns { margin-top:2em; }
    /* Definition lists */
    .nb-dl { margin: 0 0 .75em; padding: 0; }
    .nb-dt { font-weight: 600; color: var(--text); margin-top: .6em; font-family: 'Satoshi','Author',sans-serif; letter-spacing: .01em; }
    .nb-dd { margin-left: 1.6em; color: var(--textDim); margin-bottom: .25em; padding-left: .4em; border-left: 2px solid var(--borderSubtle); }
    /* Live view definition list line classes */
    .nb-live .cm-lv-dt { font-weight: 600; color: var(--text); font-family: 'Satoshi','Author',sans-serif; margin-top: .5em; }
    .nb-live .cm-lv-dd { padding-left: 1.6em; color: var(--textDim); border-left: 2px solid var(--borderSubtle); }
    .nb-live .cm-lv-fn-def { font-size: .88em; color: var(--textDim); border-top: 1px solid var(--borderSubtle); padding-top: 2px; }
    /* Footnote ref widget in live mode */
    .cm-fn-ref-widget {
      font-size: .72em; vertical-align: super; color: var(--accent);
      background: rgba(56,139,253,.08); border-radius: 3px;
      padding: 0 3px; cursor: default; font-weight: 600;
      font-family: 'Author', system-ui, sans-serif;
    }
    mark.nb-fhl { background:rgba(210,153,34,.4); border-radius:2px; padding:0 1px; }
    /* ── Ghost hint ─────────────────────────────────────── */
    .cm-ghost-hint {
      color: var(--textDim);
      opacity: 0.35;
      font-style: italic;
      pointer-events: none;
      user-select: none;
    }
    /* ── Uniform number styling ──────────────────────────── */
    .cm-nb-num {
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      letter-spacing: 0.015em;
    }
    /* ── Math variable names ─────────────────────────────── */
    .cm-math-var {
      color: #e8a87c;
      font-weight: 500;
    }
    .cm-math-var-live {
      color: #f0a060;
    }
    .cm-math-colon {
      color: #e8a87c;
      opacity: 0.45;
    }
    /* Blue complement to orange — drawn from the app's existing accent hue */
    .cm-math-ref {
      color: #79b8ff;
      font-weight: 500;
    }
    /* Bold ghost text result */
    .cm-math-ghost {
      font-weight: 700;
    }
    /* Gradient shimmer sweep when a live result auto-updates */
    @keyframes mathResultShimmer {
      0%   { background-position: -200% center; }
      100% { background-position: 200% center; }
    }
    .cm-math-live-updated {
      background: linear-gradient(
        90deg,
        #f0a060 0%,
        #ffd4a0 30%,
        #fff3e0 50%,
        #ffd4a0 70%,
        #f0a060 100%
      );
      background-size: 400% auto;
      -webkit-background-clip: text;
      background-clip: text;
      -webkit-text-fill-color: transparent;
      animation: mathResultShimmer 1.4s ease-in-out;
      animation-iteration-count: 1;
      animation-fill-mode: none;
    }
    mark.nb-fhl-a { background:rgba(56,139,253,.5); outline:2px solid var(--accent); }

    /* ── Cover banner ─────────────────────────────────── */
    .nb-cover-banner {
      position: relative;
      width: 100%;
      flex-shrink: 0;
      overflow: hidden;
    }
    .nb-cover-img {
      width: 100%; height: 100%;
      object-fit: cover;
      display: block;
      user-select: none;
    }
    .nb-cover-img-draggable { cursor: grab; }
    .nb-cover-img-draggable:active { cursor: grabbing; }
    .nb-cover-actions {
      position: absolute;
      bottom: 10px; right: 14px;
      display: flex; gap: 6px;
      opacity: 0;
      transition: opacity 0.15s;
    }
    .nb-cover-banner:hover .nb-cover-actions { opacity: 1; }
    .nb-cover-action-btn {
      background: rgba(15,15,15,0.6);
      border: none;
      color: #fff;
      font-size: 11.5px;
      border-radius: 5px;
      padding: 4px 10px;
      cursor: pointer;
      font-family: inherit;
      backdrop-filter: blur(4px);
      transition: background 0.12s;
    }
    .nb-cover-action-btn:hover { background: rgba(15,15,15,0.82); }

    /* ── Cover image picker modal ─────────────────────── */
    .nb-cover-picker-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.65);
      z-index: 9999;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .nb-cover-picker-panel {
      background: var(--surface);
      border-radius: 12px;
      padding: 20px;
      width: 600px;
      max-width: 92vw;
      max-height: 88vh;
      display: flex;
      flex-direction: column;
      gap: 14px;
      box-shadow: 0 24px 64px rgba(0,0,0,0.55);
    }
    .nb-cover-picker-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .nb-cover-picker-header > span:first-child { font-weight: 600; font-size: 14px; color: var(--text); }
    .nb-cover-picker-hint { font-size: 12px; color: var(--textDim); }
    .nb-cover-picker-stage {
      position: relative;
      overflow: hidden;
      border-radius: 8px;
      cursor: grab;
      user-select: none;
      width: 100%;
      min-height: 120px;
      background: #000;
      flex-shrink: 0;
    }
    .nb-cover-picker-stage:active { cursor: grabbing; }
    .nb-cover-picker-img {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      pointer-events: none;
    }
    .nb-cpick-dim {
      position: absolute;
      left: 0; right: 0;
      background: rgba(0,0,0,0.55);
      pointer-events: none;
    }
    .nb-cpick-vp {
      position: absolute;
      box-shadow: 0 0 0 2px rgba(255,255,255,0.8) inset;
    }
    /* north/south resize handles (horizontal pill) */
    .nb-cpick-resize-n,
    .nb-cpick-resize-s {
      position: absolute;
      left: 0; right: 0;
      height: 12px;
      cursor: ns-resize;
      display: flex;
      justify-content: center;
    }
    .nb-cpick-resize-n { top: 0; align-items: flex-start; padding-top: 3px; }
    .nb-cpick-resize-s { bottom: 0; align-items: flex-end; padding-bottom: 3px; }
    .nb-cpick-resize-n::after,
    .nb-cpick-resize-s::after {
      content: '';
      width: 36px; height: 3px;
      border-radius: 2px;
      background: rgba(255,255,255,0.75);
      display: block;
    }
    /* west/east resize handles (vertical pill) */
    .nb-cpick-resize-w,
    .nb-cpick-resize-e {
      position: absolute;
      top: 0; bottom: 0;
      width: 12px;
      cursor: ew-resize;
      display: flex;
      align-items: center;
    }
    .nb-cpick-resize-w { left: 0; justify-content: flex-start; padding-left: 3px; }
    .nb-cpick-resize-e { right: 0; justify-content: flex-end; padding-right: 3px; }
    .nb-cpick-resize-w::after,
    .nb-cpick-resize-e::after {
      content: '';
      width: 3px; height: 36px;
      border-radius: 2px;
      background: rgba(255,255,255,0.75);
      display: block;
    }
    .nb-cpick-zoom {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
    }
    .nb-cpick-zoom-btn {
      width: 26px; height: 26px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: none;
      color: var(--text);
      font-size: 16px;
      line-height: 1;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
      transition: background 0.1s;
    }
    .nb-cpick-zoom-btn:hover { background: var(--surfaceAlt); }
    .nb-cpick-zoom-slider {
      flex: 1;
      accent-color: var(--accent);
      cursor: pointer;
    }
    .nb-cover-picker-footer {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      flex-shrink: 0;
    }
    .nb-cover-picker-cancel {
      background: none;
      border: 1px solid var(--border);
      color: var(--textDim);
      border-radius: 6px;
      padding: 6px 14px;
      font-size: 13px;
      font-family: inherit;
      cursor: pointer;
      transition: background 0.12s, color 0.12s;
    }
    .nb-cover-picker-cancel:hover { background: var(--surfaceAlt); color: var(--text); }
    .nb-cover-picker-apply {
      background: var(--accent);
      border: none;
      color: #fff;
      border-radius: 6px;
      padding: 6px 18px;
      font-size: 13px;
      font-family: inherit;
      cursor: pointer;
      transition: opacity 0.12s;
    }
    .nb-cover-picker-apply:hover { opacity: 0.88; }

    /* ── /linkw URL input modal ────────────────────────── */
    .nb-linkw-modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.55);
      z-index: 9999;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .nb-linkw-modal {
      background: var(--surface);
      border-radius: 10px;
      padding: 18px 20px 14px;
      width: 420px;
      max-width: 92vw;
      display: flex;
      flex-direction: column;
      gap: 10px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.5);
    }
    .nb-linkw-modal-title { font-weight: 600; font-size: 14px; color: var(--text); }
    .nb-linkw-modal-input {
      width: 100%;
      box-sizing: border-box;
      background: var(--surfaceAlt, #252525);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 7px 10px;
      font-size: 13px;
      color: var(--text);
      font-family: inherit;
      outline: none;
    }
    .nb-linkw-modal-input:focus { border-color: var(--accent); }
    .nb-linkw-modal-hint { font-size: 11px; color: var(--textDim); }

    /* ── /linkf file badge ─────────────────────────────── */
    .cm-linkf-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 9px 2px 6px;
      border-radius: 5px;
      background: var(--surfaceAlt, #252525);
      border: 1px solid var(--border);
      font-size: 13px;
      cursor: pointer;
      vertical-align: middle;
      max-width: 340px;
      transition: background 0.12s, border-color 0.12s;
      white-space: nowrap;
      overflow: hidden;
      line-height: 1.6;
    }
    .cm-linkf-badge:hover { background: var(--accentDim, rgba(100,149,237,0.14)); border-color: var(--accent); }
    .cm-linkf-icon { display: inline-flex; align-items: center; flex-shrink: 0; color: var(--textDim); }
    .cm-linkf-name { color: var(--accent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* ── /linkw web viewer (embedded native webview) ───── */
    .cm-linkw-wrap {
      display: block;
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      margin: 4px 0;
      background: var(--surfaceAlt, #252525);
      width: 100%;
    }
    .cm-linkw-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 10px;
      border-bottom: 1px solid var(--border);
      background: var(--surfaceAlt, #252525);
      height: 32px;
      box-sizing: border-box;
    }
    .cm-linkw-glob { display: inline-flex; align-items: center; flex-shrink: 0; color: var(--textDim); }
    .cm-linkw-info {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: baseline;
      gap: 0;
      overflow: hidden;
      white-space: nowrap;
    }
    .cm-linkw-title {
      font-size: 13px;
      font-weight: 500;
      color: var(--text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex-shrink: 1;
      min-width: 0;
    }
    .cm-linkw-url {
      font-size: 11px;
      color: var(--textDim);
      white-space: nowrap;
      flex-shrink: 0;
    }
    .cm-linkw-open-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
      background: var(--accent);
      border: none;
      color: #fff;
      border-radius: 5px;
      padding: 4px 9px;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      transition: opacity 0.12s;
      white-space: nowrap;
    }
    .cm-linkw-open-btn:hover { opacity: 0.82; }
    .cm-linkw-view-area {
      width: 100%;
      height: 460px;
      background: var(--surfaceAlt, #252525);
      display: block;
      position: relative;
    }
    .cm-linkw-load-overlay {
      position: absolute;
      inset: 0;
      cursor: pointer;
      overflow: hidden;
      background: var(--surfaceAlt, #252525);
    }
    .cm-linkw-thumb {
      width: 100%;
      height: 100%;
      object-fit: cover;
      object-position: top center;
      display: block;
    }
    .cm-linkw-favicon-badge {
      position: absolute;
      bottom: 10px;
      left: 10px;
      background: rgba(0,0,0,0.55);
      border-radius: 6px;
      padding: 4px;
      display: flex;
      align-items: center;
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
    }
    .cm-linkw-favicon-badge img { width: 20px; height: 20px; display: block; }

    /* ── /linkv video player ────────────────────────────── */
    .cm-linkv-wrap {
      display: block;
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      margin: 4px 0;
      background: #000;
    }
    .cm-linkv-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 8px;
      border-bottom: 1px solid var(--border);
      background: var(--surfaceAlt, #252525);
      height: 26px;
      box-sizing: border-box;
    }
    .cm-linkv-icon { display: inline-flex; align-items: center; flex-shrink: 0; color: var(--textDim); }
    .cm-linkv-title {
      font-size: 12px;
      font-weight: 500;
      color: var(--text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      min-width: 0;
    }
    .cm-linkv-video {
      display: block;
      width: 100%;
      max-height: 340px;
      background: #000;
    }

    /* ── Title meta row (Add cover hint) ──────────────── */
    .nb-title-area { }
    .nb-title-meta-row {
      height: 22px;
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      gap: 2px;
      opacity: 0;
      transition: opacity 0.15s;
    }
    .nb-title-area:hover .nb-title-meta-row { opacity: 1; }
    .nb-title-meta-btn {
      display: inline-flex;
      align-items: center;
      background: none;
      border: none;
      color: var(--textDim);
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      border-radius: 4px;
      padding: 2px 6px;
      opacity: 0.7;
      transition: opacity 0.12s, background 0.12s;
    }
    .nb-title-meta-btn:hover { opacity: 1; background: var(--surfaceAlt); }

    /* ── Progress bar / misc ───────────────────────────── */
    .nb2-fb { background:none; border:none; color:var(--textDim); cursor:pointer; border-radius:5px; padding:3px 7px; font-size:11px; font-family:inherit; transition:background .1s,color .1s; }
    .nb2-fb:hover { background:var(--surfaceAlt); color:var(--text); }
    .nb2-fc { font-size:16px; opacity:.6; background:none; border:none; cursor:pointer; color:var(--textDim); padding:0 4px; line-height:1; }
    .nb2-fc:hover { opacity:1; }

    /* ── Save indicator animation ──────────────────────── */
    .nb-save-indicator { display:flex; align-items:center; }
    .nb-save-icon { width:18px; height:18px; color:var(--accent); opacity:0; transition:opacity 0.2s; }
    .nb-save-icon.vis { opacity:1; }
    .nb-save-ring { stroke-dasharray:47; stroke-dashoffset:47; transition:stroke-dashoffset 0s; }
    .nb-save-icon.anim .nb-save-ring { stroke-dashoffset:0; transition:stroke-dashoffset 0.3s ease; }
    .nb-save-check { stroke-dasharray:12; stroke-dashoffset:12; transition:stroke-dashoffset 0s; }
    .nb-save-icon.anim .nb-save-check { stroke-dashoffset:0; transition:stroke-dashoffset 0.15s ease 0.25s; }
    .nb-save-icon.closing .nb-save-check { stroke-dashoffset:12; transition:stroke-dashoffset 0.15s ease; }
    .nb-save-icon.closing .nb-save-ring { stroke-dashoffset:47; transition:stroke-dashoffset 0.3s ease 0.1s; }
    .nb-save-icon.closing { opacity:0; transition:opacity 0.35s 0.25s; }
  `


  // ── Per-theme syntax colors — derived from known theme palettes ───────────
  // Derived directly from themes.js exact palette values
  const THEME_SYNTAX = {
    dark: {
      italic:'#79b8ff', bold:'#f0883e', bi:'#d2a8ff', h1:'#e6edf3', h2:'#79b8ff', h3:'#56d4dd',
      h4:'#b392f0', h5:'#f97583', h6:'#8b949e',
      quote:'#8b949e', quoteBg:'rgba(56,139,253,.07)', quoteBorder:'#388bfd',
      link:'#58a6ff', wiki:'#58a6ff', hl:'rgba(255,212,59,.35)',
      code:'#e2c08d', codeBg:'rgba(255,218,120,.10)',
      strike:'#f85149',
    },
    sepia: {
      italic:'#b06830', bold:'#c44d2a', bi:'#a05020', h1:'#3b2f20', h2:'#9b5430', h3:'#b87340',
      h4:'#8a6040', h5:'#7a5030', h6:'#7a6652',
      quote:'#7a6652', quoteBg:'rgba(139,94,60,.09)', quoteBorder:'#8b5e3c',
      link:'#8b5e3c', wiki:'#a0714e', hl:'rgba(210,170,60,.45)',
      code:'#9b5e3c', codeBg:'rgba(139,94,60,.15)',
      strike:'#c0392b',
    },
    light: {
      italic:'#0550ae', bold:'#9a3412', bi:'#6639a6', h1:'#1f2328', h2:'#0550ae', h3:'#0969da',
      h4:'#8250df', h5:'#cf222e', h6:'#636c76',
      quote:'#636c76', quoteBg:'rgba(9,105,218,.05)', quoteBorder:'#0969da',
      link:'#0550ae', wiki:'#0860c7', hl:'rgba(255,212,0,.55)',
      code:'#0550ae', codeBg:'rgba(9,105,218,.12)',
      strike:'#cf222e',
    },
    moss: {
      italic:'#2d8a2d', bold:'#b5651d', bi:'#5a8a1d', h1:'#2a3320', h2:'#2d8a2d', h3:'#4a9a3f',
      h4:'#6a8c3f', h5:'#3d6934', h6:'#5a7048',
      quote:'#5a7048', quoteBg:'rgba(74,124,63,.08)', quoteBorder:'#4a7c3f',
      link:'#2d8a2d', wiki:'#3d6934', hl:'rgba(180,220,80,.45)',
      code:'#2d8a2d', codeBg:'rgba(74,124,63,.15)',
      strike:'#d44040',
    },
    cherry: {
      italic:'#ff7eb3', bold:'#f5a623', bi:'#ff5c8a', h1:'#f2dde1', h2:'#ff5c8a', h3:'#ff7eb3',
      h4:'#d88ca0', h5:'#f07090', h6:'#9e6d76',
      quote:'#9e6d76', quoteBg:'rgba(224,92,122,.09)', quoteBorder:'#e05c7a',
      link:'#ff5c8a', wiki:'#f07090', hl:'rgba(255,100,140,.30)',
      code:'#ff7eb3', codeBg:'rgba(255,126,179,.15)',
      strike:'#f85149',
    },
    sunset: {
      italic:'#ffb347', bold:'#e84855', bi:'#ff8c42', h1:'#f5e6c8', h2:'#ffa020', h3:'#ffb347',
      h4:'#e8b060', h5:'#f0a840', h6:'#a07840',
      quote:'#a07840', quoteBg:'rgba(232,146,42,.09)', quoteBorder:'#e8922a',
      link:'#ffa020', wiki:'#f0a840', hl:'rgba(255,170,40,.35)',
      code:'#ffb347', codeBg:'rgba(255,179,71,.15)',
      strike:'#e84855',
    },
  }
  const tc = THEME_SYNTAX[themeKey] || THEME_SYNTAX.dark
  const THEME_CSS = `
    .nb-root {
      --nb-bold-color:     ${tc.bold || 'var(--text)'};
      --nb-bi-color:       ${tc.bi || tc.bold || 'var(--text)'};
      --nb-italic-color:   ${tc.italic};
      --nb-strike-color:   ${tc.strike || 'var(--textDim)'};
      --nb-h1-color:       ${tc.h1};
      --nb-h2-color:       ${tc.h2};
      --nb-h3-color:       ${tc.h3};
      --nb-h4-color:       ${tc.h4 || tc.h3};
      --nb-h5-color:       ${tc.h5 || tc.h3};
      --nb-h6-color:       ${tc.h6 || 'var(--textDim)'};
      --nb-quote-color:    ${tc.quote};
      --nb-quote-bg:       ${tc.quoteBg};
      --nb-quote-border:   ${tc.quoteBorder};
      --nb-link-color:     ${tc.link};
      --nb-wikilink-color: ${tc.wiki};
      --nb-hl-bg:          ${tc.hl};
      --nb-code-color:     ${tc.code};
      --nb-code-bg:        ${tc.codeBg};
    }
  `

  return (
    <div className="nb-root" style={{ display:'flex', flexDirection:'column', height:'100vh', overflow:'hidden', background:'var(--readerBg, var(--bg))', color:'var(--text)', position:'relative', '--nb-fs': `${nbFontSize}px` }}>
      <style>{CSS}</style>
      <style>{THEME_CSS}</style>

      {/* ── Header — flex: [nav] [save + search (centered)] [mode + settings] ── */}
      <header className="nb-header gnos-header">
        {/* Far left: nav button */}
        <div style={{ display:'flex', alignItems:'center', flex:'0 0 auto', minWidth:0 }}>
          <GnosNavButton />
        </div>

        {/* Center: save indicator + search bar (centered) */}
        <div style={{ display:'flex', alignItems:'center', flex:'1 1 0', minWidth:0, gap:8, margin:'0 8px', justifyContent:'center' }}>
          <div className="nb-save-indicator" style={{ flexShrink:0 }}>
            <svg id="nb-save-icon" className="nb-save-icon" viewBox="0 0 18 18" fill="none">
              <circle className="nb-save-ring" cx="9" cy="9" r="7.5" stroke="currentColor" strokeWidth="1.5" fill="none"/>
              <polyline className="nb-save-check" points="5.5,9 7.8,11.5 12.5,6.5" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <div style={{ flex:'0 1 520px', minWidth:0 }}>
            <div className={`search-bar${findQ?' focused':''}`} style={{ background:'var(--surfaceAlt)' }}
              onClick={() => findRef.current?.focus()}>
              <svg className="search-icon" width="13" height="13" viewBox="0 0 16 16" fill="none">
                <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M10 10l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
              {/* TODO /view commands — planned, not yet implemented:
                  /view s  → switch to scrolling layout (current behavior)
                  /view p  → switch to paginated layout (pages like a book)
                  Implementation plan:
                  - Add `viewLayout` state: 'scroll' | 'pages'
                  - 'scroll' = current cm-scroller behavior (flex-col, overflow-y:auto)
                  - 'pages'  = fixed-height cm-content panels, one page at a time,
                               with prev/next page controls; page breaks at \n---\n or
                               auto-calculated from content height vs viewport
                  - Search bar onChange: detect /view s or /view p → switch layout, clear input
                  - Persist layout preference in notebook metadata (useAppStore)
              */}
              <input ref={findRef} id="nb-search-input"
                style={{ background:'none', border:'none', color:'var(--text)', outline:'none', fontSize:13, flex:1, minWidth:0 }}
                placeholder={noteTitle || notebook?.title || 'Find…'} value={findQ}
                onChange={e => { setFindQ(e.target.value); doFind(e.target.value) }}
                onKeyDown={e => {
                  if (e.key==='Enter') { e.preventDefault(); findNav(e.shiftKey?-1:1) }
                  if (e.key==='Escape') { setFindQ(''); doFind('') }
                }}
              />
              {findQ ? (
                <span style={{ fontSize:11, color:'var(--textDim)', whiteSpace:'nowrap', marginRight:4 }}>
                  {findCount>0?`${findCurD+1}/${findCount}`:'Not found'}
                </span>
              ) : (
                <span style={{ fontSize:11, color: selectionWC > 0 ? 'var(--accent)' : 'var(--textDim)', whiteSpace:'nowrap', paddingLeft:8, flexShrink:0 }}>
                  {selectionWC > 0 ? `${selectionWC} of ${wordCount.toLocaleString()} words` : `${wordCount.toLocaleString()} words`}
                </span>
              )}
              {findQ && (
                <>
                  <button className="nb2-fb" onClick={() => findNav(-1)} title="Previous">↑</button>
                  <button className="nb2-fb" onClick={() => findNav(1)}  title="Next">↓</button>
                  <button className="nb2-fc" onClick={() => { setFindQ(''); doFind('') }} title="Clear">×</button>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Far right: view mode + settings */}
        <div style={{ display:'flex', alignItems:'center', gap:6, flex:'0 0 auto' }}>
          <ViewModeBtn viewMode={viewMode} setViewMode={switchMode} />
          <button onClick={() => setEditModal(true)} title="Notebook settings"
            style={{ background:'none', border:'1px solid var(--border)', borderRadius:6, color:'var(--textDim)', cursor:'pointer', width:30, height:30, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4"/>
              <path d="M8 1.5v1M8 13.5v1M1.5 8h1M13.5 8h1M3.3 3.3l.7.7M12 12l.7.7M12 3.3l-.7.7M4 12l-.7.7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      </header>

      {/* ── Main ──────────────────────────────────────────────────────────── */}
      {!isLoaded ? (
        <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', gap:8, color:'var(--textDim)', fontSize:13 }}>
          <div className="spinner" />Loading…
        </div>
      ) : (
        <div style={{ flex:1, overflow:'hidden', display:'flex', flexDirection:'column', position:'relative', background:'var(--readerBg,var(--bg))' }}>
          {/* Hidden file input for cover image — lives outside the hover area */}
          <input
            ref={coverInputRef}
            type="file"
            accept="image/*"
            style={{ display:'none' }}
            onChange={e => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (!file || !notebookId) return
              const objectUrl = URL.createObjectURL(file)
              setCoverPicker({ objectUrl, file, pos: { x: 50, y: 50 }, scale: 1 })
            }}
          />

          {/* ── Cover banner (full-width, Notion-style) ── */}
          {coverImage ? (
            <div className="nb-cover-banner" style={{ height: 220 }}>
              <img
                src={coverImage}
                alt="cover"
                className={`nb-cover-img${viewMode !== 'preview' ? ' nb-cover-img-draggable' : ''}`}
                style={{
                  transform: `scale(${coverScale})`,
                  transformOrigin: `${coverPos.x}% ${coverPos.y}%`,
                }}
                draggable={false}
                onMouseDown={viewMode !== 'preview' ? e => {
                  e.preventDefault()
                  coverDragRef.current = { startX: e.clientX, startY: e.clientY, px: coverPos.x, py: coverPos.y }
                  const banner = e.currentTarget.parentElement
                  const bW = banner.offsetWidth, bH = banner.offsetHeight
                  // overflow in each axis created by the scale factor
                  const overflowX = bW * (coverScale - 1)
                  const overflowY = bH * (coverScale - 1)
                  const onMove = ev => {
                    const d = coverDragRef.current
                    if (!d) return
                    const dx = overflowX > 0 ? (ev.clientX - d.startX) / overflowX * 100 : 0
                    const dy = overflowY > 0 ? (ev.clientY - d.startY) / overflowY * 100 : 0
                    setCoverPos({ x: Math.max(0, Math.min(100, d.px - dx)), y: Math.max(0, Math.min(100, d.py - dy)) })
                  }
                  const onUp = () => {
                    window.removeEventListener('mousemove', onMove)
                    window.removeEventListener('mouseup', onUp)
                    coverDragRef.current = null
                    setCoverPos(p => {
                      updateNotebook(notebookId, { coverPos: p })
                      useAppStore.getState().persistNotebooks?.()
                      return p
                    })
                  }
                  window.addEventListener('mousemove', onMove)
                  window.addEventListener('mouseup', onUp)
                } : undefined}
              />
              {viewMode !== 'preview' && (
                <div className="nb-cover-actions">
                  <button className="nb-cover-action-btn" onClick={openPickerForEdit}>Edit</button>
                  <button className="nb-cover-action-btn" onClick={() => coverInputRef.current?.click()}>Change</button>
                  <button className="nb-cover-action-btn" onClick={() => {
                    setCoverImage(null)
                    setCoverPos({ x: 50, y: 50 })
                    updateNotebook(notebookId, { coverImage: null, coverPos: null })
                    useAppStore.getState().persistNotebooks?.()
                  }}>Remove</button>
                </div>
              )}
            </div>
          ) : null}

          {/* ── Title area ── */}
          <div className={`nb-title-area${viewMode === 'preview' ? ' nb-title-area-preview' : ''}`}>
            <div className="nb-content-wrap" style={{ maxWidth:780, margin:'0 auto', width:'100%', padding:`${coverImage ? 16 : 24}px 48px 0`, boxSizing:'border-box' }}>
              {/* "Add cover" hint — only in edit mode, revealed on hover via CSS */}
              {viewMode !== 'preview' && (
                <div className="nb-title-meta-row">
                  {!coverImage && (
                    <button className="nb-title-meta-btn" onClick={() => coverInputRef.current?.click()}>
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ marginRight:5, flexShrink:0 }}>
                        <rect x="1" y="3" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.4"/>
                        <circle cx="5.5" cy="7" r="1.5" stroke="currentColor" strokeWidth="1.2"/>
                        <path d="M1.5 11.5l3.5-3 3 3 2.5-2.5 4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      Add cover
                    </button>
                  )}
                </div>
              )}
              {viewMode === 'preview' ? (
                noteTitle && (
                  <div style={{ fontFamily:'Georgia,serif', fontSize:'1.7em', fontWeight:700, color:'var(--text)', lineHeight:1.2 }}>
                    {noteTitle}
                  </div>
                )
              ) : (
                <input value={noteTitle}
                  onChange={e => { const t=e.target.value; setTitle(t); titleRef.current=t; scheduleSave(contentRef.current) }}
                  placeholder="Title…"
                  style={{ width:'100%', background:'none', border:'none', outline:'none', fontFamily:'Georgia,serif', fontSize:'1.7em', fontWeight:700, color:'var(--text)', lineHeight:1.2, padding:0, caretColor:'var(--accent)' }}
                  onKeyDown={e => { if(e.key==='Enter'){e.preventDefault();cmRef.current?.focus()} }}
                />
              )}
            </div>
          </div>
          {/* Divider — hidden in preview */}
          {viewMode !== 'preview' && (
            <div style={{ maxWidth:780, margin:'4px auto 0', width:'100%', padding:'0 48px', boxSizing:'border-box', pointerEvents:'none' }}>
              <div style={{ height:1, background:'var(--borderSubtle)', opacity:.5 }} />
            </div>
          )}
          {/* CodeMirror — mounted in all modes; read-only + live decorations in preview */}
          <div ref={editorRef} className={`nb-cm${(viewMode==='live'||viewMode==='preview')?' nb-live':''}${viewMode==='preview'?' nb-preview':''}${viewMode==='source'?' nb-source':''}`} style={{ flex:1, overflow:'hidden', minHeight:0 }} />
          {/* Wiki-link dropdown */}
          {wikiDrop && wikiDrop.coords && (
            <div className="nb-wiki-dropdown" style={{
              position: 'fixed',
              left: Math.min(wikiDrop.coords.left, window.innerWidth - 370),
              top: Math.min(wikiDrop.coords.top, window.innerHeight - 340),
              zIndex: 9999,
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              boxShadow: '0 16px 48px rgba(0,0,0,0.55)',
              padding: 6,
              minWidth: 260,
              maxWidth: 360,
              maxHeight: 320,
              overflow: 'auto',
            }}>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {wikiDrop.options.map((opt, i) => (
                  <li key={`${opt.detail}-${opt.label}-${i}`}
                    onMouseDown={e => {
                      e.preventDefault()
                      // Confirm this option
                      const view = cmRef.current
                      if (view) {
                        const state = view.state
                        const cur = state.selection.main.head
                        const line = state.doc.lineAt(cur)
                        const col = cur - line.from
                        const textBefore = line.text.slice(0, col)
                        const idx = textBefore.lastIndexOf('[[')
                        if (idx !== -1) {
                          view.dispatch({ changes: { from: line.from + idx, to: cur, insert: opt.insert } })
                        }
                      }
                      setWikiDrop(null)
                    }}
                    style={{
                      padding: '9px 12px',
                      borderRadius: 8,
                      margin: '1px 0',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      cursor: 'pointer',
                      transition: 'background 0.08s',
                      background: i === wikiDrop.selectedIdx ? 'rgba(56,139,253,0.18)' : 'transparent',
                      color: i === wikiDrop.selectedIdx ? 'var(--accent)' : 'var(--text)',
                    }}>
                    <span style={{ flex: 1, fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{opt.label}</span>
                    <span style={{ fontSize: 12, opacity: 0.65, flexShrink: 0, paddingLeft: 8 }}>{opt.detail}</span>
                  </li>
                ))}
              </ul>
              <div style={{
                padding: '5px 12px 6px',
                fontSize: 10.5,
                color: 'var(--textDim)',
                opacity: 0.65,
                borderTop: '1px solid var(--borderSubtle)',
                marginTop: 4,
                textAlign: 'center',
                letterSpacing: '0.01em',
              }}>Tab to confirm · Esc to dismiss</div>
            </div>
          )}
          {/* ── Inline command dropdown (/color, /font, /spacing, /size) ──── */}
          {inlineCmd && inlineCmd.coords && (() => {
            const { type, hint, selectedIdx, coords, lineFrom, lineTo } = inlineCmd
            const options = type === 'color' ? INLINE_COLORS
              : type === 'font' ? INLINE_FONTS
              : type === 'spacing' ? INLINE_SPACINGS
              : INLINE_SIZES

            const filtered = hint
              ? options.filter(o => o.name.toLowerCase().startsWith(hint))
              : options
            const activeIdx = Math.min(selectedIdx, Math.max(0, filtered.length - 1))

            const TITLES = { color: 'Text Color', font: 'Font', spacing: 'Line Spacing', size: 'Text Size' }

            const confirmOption = opt => {
              const view = cmRef.current
              if (!view || !opt) return
              const marker = `{${type}:${opt.value}}`
              view.dispatch({
                changes: { from: lineFrom, to: lineTo, insert: marker },
                selection: { anchor: lineFrom + marker.length },
              })
              setInlineCmd(null)
              view.focus()
            }

            return (
              <div style={{
                position: 'fixed',
                left: Math.min(coords.left, window.innerWidth - 380),
                top: Math.min(coords.top, window.innerHeight - 380),
                zIndex: 9999,
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 12,
                boxShadow: '0 16px 48px rgba(0,0,0,0.55)',
                padding: 6,
                minWidth: type === 'color' ? 280 : 240,
                maxWidth: 380,
                maxHeight: 360,
                overflow: 'auto',
              }}>
                <div style={{ padding: '4px 10px 6px', fontSize: 11, color: 'var(--textDim)', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', opacity: 0.7 }}>
                  {TITLES[type]}
                </div>
                {type === 'color' ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 4, padding: '0 4px 4px' }}>
                    {filtered.map((opt, i) => (
                      <button key={opt.name} title={opt.name}
                        onMouseDown={e => { e.preventDefault(); confirmOption(opt) }}
                        style={{
                          width: 36, height: 36, borderRadius: 8,
                          border: i === activeIdx ? '2px solid var(--accent)' : '2px solid transparent',
                          background: opt.value.startsWith('var(') ? opt.value : opt.value === 'inherit' ? 'var(--surfaceAlt)' : opt.value,
                          cursor: 'pointer', outline: 'none', position: 'relative',
                        }}>
                        {opt.value === 'inherit' && (
                          <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: 'var(--text)', fontWeight: 700 }}>∅</span>
                        )}
                      </button>
                    ))}
                  </div>
                ) : (
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                    {filtered.map((opt, i) => (
                      <li key={opt.name}
                        onMouseDown={e => { e.preventDefault(); confirmOption(opt) }}
                        style={{
                          padding: '8px 12px', borderRadius: 8, margin: '1px 0',
                          display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
                          background: i === activeIdx ? 'rgba(56,139,253,0.18)' : 'transparent',
                          color: i === activeIdx ? 'var(--accent)' : 'var(--text)',
                        }}>
                        {type === 'font' && (
                          <>
                            <span style={{ flex: 1, fontSize: 14, fontFamily: opt.value, fontWeight: 500 }}>{opt.name}</span>
                            <span style={{ fontSize: 11, opacity: 0.5, fontFamily: opt.value }}>Abc</span>
                          </>
                        )}
                        {type === 'size' && (
                          <>
                            <span style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>{opt.name}</span>
                            <span style={{ fontSize: opt.value, opacity: 0.75, lineHeight: 1 }}>Aa</span>
                          </>
                        )}
                        {(type === 'spacing') && (
                          <>
                            <span style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>{opt.name}</span>
                            <span style={{ fontSize: 12, opacity: 0.6, fontFamily: 'monospace' }}>{opt.preview}</span>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                <div style={{ padding: '5px 12px 6px', fontSize: 10.5, color: 'var(--textDim)', opacity: 0.65, borderTop: '1px solid var(--borderSubtle)', marginTop: 4, textAlign: 'center', letterSpacing: '0.01em' }}>
                  ↑↓ navigate · Tab/Enter confirm · Esc dismiss
                </div>
              </div>
            )
          })()}
        </div>
      )}

      {editModal && <NotebookSettingsPanel notebook={notebook} notebooks={notebooks} onClose={() => setEditModal(false)} />}

      {/* ── /linkw URL input modal ──────────────────────────────────────────── */}
      {linkPicker?.type === 'web' && (
        <div className="nb-linkw-modal-backdrop" onMouseDown={e => {
          if (e.target === e.currentTarget) { setLinkPicker(null); setLinkWebUrl('') }
        }}>
          <form className="nb-linkw-modal" onSubmit={e => {
            e.preventDefault()
            const url = linkWebUrl.trim()
            if (url && cmRef.current) {
              const insertText = `/linkw:${url}\n`
              cmRef.current.dispatch({
                changes: { from: linkPicker.lineFrom, to: linkPicker.lineTo, insert: insertText },
                selection: { anchor: linkPicker.lineFrom + insertText.length },
              })
            }
            setLinkPicker(null); setLinkWebUrl('')
          }}>
            <div className="nb-linkw-modal-title">Embed webpage</div>
            <input
              autoFocus
              className="nb-linkw-modal-input"
              type="url"
              placeholder="https://example.com"
              value={linkWebUrl}
              onChange={e => setLinkWebUrl(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') { e.preventDefault(); setLinkPicker(null); setLinkWebUrl('') }
              }}
            />
            <div className="nb-linkw-modal-hint">Press Enter to embed · Esc to cancel</div>
          </form>
        </div>
      )}

      {/* ── Cover image picker ──────────────────────────────────────────────── */}
      {coverPicker && (
        <div className="nb-cover-picker-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) cancelPicker() }}>
          <div className="nb-cover-picker-panel">
            <div className="nb-cover-picker-header">
              <span>Position cover image</span>
              <span className="nb-cover-picker-hint">Drag to reposition · Use slider to zoom</span>
            </div>

            {/* Thumbnail preview — image zooms and pans within the fixed frame */}
            <div
              className="nb-cover-picker-stage"
              style={{ aspectRatio: `${Math.round((window.innerWidth || 1200) / 220 * 100) / 100}` }}
              onMouseDown={e => {
                e.preventDefault()
                const startX = e.clientX, startY = e.clientY
                const snap = { ...coverPicker.pos }
                const sc = Math.max(1, coverPicker.scale ?? 1)
                const el = e.currentTarget
                const sW = el.offsetWidth, sH = el.offsetHeight
                const overflowX = sW * (sc - 1)
                const overflowY = sH * (sc - 1)
                const onMove = ev => {
                  const dx = ev.clientX - startX, dy = ev.clientY - startY
                  const newX = overflowX > 0 ? Math.max(0, Math.min(100, snap.x - dx / overflowX * 100)) : 50
                  const newY = overflowY > 0 ? Math.max(0, Math.min(100, snap.y - dy / overflowY * 100)) : 50
                  setCoverPicker(p => p ? { ...p, pos: { x: newX, y: newY } } : p)
                }
                const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
                window.addEventListener('mousemove', onMove)
                window.addEventListener('mouseup', onUp)
              }}
            >
              <img
                src={coverPicker.objectUrl}
                className="nb-cover-picker-img"
                draggable={false}
                style={{
                  transform: `scale(${Math.max(1, coverPicker.scale ?? 1)})`,
                  transformOrigin: `${coverPicker.pos.x}% ${coverPicker.pos.y}%`,
                }}
              />
            </div>

            {/* Zoom controls */}
            <div className="nb-cpick-zoom">
              <button className="nb-cpick-zoom-btn" onClick={() => {
                setCoverPicker(p => p ? { ...p, scale: Math.max(1, (p.scale ?? 1) / 1.2) } : p)
              }} title="Zoom out">−</button>
              <input
                type="range" min={1} max={4} step={0.01}
                value={Math.max(1, coverPicker.scale ?? 1)}
                className="nb-cpick-zoom-slider"
                onChange={e => setCoverPicker(p => p ? { ...p, scale: parseFloat(e.target.value) } : p)}
              />
              <button className="nb-cpick-zoom-btn" onClick={() => {
                setCoverPicker(p => p ? { ...p, scale: Math.min(4, (p.scale ?? 1) * 1.2) } : p)
              }} title="Zoom in">+</button>
            </div>

            <div className="nb-cover-picker-footer">
              <button className="nb-cover-picker-cancel" onClick={cancelPicker}>Cancel</button>
              <button className="nb-cover-picker-apply" onClick={applyPicker}>Apply</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Notebook settings panel (Syntax + Backlinks tabs) ───────────────────────
const SYNTAX_SUBTABS = [
  { id: 'formatting', label: 'Formatting', sections: ['Inline Formatting', 'Headings', 'Auto-wrap Pairs'] },
  { id: 'blocks',     label: 'Blocks',     sections: ['Blocks', 'Inline Math'] },
  { id: 'links',      label: 'Links & Tags', sections: ['Wikilinks', 'Tags & Dates'] },
  { id: 'shortcuts',  label: 'Shortcuts',  sections: ['Shortcuts'] },
]

function NotebookSettingsPanel({ notebook, notebooks, onClose }) {
  const [tab, setTab] = useState('syntax')
  const [syntaxTab, setSyntaxTab] = useState('formatting')
  const [blView, setBlView] = useState('list') // 'list' | 'graph'
  const [backlinks, setBacklinks] = useState(null) // null = loading, [] = none
  const [forwardsLinks, setForwardsLinks] = useState(null) // null = loading, [] = none
  const [tagSearch, setTagSearch] = useState('')
  const [tagResults, setTagResults] = useState(null) // null = idle, [] = no matches
  const title = notebook?.title || ''

  useEffect(() => {
    if (tab !== 'backlinks' || backlinks !== null) return
    let gone = false
    ;(async () => {
      const { loadNotebookContent } = await import('@/lib/storage')
      const refs = []
      for (const nb of (notebooks || [])) {
        if (nb.id === notebook?.id) continue
        try {
          const content = await loadNotebookContent(nb.id)
          const pattern = new RegExp(`\\[\\[${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\|[^\\]]*)?\\]\\]`, 'i')
          if (pattern.test(content || '')) refs.push(nb)
        } catch { /* skip */ }
      }
      if (!gone) setBacklinks(refs)
    })()
    return () => { gone = true }
  }, [tab, backlinks, notebooks, notebook, title])

  // Scan current notebook's content for outgoing [[wikilinks]]
  useEffect(() => {
    if (tab !== 'backlinks' || forwardsLinks !== null || !notebook?.id) return
    let gone = false
    ;(async () => {
      const { loadNotebookContent } = await import('@/lib/storage')
      try {
        const content = await loadNotebookContent(notebook.id)
        const wikiRe = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g
        const seen = new Set()
        const fwd = []
        let m
        while ((m = wikiRe.exec(content || '')) !== null) {
          const linkedTitle = m[1].trim()
          if (seen.has(linkedTitle)) continue
          seen.add(linkedTitle)
          const found = (notebooks || []).find(n => n.title?.toLowerCase() === linkedTitle.toLowerCase() && n.id !== notebook.id)
          if (found) fwd.push(found)
        }
        if (!gone) setForwardsLinks(fwd)
      } catch { if (!gone) setForwardsLinks([]) }
    })()
    return () => { gone = true }
  }, [tab, forwardsLinks, notebook, notebooks])

  useEffect(() => {
    const raw = tagSearch.replace(/^::/, '').trim().toLowerCase()
    if (!raw) { setTagResults(null); return }
    const now = new Date()
    const todayStr = now.toDateString()
    if (raw === 'today') {
      const matches = (notebooks || [])
        .filter(nb => nb.id !== notebook?.id && nb.dueDate && new Date(nb.dueDate).toDateString() === todayStr)
        .map(nb => ({ nb, dueLabel: new Date(nb.dueDate).toLocaleDateString('en-US', { month:'short', day:'numeric' }), dueState: 'today' }))
      setTagResults(matches); return
    }
    if (raw === 'overdue') {
      const matches = (notebooks || [])
        .filter(nb => nb.id !== notebook?.id && nb.dueDate && new Date(nb.dueDate) < now)
        .map(nb => ({ nb, dueLabel: new Date(nb.dueDate).toLocaleDateString('en-US', { month:'short', day:'numeric' }), dueState: 'overdue' }))
      setTagResults(matches); return
    }
    let gone = false
    setTagResults(null)
    ;(async () => {
      const { loadNotebookContent } = await import('@/lib/storage')
      const tagRe = /::([a-zA-Z][a-zA-Z0-9_-]*)/g
      const matches = []
      for (const nb of (notebooks || [])) {
        if (nb.id === notebook?.id) continue
        try {
          const content = await loadNotebookContent(nb.id)
          tagRe.lastIndex = 0
          const tags = new Set()
          let m
          while ((m = tagRe.exec(content || '')) !== null) tags.add(m[1].toLowerCase())
          const hit = [...tags].filter(t => t.includes(raw))
          if (hit.length) matches.push({ nb, tags: hit })
        } catch { /* skip */ }
      }
      if (!gone) setTagResults(matches)
    })()
    return () => { gone = true }
  }, [tagSearch, notebooks, notebook])

  const SECS = [
    { title:'Inline Formatting', rows:[
      {k:'**bold**',d:'Bold'},{k:'*italic*',d:'Italic'},
      {k:'***bold italic***',d:'Bold + italic'},{k:'~~strike~~',d:'Strikethrough'},
      {k:'==highlight==',d:'Highlight'},{k:'`code`',d:'Inline code'},
      {k:'^sup^',d:'Superscript'},{k:'~sub~',d:'Subscript'},
      {k:'[text](url)',d:'Hyperlink'},{k:'![alt](url)',d:'Image'},{k:'![alt :left](url)',d:'Image aligned left/right/center'},
    ]},
    { title:'Headings', rows:[
      {k:'# H1',d:'Heading 1'},{k:'## H2',d:'Heading 2'},{k:'### H3',d:'Heading 3'},
      {k:'#### H4',d:'H4'},{k:'##### H5',d:'H5'},{k:'###### H6',d:'H6'},
    ]},
    { title:'Blocks', rows:[
      {k:'> text',d:'Blockquote'},{k:'> [!NOTE]',d:'Callout'},
      {k:'- item',d:'Unordered list'},{k:'1. item',d:'Ordered list'},
      {k:'  - nested',d:'Nested list (2 spaces)'},{k:'- [ ] task',d:'Task item'},
      {k:'- [x] done',d:'Checked task (clickable)'},{k:'```lang',d:'Code block'},
      {k:'---',d:'Horizontal rule'},{k:'| a | b |',d:'Table'},
      {k:'/habits',d:'Habit tracker (add habits, check off per day)'},
      {k:'/task or /task:Title',d:'Kanban board'},
      {k:'/timer mm:ss or hh:mm:ss',d:'Countdown timer with progress bar'},
      {k:'/calendar',d:'Interactive inline calendar'},
      {k:'?[question]()',d:'Review question — click to set date or link to flashcard deck'},
      {k:'[^1]: note',d:'Footnote definition'},
      {k:'$math$',d:'Inline math (MathQuill — click to edit)'},
      {k:'$$\nmath\n$$',d:'Math block (MathQuill — click to edit)'},
    ]},
    { title:'Wikilinks', rows:[
      {k:'[[Title]]',d:'Link to note or book'},
      {k:'Type [[',d:'Dropdown — up to 4 suggestions'},
      {k:'Click link',d:'Opens; creates missing notes'},
    ]},
    { title:'Tags & Dates', rows:[
      {k:'::meeting',d:'Tag — renders as a #meeting badge; searchable in library'},
      {k:'::important',d:'Another tag example — use any word after ::'},
      {k:'::2026-03-18',d:'Due date (year-month-day)'},
      {k:'::18-03-2026',d:'Due date (day-month-year)'},
      {k:'::18-03-26',d:'Due date (day-month-2-digit year)'},
      {k:'::18-03-2026,14:30',d:'Due date + time (2:30 PM = 14:30)'},
      {k:'::14:30',d:'Due today at 14:30'},
      {k:'::+2d',d:'Due in 2 days from now'},
      {k:'::+3h',d:'Due in 3 hours from now'},
    ]},
    { title:'Auto-wrap Pairs', rows:[
      {k:'Select text → type **',d:'Wraps selection with **…**'},
      {k:'Select text → type *',d:'Wraps selection with *…*'},
      {k:'Select text → type `',d:'Wraps selection with `…`'},
      {k:'Select text → type ~~',d:'Wraps selection with ~~…~~'},
      {k:'Select text → type ==',d:'Wraps selection with ==…=='},
      {k:'Select text → type $',d:'Wraps selection with $…$'},
    ]},
    { title:'Inline Math', rows:[
      {k:'2+2 =',d:'Shows answer as ghost hint — press Tab to accept'},
      {k:'2*32.12321 =:.2',d:'Round result to 2 decimals → 64.25'},
      {k:'5 km to miles =',d:'Unit conversion via math.js'},
      {k:'@14:30',d:'Time reference (24h format)'},
      {k:'@2:30pm',d:'Time reference (12h format)'},
    ]},
    { title:'Shortcuts', rows:[
      {k:'Ctrl+B',d:'Bold'},{k:'Ctrl+I',d:'Italic'},{k:'Ctrl+K',d:'Link'},
      {k:'Ctrl+E',d:'Code'},{k:'Ctrl+Shift+H',d:'Highlight'},
      {k:'Ctrl+S',d:'Save'},{k:'Ctrl+F',d:'Find'},
      {k:'Tab',d:'Indent list'},{k:'Enter',d:'Smart list continue'},
    ]},
  ]

  // Tree graph: backlinks feed INTO the current note (arrows pointing right → current)
  // forwards links branch OUT from the current note (arrows pointing right → linked)
  function ConnectionsTree({ backlinks: bls, forwardsLinks: fwds }) {
    const loading = bls === null || fwds === null
    if (loading) return (
      <div style={{ display:'flex', alignItems:'center', gap:8, color:'var(--textDim)', fontSize:12, padding:'8px 0' }}>
        <div className="spinner" /><span>Scanning…</span>
      </div>
    )
    const hasBls = bls?.length > 0
    const hasFwds = fwds?.length > 0
    if (!hasBls && !hasFwds) return (
      <div style={{ color:'var(--textDim)', fontSize:13, padding:'12px 0', textAlign:'center' }}>No connections found.</div>
    )

    const NODE_W = 110, NODE_H = 28, GAP_Y = 10, COL_GAP = 70
    const CENTER_X = 160, CENTER_Y_BASE = 20

    // Layout backlink nodes on the left, forwards on the right
    const blNodes = (bls || []).map((nb, i) => ({ nb, x: CENTER_X - COL_GAP - NODE_W, y: CENTER_Y_BASE + i * (NODE_H + GAP_Y) }))
    const fwNodes = (fwds || []).map((nb, i) => ({ nb, x: CENTER_X + COL_GAP, y: CENTER_Y_BASE + i * (NODE_H + GAP_Y) }))

    const allRows = Math.max(blNodes.length, fwNodes.length, 1)
    const centerY = CENTER_Y_BASE + ((allRows - 1) * (NODE_H + GAP_Y)) / 2
    const svgH = CENTER_Y_BASE * 2 + allRows * (NODE_H + GAP_Y)
    const svgW = CENTER_X * 2 + COL_GAP + NODE_W

    function nodeLabel(nb) {
      const t = nb.title || 'Untitled'
      return t.length > 13 ? t.slice(0, 12) + '…' : t
    }

    function ArrowLine({ x1, y1, x2, y2 }) {
      const dx = x2 - x1, dy = y2 - y1
      const len = Math.sqrt(dx * dx + dy * dy)
      const ux = dx / len, uy = dy / len
      const AH = 7
      const ax = x2 - ux * AH, ay = y2 - uy * AH
      const perp = { x: -uy * 3, y: ux * 3 }
      return (
        <g>
          <line x1={x1} y1={y1} x2={ax} y2={ay} stroke="var(--border)" strokeWidth="1.4" />
          <polygon points={`${x2},${y2} ${ax + perp.x},${ay + perp.y} ${ax - perp.x},${ay - perp.y}`} fill="var(--border)" />
        </g>
      )
    }

    function NoteBox({ x, y, nb, accent }) {
      return (
        <g>
          <rect x={x} y={y} width={NODE_W} height={NODE_H} rx={6} fill={accent ? 'var(--accent)' : 'var(--surfaceAlt)'} stroke={accent ? 'var(--accent)' : 'var(--border)'} strokeWidth="1.2" />
          <text x={x + NODE_W / 2} y={y + NODE_H / 2 + 1} textAnchor="middle" dominantBaseline="middle" fontSize={9} fill={accent ? '#fff' : 'var(--text)'} fontWeight={accent ? 700 : 500}>
            {nodeLabel(nb)}
          </text>
        </g>
      )
    }

    return (
      <svg width="100%" viewBox={`0 0 ${svgW} ${svgH}`} style={{ maxHeight: Math.min(svgH, 320), overflow: 'visible' }}>
        {/* Backlink arrows: from right-edge of bl node → left-edge of center */}
        {blNodes.map(({ nb, x, y }) => (
          <ArrowLine key={nb.id}
            x1={x + NODE_W} y1={y + NODE_H / 2}
            x2={CENTER_X} y2={centerY + NODE_H / 2}
          />
        ))}
        {/* Forwards arrows: from right-edge of center → left-edge of fwd node */}
        {fwNodes.map(({ nb, x, y }) => (
          <ArrowLine key={nb.id}
            x1={CENTER_X + NODE_W} y1={centerY + NODE_H / 2}
            x2={x} y2={y + NODE_H / 2}
          />
        ))}
        {/* Backlink nodes */}
        {blNodes.map(({ nb, x, y }) => <NoteBox key={nb.id} x={x} y={y} nb={nb} />)}
        {/* Center node */}
        <NoteBox x={CENTER_X} y={centerY} nb={{ title }} accent />
        {/* Forwards link nodes */}
        {fwNodes.map(({ nb, x, y }) => <NoteBox key={nb.id} x={x} y={y} nb={nb} />)}
        {/* Legend */}
        {hasBls && <text x={blNodes[0].x + NODE_W / 2} y={CENTER_Y_BASE - 8} textAnchor="middle" fontSize={8} fill="var(--textDim)" opacity={0.7}>links here</text>}
        {hasFwds && <text x={fwNodes[0].x + NODE_W / 2} y={CENTER_Y_BASE - 8} textAnchor="middle" fontSize={8} fill="var(--textDim)" opacity={0.7}>linked from here</text>}
      </svg>
    )
  }

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.55)', zIndex:10000, display:'flex', alignItems:'center', justifyContent:'center' }} onClick={onClose}>
      <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:14, width:620, maxWidth:'94vw', maxHeight:'80vh', display:'flex', flexDirection:'column', boxShadow:'0 20px 60px rgba(0,0,0,.55)' }} onClick={e=>e.stopPropagation()}>
        {/* Header */}
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'14px 20px 0', flexShrink:0 }}>
          <div style={{ display:'flex', gap:4 }}>
            {['syntax','backlinks'].map(t => (
              <button key={t} onClick={() => setTab(t)} style={{
                padding:'6px 14px', fontSize:12, fontWeight:600, fontFamily:'inherit',
                borderRadius:'8px 8px 0 0', border:'1px solid var(--border)',
                borderBottom: t === tab ? '1px solid var(--surface)' : '1px solid var(--border)',
                background: t === tab ? 'var(--surface)' : 'var(--surfaceAlt)',
                color: t === tab ? 'var(--text)' : 'var(--textDim)', cursor:'pointer',
                textTransform:'capitalize', marginBottom: t === tab ? -1 : 0,
              }}>{t}</button>
            ))}
          </div>
          <button onClick={onClose} title="Close" style={{width:24,height:24,borderRadius:6,border:'1px solid var(--border)',background:'var(--surfaceAlt)',color:'var(--textDim)',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',transition:'background 0.1s,color 0.1s,border-color 0.1s',marginBottom:0}} onMouseEnter={e=>{e.currentTarget.style.background='rgba(248,81,73,0.12)';e.currentTarget.style.color='#f85149';e.currentTarget.style.borderColor='rgba(248,81,73,0.4)'}} onMouseLeave={e=>{e.currentTarget.style.background='var(--surfaceAlt)';e.currentTarget.style.color='var(--textDim)';e.currentTarget.style.borderColor='var(--border)'}}><svg width="9" height="9" viewBox="0 0 9 9" fill="none"><path d="M1 1l7 7M8 1l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg></button>
        </div>
        <div style={{ borderTop:'1px solid var(--border)', marginTop:0 }} />

        {tab === 'syntax' && (
          <div style={{ display:'flex', flexDirection:'column', flex:1, overflow:'hidden' }}>
            {/* Syntax subtabs */}
            <div style={{ display:'flex', gap:2, padding:'10px 20px 0', borderBottom:'1px solid var(--borderSubtle)', flexShrink:0 }}>
              {SYNTAX_SUBTABS.map(st => (
                <button key={st.id} onClick={() => setSyntaxTab(st.id)} style={{
                  padding:'5px 12px', fontSize:11, fontWeight:600, fontFamily:'inherit',
                  borderRadius:'6px 6px 0 0', border:'1px solid',
                  borderColor: st.id === syntaxTab ? 'var(--border)' : 'transparent',
                  borderBottom: st.id === syntaxTab ? '1px solid var(--surface)' : '1px solid transparent',
                  background: st.id === syntaxTab ? 'var(--surface)' : 'transparent',
                  color: st.id === syntaxTab ? 'var(--text)' : 'var(--textDim)',
                  cursor:'pointer', marginBottom: st.id === syntaxTab ? -1 : 0,
                  transition:'background 0.1s, color 0.1s',
                }}>{st.label}</button>
              ))}
            </div>
            <div style={{ overflow:'auto', padding:'14px 20px 20px', flex:1 }}>
              {SECS.filter(sec => (SYNTAX_SUBTABS.find(st => st.id === syntaxTab)?.sections || []).includes(sec.title)).map(sec => (
                <div key={sec.title} style={{ marginBottom:18 }}>
                  <div style={{ fontSize:10, fontWeight:700, letterSpacing:'.08em', textTransform:'uppercase', color:'var(--textDim)', opacity:.6, marginBottom:8 }}>{sec.title}</div>
                  {sec.rows.map(({k,d}) => (
                    <div key={k} style={{ display:'flex', alignItems:'baseline', gap:12, padding:'4px 0', borderBottom:'1px solid var(--borderSubtle)' }}>
                      <code style={{ fontFamily:'SF Mono,Menlo,Consolas,monospace', fontSize:11, background:'var(--surfaceAlt)', border:'1px solid var(--border)', borderRadius:5, padding:'2px 8px', color:'var(--accent)', flexShrink:0, minWidth:130, display:'inline-block' }}>{k}</code>
                      <span style={{ fontSize:12, color:'var(--textDim)' }}>{d}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'backlinks' && (
          <div style={{ overflow:'auto', padding:'14px 20px 20px', flex:1, display:'flex', flexDirection:'column', gap:16 }}>

            {/* ── Tag search ─────────────────────────────────────────── */}
            <div>
              <div style={{ fontSize:10, fontWeight:700, letterSpacing:'.08em', textTransform:'uppercase', color:'var(--textDim)', opacity:.6, marginBottom:8 }}>Search by Tag</div>
              <div style={{ display:'flex', alignItems:'center', gap:6, background:'var(--surfaceAlt)', border:'1px solid var(--border)', borderRadius:7, padding:'5px 10px', marginBottom:8 }}>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ opacity:.5, flexShrink:0 }}><circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.5"/><path d="M10 10l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                <input
                  value={tagSearch}
                  onChange={e => setTagSearch(e.target.value)}
                  placeholder="::tagname or ::today"
                  style={{ flex:1, background:'none', border:'none', outline:'none', fontSize:12, color:'var(--text)', fontFamily:'inherit' }}
                />
                {tagSearch && <button onClick={() => setTagSearch('')} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--textDim)', padding:0, lineHeight:1 }}>✕</button>}
              </div>
              {(() => {
                const raw = tagSearch.replace(/^::/, '').trim().toLowerCase()
                if (!raw) return null
                if (tagResults === null) return (
                  <div style={{ display:'flex', alignItems:'center', gap:8, color:'var(--textDim)', fontSize:12, padding:'4px 2px' }}>
                    <div className="spinner" /><span>Scanning…</span>
                  </div>
                )
                const emptyMsg = raw === 'today' ? 'Nothing due today'
                  : raw === 'overdue' ? 'No overdue notes'
                  : <span>No notes tagged <strong>{raw}</strong></span>
                return tagResults.length === 0
                  ? <div style={{ fontSize:12, color:'var(--textDim)', padding:'4px 2px' }}>{emptyMsg}</div>
                  : <div style={{ display:'flex', flexDirection:'column', gap:5 }}>
                      {tagResults.map(({ nb, tags, dueLabel, dueState }) => (
                        <div key={nb.id} style={{ display:'flex', alignItems:'center', gap:8, padding:'7px 11px', borderRadius:7, border:'1px solid var(--border)', background:'var(--surfaceAlt)' }}>
                          <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="2" y="1" width="12" height="14" rx="2" stroke="currentColor" strokeWidth="1.3"/><line x1="5" y1="5" x2="11" y2="5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/><line x1="5" y1="8" x2="11" y2="8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/></svg>
                          <span style={{ fontSize:12, color:'var(--text)', fontWeight:500, flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{nb.title}</span>
                          <div style={{ display:'flex', gap:4, flexShrink:0 }}>
                            {dueLabel
                              ? <span style={{ fontSize:10, padding:'1px 5px', borderRadius:4, background:'var(--surface)', border:'1px solid var(--border)', color: dueState === 'overdue' ? '#c02020' : '#b87000' }}>{dueLabel}</span>
                              : tags?.map(t => (
                                  <span key={t} style={{ fontSize:10, padding:'1px 5px', borderRadius:4, background:'var(--surface)', border:'1px solid var(--border)', color:'var(--textDim)' }}>{t}</span>
                                ))
                            }
                          </div>
                        </div>
                      ))}
                    </div>
              })()}
            </div>

            {/* ── Connections ─────────────────────────────────────────── */}
            <div>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
                <div style={{ fontSize:10, fontWeight:700, letterSpacing:'.08em', textTransform:'uppercase', color:'var(--textDim)', opacity:.6 }}>Connections</div>
                <div style={{ display:'flex', gap:4 }}>
                  {[['list','List'],['graph','Graph']].map(([v,lbl]) => (
                    <button key={v} onClick={() => setBlView(v)} style={{
                      padding:'3px 9px', fontSize:11, fontWeight:600, borderRadius:6,
                      border:'1px solid var(--border)',
                      background: v === blView ? 'var(--accent)' : 'none',
                      color: v === blView ? '#fff' : 'var(--textDim)',
                      cursor:'pointer', fontFamily:'inherit',
                    }}>{lbl}</button>
                  ))}
                </div>
              </div>

              {blView === 'graph' ? (
                <ConnectionsTree backlinks={backlinks} forwardsLinks={forwardsLinks} />
              ) : (
                <>
                  {/* Backlinks */}
                  <div style={{ fontSize:11, fontWeight:600, color:'var(--textDim)', marginBottom:5, marginTop:2 }}>← Links to this note</div>
                  {backlinks === null ? (
                    <div style={{ display:'flex', alignItems:'center', gap:8, color:'var(--textDim)', fontSize:12, padding:'6px 0 10px' }}>
                      <div className="spinner" /><span>Scanning…</span>
                    </div>
                  ) : backlinks.length === 0 ? (
                    <div style={{ color:'var(--textDim)', fontSize:12, padding:'4px 0 10px' }}>No notes link to this one yet.</div>
                  ) : (
                    <div style={{ display:'flex', flexDirection:'column', gap:4, marginBottom:12 }}>
                      {backlinks.map(nb => (
                        <div key={nb.id} onClick={() => { const s = useAppStore.getState(); s.setActiveNotebook(nb); s.updateTab(paneTabId || activeTabId, { view: 'notebook', activeNotebook: nb }); s.setView('notebook') }} style={{ display:'flex', alignItems:'center', gap:10, padding:'7px 12px', borderRadius:8, border:'1px solid var(--border)', background:'var(--surfaceAlt)', cursor:'pointer' }}>
                          <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="2" y="1" width="12" height="14" rx="2" stroke="currentColor" strokeWidth="1.3"/><line x1="5" y1="5" x2="11" y2="5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/><line x1="5" y1="8" x2="11" y2="8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/><line x1="5" y1="11" x2="8" y2="11" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/></svg>
                          <span style={{ fontSize:12, color:'var(--text)', fontWeight:500 }}>{nb.title}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Forwards links */}
                  <div style={{ fontSize:11, fontWeight:600, color:'var(--textDim)', marginBottom:5 }}>→ Links from this note</div>
                  {forwardsLinks === null ? (
                    <div style={{ display:'flex', alignItems:'center', gap:8, color:'var(--textDim)', fontSize:12, padding:'6px 0' }}>
                      <div className="spinner" /><span>Scanning…</span>
                    </div>
                  ) : forwardsLinks.length === 0 ? (
                    <div style={{ color:'var(--textDim)', fontSize:12, padding:'4px 0' }}>No outgoing links in this note.</div>
                  ) : (
                    <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                      {forwardsLinks.map(nb => (
                        <div key={nb.id} onClick={() => { const s = useAppStore.getState(); s.setActiveNotebook(nb); s.updateTab(paneTabId || activeTabId, { view: 'notebook', activeNotebook: nb }); s.setView('notebook') }} style={{ display:'flex', alignItems:'center', gap:10, padding:'7px 12px', borderRadius:8, border:'1px solid var(--border)', background:'var(--surfaceAlt)', cursor:'pointer' }}>
                          <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="2" y="1" width="12" height="14" rx="2" stroke="currentColor" strokeWidth="1.3"/><line x1="5" y1="5" x2="11" y2="5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/><line x1="5" y1="8" x2="11" y2="8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/><line x1="5" y1="11" x2="8" y2="11" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/></svg>
                          <span style={{ fontSize:12, color:'var(--text)', fontWeight:500 }}>{nb.title}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}