// ─────────────────────────────────────────────────────────────────────────────
// bookImport.js
// Pure functions for parsing and importing books/audiobooks.
// No DOM manipulation, no global state — returns data that the store consumes.
// ─────────────────────────────────────────────────────────────────────────────

import JSZip from 'jszip'
import storage, { saveBookContent, saveAudiobookMeta, writeAudioFile } from '@/lib/storage'
import { readFileAsDataURL } from '@/lib/utils'

// ── Constants ─────────────────────────────────────────────────────────────────

const BLOCK_OPEN  = new Set(['p','div','li','tr','blockquote','section','article','figure','header','footer','main','td','th'])
const BLOCK_CLOSE = new Set(['p','div','li','tr','blockquote','section','article','figure','header','footer','main','td','th'])
const CHAPTER_RE  = /^(chapter\s+[\divxlcdm]+.*|part\s+[\divxlcdm]+.*|\bprologue\b.*|\bepilogue\b.*|\bintroduction\b.*|\bpreface\b.*)$/i

// ── Low-level helpers ─────────────────────────────────────────────────────────

const readFileAsText = (file) => new Promise((res, rej) => {
  const r = new FileReader()
  r.onload = () => res(r.result)
  r.onerror = rej
  r.readAsText(file)
})

function decodeEntities(s) {
  return s
    .replace(/&amp;/g,  '&').replace(/&lt;/g,   '<').replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g,  "'").replace(/&#160;|&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
}

function resolveHref(baseDir, href) {
  const noFrag = decodeURIComponent(href).split('#')[0]
  if (!noFrag) return null
  if (noFrag.startsWith('/')) return noFrag.slice(1)
  const parts = (baseDir + noFrag).split('/')
  const out = []
  for (const p of parts) {
    if (p === '..') out.pop()
    else if (p && p !== '.') out.push(p)
  }
  return out.join('/')
}

function getAttr(tag, name) {
  const m = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'))
  return m ? (m[1] ?? m[2] ?? null) : null
}

function zipFind(zip, path) {
  if (!path) return null
  const f = zip.file(path)
  if (f) return f
  const lo = path.toLowerCase()
  const k = Object.keys(zip.files).find(x => x.toLowerCase() === lo)
  return k ? zip.file(k) : null
}

async function loadJSZip() {
  return JSZip
}

// ── Image inliner ─────────────────────────────────────────────────────────────

const MIME_MAP = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif' }

async function inlineImages(html, zip, baseDir) {
  const full = /<img([^>]*?)(?:\/)?>/gi
  const matches = []
  let m
  while ((m = full.exec(html)) !== null) {
    const src = getAttr(m[1], 'src')
    if (src && !src.startsWith('data:')) matches.push({ match: m[0], attrs: m[1], src })
  }
  let result = html
  for (const { match, src } of matches) {
    const path  = resolveHref(baseDir, src)
    const entry = path ? zipFind(zip, path) : null
    if (!entry) continue
    const b64  = await entry.async('base64')
    const ext  = src.split('.').pop().toLowerCase().split('?')[0]
    const mime = MIME_MAP[ext] || 'image/jpeg'
    result = result.replace(match, match.replace(src, `data:${mime};base64,${b64}`))
  }
  return result
}

// ── Block parsers ─────────────────────────────────────────────────────────────

