// ============================================================================
// STORAGE POLYFILL & CONSTANTS
// ============================================================================
window.storage = window.storage || {
  get: async (k) => { const v = localStorage.getItem(k); return v !== null ? { value: v } : null; },
  set: async (k, v) => localStorage.setItem(k, v),
  delete: async (k) => localStorage.removeItem(k)
};

const CHUNK_SIZE = 100;
const MAX_SINGLE_KB = 4_500_000;
const BLOCK_OPEN = new Set(["p","div","li","tr","blockquote","section","article","figure","header","footer","main","td","th"]);
const BLOCK_CLOSE = new Set(["p","div","li","tr","blockquote","section","article","figure","header","footer","main","td","th"]);
const CHAPTER_RE = /^(chapter\s+[\divxlcdm]+.*|part\s+[\divxlcdm]+.*|\bprologue\b.*|\bepilogue\b.*|\bintroduction\b.*|\bpreface\b.*)$/i;

const BUILT_IN_THEMES = {
  dark: {
    name: "Dark",
    bg: "#0d1117", surface: "#161b22", surfaceAlt: "#21262d", border: "#30363d", borderSubtle: "#21262d",
    text: "#e6edf3", textMuted: "#8b949e", textDim: "#6e7681", textDisabled: "#3d444d",
    accent: "#388bfd", accentSecondary: "#a371f7", readerBg: "#111820", readerCard: "#161b22", readerText: "#cdd9e5",
    headerBg: "#0d1117", progressTrack: "#21262d", buttonBorder: "#30363d", addBookBorder: "#30363d",
    addBookBg: "rgba(56,139,253,0.04)", addBookHover: "rgba(56,139,253,0.09)", addBookIcon: "#388bfd", addBookText: "#8b949e", tagBg: "#21262d"
  },
  light: {
    name: "Light (Cream)",
    bg: "#f5f0e8", surface: "#fdfaf4", surfaceAlt: "#ede8dc", border: "#d5cfc3", borderSubtle: "#e8e2d6",
    text: "#2c2416", textMuted: "#7a6e5e", textDim: "#9a8e7e", textDisabled: "#c5bfb3",
    accent: "#7c6034", accentSecondary: "#a0522d", readerBg: "#f0ebe0", readerCard: "#fdfaf4", readerText: "#3a2e1e",
    headerBg: "#fdfaf4", progressTrack: "#ddd7cb", buttonBorder: "#c8c2b6", addBookBorder: "#c8c2b6",
    addBookBg: "rgba(124,96,52,0.04)", addBookHover: "rgba(124,96,52,0.09)", addBookIcon: "#7c6034", addBookText: "#7a6e5e", tagBg: "#ede8dc"
  }
};

// ============================================================================
// STATE
// ============================================================================
const state = {
  view: "library",
  library: [],
  activeBook: null,
  pages: [],
  currentPage: 0,
  themeKey: "dark",
  customThemes: {},
  tapToTurn: true,
  twoPage: false,
  fontSize: 18,
  lineSpacing: 1.8,
  fontFamily: "Georgia, serif",
  audioSrc: null,
  isPlaying: false,
  searchQuery: ""
};

// ============================================================================
// UTILITIES & PARSING
// ============================================================================
const readFileAsText = (file) => new Promise((res, rej) => {
  const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(file);
});
const readFileAsDataURL = (file) => new Promise((res, rej) => {
  const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file);
});

function decodeEntities(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#160;|&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

function resolveHref(baseDir, href) {
  const noFrag = decodeURIComponent(href).split("#")[0];
  if (!noFrag) return null;
  if (noFrag.startsWith("/")) return noFrag.slice(1);
  const parts = (baseDir + noFrag).split("/");
  const out = [];
  for (const p of parts) { if (p === "..") out.pop(); else if (p && p !== ".") out.push(p); }
  return out.join("/");
}

function getAttr(tag, name) {
  const m = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return m ? (m[1] ?? m[2] ?? null) : null;
}

function zipFind(zip, path) {
  if (!path) return null;
  const f = zip.file(path); if (f) return f;
  const lo = path.toLowerCase();
  const k = Object.keys(zip.files).find((x) => x.toLowerCase() === lo);
  return k ? zip.file(k) : null;
}

function generateCoverColor(title) {
  const pairs = [
    ["#2C3E50","#3498DB"],["#1A1A2E","#E94560"],["#0F3460","#533483"],["#16213E","#0F3460"],
    ["#1B262C","#0F4C75"],["#2C2C54","#706FD3"],["#1C1C1C","#636E72"],["#2D3436","#6C5CE7"],
    ["#1E3799","#4A69BD"],["#192a56","#218c74"],["#4a1942","#c0392b"],["#1a3c34","#27ae60"],
  ];
  let h = 0;
  for (let i=0; i<title.length; i++) h = (h * 31 + title.charCodeAt(i)) & 0xffffffff;
  return pairs[Math.abs(h) % pairs.length];
}

function countWords(str) {
  let n = 0, inW = false;
  for (let i = 0; i < str.length; i++) {
    const ws = str.charCodeAt(i) <= 32;
    if (!ws && !inW) { n++; inW = true; } else if (ws) inW = false;
  }
  return n;
}

// Calculate dynamic words per page based on reader window bounds
function getWordsPerPage() {
  const maxW = Math.min(window.innerWidth - 48, 680); 
  const maxH = window.innerHeight - 200; // Account for headers/footers
  const charArea = (state.fontSize * 0.6) * (state.fontSize * state.lineSpacing);
  const chars = (maxW * maxH) / charArea;
  // Estimate ~6 characters per word, with a 100 word minimum safeguard
  return Math.max(100, Math.floor(chars / 6));
}

function splitParaByWords(text, maxWords) {
  if (countWords(text) <= maxWords) return [text];
  const sentenceRe = /[^.!?]+[.!?]+["\u2019\u201d]?\s*/g;
  const sentences = text.match(sentenceRe) || [];
  if (sentences.length <= 1) {
    const words = text.split(/\s+/); const chunks = [];
    for (let i = 0; i < words.length; i += maxWords) chunks.push(words.slice(i, i + maxWords).join(" "));
    return chunks.length ? chunks : [text];
  }
  const chunks = []; let buf = "", bufW = 0;
  for (const s of sentences) {
    const sw = countWords(s);
    if (bufW > 0 && bufW + sw > maxWords) { chunks.push(buf.trimEnd()); buf = ""; bufW = 0; }
    buf += s; bufW += sw;
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks.length ? chunks : [text];
}

function htmlToBlocks(html) {
  let h = html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<link[^>]*>/g, " ");
  const blocks = []; let pos = 0, textBuf = "";

  const flush = () => {
    const t = decodeEntities(textBuf.replace(/[ \t\r\n]+/g, " ").trim());
    if (t.length > 1) blocks.push({ type: "para", text: t });
    textBuf = "";
  };

  while (pos < h.length) {
    const lt = h.indexOf("<", pos);
    if (lt === -1) { textBuf += h.slice(pos); break; }
    textBuf += h.slice(pos, lt);
    const gt = h.indexOf(">", lt);
    if (gt === -1) { textBuf += h.slice(lt); break; }
    const tag = h.slice(lt, gt + 1);
    pos = gt + 1;

    const inner = tag.slice(1, -1).trim();
    const isClose = inner.startsWith("/");
    const name = inner.replace(/^\//, "").split(/[\s/]/)[0].toLowerCase();

    if (/^h[1-6]$/.test(name) && !isClose) {
      flush();
      const closeStr = `</${name}`; const closeIdx = h.toLowerCase().indexOf(closeStr, pos);
      const headContent = closeIdx === -1 ? h.slice(pos) : h.slice(pos, closeIdx);
      const text = decodeEntities(headContent.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
      if (text) blocks.push({ type: parseInt(name[1]) === 1 ? "heading" : "subheading", text });
      if (closeIdx !== -1) { const afterGt = h.indexOf(">", closeIdx); pos = afterGt !== -1 ? afterGt + 1 : closeIdx + closeStr.length; }
      continue;
    }
    if (BLOCK_OPEN.has(name) || BLOCK_CLOSE.has(name)) { flush(); continue; }
    if (name === "br") { textBuf += " "; continue; }
  }
  flush(); return blocks;
}

function splitBlocksIntoPages(blocks, wordsPerPage) {
  const pages = []; let cur = [], curWords = 0, isChapterPage = false;
  const flush = () => { if (cur.length > 0) { pages.push(cur); cur = []; curWords = 0; isChapterPage = false; } };

  for (const block of blocks) {
    if (block.type === "heading") { flush(); cur.push(block); isChapterPage = true; continue; }
    if (block.type === "subheading") { if (isChapterPage && curWords === 0) { cur.push(block); } else { flush(); cur.push(block); isChapterPage = true; } continue; }
    if (isChapterPage) flush();
    const parts = splitParaByWords(block.text, wordsPerPage);
    for (const part of parts) {
      const pw = countWords(part);
      if (pw >= wordsPerPage) { if (cur.length > 0) flush(); cur.push({ type: "para", text: part }); flush(); continue; }
      if (curWords > 0 && curWords + pw > wordsPerPage) flush();
      cur.push({ type: "para", text: part }); curWords += pw;
    }
  }
  flush(); return pages.length > 0 ? pages : [[{ type: "para", text: "" }]];
}

function deriveChaptersFromPages(pages) {
  const chapters = [];
  for (let i = 0; i < pages.length; i++) {
    const pg = pages[i];
    if (!Array.isArray(pg) || pg.length === 0) continue;
    if (pg.every((b) => b.type === "heading" || b.type === "subheading")) {
      const h = pg.find((b) => b.type === "heading"), s = pg.find((b) => b.type === "subheading");
      chapters.push({ title: h?.text || s?.text || `Section ${chapters.length + 1}`, pageIndex: i });
    }
  }
  if (chapters.length === 0) chapters.push({ title: "Beginning", pageIndex: 0 });
  return chapters;
}

function textToBlocks(text) {
  const blocks = [], lines = text.split("\n"); let i = 0;
  while (i < lines.length) {
    const raw = lines[i], trimmed = raw.trim();
    if (!trimmed) { i++; continue; }
    const prevBlank = i === 0 || !lines[i - 1]?.trim(), nextBlank = i >= lines.length - 1 || !lines[i + 1]?.trim();
    const isChapter = CHAPTER_RE.test(trimmed) && trimmed.length < 100;
    const isAllCaps = trimmed === trimmed.toUpperCase() && /[A-Z]{2}/.test(trimmed) && trimmed.length < 80;
    const isStandalone = prevBlank && nextBlank && trimmed.length < 65;

    if (isChapter || (isAllCaps && prevBlank && nextBlank) || (isStandalone && /^[A-Z\d]/.test(trimmed))) { blocks.push({ type: "heading", text: trimmed }); i++; continue; }
    const paraLines = []; while (i < lines.length && lines[i].trim()) { paraLines.push(lines[i].trim()); i++; }
    if (paraLines.length) blocks.push({ type: "para", text: paraLines.join(" ") });
  }
  return blocks;
}

async function loadJSZip() {
  if (window.JSZip) return window.JSZip;
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
    s.onload = () => resolve(window.JSZip); s.onerror = reject; document.head.appendChild(s);
  });
}

async function parseEpub(file) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const containerXml = await zipFind(zip, "META-INF/container.xml")?.async("string");
  if (!containerXml) throw new Error("Invalid EPUB");
  const opfMatch = containerXml.match(/full-path\s*=\s*["']([^"']+)["']/i);
  const opfPath = opfMatch[1].replace(/^\//, "");
  const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const opfXml = await zipFind(zip, opfPath)?.async("string");

  const titleM = opfXml.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i);
  const authorM = opfXml.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i);
  const epubTitle = titleM ? decodeEntities(titleM[1].trim()) : file.name.replace(/\.epub3?$/i, "");
  const epubAuthor = authorM ? decodeEntities(authorM[1].trim()) : "";

  const manifest = {};
  let m, itemRe = /<item\s([^>]+?)\/?>(?:<\/item>)?/gi;
  while ((m = itemRe.exec(opfXml)) !== null) {
    const id = getAttr(m[1], "id"), href = getAttr(m[1], "href");
    if (id && href) manifest[id] = { href, type: getAttr(m[1], "media-type") || "", props: getAttr(m[1], "properties") || "" };
  }

  const spineHrefs = [];
  const itemrefRe = /<itemref\s([^>]+?)\/?>(?:<\/itemref>)?/gi;
  while ((m = itemrefRe.exec(opfXml)) !== null) {
    const idref = getAttr(m[1], "idref"); if (!idref || !manifest[idref]) continue;
    const item = manifest[idref], t = item.type.toLowerCase(), ext = item.href.split(".").pop().toLowerCase();
    if (t.includes("html") || t.includes("xhtml") || ["html","xhtml","htm"].includes(ext) || t === "" || t === "application/xml") {
      const r = resolveHref(opfDir, item.href); if (r && !spineHrefs.includes(r)) spineHrefs.push(r);
    }
  }

  const tocMap = {};
  const rawFiles = await Promise.all(spineHrefs.map(async (href) => {
    const entry = zipFind(zip, href); return entry ? { href, html: await entry.async("string") } : null;
  }));

  const allPages = [];
  const dynamicWordsPerPage = getWordsPerPage();
  
  for (const f of rawFiles) {
    if (!f) continue;
    const blocks = htmlToBlocks(f.html);
    if (!blocks.some((b) => b.text.trim().length > 5)) continue;
    if (tocMap[f.href] && blocks[0]?.text !== tocMap[f.href]) blocks.unshift({ type: "heading", text: tocMap[f.href] });
    for (const pg of splitBlocksIntoPages(blocks, dynamicWordsPerPage)) allPages.push(pg);
  }

  if (allPages.length === 0) throw new Error("Could not extract any text");
  return { title: epubTitle, author: epubAuthor, pages: allPages, chapters: deriveChaptersFromPages(allPages) };
}