function htmlToBlocks(html) {
  let h = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<link[^>]*>/g, ' ')

  const blocks = []
  let pos = 0, textBuf = ''

  const flush = () => {
    const t = decodeEntities(textBuf.replace(/[ \t\r\n]+/g, ' ').trim())
    if (t.length > 1) blocks.push({ type: 'para', text: t })
    textBuf = ''
  }

  while (pos < h.length) {
    const lt = h.indexOf('<', pos)
    if (lt === -1) { textBuf += h.slice(pos); break }
    textBuf += h.slice(pos, lt)
    const gt = h.indexOf('>', lt)
    if (gt === -1) { textBuf += h.slice(lt); break }
    const tag   = h.slice(lt, gt + 1)
    pos = gt + 1

    const inner   = tag.slice(1, -1).trim()
    const isClose = inner.startsWith('/')
    const name    = inner.replace(/^\//, '').split(/[\s/]/)[0].toLowerCase()

    if (/^h[1-6]$/.test(name) && !isClose) {
      flush()
      const closeStr = `</${name}`
      const closeIdx = h.toLowerCase().indexOf(closeStr, pos)
      const headContent = closeIdx === -1 ? h.slice(pos) : h.slice(pos, closeIdx)
      const text = decodeEntities(headContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
      if (text) blocks.push({ type: parseInt(name[1]) === 1 ? 'heading' : 'subheading', text })
      if (closeIdx !== -1) {
        const afterGt = h.indexOf('>', closeIdx)
        pos = afterGt !== -1 ? afterGt + 1 : closeIdx + closeStr.length
      }
      continue
    }
    if (name === 'img' && !isClose) {
      flush()
      const src = getAttr(tag, 'src')
      if (src) blocks.push({ type: 'image', src })
      continue
    }
    if (BLOCK_OPEN.has(name) || BLOCK_CLOSE.has(name)) { flush(); continue }
    if (name === 'br') { textBuf += ' '; continue }
  }
  flush()
  return blocks
}

function textToBlocks(text) {
  const blocks = [], lines = text.split('\n')
  let i = 0
  while (i < lines.length) {
    const trimmed = lines[i].trim()
    if (!trimmed) { i++; continue }
    const prevBlank = i === 0 || !lines[i - 1]?.trim()
    const nextBlank = i >= lines.length - 1 || !lines[i + 1]?.trim()
    const isChapter = CHAPTER_RE.test(trimmed) && trimmed.length < 100
    const isAllCaps = trimmed === trimmed.toUpperCase() && /[A-Z]{2}/.test(trimmed) && trimmed.length < 80
    const isStandalone = prevBlank && nextBlank && trimmed.length < 65

    if (isChapter || (isAllCaps && prevBlank && nextBlank) || (isStandalone && /^[A-Z\d]/.test(trimmed))) {
      blocks.push({ type: 'heading', text: trimmed })
      i++
      continue
    }
    const paraLines = []
    while (i < lines.length && lines[i].trim()) { paraLines.push(lines[i].trim()); i++ }
    if (paraLines.length) blocks.push({ type: 'para', text: paraLines.join(' ') })
  }
  return blocks
}

function blocksToChapters(blocks) {
  const chapters = []
  let current = null
  for (const block of blocks) {
    if (block.type === 'heading') {
      if (current) chapters.push(current)
      current = { title: block.text, blocks: [block] }
    } else {
      if (!current) current = { title: 'Beginning', blocks: [] }
      current.blocks.push(block)
    }
  }
  if (current) chapters.push(current)
  if (chapters.length === 0) chapters.push({ title: 'Beginning', blocks: [] })
  return chapters
}

// ── EPUB parser ───────────────────────────────────────────────────────────────

export async function parseEpub(file) {
  const JSZip = await loadJSZip()
  const zip   = await JSZip.loadAsync(await file.arrayBuffer())

  const containerXml = await zipFind(zip, 'META-INF/container.xml')?.async('string')
  if (!containerXml) throw new Error('Invalid EPUB')

  const opfMatch = containerXml.match(/full-path\s*=\s*["']([^"']+)["']/i)
  if (!opfMatch) throw new Error('Cannot locate OPF manifest in EPUB container')
  const opfPath  = opfMatch[1].replace(/^\//, '')
  const opfDir   = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''
  const opfXml   = await zipFind(zip, opfPath)?.async('string')
  if (!opfXml) throw new Error(`Cannot read OPF file: ${opfPath}`)

  const titleM   = opfXml.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i)
  const authorM  = opfXml.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i)
  const epubTitle  = titleM  ? decodeEntities(titleM[1].trim())  : file.name.replace(/\.epub3?$/i, '')
  const epubAuthor = authorM ? decodeEntities(authorM[1].trim()) : ''

  // Build manifest
  const manifest = {}
  const itemReG = /<item\s([^>]+?)\/?>/gi
  let m
  while ((m = itemReG.exec(opfXml)) !== null) {
    const id = getAttr(m[1], 'id'), href = getAttr(m[1], 'href')
    if (id && href) manifest[id] = { href, type: getAttr(m[1], 'media-type') || '', props: getAttr(m[1], 'properties') || '' }
  }

  // Build spine early (needed for cover extraction fallback)
  const spineHrefs = []
  const itemrefRe  = /<itemref\s([^>]+?)\/?>/gi
  while ((m = itemrefRe.exec(opfXml)) !== null) {
    const idref = getAttr(m[1], 'idref')
    if (!idref || !manifest[idref]) continue
    const item = manifest[idref], t = item.type.toLowerCase(), ext = item.href.split('.').pop().toLowerCase()
    if (t.includes('html') || t.includes('xhtml') || ['html','xhtml','htm'].includes(ext) || t === '' || t === 'application/xml') {
      const r = resolveHref(opfDir, item.href)
      if (r && !spineHrefs.includes(r)) spineHrefs.push(r)
    }
  }

  // Extract cover image
  let coverDataUrl = null
  try {
    const isImageType = (id) => {
      const t = (manifest[id]?.type || '').toLowerCase()
      const h = (manifest[id]?.href || '').toLowerCase()
      return t.startsWith('image/') || /\.(jpe?g|png|gif|webp|svg)$/i.test(h)
    }
    const isHtmlType = (id) => {
      const t = (manifest[id]?.type || '').toLowerCase()
      const h = (manifest[id]?.href || '').toLowerCase()
      return t.includes('html') || t.includes('xhtml') || /\.(html?|xhtml)$/i.test(h)
    }

    // Helper: load an image manifest entry as a data URL
    const loadImageAsDataUrl = async (manifestId) => {
      const entry = manifest[manifestId]
      if (!entry) return null
      const href = resolveHref(opfDir, entry.href)
      const zipEntry = href ? zipFind(zip, href) : null
      if (!zipEntry) return null
      const data = await zipEntry.async('base64')
      return `data:${entry.type || 'image/jpeg'};base64,${data}`
    }

    // Helper: extract first <img> src from an HTML cover page and load that image
    const extractImageFromHtml = async (manifestId) => {
      const entry = manifest[manifestId]
      if (!entry) return null
      const href = resolveHref(opfDir, entry.href)
      const htmlEntry = href ? zipFind(zip, href) : null
      if (!htmlEntry) return null
      const html = await htmlEntry.async('string')
      const imgMatch = html.match(/<img[^>]+src\s*=\s*["']([^"']+)["']/i)
      if (!imgMatch) return null
      const imgSrc = imgMatch[1]
      const htmlDir = href.includes('/') ? href.slice(0, href.lastIndexOf('/') + 1) : ''
      const imgPath = resolveHref(htmlDir, imgSrc)
      const imgZipEntry = imgPath ? zipFind(zip, imgPath) : null
      if (!imgZipEntry) return null
      const imgData = await imgZipEntry.async('base64')
      const ext = imgSrc.split('.').pop()?.toLowerCase() || 'jpeg'
      const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'svg' ? 'image/svg+xml' : 'image/jpeg'
      return `data:${mime};base64,${imgData}`
    }

    // Strategy 1: explicit cover-image property
    const coverImagePropId = Object.keys(manifest).find(k => manifest[k].props.toLowerCase().includes('cover-image'))
    if (coverImagePropId) {
      if (isImageType(coverImagePropId)) {
        coverDataUrl = await loadImageAsDataUrl(coverImagePropId)
      } else if (isHtmlType(coverImagePropId)) {
        coverDataUrl = await extractImageFromHtml(coverImagePropId)
      }
    }

    // Strategy 2: manifest id named "cover" or "cover-image"
    if (!coverDataUrl) {
      const coverNameId = Object.keys(manifest).find(k => /^cover(-image)?$/i.test(k))
      if (coverNameId) {
        if (isImageType(coverNameId)) {
          coverDataUrl = await loadImageAsDataUrl(coverNameId)
        } else if (isHtmlType(coverNameId)) {
          coverDataUrl = await extractImageFromHtml(coverNameId)
        }
      }
    }

    // Strategy 3: <meta name="cover" content="..."> tag
    if (!coverDataUrl) {
      const metaCoverM = opfXml.match(/<meta\s[^>]*name\s*=\s*["']cover["'][^>]*content\s*=\s*["']([^"']+)["']/i)
                      || opfXml.match(/<meta\s[^>]*content\s*=\s*["']([^"']+)["'][^>]*name\s*=\s*["']cover["']/i)
      if (metaCoverM && manifest[metaCoverM[1]]) {
        if (isImageType(metaCoverM[1])) {
          coverDataUrl = await loadImageAsDataUrl(metaCoverM[1])
        } else if (isHtmlType(metaCoverM[1])) {
          coverDataUrl = await extractImageFromHtml(metaCoverM[1])
        }
      }
    }

    // Strategy 4: any image manifest item with "cover" in href
    if (!coverDataUrl) {
      const coverHrefId = Object.keys(manifest).find(k => isImageType(k) && manifest[k].href.toLowerCase().includes('cover'))
      if (coverHrefId) {
        coverDataUrl = await loadImageAsDataUrl(coverHrefId)
      }
    }

    // Strategy 5: extract image from first spine HTML if it looks like a cover page
    if (!coverDataUrl && spineHrefs.length > 0) {
      const firstHref = spineHrefs[0]
      const firstEntry = zipFind(zip, firstHref)
      if (firstEntry) {
        const html = await firstEntry.async('string')
        // If the first page is short (likely a cover page) and has an image, use it
        const textOnly = html.replace(/<[^>]+>/g, '').trim()
        if (textOnly.length < 200) {
          const imgMatch = html.match(/<img[^>]+src\s*=\s*["']([^"']+)["']/i)
          if (imgMatch) {
            const htmlDir = firstHref.includes('/') ? firstHref.slice(0, firstHref.lastIndexOf('/') + 1) : ''
            const imgPath = resolveHref(htmlDir, imgMatch[1])
            const imgZipEntry = imgPath ? zipFind(zip, imgPath) : null
            if (imgZipEntry) {
              const imgData = await imgZipEntry.async('base64')
              const ext = imgMatch[1].split('.').pop()?.toLowerCase() || 'jpeg'
              const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
              coverDataUrl = `data:${mime};base64,${imgData}`
            }
          }
        }
      }
    }
  } catch (e) { console.warn('[Gnos] Cover extraction failed:', e) }

  const rawFiles = await Promise.all(spineHrefs.map(async (href) => {
    const entry = zipFind(zip, href)
    if (!entry) return null
    const baseDir = href.includes('/') ? href.slice(0, href.lastIndexOf('/') + 1) : ''
    const raw  = await entry.async('string')
    const html = await inlineImages(raw, zip, baseDir)
    return { href, html }
  }))

  // Parse TOC (NCX or EPUB3 nav)
  const tocEntries = []

  const parseNcx = (xml) => {
    const navPointRe = /<navPoint[\s\S]*?<\/navPoint>/gi
    let np
    while ((np = navPointRe.exec(xml)) !== null) {
      const textM = np[0].match(/<text[^>]*>([\s\S]*?)<\/text>/i)
      const srcM  = np[0].match(/<content[^>]+src=["']([^"']+)["']/i)
      if (!textM || !srcM) continue
      const title    = decodeEntities(textM[1].replace(/<[^>]+>/g, '').trim())
      const hi       = srcM[1].indexOf('#')
      const base     = (hi === -1 ? srcM[1] : srcM[1].slice(0, hi)).split('/').pop().split('?')[0]
      const fragment = hi === -1 ? '' : srcM[1].slice(hi + 1)
      if (title && base) tocEntries.push({ title, base, fragment })
    }
  }

  const parseNav = (xml) => {
    const re = /<a\s[^>]*href=["']([^"'][^"']*?)["'][^>]*>([\s\S]*?)<\/a>/gi
    let mm
    while ((mm = re.exec(xml)) !== null) {
      const raw = mm[1]
      if (!raw || raw.startsWith('?')) continue
      const hi       = raw.indexOf('#')
      const base     = (hi === -1 ? raw : raw.slice(0, hi)).split('/').pop().split('?')[0]
      const fragment = hi === -1 ? '' : raw.slice(hi + 1)
      const title    = decodeEntities(mm[2].replace(/<[^>]+>/g, '').trim())
      if (title && base) tocEntries.push({ title, base, fragment })
    }
  }

  try {
    const navId = Object.keys(manifest).find(k => manifest[k].props.includes('nav'))
    const ncxId = Object.keys(manifest).find(k => manifest[k].type.includes('ncx') || manifest[k].href.endsWith('.ncx'))
    if (navId) {
      const navHref  = resolveHref(opfDir, manifest[navId].href)
      const navEntry = navHref ? zipFind(zip, navHref) : null
      if (navEntry) parseNav(await navEntry.async('string'))
    }
    if (ncxId) {
      const ncxHref  = resolveHref(opfDir, manifest[ncxId].href)
      const ncxEntry = ncxHref ? zipFind(zip, ncxHref) : null
      if (ncxEntry) parseNcx(await ncxEntry.async('string'))
    }
  } catch { /* skip */ }

  // Deduplicate TOC entries
  const _seen   = new Set()
  const _uEntries = tocEntries.filter(e => {
    const k = e.base + '\x00' + e.fragment
    return _seen.has(k) ? false : (_seen.add(k), true)
  })
  const tocByFile = {}
  for (const e of _uEntries) {
    if (!tocByFile[e.base]) tocByFile[e.base] = []
    tocByFile[e.base].push({ title: e.title, fragment: e.fragment })
  }
  const tocBasenames = new Set(Object.keys(tocByFile))
  const hasToc = tocBasenames.size > 0

  function splitHtmlAtFragments(html, entries) {
    const positions = entries.map(({ fragment }) => {
      if (!fragment) return 0
      const re = new RegExp(`id=["']?${fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?[\\s>]`, 'i')
      const mm = re.exec(html)
      if (!mm) return -1
      let p = mm.index
      while (p > 0 && html[p] !== '<') p--
      return p
    })
    return entries.map(({ title }, i) => {
      const start = positions[i] === -1 ? (i === 0 ? 0 : (positions[i - 1] ?? 0)) : positions[i]
      const end   = i < entries.length - 1 ? (positions[i + 1] === -1 ? html.length : positions[i + 1]) : html.length
      return { title, html: html.slice(Math.max(0, start), end) }
    })
  }

  function makeChapterBlocks(blocks, title) {
    const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (blocks[0]?.type === 'heading' || blocks[0]?.type === 'subheading') return blocks
    const fp = blocks[0]
    if (fp?.type === 'para' && norm(fp.text) === norm(title)) return [{ type: 'subheading', text: fp.text }, ...blocks.slice(1)]
    return [{ type: 'subheading', text: title }, ...blocks]
  }

  const chapters = []
  let partNum = 0

  for (const f of rawFiles) {
    if (!f) continue
    const base        = f.href.split('/').pop().split('?')[0]
    const isTocFile   = hasToc ? tocBasenames.has(base) : true
    const fileEntries = tocByFile[base] || []

    if (!isTocFile && chapters.length > 0) {
      chapters[chapters.length - 1].blocks = [...chapters[chapters.length - 1].blocks, ...htmlToBlocks(f.html)]
      continue
    }
    if (fileEntries.length > 1) {
      for (const { title, html: ph } of splitHtmlAtFragments(f.html, fileEntries)) {
        const blocks = htmlToBlocks(ph)
        if (!blocks.some(b => b.text?.trim().length > 5)) continue
        chapters.push({ title, blocks: makeChapterBlocks(blocks, title) })
      }
      continue
    }
    const blocks       = htmlToBlocks(f.html)
    if (!blocks.some(b => b.text?.trim().length > 5)) continue
    const tocTitle     = fileEntries[0]?.title
    const firstHeading = blocks.find(b => b.type === 'heading' || b.type === 'subheading')
    const title        = tocTitle || firstHeading?.text || `Part ${++partNum}`
    chapters.push({ title, blocks: makeChapterBlocks(blocks, title) })
  }

  // Fallback if TOC was empty
  if (chapters.length === 0) {
    for (const f of rawFiles) {
      if (!f) continue
      const blocks = htmlToBlocks(f.html)
      if (!blocks.some(b => b.text?.trim().length > 5)) continue
      const firstHeading = blocks.find(b => b.type === 'heading' || b.type === 'subheading')
      const title = firstHeading?.text || `Part ${++partNum}`
      const chapterBlocks = (blocks[0]?.type === 'heading' || blocks[0]?.type === 'subheading')
        ? blocks : [{ type: 'subheading', text: title }, ...blocks]
      chapters.push({ title, blocks: chapterBlocks })
    }
  }

  if (chapters.length === 0) throw new Error('Could not extract any text')
  return { title: epubTitle, author: epubAuthor, chapters, coverDataUrl }
}

// ── Book ID generator ─────────────────────────────────────────────────────────

function makeBookId(prefix = 'book') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
}

// ── importBooks — handles EPUB / TXT / MD files ───────────────────────────────
//
// Returns { added: BookEntry[], errors: string[] }
// Caller is responsible for pushing to the store and persisting.

export async function importBooks(files) {
  const added  = []
  const errors = []

  for (const file of Array.from(files)) {
    if (file.name.startsWith('.')) continue
    const nameMatchesKnown = /\.(txt|md|epub3?|pdf)$/i.test(file.name)
    const mimeIsEpub = /^application\/(epub\+zip|epub)$/i.test(file.type)
    const mimeIsKnown = /^(text\/(plain|markdown)|application\/(pdf|zip|epub\+zip|epub))$/i.test(file.type)
    if (!nameMatchesKnown && !mimeIsEpub && !mimeIsKnown) continue

    try {
      const isEpub = /\.epub3?$/i.test(file.name) || mimeIsEpub
      const isMd   = /\.md$/i.test(file.name)
      const isPdf  = /\.pdf$/i.test(file.name)
      let bookTitle, bookAuthor = '', chapters, format, coverDataUrl = null, pdfDataUrl = null

      if (isEpub) {
        format = 'epub'
        const parsed = await parseEpub(file)
        bookTitle    = parsed.title
        bookAuthor   = parsed.author
        chapters     = parsed.chapters
        coverDataUrl = parsed.coverDataUrl || null
      } else if (isPdf) {
        format      = 'pdf'
        bookTitle   = file.name.replace(/\.pdf$/i, '').replace(/[_-]/g, ' ').trim()
        pdfDataUrl  = await readFileAsDataURL(file)
        // Minimal placeholder chapters — actual rendering done by PdfView
        chapters    = [{ title: bookTitle, blocks: [{ type: 'para', text: bookTitle }] }]
        // Generate cover thumbnail from first page
        try {
          let pdfjsLib = window.pdfjsLib
          if (!pdfjsLib) {
            await new Promise((res, rej) => {
              const s = document.createElement('script')
              s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
              s.onload = () => {
                window.pdfjsLib.GlobalWorkerOptions.workerSrc =
                  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
                res()
              }
              s.onerror = rej
              document.head.appendChild(s)
            })
            pdfjsLib = window.pdfjsLib
          }
          const pdfDoc = await pdfjsLib.getDocument({ url: pdfDataUrl }).promise
          const firstPage = await pdfDoc.getPage(1)
          const rawVp = firstPage.getViewport({ scale: 1 })
          const dpr = window.devicePixelRatio || 1
          const thumbScale = Math.min(280 / rawVp.width, 380 / rawVp.height) * dpr
          const thumbVp = firstPage.getViewport({ scale: thumbScale })
          const offscreen = document.createElement('canvas')
          offscreen.width  = thumbVp.width
          offscreen.height = thumbVp.height
          const octx = offscreen.getContext('2d')
          await firstPage.render({ canvasContext: octx, viewport: thumbVp }).promise
          coverDataUrl = offscreen.toDataURL('image/jpeg', 0.9)
          pdfDoc.destroy()
        } catch { /* non-fatal — cover stays null */ }
      } else {
        format    = isMd ? 'md' : 'txt'
        const text = await readFileAsText(file)
        bookTitle  = file.name.replace(/\.(txt|md)$/i, '').replace(/[_-]/g, ' ')
        chapters   = blocksToChapters(textToBlocks(text))
      }

      const id = makeBookId('book')
      const bookEntry = {
        id, title: bookTitle, author: bookAuthor, format,
        totalChapters: chapters.length,
        currentChapter: 0, currentPage: 0,
        addedAt: new Date().toISOString(),
        hasAudio: false,
        coverDataUrl: coverDataUrl || null,
        pdfDataUrl: pdfDataUrl || null,
      }
      await saveBookContent(bookEntry, chapters)
      added.push(bookEntry)
    } catch (err) {
      console.error('Book import error:', err)
      errors.push(`"${file.name}" — ${err.message || 'unknown error'}`)
    }
  }
  return { added, errors }
}

// ── importAudioFile — single standalone audio file ────────────────────────────

export async function importAudioFile(file) {
  if (!/\.(mp3|m4b|m4a|wav|ogg|flac|aac|opus)$/i.test(file.name) && !file.type.startsWith('audio/')) {
    throw new Error('Not a supported audio format')
  }
  const ext   = file.name.split('.').pop().toLowerCase()
  const id    = makeBookId('audio')
  const title = file.name
    .replace(/\.(mp3|m4b|m4a|wav|ogg|flac|aac|opus)$/i, '')
    .replace(/[_-]/g, ' ')
    .trim()

  const book = {
    id, title, author: '', type: 'audio', format: 'audio',
    audioExt: ext, hasAudio: true,
    totalChapters: 1, currentChapter: 0, currentPage: 0,
    addedAt: new Date().toISOString(),
    coverDataUrl: null,
  }

  // Write raw audio bytes directly to disk — no base64 overhead
  const bytes = new Uint8Array(await file.arrayBuffer())
  await writeAudioFile(book, `audio.${ext}`, bytes)
  await saveAudiobookMeta(book)
  return book
}

// ── importAudioFolder — folder of chapter files → one multi-chapter entry ─────

export async function importAudioFolder(files) {
  const audioFiles = Array.from(files)
    .filter(f => /\.(mp3|m4b|m4a|wav|ogg|flac|aac|opus)$/i.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))

  if (!audioFiles.length) throw new Error('No audio files found in folder')

  const folderName = audioFiles[0].webkitRelativePath
    ? audioFiles[0].webkitRelativePath.split('/')[0]
    : audioFiles[0].name.replace(/\.(mp3|m4b|m4a|wav|ogg|flac|aac|opus)$/i, '')

  const id = makeBookId('audio')

  // Build book object first so writeAudioFile can resolve the folder path
  const book = {
    id,
    title: folderName, author: '', type: 'audio', format: 'audiofolder',
    audioChapters: [],
    hasAudio: true, totalChapters: audioFiles.length,
    currentChapter: 0, currentPage: 0,
    addedAt: new Date().toISOString(),
    coverDataUrl: null,
  }

  const chapters = []
  for (let i = 0; i < audioFiles.length; i++) {
    const file  = audioFiles[i]
    const ext   = file.name.split('.').pop().toLowerCase()
    const chapterTitle = file.name
      .replace(/\.(mp3|m4b|m4a|wav|ogg|flac|aac|opus)$/i, '')
      .replace(/[_-]/g, ' ')
      .trim()
    // Write raw bytes directly — no base64 overhead
    const bytes = new Uint8Array(await file.arrayBuffer())
    await writeAudioFile(book, `chapter_${i}.${ext}`, bytes)
    chapters.push({ title: chapterTitle, index: i, ext })
  }

  book.audioChapters = chapters
  await saveAudiobookMeta(book)
  return book
}