// ============================================================================
// APP LOGIC & RENDERING
// ============================================================================

async function initApp() {
  const libMeta = await window.storage.get("library_meta");
  if (libMeta) state.library = JSON.parse(libMeta.value);
  const themeData = await window.storage.get("app_theme");
  if (themeData) {
    const parsed = JSON.parse(themeData.value);
    state.themeKey = parsed.themeKey || "dark";
    state.customThemes = parsed.customThemes || {};
    if (parsed.tapToTurn !== undefined) state.tapToTurn = parsed.tapToTurn;
    if (parsed.twoPage !== undefined) state.twoPage = parsed.twoPage;
  }
  
  applyTheme(state.themeKey);
  renderLibrary();

  // Attach global listeners
  document.getElementById('library-search').oninput = (e) => { state.searchQuery = e.target.value.toLowerCase(); renderLibrary(); };
  document.getElementById('btn-add-book').onclick = () => document.getElementById('file-input').click();
  document.getElementById('btn-settings').onclick = () => openModal('settings-modal');
  document.getElementById('btn-close-settings').onclick = () => closeModal('settings-modal');
  document.getElementById('btn-exit-reader').onclick = exitReader;
  
  document.getElementById('file-input').onchange = handleFileUpload;
  document.getElementById('folder-input').onchange = handleFileUpload; // Used in library settings
  document.getElementById('audio-input').onchange = handleAudioUpload;
  
  document.querySelectorAll('.tab').forEach(t => t.onclick = (e) => switchModalTab(e.target.dataset.tab));

  // Reader listeners
  document.getElementById('btn-prev-page').onclick = prevPage;
  document.getElementById('btn-next-page').onclick = nextPage;
  document.getElementById('tap-zone-prev').onclick = prevPage;
  document.getElementById('tap-zone-next').onclick = nextPage;
  document.getElementById('btn-toggle-audio').onclick = toggleAudio;
  document.getElementById('btn-upload-audio').onclick = () => document.getElementById('audio-input').click();
  document.getElementById('btn-reader-settings').onclick = () => document.getElementById('reader-settings-panel').classList.toggle('hidden');
  document.getElementById('btn-chapter-drop').onclick = () => {
    document.getElementById('chapter-dropdown').classList.toggle('hidden');
    document.getElementById('chapter-search').value = '';
    buildChapterDropdown();
  };

  window.addEventListener('keydown', (e) => {
    if (state.view !== 'reader') return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") nextPage();
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") prevPage();
    else if (e.key === "Escape") {
      document.getElementById('reader-settings-panel').classList.add('hidden');
      document.getElementById('chapter-dropdown').classList.add('hidden');
    }
  });

  // Audio events
  document.getElementById('audio-player').onended = () => { state.isPlaying = false; updateAudioBtn(); };
}

function switchView(view) {
  state.view = view;
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  document.getElementById(`${view}-view`).classList.add('active');
}

function applyTheme(key) {
  const allThemes = { ...BUILT_IN_THEMES, ...state.customThemes };
  const theme = allThemes[key] || BUILT_IN_THEMES.dark;
  const root = document.documentElement;
  Object.keys(theme).forEach(prop => root.style.setProperty(`--${prop}`, theme[prop]));
}

async function renderLibrary() {
  const grid = document.getElementById('library-grid');
  Array.from(grid.children).forEach(c => { if(c.id !== 'add-book-card') c.remove(); });

  const filteredLibrary = state.library.filter(b => 
    b.title.toLowerCase().includes(state.searchQuery) || 
    (b.author && b.author.toLowerCase().includes(state.searchQuery))
  );

  if (filteredLibrary.length === 0 && !state.searchQuery) {
    document.getElementById('empty-state').classList.remove('hidden');
    document.getElementById('library-header-text').classList.add('hidden');
  } else {
    document.getElementById('empty-state').classList.add('hidden');
    document.getElementById('library-header-text').classList.remove('hidden');
    document.getElementById('library-count').textContent = `${filteredLibrary.length} book${filteredLibrary.length !== 1 ? 's' : ''}`;
  }

  filteredLibrary.forEach(book => {
    const [c1, c2] = generateCoverColor(book.title);
    const pct = book.totalPages > 1 ? (book.currentPage / (book.totalPages - 1)) * 100 : 0;
    const fmt = (book.format === "epub" || book.format === "epub3") ? "EPUB" : (book.format?.toUpperCase() || "TXT");

    const el = document.createElement('div');
    el.className = 'book-card-container';
    el.innerHTML = `
      <div class="book-cover" style="--c1:${c1}; --c2:${c2}">
        <div class="cover-spine"></div><div class="cover-crease"></div><div class="cover-edge"></div>
        <div class="cover-title">${book.title}</div>
        ${book.author ? `<div class="cover-author">${book.author}</div>` : ''}
        <div class="cover-badge">${fmt}</div>
        ${book.hasAudio ? `<div class="cover-audio">🎵</div>` : ''}
        <div class="cover-prog-bg"><div class="cover-prog-fill" style="width:${pct}%"></div></div>
      </div>
      <div class="book-meta">
        <div class="meta-text">
          <div class="meta-title">${book.title}</div>
          ${book.author ? `<div class="meta-author">${book.author}</div>` : ''}
          <div class="meta-prog-row">
            <div class="meta-prog-track"><div class="meta-prog-fill" style="width:${pct}%"></div></div>
            <span class="meta-prog-pct">${Math.round(pct)}%</span>
          </div>
        </div>
        <button class="btn-dots">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="3" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="13" cy="8" r="1.5"/></svg>
        </button>
      </div>
      <div class="context-menu hidden">
        <button class="ctx-item reset-btn"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 8a5 5 0 1 1 1 3.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><polyline points="1,5 3,8 6,6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Reset progress</button>
        <button class="ctx-item danger delete-btn"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M6 4V2h4v2M5 4l1 9h4l1-9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Delete book</button>
      </div>
    `;

    el.querySelector('.book-cover').onclick = () => openBook(book);
    const menu = el.querySelector('.context-menu');
    el.querySelector('.btn-dots').onclick = (e) => {
      e.stopPropagation();
      document.querySelectorAll('.context-menu').forEach(m => { if(m !== menu) m.classList.add('hidden'); });
      menu.classList.toggle('hidden');
    };
    el.querySelector('.reset-btn').onclick = (e) => { e.stopPropagation(); resetBookProgress(book.id); menu.classList.add('hidden'); };
    el.querySelector('.delete-btn').onclick = (e) => { e.stopPropagation(); deleteBook(book.id); menu.classList.add('hidden'); };

    grid.insertBefore(el, document.getElementById('add-book-card'));
  });
}

async function openBook(book) {
  document.getElementById('loading-state').classList.remove('hidden');
  const pages = await loadBookContent(book.id);
  document.getElementById('loading-state').classList.add('hidden');
  
  if (pages) {
    state.activeBook = book;
    state.pages = pages;
    state.currentPage = book.currentPage || 0;
    
    const audSrc = await window.storage.get(`audio_${book.id}`);
    state.audioSrc = audSrc ? audSrc.value : null;
    const player = document.getElementById('audio-player');
    if (state.audioSrc) player.src = state.audioSrc;
    updateAudioBtn();

    switchView('reader');
    renderReader();
  }
}

function exitReader() {
  state.activeBook = null;
  state.pages = [];
  document.getElementById('audio-player').pause();
  state.isPlaying = false;
  switchView('library');
  renderLibrary(); 
}

function renderReader() {
  document.getElementById('reader-book-title').textContent = state.activeBook.title;
  buildChapterDropdown();
  buildReaderSettings();
  updateReaderNav();
  renderPage();
}

function formatChapterTitle(title, index) {
  return title.toLowerCase().includes('chapter') ? title : `Chapter ${index + 1}: ${title}`;
}

function buildChapterDropdown() {
  const chaps = state.activeBook.chapters || [];
  const list = document.getElementById('chapter-list');
  const q = document.getElementById('chapter-search')?.value.toLowerCase() || "";
  
  list.innerHTML = '';
  document.getElementById('drop-book-title').textContent = state.activeBook.title;
  document.getElementById('drop-book-stats').textContent = `${chaps.length} chapter(s) · ${state.pages.length} pages`;
  
  const activeIdx = chaps.reduce((best, ch, i) => ch.pageIndex <= state.currentPage ? i : best, 0);
  
  chaps.forEach((ch, i) => {
    const displayTitle = formatChapterTitle(ch.title, i);
    if (q && !displayTitle.toLowerCase().includes(q)) return;

    const nextP = chaps[i+1]?.pageIndex ?? state.pages.length;
    const len = nextP - ch.pageIndex;
    const el = document.createElement('div');
    el.className = `chapter-item ${i === activeIdx ? 'active' : ''}`;
    el.innerHTML = `<div class="ch-flex"><div class="ch-title">${displayTitle}</div><span class="ch-pgs">${len}p</span></div><div class="ch-sub">Page ${(ch.pageIndex||0)+1}</div>`;
    el.onclick = () => {
      state.currentPage = ch.pageIndex || 0;
      updateProgress(state.currentPage);
      document.getElementById('chapter-dropdown').classList.add('hidden');
    };
    list.appendChild(el);
  });
  
  document.getElementById('chapter-search').oninput = buildChapterDropdown;
}

function buildReaderSettings() {
  const panel = document.getElementById('reader-settings-panel');
  panel.innerHTML = `
    <div class="section-label">DISPLAY</div>
    <label style="display:block; margin-bottom:12px; font-size:12px;">
      <div style="display:flex; justify-content:space-between; margin-bottom:5px;"><span>Font Size</span><span style="color:var(--textDim)">${state.fontSize}px</span></div>
      <input type="range" id="fs-slider" min="14" max="28" step="1" value="${state.fontSize}">
    </label>
    <label style="display:block; margin-bottom:12px; font-size:12px;">
      <div style="display:flex; justify-content:space-between; margin-bottom:5px;"><span>Line Spacing</span><span style="color:var(--textDim)">${state.lineSpacing}</span></div>
      <input type="range" id="ls-slider" min="1.4" max="2.4" step="0.1" value="${state.lineSpacing}">
    </label>
    <label style="display:block; font-size:12px;">
      <div style="margin-bottom:5px;">Font</div>
      <select id="font-select">
        <option value="Georgia, serif" ${state.fontFamily.includes('Georgia')?'selected':''}>Georgia</option>
        <option value="'Palatino Linotype', serif" ${state.fontFamily.includes('Palatino')?'selected':''}>Palatino</option>
        <option value="system-ui, sans-serif" ${state.fontFamily.includes('system')?'selected':''}>System UI</option>
      </select>
    </label>
    <div style="margin-top:14px; padding-top:14px; border-top:1px solid var(--borderSubtle)">
      <div class="section-label">NAVIGATION & LAYOUT</div>
      <label style="display:flex; align-items:center; justify-content:space-between; cursor:pointer; margin-bottom:10px;">
        <div>
          <div style="font-size:12px; font-weight:500;">Tap margins to turn</div>
        </div>
        <div id="tap-toggle" style="width:36px; height:20px; border-radius:10px; background:${state.tapToTurn?'var(--accent)':'var(--borderSubtle)'}; position:relative;">
          <div style="position:absolute; top:2px; left:${state.tapToTurn?'18px':'2px'}; width:16px; height:16px; border-radius:50%; background:#fff; transition:left 0.2s;"></div>
        </div>
      </label>
      <label style="display:flex; align-items:center; justify-content:space-between; cursor:pointer;">
        <div>
          <div style="font-size:12px; font-weight:500;">Two-page spread</div>
        </div>
        <div id="two-page-toggle" style="width:36px; height:20px; border-radius:10px; background:${state.twoPage?'var(--accent)':'var(--borderSubtle)'}; position:relative;">
          <div style="position:absolute; top:2px; left:${state.twoPage?'18px':'2px'}; width:16px; height:16px; border-radius:50%; background:#fff; transition:left 0.2s;"></div>
        </div>
      </label>
    </div>
  `;

  document.getElementById('fs-slider').oninput = (e) => { state.fontSize = +e.target.value; renderPage(); e.target.previousElementSibling.lastElementChild.textContent = `${state.fontSize}px`; };
  document.getElementById('ls-slider').oninput = (e) => { state.lineSpacing = +e.target.value; renderPage(); e.target.previousElementSibling.lastElementChild.textContent = state.lineSpacing; };
  document.getElementById('font-select').onchange = (e) => { state.fontFamily = e.target.value; renderPage(); };
  
  const savePreferences = () => window.storage.set("app_theme", JSON.stringify({ themeKey: state.themeKey, customThemes: state.customThemes, tapToTurn: state.tapToTurn, twoPage: state.twoPage }));

  document.getElementById('tap-toggle').onclick = () => {
    state.tapToTurn = !state.tapToTurn;
    buildReaderSettings(); updateReaderNav();
    savePreferences();
  };
  
  document.getElementById('two-page-toggle').onclick = () => {
    state.twoPage = !state.twoPage;
    buildReaderSettings(); renderPage();
    savePreferences();
  };
}

function constructPageDOM(pageData) {
  const container = document.createElement('div');
  container.style.fontFamily = state.fontFamily;

  if (typeof pageData === "string") {
    container.innerHTML = `<div style="color:var(--readerText); min-height:400px;"><p style="font-size:${state.fontSize}px; line-height:${state.lineSpacing}; margin:0; text-align:justify; word-break:break-word;">${decodeEntities(pageData)}</p></div>`;
    return container;
  }

  const isChapterStart = pageData.every(b => b.type === "heading" || b.type === "subheading");

  if (isChapterStart) {
    const h = pageData.find((b) => b.type === "heading");
    const s = pageData.find((b) => b.type === "subheading");
    container.innerHTML = `
      <div style="font-family:'Georgia, serif'; color:var(--readerText); min-height:420px; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:${Math.round(state.fontSize * 3)}px 0;">
        <div style="width:48px; height:2px; background:var(--accent); border-radius:1px; margin-bottom:${Math.round(state.fontSize * 2.5)}px; opacity:0.6;"></div>
        ${h ? `<div style="font-size:${Math.round(state.fontSize * 2.0)}px; font-weight:700; line-height:1.2; letter-spacing:-0.02em; margin-bottom:${s?Math.round(state.fontSize*1):0}px;">${h.text}</div>` : ''}
        ${s ? `<div style="font-size:${Math.round(state.fontSize * 1.2)}px; font-weight:400; line-height:1.4; opacity:0.65; font-style:italic; margin-top:${Math.round(state.fontSize*0.5)}px;">${s.text}</div>` : ''}
        <div style="width:48px; height:2px; background:var(--accent); border-radius:1px; margin-top:${Math.round(state.fontSize * 2.5)}px; opacity:0.6;"></div>
      </div>
    `;
    return container;
  }

  pageData.forEach((block, i) => {
    if (!block?.text?.trim()) return;
    const el = document.createElement(block.type === 'para' ? 'p' : 'div');
    
    if (block.type === 'heading') {
      el.style.cssText = `font-family:Georgia,serif; font-size:${Math.round(state.fontSize*1.4)}px; font-weight:700; line-height:1.25; margin-top:${i===0?0:Math.round(state.fontSize*1.8)}px; margin-bottom:${Math.round(state.fontSize*0.9)}px; padding-bottom:${Math.round(state.fontSize*0.4)}px; border-bottom:1px solid var(--borderSubtle);`;
    } else if (block.type === 'subheading') {
      el.style.cssText = `font-family:Georgia,serif; font-size:${Math.round(state.fontSize*1.15)}px; font-weight:600; line-height:1.35; opacity:0.85; margin-top:${i===0?0:Math.round(state.fontSize*1.2)}px; margin-bottom:${Math.round(state.fontSize*0.55)}px;`;
    } else {
      const prevIsNonPara = i === 0 || pageData[i - 1]?.type !== "para";
      el.style.cssText = `font-size:${state.fontSize}px; line-height:${state.lineSpacing}; margin:0; margin-bottom:${prevIsNonPara?Math.round(state.fontSize*0.6):0}px; text-indent:${prevIsNonPara?0:'2em'}; text-align:justify; word-break:break-word; hyphens:auto;`;
    }
    el.textContent = block.text;
    container.appendChild(el);
  });
  
  return container;
}

function renderPage() {
  const page1 = state.pages[state.currentPage];
  const page2 = state.twoPage ? state.pages[state.currentPage + 1] : null;
  const card = document.getElementById('reader-card');
  card.innerHTML = '';
  
  if (state.twoPage) card.classList.add('two-page');
  else card.classList.remove('two-page');
  
  if (!page1) return;
  card.appendChild(constructPageDOM(page1));

  if (state.twoPage && page2) {
    card.appendChild(constructPageDOM(page2));
  }
}

function updateReaderNav() {
  const chaps = state.activeBook.chapters || [];
  const actChIdx = chaps.reduce((best, ch, i) => ch.pageIndex <= state.currentPage ? i : best, 0);
  
  // Calculate pages left in chapter
  const nextChap = chaps[actChIdx + 1];
  const endPage = nextChap ? nextChap.pageIndex : state.pages.length;
  const pagesLeft = endPage - state.currentPage;

  const pct = state.pages.length > 1 ? (state.currentPage / (state.pages.length - 1)) * 100 : 0;
  
  document.getElementById('page-indicator').textContent = `Page ${state.currentPage + 1} of ${state.pages.length} · ${Math.round(pct)}% · ${pagesLeft} pages left in chapter`;
  document.getElementById('progress-bar').style.width = `${pct}%`;
  
  document.getElementById('btn-prev-page').disabled = state.currentPage === 0;
  document.getElementById('btn-next-page').disabled = state.currentPage >= state.pages.length - 1;

  if (state.tapToTurn) {
    document.getElementById('tap-zone-prev').classList.remove('hidden');
    document.getElementById('tap-zone-next').classList.remove('hidden');
    document.getElementById('tap-zone-prev').style.cursor = state.currentPage === 0 ? "default" : "w-resize";
    document.getElementById('tap-zone-next').style.cursor = state.currentPage >= state.pages.length - 1 ? "default" : "e-resize";
  } else {
    document.getElementById('tap-zone-prev').classList.add('hidden');
    document.getElementById('tap-zone-next').classList.add('hidden');
  }

  if (chaps[actChIdx]) {
    document.getElementById('reader-chapter-title').textContent = formatChapterTitle(chaps[actChIdx].title, actChIdx);
    buildChapterDropdown(); 
  }
}

function nextPage() {
  const step = state.twoPage ? 2 : 1;
  if (state.currentPage < state.pages.length - 1) {
    state.currentPage = Math.min(state.currentPage + step, state.pages.length - 1);
    updateProgress(state.currentPage);
  }
}

function prevPage() {
  const step = state.twoPage ? 2 : 1;
  if (state.currentPage > 0) {
    state.currentPage = Math.max(state.currentPage - step, 0);
    updateProgress(state.currentPage);
  }
}

function updateProgress(page) {
  state.activeBook.currentPage = page;
  const idx = state.library.findIndex(b => b.id === state.activeBook.id);
  if (idx > -1) state.library[idx].currentPage = page;
  saveLibrary();
  renderPage();
  updateReaderNav();
}

// ============================================================================
// DATA & FILE HANDLING
// ============================================================================
async function saveLibrary() {
  await window.storage.set("library_meta", JSON.stringify(state.library));
}

async function saveBookContent(id, pages) {
  const json = JSON.stringify(pages);
  if (json.length < MAX_SINGLE_KB) {
    await window.storage.set(`book_${id}_data`, json);
    await window.storage.set(`book_${id}_chunks`, "0");
    return;
  }
  const chunks = [];
  for (let i = 0; i < pages.length; i += CHUNK_SIZE) chunks.push(pages.slice(i, i + CHUNK_SIZE));
  await Promise.all(chunks.map((c, ci) => window.storage.set(`book_${id}_chunk_${ci}`, JSON.stringify(c))));
  await window.storage.set(`book_${id}_chunks`, String(chunks.length));
}

async function loadBookContent(id) {
  const meta = await window.storage.get(`book_${id}_chunks`);
  const n = parseInt(meta?.value ?? "-1");
  if (n === 0) {
    const raw = await window.storage.get(`book_${id}_data`);
    return raw ? JSON.parse(raw.value) : null;
  }
  if (n > 0) {
    const results = await Promise.all(Array.from({ length: n }, (_, ci) => window.storage.get(`book_${id}_chunk_${ci}`)));
    const pages = []; for (const r of results) if (r) pages.push(...JSON.parse(r.value));
    return pages;
  }
  return null;
}

async function deleteBook(id) {
  const meta = await window.storage.get(`book_${id}_chunks`);
  const n = parseInt(meta?.value ?? "-1");
  if (n === 0) await window.storage.delete(`book_${id}_data`);
  else if (n > 0) await Promise.all(Array.from({ length: n }, (_, ci) => window.storage.delete(`book_${id}_chunk_${ci}`)));
  await window.storage.delete(`book_${id}_chunks`);
  await window.storage.delete(`audio_${id}`);
  state.library = state.library.filter(b => b.id !== id);
  saveLibrary(); renderLibrary();
}

async function resetBookProgress(id) {
  const idx = state.library.findIndex(b => b.id === id);
  if(idx > -1) state.library[idx].currentPage = 0;
  saveLibrary(); renderLibrary();
}

async function handleFileUpload(e) {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  showToast(true, "Processing…");
  
  const dynamicWordsPerPage = getWordsPerPage();

  for (const file of files) {
    if (file.name.startsWith('.') || (!/\.(txt|md|epub3?)$/i.test(file.name))) continue; // Ignore system/unsupported files in folders

    try {
      const isEpub = /\.epub3?$/i.test(file.name);
      let bookTitle, bookAuthor="", bookPages, chapters, format;
      
      if (isEpub) {
        format = "epub";
        const parsed = await parseEpub(file);
        bookTitle = parsed.title; bookAuthor = parsed.author; bookPages = parsed.pages; chapters = parsed.chapters;
      } else {
        format = /\.md$/i.test(file.name) ? "md" : "txt";
        const text = await readFileAsText(file);
        bookTitle = file.name.replace(/\.(txt|md)$/i,"").replace(/[_-]/g," ");
        bookPages = splitBlocksIntoPages(textToBlocks(text), dynamicWordsPerPage);
        chapters = deriveChaptersFromPages(bookPages);
      }
      
      const id = `book_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
      await saveBookContent(id, bookPages);
      state.library.push({ id, title: bookTitle, author: bookAuthor, format, totalPages: bookPages.length, currentPage: 0, chapters, addedAt: new Date().toISOString(), hasAudio: false });
      await saveLibrary();
    } catch (err) {
      console.error(err);
      showToast(false, `Failed: "${file.name}"`);
    }
  }
  renderLibrary();
  hideToast();
  e.target.value = "";
}

async function handleAudioUpload(e) {
  const file = e.target.files[0]; if(!file||!state.activeBook) return;
  const url = await readFileAsDataURL(file);
  await window.storage.set(`audio_${state.activeBook.id}`, url);
  state.audioSrc = url;
  
  const idx = state.library.findIndex(b => b.id === state.activeBook.id);
  if(idx > -1) { state.library[idx].hasAudio = true; saveLibrary(); }
  state.activeBook.hasAudio = true;
  
  document.getElementById('audio-player').src = url;
  updateAudioBtn();
  e.target.value = "";
}

function updateAudioBtn() {
  const btn = document.getElementById('btn-toggle-audio');
  if(state.audioSrc) {
    btn.classList.remove('hidden');
    btn.textContent = state.isPlaying ? "⏸ Pause" : "▶ Play";
    btn.style.background = state.isPlaying ? `rgba(56,139,253,0.14)` : 'none';
    btn.style.color = state.isPlaying ? `var(--accent)` : 'var(--textMuted)';
    btn.style.borderColor = state.isPlaying ? `var(--accent)` : 'var(--buttonBorder)';
  } else {
    btn.classList.add('hidden');
  }
}

function toggleAudio() {
  const player = document.getElementById('audio-player');
  if(!player.src) return;
  if(state.isPlaying) { player.pause(); state.isPlaying = false; }
  else { player.play(); state.isPlaying = true; }
  updateAudioBtn();
}

// ============================================================================
// MODALS & TOASTS
// ============================================================================
function openModal(id) { document.getElementById(id).classList.remove('hidden'); switchModalTab('theme'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

function showToast(isLoading, text) {
  const t = document.getElementById('upload-toast');
  t.classList.remove('hidden', 'error');
  if(!isLoading) t.classList.add('error');
  document.getElementById('upload-spinner').style.display = isLoading ? 'block' : 'none';
  document.getElementById('upload-toast-text').textContent = text;
}
function hideToast() { document.getElementById('upload-toast').classList.add('hidden'); }

function switchModalTab(tabId) {
  document.querySelectorAll('.tab').forEach(t => {
    if(t.dataset.tab === tabId) t.classList.add('active'); else t.classList.remove('active');
  });
  const body = document.getElementById('modal-body');
  
  if (tabId === 'theme') {
    const all = { ...BUILT_IN_THEMES, ...state.customThemes };
    body.innerHTML = `
      <div class="section-label">THEME</div>
      <div class="radio-list">
        ${Object.keys(all).map(k => `
          <label class="radio-item ${state.themeKey === k ? 'active' : ''}">
            <input type="radio" name="theme" value="${k}" ${state.themeKey === k ? 'checked' : ''}>
            <div style="display:flex; gap:4px;">
              <div class="swatch" style="background:${all[k].bg}"></div>
              <div class="swatch" style="background:${all[k].surface}"></div>
              <div class="swatch" style="background:${all[k].accent||'#888'}"></div>
            </div>
            <span style="font-size:13px; font-weight:500; color:var(--text); flex:1;">${all[k].name}</span>
            ${k.startsWith('custom_') ? '<span style="font-size:10px; color:var(--textDim)">Custom</span>' : ''}
          </label>
        `).join('')}
      </div>
      <div class="theme-import-box">
        <div style="font-size:12px; color:var(--textMuted); margin-bottom:8px;">Import custom theme <strong>.json</strong></div>
        <button id="btn-import-theme" class="btn secondary">Import theme (.json)</button>
      </div>
    `;
    
    body.querySelectorAll('input[name="theme"]').forEach(rad => {
      rad.onchange = (e) => {
        state.themeKey = e.target.value;
        window.storage.set("app_theme", JSON.stringify({ themeKey: state.themeKey, customThemes: state.customThemes, tapToTurn: state.tapToTurn, twoPage: state.twoPage }));
        applyTheme(state.themeKey); switchModalTab('theme');
      };
    });
    body.querySelector('#btn-import-theme').onclick = () => document.getElementById('theme-input').click();
    
    document.getElementById('theme-input').onchange = async (e) => {
      const file = e.target.files[0]; if(!file) return;
      try {
        const p = JSON.parse(await readFileAsText(file));
        if (p.name && p.bg && p.text) {
          const k = `custom_${Date.now()}`;
          state.customThemes[k] = p; state.themeKey = k;
          window.storage.set("app_theme", JSON.stringify({ themeKey: state.themeKey, customThemes: state.customThemes, tapToTurn: state.tapToTurn, twoPage: state.twoPage }));
          applyTheme(k); switchModalTab('theme');
        }
      } catch (err) { alert('Invalid theme file'); }
      e.target.value = '';
    };

  } else if (tabId === 'library') {
    body.innerHTML = `
      <div class="section-label">LIBRARY DATA</div>
      <p style="font-size:13px; color:var(--textMuted); margin-bottom:14px; line-height:1.6;">Export your library as <strong>biblio-library.json</strong> to back it up.</p>
      <div style="display:flex; gap:10px; margin-bottom:18px;">
        <button id="btn-export-lib" class="btn secondary" style="flex:1; justify-content:center;">↓ Export</button>
        <button id="btn-import-lib" class="btn primary" style="flex:1; justify-content:center;">↑ Import</button>
      </div>
      <div class="section-label" style="margin-top: 24px;">ADD CONTENT</div>
      <div style="display:flex; gap:10px; margin-bottom:18px;">
        <button id="btn-settings-add-book" class="btn secondary" style="flex:1; justify-content:center;">+ Add Book</button>
        <button id="btn-settings-add-folder" class="btn primary" style="flex:1; justify-content:center;">+ Add Folder</button>
      </div>
    `;
    body.querySelector('#btn-export-lib').onclick = () => {
      const blob = new Blob([JSON.stringify({ _readme: "Biblio Library", books: state.library }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      Object.assign(document.createElement("a"), { href: url, download: "biblio-library.json" }).click();
      URL.revokeObjectURL(url);
    };
    body.querySelector('#btn-import-lib').onclick = () => document.getElementById('lib-import-input').click();
    body.querySelector('#btn-settings-add-book').onclick = () => document.getElementById('file-input').click();
    body.querySelector('#btn-settings-add-folder').onclick = () => document.getElementById('folder-input').click();
    
    document.getElementById('lib-import-input').onchange = async (e) => {
      const file = e.target.files[0]; if(!file) return;
      try {
        const d = JSON.parse(await readFileAsText(file));
        if (Array.isArray(d.books)) {
          const ids = new Set(state.library.map((b) => b.id));
          state.library.push(...d.books.filter((b) => !ids.has(b.id)));
          saveLibrary(); renderLibrary();
        }
      } catch (err) { alert('Invalid library file'); }
      e.target.value = '';
    };
  }
}

// Click outside closers
document.addEventListener("mousedown", (e) => {
  const panel = document.getElementById('reader-settings-panel');
  const drop = document.getElementById('chapter-dropdown');
  const ctxMenus = document.querySelectorAll('.context-menu');
  
  if (panel && !panel.classList.contains('hidden') && !panel.contains(e.target) && e.target.id !== 'btn-reader-settings') panel.classList.add('hidden');
  if (drop && !drop.classList.contains('hidden') && !drop.contains(e.target) && !document.getElementById('btn-chapter-drop').contains(e.target)) drop.classList.add('hidden');
  ctxMenus.forEach(m => { if (!m.classList.contains('hidden') && !m.contains(e.target)) m.classList.add('hidden'); });
});

window.onload = initApp;