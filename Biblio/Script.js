// ============================================================================
// STORAGE POLYFILL & CONSTANTS
// ============================================================================
const DB_NAME = "GnosDB";
const STORE_NAME = "keyval";

const initDB = () => new Promise((resolve, reject) => {
  const req = indexedDB.open(DB_NAME, 1);
  req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

window.storage = window.storage || {
  _db: null,
  async getDB() {
    if (!this._db) this._db = await initDB();
    return this._db;
  },
  async get(k) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(k);
      req.onsuccess = () => resolve(req.result !== undefined ? { value: req.result } : null);
      req.onerror = () => reject(req.error);
    });
  },
  async set(k, v) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const req = tx.objectStore(STORE_NAME).put(v, k);
      req.onsuccess = () => resolve({ value: v });
      req.onerror = () => reject(req.error);
    });
  },
  async delete(k) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const req = tx.objectStore(STORE_NAME).delete(k);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
};

const CHUNK_SIZE = 20; // chapters per storage chunk
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
  // New: chapters is array of { title, blocks[] }
  // currentChapter = index into chapters array
  // currentPage = logical column index within current chapter's column flow
  chapters: [],
  currentChapter: 0,
  currentPage: 0,       // page index within the current chapter
  totalPages: 0,        // estimated total pages (for progress bar)
  themeKey: "dark",
  customThemes: {},
  tapToTurn: true,
  twoPage: false,
  fontSize: 18,
  lineSpacing: 1.8,
  fontFamily: "Georgia, serif",
  audioSrc: null,
  isPlaying: false,
  searchQuery: "",
  activeLibTab: "books",
  connectedFolder: null,
  highlightWords: false,
  underlineLine: false,
  justifyText: true,
  ollamaUrl: "",
  ollamaModel: "",
  readingLog: {},
  sessionStart: null,
  sessionBookId: null,
  notes: {},
  notebooks: [],
};

// ============================================================================
// UTILITIES & PARSING
// ============================================================================
function getOllamaUrl() {
  return (state.ollamaUrl || "http://localhost:11434").replace(/\/$/, "");
}

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

// ============================================================================
// BLOCK PARSERS  (produce { type, text } arrays from HTML or plain text)
// ============================================================================

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

// ============================================================================
// CHAPTER SPLITTER
// Split a flat blocks array into chapters: each chapter starts at a heading
// block and contains all subsequent blocks until the next heading.
// Returns: [{ title, blocks[] }]
// ============================================================================
function blocksToChapters(blocks) {
  const chapters = [];
  let current = null;

  for (const block of blocks) {
    if (block.type === "heading") {
      if (current) chapters.push(current);
      current = { title: block.text, blocks: [block] };
    } else {
      if (!current) current = { title: "Beginning", blocks: [] };
      current.blocks.push(block);
    }
  }
  if (current) chapters.push(current);
  if (chapters.length === 0) chapters.push({ title: "Beginning", blocks: [] });
  return chapters;
}

// ============================================================================
// BINARY-SEARCH PAGINATION ENGINE  (v2 — fixes animation artifacts,
//   two-page spread, and slow book-open performance)
// ─────────────────────────────────────────────────────────────────────────────
//
// ─── State ────────────────────────────────────────────────────────────────
let _pageBreaks = [];            // [pageIndex] = first expanded-block index on that page
let _pageStyleEl = null;         // <style> tag for reader typography
let _resizeTimer = null;
let _currentRenderedChapter = -1;
let _animating = false;          // mutex: true while a page-turn animation runs
let _outgoingPage = null;        // the page element currently animating out
let _chapterBreaksCache = {};    // chapterIdx → _pageBreaks array (cached after first compute)
let _lazyComputeGen = 0;         // incremented on every settings change to cancel stale workers

// ─── Helpers ──────────────────────────────────────────────────────────────

function getCardDims() {
  const card = document.getElementById("reader-card");
  if (!card) return { w: 720, h: 600 };
  // clientWidth excludes borders — the card has 1px left+right borders.
  // offsetWidth would include those 2px, making the probe 2px too wide and
  // causing it to underestimate content height (fitting more per page than renders).
  // clientHeight == offsetHeight here since the card has no top/bottom borders.
  return { w: card.clientWidth || 720, h: card.offsetHeight || 600 };
}

function ensurePageStyle() {
  const css = buildPageStyles();
  if (_pageStyleEl && _pageStyleEl.parentNode) {
    _pageStyleEl.textContent = css;
  } else {
    _pageStyleEl = document.createElement("style");
    _pageStyleEl.textContent = css;
    document.head.appendChild(_pageStyleEl);
  }
}

function buildPageStyles() {
  const fs = state.fontSize;
  const ls = state.lineSpacing;
  const paraGap = Math.round(fs * 0.55);
  // No column-count here. Two-page is handled by rendering two consecutive
  // single-column page-content divs side by side in renderPage.
  // Probe and display must use identical layout or measurements will be wrong.
  return `
    .page-content {
      font-family: ${state.fontFamily};
      font-size: ${fs}px;
      line-height: ${ls};
      color: var(--readerText);
      padding: 36px 64px;
      box-sizing: border-box;
      word-break: break-word;
      hyphens: auto;
      height: 100%;
      overflow: hidden;
      text-rendering: optimizeLegibility;
    }
    .page-content p {
      margin: 0 0 ${paraGap}px 0;
      text-align: ${state.justifyText !== false ? "justify" : "left"};
      text-align-last: left;
      hanging-punctuation: first last;
      font-feature-settings: "kern" 1, "liga" 1, "onum" 1;
      orphans: 3; widows: 3;
    }
    .page-content p + p {
      text-indent: 2em;
      margin-bottom: 0;
    }
    .page-content h2 + p,
    .page-content h3 + p {
      text-indent: 0;
    }
    .page-content h2 {
      font-size: ${Math.round(fs * 1.65)}px;
      font-weight: 700;
      line-height: 1.2;
      font-family: Georgia, serif;
      margin: 0 0 ${Math.round(fs * 0.5)}px 0;
      letter-spacing: -0.01em;
    }
    .page-content h3 {
      font-size: ${Math.round(fs * 1.1)}px;
      font-weight: 400;
      line-height: 1.4;
      font-family: Georgia, serif;
      margin: 0 0 ${Math.round(fs * 0.4)}px 0;
      opacity: 0.72;
      letter-spacing: 0.02em;
      font-style: italic;
    }
    .page-content.chapter-title-page {
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      text-align: center;
    }
    .page-content.chapter-title-page h2,
    .page-content.chapter-title-page h3 {
      width: 100%;
      text-align: center;
    }
    .page-content.chapter-title-page h2 {
      margin-bottom: ${Math.round(fs * 0.3)}px;
    }
    .page-content.chapter-title-page h3 {
      margin-bottom: 0;
    }
    .page-content.cover-page {
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--readerCard);
    }
    .page-content.cover-page img {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      display: block;
      border-radius: 4px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.32);
    }
  `;
}

function blocksToHTML(blocks) {
  return blocks.map(b => {
    if (!b?.text?.trim() && b?.type !== "cover") return "";
    if (b.type === "cover")      return `<img src="${b.src}" alt="Book cover">`;
    if (b.type === "pdfPage")    return `<img src="${b.src}" alt="" class="pdf-page-img">`;
    if (b.type === "heading")    return `<h2>${b.text}</h2>`;
    if (b.type === "subheading") return `<h3>${b.text}</h3>`;
    return `<p>${b.text}</p>`;
  }).join("");
}

function blocksToDisplayHTML(blocks) {
  return blocks.map(b => {
    if (!b?.text?.trim() && b?.type !== "cover") return "";
    if (b.type === "cover")      return `<img src="${b.src}" alt="Book cover">`;
    if (b.type === "pdfPage")    return `<img src="${b.src}" alt="" class="pdf-page-img">`;
    if (b.type === "heading")    return `<h2>${b.text}</h2>`;
    if (b.type === "subheading") return `<h3>${b.text}</h3>`;
    const wrapped = b.text.replace(/(\S+)/g, (w) => {
      const clean = w.replace(/[^a-zA-Z'\u2019-]/g, "");
      return `<span class="col-word" data-word="${clean}">${w}</span>`;
    });
    return `<p>${wrapped}</p>`;
  }).join("");
}

// ─── Core: compute page breaks for a chapter ──────────────────────────────
//
// Zero-padding probe measures pure text height per block.
// In two-page mode the probe width is half the card (one column's width).
// Page breaks are always single-column — renderPage places two consecutive
// pages side-by-side for the spread view.
//
// Long paragraphs that exceed a full page height are split at word boundaries
// using binary search, matching how Kindle and Apple Books handle them.
//
function computePageBreaks(chapterIdx) {
  const chapter = state.chapters[chapterIdx];
  if (!chapter || !chapter.blocks.length) return [0];

  const { w: cardW, h: cardH } = getCardDims();

  const PAD_V = 36;
  const PAD_H = 64;
  const colW = state.twoPage
    ? Math.floor(cardW / 2) - PAD_H * 2
    : cardW - PAD_H * 2;
  const pageH = cardH - PAD_V * 2;
  if (pageH <= 0 || colW <= 0) return [0];

  const fs = state.fontSize;
  const paraGap = Math.round(fs * 0.55);
  const textAlign = state.justifyText !== false ? "justify" : "left";

  const probe = document.createElement("div");
  probe.style.cssText = `
    position: fixed; top: 0; left: -9999px;
    width: ${colW}px; height: auto; padding: 0; margin: 0; border: none;
    opacity: 0; pointer-events: none; z-index: -1; overflow: visible;
    font-family: ${state.fontFamily}; font-size: ${fs}px;
    line-height: ${state.lineSpacing}; word-break: break-word;
    hyphens: auto; box-sizing: border-box;
  `;
  const probeStyle = document.createElement("style");
  probeStyle.textContent = `
    .gnos-probe p  { margin: 0 0 ${paraGap}px 0; text-align: ${textAlign};
                     text-align-last: left;
                     font-feature-settings: "kern" 1, "liga" 1, "onum" 1; }
    .gnos-probe p + p { text-indent: 2em; margin-bottom: 0; }
    .gnos-probe h2 { font-size: ${Math.round(fs * 1.65)}px; font-weight: 700;
                     line-height: 1.2; margin: 0 0 ${Math.round(fs * 0.5)}px 0; }
    .gnos-probe h3 { font-size: ${Math.round(fs * 1.1)}px; font-weight: 400;
                     line-height: 1.4;
                     margin: 0 0 ${Math.round(fs * 0.4)}px 0; }
  `;
  document.head.appendChild(probeStyle);
  probe.className = "gnos-probe";
  document.body.appendChild(probe);

  // Measure the true rendered height of content in the probe.
  // scrollHeight includes the bottom margin of the last child, which causes
  // the paginator to trigger overflow one block too early, adding ~10% extra pages.
  // We instead measure the bottom edge of the last rendered child relative to
  // the probe's top — this is the actual ink height with no trailing margin.
  function probeHeight() {
    const last = probe.lastElementChild;
    if (!last) return 0;
    const probeTop = probe.getBoundingClientRect().top;
    return last.getBoundingClientRect().bottom - probeTop;
  }
  // Returns [firstPart, remainder] where firstPart fills the page to the last
  // complete line, with no orphan words (single word alone on the last line).
  function splitParaAtPageBoundary(text, prefixBlocks) {
    const words = text.split(" ");
    let lo = 1, hi = words.length - 1, bestSplit = 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const testBlocks = [...prefixBlocks, { type: "para", text: words.slice(0, mid).join(" ") }];
      probe.innerHTML = blocksToHTML(testBlocks);
      if (probeHeight() <= pageH) { bestSplit = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }

    // Anti-orphan: check whether the last word landed alone on its own line.
    // Render with bestSplit words, measure height. Render with bestSplit-1 words.
    // If height drops, the last word was on its own line — move it to the next page.
    //
    // This requires the probe to be within the browser's visible Y range so that
    // Chromium actually computes layout (it skips layout for position:fixed elements
    // entirely above/below the viewport, making all rects return 0). The probe is
    // now at top:0; left:-9999px so Y measurements are always correct.
    if (bestSplit === 1 && prefixBlocks.length > 0) {
      bestSplit = 0;
    } else if (bestSplit >= 2) {
      probe.innerHTML = blocksToHTML([...prefixBlocks, { type: "para", text: words.slice(0, bestSplit).join(" ") }]);
      const hFull = probeHeight();
      probe.innerHTML = blocksToHTML([...prefixBlocks, { type: "para", text: words.slice(0, bestSplit - 1).join(" ") }]);
      const hShort = probeHeight();
      if (hFull > hShort) {
        if (bestSplit - 1 >= 2) { bestSplit--; }
        else if (prefixBlocks.length > 0) { bestSplit = 0; }
      }
    }

    return [
      words.slice(0, bestSplit).join(" "),
      words.slice(bestSplit).join(" ")
    ];
  }

  // Build a clean working copy of blocks for this computation. Must be rebuilt
  // from chapter.blocks on every call — never reuse a previous _expanded,
  // because split fragments from a prior call would be split again on the next
  // recompute, doubling the page count each time settings change.
  const expanded = [];
  for (const b of chapter.blocks) {
    if (!b?.text?.trim() && b?.type !== "cover" && b?.type !== "pdfPage") continue;
    expanded.push({ ...b }); // shallow copy so splice/mutation never touches originals
  }

  const breaks = [0]; // index into expanded[]
  let pageBlocks = [];
  let pageIsHeadingOnly = false;

  for (let i = 0; i < expanded.length; i++) {
    const b = expanded[i];
    const isHeading = b.type === "heading" || b.type === "subheading";

    if (isHeading && pageBlocks.length > 0 && !pageIsHeadingOnly) {
      breaks.push(i);
      pageBlocks = [];
      pageIsHeadingOnly = false;
    } else if (!isHeading && pageIsHeadingOnly) {
      breaks.push(i);
      pageBlocks = [];
      pageIsHeadingOnly = false;
    }

    pageBlocks.push(b);
    pageIsHeadingOnly = pageBlocks.every(
      bl => bl.type === "heading" || bl.type === "subheading"
    );

    probe.innerHTML = blocksToHTML(pageBlocks);

    if (probeHeight() > pageH) {
      if (b.type === "para" && b.text.split(" ").length > 2) {
        // The page overflows. If this is the only block, split it solo.
        // If there are other blocks already, split it with their context so
        // whatever fits of this paragraph stays on the current page and the
        // remainder starts the next — filling the page to the last line.
        //
        // This is how Apple Books and Kindle fill pages: they never move a
        // whole paragraph to the next page if any part of it fits. Every
        // paragraph that crosses a page boundary is split at a word boundary.
        const prefixForSplit = pageBlocks.length > 1
          ? pageBlocks.slice(0, -1)   // blocks already committed to this page
          : [];
        const [first, rest] = splitParaAtPageBoundary(b.text, prefixForSplit);
        if (first && rest) {
          expanded.splice(i + 1, 0, { type: "para", text: rest, continued: true });
          expanded[i] = { ...b, text: first };
          pageBlocks[pageBlocks.length - 1] = expanded[i];
          breaks.push(i + 1);
          pageBlocks = [];
          pageIsHeadingOnly = false;
        } else if (pageBlocks.length > 1) {
          // Split yielded nothing (e.g. even one word overflows with context) —
          // fall back to moving the block to a fresh page and splitting there.
          breaks.push(i);
          pageBlocks = [b];
          probe.innerHTML = blocksToHTML(pageBlocks);
          if (probeHeight() > pageH) {
            const [f2, r2] = splitParaAtPageBoundary(b.text, []);
            if (f2 && r2) {
              expanded.splice(i + 1, 0, { type: "para", text: r2, continued: true });
              expanded[i] = { ...b, text: f2 };
              pageBlocks[0] = expanded[i];
              breaks.push(i + 1);
              pageBlocks = [];
            }
          }
          pageIsHeadingOnly = false;
        }
        // else single short paragraph that can't be split — let it stand
      } else if (pageBlocks.length > 1) {
        // Non-paragraph block (heading) overflowed — move it to the next page.
        breaks.push(i);
        pageBlocks = [b];
        pageIsHeadingOnly = b.type === "heading" || b.type === "subheading";
        probe.innerHTML = blocksToHTML(pageBlocks);
      }
      // Single non-para block that's too tall: let it stand rather than loop
    }
  }

  document.body.removeChild(probe);
  probeStyle.remove();
  // Store the final expanded list (with any split fragments) back on the chapter
  // so renderPage can slice it. This is always overwritten on the next recompute.
  chapter._expanded = expanded;
  return breaks;
}

// ─── Render ───────────────────────────────────────────────────────────────
//
// FIX — animation artifact: track _animating mutex + _outgoingPage ref.
// If renderPage is called while an animation is running, immediately
// complete the previous animation before starting the new one.
// This prevents multiple .page-content divs stacking in the card.
//
function renderPage(chapterIdx, pageIdx, animate) {
  const card = document.getElementById("reader-card");
  if (!card) return;

  ensurePageStyle();

  const chapter = state.chapters[chapterIdx];
  if (!chapter) return;

  if (chapterIdx !== _currentRenderedChapter) {
    if (_chapterBreaksCache[chapterIdx]) {
      _pageBreaks = _chapterBreaksCache[chapterIdx];
    } else {
      _pageBreaks = computePageBreaks(chapterIdx);
      _chapterBreaksCache[chapterIdx] = _pageBreaks;
    }
    _currentRenderedChapter = chapterIdx;
  }

  const totalPagesInChapter = _pageBreaks.length;
  pageIdx = Math.max(0, Math.min(pageIdx, totalPagesInChapter - 1));
  state.currentPage = pageIdx;

  // ── Build the new surface ────────────────────────────────────────────────
  // In two-page mode we render two consecutive single-column pages side by
  // side inside a flex wrapper. Each column is a normal .page-content div —
  // the same element the probe measured — so display and measurement match
  // exactly. This is how Kindle, epub.js, and Readium implement two-page:
  // two independent page slots, not CSS columns on a single element.
  //
  // In single-page mode the wrapper is just one .page-content div.

  function makePageDiv(pIdx) {
    const source  = chapter._expanded || chapter.blocks;
    const startBlock = _pageBreaks[pIdx];
    const endBlock   = _pageBreaks[pIdx + 1] ?? source.length;
    const blocks     = source.slice(startBlock, endBlock);
    const div = document.createElement("div");
    div.className = "page-content";
    // Set an explicit pixel height rather than relying on height:100%.
    // Safari has a known bug where height:100% fails to resolve correctly
    // when no ancestor in the chain has an explicit pixel height — only
    // flex:1 heights. The symptom: page-content expands to its content
    // height and text overflows the card boundary into the footer.
    // An explicit pixel height removes all ambiguity and overflow:hidden
    // then clips exactly at the right boundary.
    div.style.height = card.offsetHeight + "px";
    div.innerHTML = blocksToDisplayHTML(blocks);
    const nonEmpty = blocks.filter(b => b?.text?.trim() || b?.type === "cover" || b?.type === "pdfPage");
    if (nonEmpty.length > 0) {
      if (nonEmpty.every(b => b.type === "cover")) {
        div.classList.add("cover-page");
      } else if (nonEmpty.every(b => b.type === "pdfPage")) {
        div.classList.add("cover-page", "pdf-fill-page");
      } else if (nonEmpty.every(b => b.type === "heading" || b.type === "subheading")) {
        div.classList.add("chapter-title-page");
      }
    }
    if (nonEmpty[0]?.continued) {
      const firstP = div.querySelector("p");
      if (firstP) firstP.style.textIndent = "0";
    }
    return div;
  }

  const cardH = card.offsetHeight;
  let newSurface;
  if (state.twoPage) {
    newSurface = document.createElement("div");
    newSurface.className = "page-spread";
    newSurface.style.height = cardH + "px"; // explicit height for same reason
    const leftPage  = makePageDiv(pageIdx);
    const rightPage = pageIdx + 1 < totalPagesInChapter
      ? makePageDiv(pageIdx + 1)
      : (() => {
          const e = document.createElement("div");
          e.className = "page-content";
          e.style.height = cardH + "px";
          return e;
        })();
    newSurface.appendChild(leftPage);
    newSurface.appendChild(rightPage);
  } else {
    newSurface = makePageDiv(pageIdx);
  }

  // ── Snap any in-flight animation before starting a new one ───────────────
  if (_animating && _outgoingPage) {
    _outgoingPage.remove();
    _outgoingPage = null;
    _animating = false;
    card.querySelectorAll(".page-content, .page-spread").forEach(el => el.remove());
  }

  // ── Animate: cross-fade for all modes ────────────────────────────────────
  // A fade keeps the centre divider perfectly static and works equally well
  // at any card width. Apple Books uses fade on spreads; Kindle uses fade
  // on everything. The slide animation caused content to visually cross the
  // centre line in two-page mode, so we now use fade universally.
  if (animate) {
    const existing = card.querySelector(".page-content, .page-spread");
    if (existing) {
      _animating = true;
      _outgoingPage = existing;

      newSurface.style.cssText = "position:absolute;inset:0;opacity:0;transition:opacity 0.18s ease;";
      card.appendChild(newSurface);
      void newSurface.offsetWidth; // force reflow before transition
      existing.style.cssText  = "position:absolute;inset:0;opacity:1;transition:opacity 0.18s ease;";
      existing.style.opacity  = "0";
      newSurface.style.opacity = "1";

      const cleanup = () => {
        if (_outgoingPage === existing) {
          existing.remove();
          newSurface.style.cssText = "";
          _outgoingPage = null;
          _animating = false;
        }
      };
      existing.addEventListener("transitionend", cleanup, { once: true });
      setTimeout(cleanup, 260); // safety in case transitionend doesn't fire
    } else {
      card.innerHTML = "";
      card.appendChild(newSurface);
    }
  } else {
    card.innerHTML = "";
    card.appendChild(newSurface);
  }

  updateReaderNav();
  addBookmarkIcons(card);
  card.removeEventListener("click", handleWordClick);
  card.removeEventListener("mouseover", handleWordMouseover);
  card.addEventListener("click", handleWordClick);
  card.addEventListener("mouseover", handleWordMouseover);
}

// ─── Navigation ───────────────────────────────────────────────────────────

function nextPage() {
  const step = state.twoPage ? 2 : 1;
  const totalPagesInChapter = _pageBreaks.length || 1;
  if (state.currentPage + step <= totalPagesInChapter - 1) {
    state.currentPage += step;
    renderPage(state.currentChapter, state.currentPage, "forward");
    updateProgress();
  } else if (state.currentPage < totalPagesInChapter - 1) {
    // In two-page mode, snap to last page rather than skipping chapter
    state.currentPage = totalPagesInChapter - 1;
    renderPage(state.currentChapter, state.currentPage, "forward");
    updateProgress();
  } else if (state.currentChapter < state.chapters.length - 1) {
    state.currentChapter++;
    _currentRenderedChapter = -1;
    renderPage(state.currentChapter, 0, "forward");
    updateProgress();
  }
}

function prevPage() {
  const step = state.twoPage ? 2 : 1;
  if (state.currentPage >= step) {
    state.currentPage -= step;
    renderPage(state.currentChapter, state.currentPage, "backward");
    updateProgress();
  } else if (state.currentPage > 0) {
    // Snap to page 0 rather than going negative
    state.currentPage = 0;
    renderPage(state.currentChapter, 0, "backward");
    updateProgress();
  } else if (state.currentChapter > 0) {
    state.currentChapter--;
    _currentRenderedChapter = -1;
    const prevBreaks = computePageBreaks(state.currentChapter);
    _pageBreaks = prevBreaks;
    _currentRenderedChapter = state.currentChapter;
    // Land on last even-indexed page for clean spread alignment
    const lastPage = state.twoPage
      ? Math.floor((prevBreaks.length - 1) / 2) * 2
      : prevBreaks.length - 1;
    renderPage(state.currentChapter, lastPage, "backward");
    updateProgress();
  }
}

function jumpToChapter(chapterIdx, pageIdx) {
  chapterIdx = Math.max(0, Math.min(chapterIdx, state.chapters.length - 1));
  state.currentChapter = chapterIdx;
  _currentRenderedChapter = -1;
  renderPage(chapterIdx, pageIdx || 0, false);
  updateProgress();
}

// ─── Progress ─────────────────────────────────────────────────────────────

// ─── Page counting — exact from cache ─────────────────────────────────────
// All chapter breaks are computed before the reader opens, so these functions
// always return exact values — no estimation, no block-ratio extrapolation.

function estimateTotalPages() {
  return Math.max(1, Object.values(_chapterBreaksCache).reduce((s, b) => s + b.length, 0));
}

function estimateGlobalPage() {
  let offset = 0;
  for (let i = 0; i < state.currentChapter; i++) {
    offset += (_chapterBreaksCache[i]?.length || 1);
  }
  return offset + state.currentPage;
}

function updateProgress() {
  const total   = estimateTotalPages();
  const current = estimateGlobalPage();
  const pct     = total > 1 ? (current / (total - 1)) * 100 : 0;

  if (state.activeBook) {
    // Subtract 1 from currentChapter when saving — chapter 0 is the injected
    // cover page which is not part of the stored chapter list.
    const savedChapter = Math.max(0, state.currentChapter - 1);
    const savedPage    = state.currentChapter === 0 ? 0 : state.currentPage;
    state.activeBook.currentChapter = savedChapter;
    state.activeBook.currentPage    = savedPage;
    const idx = state.library.findIndex(b => b.id === state.activeBook.id);
    if (idx > -1) {
      state.library[idx].currentChapter = savedChapter;
      state.library[idx].currentPage    = savedPage;
    }
    saveLibrary();
  }
  updateReaderNav();
}

// ─── Reader nav UI ────────────────────────────────────────────────────────

function updateReaderNav() {
  const chaps   = state.chapters || [];
  const total   = estimateTotalPages();
  const current = estimateGlobalPage();
  const pct     = total > 1 ? (current / (total - 1)) * 100 : 0;
  const totalInChapter = _pageBreaks.length || 1;

  const pageInd = document.getElementById("page-indicator");
  if (pageInd) {
    const globalNum = current + 1;
    const _isCv=(state.chapters||[])[state.currentChapter]?.title==="_cover_";
    const _cb=_chapterBreaksCache[state.currentChapter];
    const _ct=_cb?_cb.length:(_pageBreaks.length||1);
    const _pl=_ct-state.currentPage-1;
    const _st=state.twoPage?2:1;
    const _lft=_isCv?"":`${_pl<=0?" · last page":_pl===_st?" · 1 pg left":` · ${_pl} pgs left`}`;
    pageInd.innerHTML=`Page <input id="page-num-input" type="number" min="1" max="${total}" value="${globalNum}" style="width:${Math.max(36,String(total).length*10+16)}px;background:transparent;border:none;border-bottom:1px solid var(--textDim);color:var(--text);font-size:inherit;font-family:inherit;text-align:center;padding:0 2px;outline:none;-moz-appearance:textfield;"> of ${total} · ${Math.round(pct)}%${_lft}`;
    const pnInput = document.getElementById("page-num-input");
    if (pnInput) {
      pnInput.onclick = (e) => { e.stopPropagation(); pnInput.select(); };
      const doJump = () => {
        const val = parseInt(pnInput.value, 10);
        if (!isNaN(val) && val >= 1 && val <= total) {
          let remaining = val - 1;
          for (let i = 0; i < state.chapters.length; i++) {
            const chPgs = _chapterBreaksCache[i]?.length || 1;
            if (remaining < chPgs) { jumpToChapter(i, remaining); return; }
            remaining -= chPgs;
          }
          jumpToChapter(state.chapters.length - 1, 0);
        } else {
          pnInput.value = current + 1;
        }
      };
      pnInput.onblur = doJump;
      pnInput.onkeydown = (e) => {
        if (e.key === "Enter") { doJump(); pnInput.blur(); }
        if (e.key === "Escape") { pnInput.value = current + 1; pnInput.blur(); }
      };
    }
  }

  const pb = document.getElementById("progress-bar");
  if (pb) pb.style.width = `${pct}%`;

  const btnPrev = document.getElementById("btn-prev-page");
  const btnNext = document.getElementById("btn-next-page");
  if (btnPrev) btnPrev.disabled = state.currentChapter === 0 && state.currentPage === 0;
  if (btnNext) btnNext.disabled = state.currentChapter >= state.chapters.length - 1 && state.currentPage >= totalInChapter - 1;

  if (state.tapToTurn) {
    document.getElementById("tap-zone-prev")?.classList.remove("hidden");
    document.getElementById("tap-zone-next")?.classList.remove("hidden");
  } else {
    document.getElementById("tap-zone-prev")?.classList.add("hidden");
    document.getElementById("tap-zone-next")?.classList.add("hidden");
  }

  const chap = chaps[state.currentChapter];
  if (chap) {
    const el = document.getElementById("reader-chapter-title");
    if (el) el.textContent = chap.title;
  }
}

// ─── Rebuild on settings / resize ─────────────────────────────────────────

function rebuildReaderForSettings() {
  ensurePageStyle();
  // Recompute all chapter breaks synchronously — font/size/justify change
  // invalidates every page position in the book. This takes ~100–300ms for
  // a full novel, matching Kindle's behaviour on font size change.
  recomputeAllChapterBreaks();
  _currentRenderedChapter = -1;
  if (state.view === "reader") {
    renderPage(state.currentChapter, state.currentPage, false);
    buildChapterDropdown(); // refresh page numbers in dropdown
  }
  updateReaderNav();
}

// ============================================================================
// EPUB PARSER — now produces chapters[], not pages[][]
// ============================================================================

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
  let m, itemRe = /<item\s([^>]+?)\/?>/ ;
  const itemReG = /<item\s([^>]+?)\/?>/gi;
  while ((m = itemReG.exec(opfXml)) !== null) {
    const id = getAttr(m[1], "id"), href = getAttr(m[1], "href");
    if (id && href) manifest[id] = { href, type: getAttr(m[1], "media-type") || "", props: getAttr(m[1], "properties") || "" };
  }

  // Extract cover image
  let coverDataUrl = null;
  try {
    const coverId = Object.keys(manifest).find(k =>
      manifest[k].props.toLowerCase().includes("cover-image") ||
      k.toLowerCase() === "cover" ||
      manifest[k].href.toLowerCase().includes("cover")
    );
    if (coverId) {
      const coverHref = resolveHref(opfDir, manifest[coverId].href);
      const coverEntry = coverHref ? zipFind(zip, coverHref) : null;
      if (coverEntry) {
        const coverData = await coverEntry.async("base64");
        const mtype = manifest[coverId].type || "image/jpeg";
        coverDataUrl = `data:${mtype};base64,${coverData}`;
      }
    }
    if (!coverDataUrl) {
      const metaCoverM = opfXml.match(/<meta\s[^>]*name\s*=\s*["']cover["'][^>]*content\s*=\s*["']([^"']+)["']/i)
                       || opfXml.match(/<meta\s[^>]*content\s*=\s*["']([^"']+)["'][^>]*name\s*=\s*["']cover["']/i);
      if (metaCoverM && manifest[metaCoverM[1]]) {
        const coverHref = resolveHref(opfDir, manifest[metaCoverM[1]].href);
        const coverEntry = coverHref ? zipFind(zip, coverHref) : null;
        if (coverEntry) {
          const coverData = await coverEntry.async("base64");
          const mtype = manifest[metaCoverM[1]].type || "image/jpeg";
          coverDataUrl = `data:${mtype};base64,${coverData}`;
        }
      }
    }
  } catch(e) {}

  const spineHrefs = [];
  const itemrefRe = /<itemref\s([^>]+?)\/?>/gi;
  while ((m = itemrefRe.exec(opfXml)) !== null) {
    const idref = getAttr(m[1], "idref"); if (!idref || !manifest[idref]) continue;
    const item = manifest[idref], t = item.type.toLowerCase(), ext = item.href.split(".").pop().toLowerCase();
    if (t.includes("html") || t.includes("xhtml") || ["html","xhtml","htm"].includes(ext) || t === "" || t === "application/xml") {
      const r = resolveHref(opfDir, item.href); if (r && !spineHrefs.includes(r)) spineHrefs.push(r);
    }
  }

  const rawFiles = await Promise.all(spineHrefs.map(async (href) => {
    const entry = zipFind(zip, href); return entry ? { href, html: await entry.async("string") } : null;
  }));

  // ── Parse navigation TOC (NCX or EPUB3 nav) for chapter titles ───────────
  // NCX format (EPUB2):
  //   <navPoint><navLabel><text>Chapter Title</text></navLabel>
  //             <content src="chapter01.xhtml#anchor"/></navPoint>
  // EPUB3 nav format:
  //   <nav epub:type="toc"><ol><li><a href="chapter01.xhtml">Title</a></li></ol></nav>
  //
  const tocEntries = [];

  const parseNcx = (xml) => {
    const navPointRe = /<navPoint[\s\S]*?<\/navPoint>/gi;
    let np;
    while ((np = navPointRe.exec(xml)) !== null) {
      const textM = np[0].match(/<text[^>]*>([\s\S]*?)<\/text>/i);
      const srcM  = np[0].match(/<content[^>]+src=["']([^"']+)["']/i);
      if (!textM || !srcM) continue;
      const title    = decodeEntities(textM[1].replace(/<[^>]+>/g, "").trim());
      const raw      = srcM[1];
      const hi       = raw.indexOf("#");
      const base     = (hi === -1 ? raw : raw.slice(0, hi)).split("/").pop().split("?")[0];
      const fragment = hi === -1 ? "" : raw.slice(hi + 1);
      if (title && base) tocEntries.push({ title, base, fragment });
    }
  };

  const parseNav = (xml) => {
    const re = /<a\s[^>]*href=["']([^"'][^"']*?)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let mm;
    while ((mm = re.exec(xml)) !== null) {
      const raw = mm[1];
      if (!raw || raw.startsWith("?")) continue;
      const hi       = raw.indexOf("#");
      const base     = (hi === -1 ? raw : raw.slice(0, hi)).split("/").pop().split("?")[0];
      const fragment = hi === -1 ? "" : raw.slice(hi + 1);
      const title    = decodeEntities(mm[2].replace(/<[^>]+>/g, "").trim());
      if (title && base) tocEntries.push({ title, base, fragment });
    }
  };

  try {
    const navId = Object.keys(manifest).find(k => manifest[k].props.includes("nav"));
    const ncxId = Object.keys(manifest).find(k =>
      manifest[k].type.includes("ncx") || manifest[k].href.endsWith(".ncx"));

    // Try EPUB3 nav first, then NCX — parse BOTH so we get the most titles
    if (navId) {
      const navHref = resolveHref(opfDir, manifest[navId].href);
      const navEntry = navHref ? zipFind(zip, navHref) : null;
      if (navEntry) parseNav(await navEntry.async("string"));
    }
    if (ncxId) {
      const ncxHref = resolveHref(opfDir, manifest[ncxId].href);
      const ncxEntry = ncxHref ? zipFind(zip, ncxHref) : null;
      if (ncxEntry) parseNcx(await ncxEntry.async("string"));
    }
  } catch(e) { /* nav parse failure is non-fatal */ }
  // ─────────────────────────────────────────────────────────────────────────

  // ── Build chapters using the TOC as the sole authority ───────────────────
  // Apple Books and Kindle both use this model: the NCX/nav TOC is the
  // definitive list of navigable chapters. Every spine file that is NOT
  // directly referenced in the TOC gets appended to the preceding chapter —
  // it is front matter, back matter, an epigraph file, a title-page file, etc.
  // Files that appear between two TOC entries are absorbed into the first one.
  //
  // This eliminates the pattern of: title page → epigraph page → title page
  // which arose from EPUB publishers splitting one logical chapter into
  // a "title file" (h2 + maybe an epigraph) and a "content file" (h2 + text).
  // When we only create chapter boundaries at TOC entries, that structure
  // collapses into a single chapter with a correct title page.

  const _seenToc = new Set();
  const _uEntries = tocEntries.filter(e => { const k = e.base+"\x00"+e.fragment; return _seenToc.has(k)?false:(_seenToc.add(k),true); });
  const tocByFile = {};
  for (const e of _uEntries) { if (!tocByFile[e.base]) tocByFile[e.base]=[]; tocByFile[e.base].push({title:e.title,fragment:e.fragment}); }
  const tocBasenames = new Set(Object.keys(tocByFile));
  const hasToc = tocBasenames.size > 0;

  function splitHtmlAtFragments(html, entries) {
    const positions = entries.map(({fragment}) => {
      if (!fragment) return 0;
      const re = new RegExp(`id=["']?${fragment.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}["']?[\\s>]`,"i");
      const m = re.exec(html); if (!m) return -1;
      let p = m.index; while (p > 0 && html[p] !== "<") p--; return p;
    });
    return entries.map(({title},i) => {
      const start = positions[i]===-1?(i===0?0:(positions[i-1]??0)):positions[i];
      const end = i<entries.length-1?(positions[i+1]===-1?html.length:positions[i+1]):html.length;
      return {title, html:html.slice(Math.max(0,start),end)};
    });
  }
  function makeChapterBlocks(blocks,title) {
    const norm=s=>s.toLowerCase().replace(/[^a-z0-9]/g,"");
    if (blocks[0]?.type==="heading"||blocks[0]?.type==="subheading") return blocks;
    const fp=blocks[0];
    if (fp?.type==="para"&&norm(fp.text)===norm(title)) return [{type:"subheading",text:fp.text},...blocks.slice(1)];
    return [{type:"subheading",text:title},...blocks];
  }

  const chapters = [];
  let partNum = 0;

  for (const f of rawFiles) {
    if (!f) continue;
    const base = f.href.split("/").pop().split("?")[0];
    const isTocFile = hasToc ? tocBasenames.has(base) : true;
    const fileEntries = tocByFile[base] || [];
    if (!isTocFile && chapters.length > 0) {
      const last = chapters[chapters.length-1];
      last.blocks = [...last.blocks, ...htmlToBlocks(f.html)];
      continue;
    }
    if (fileEntries.length > 1) {
      for (const {title, html:ph} of splitHtmlAtFragments(f.html, fileEntries)) {
        const blocks = htmlToBlocks(ph);
        if (!blocks.some(b=>b.text?.trim().length>5)) continue;
        chapters.push({title, blocks:makeChapterBlocks(blocks,title)});
      }
      continue;
    }
    const blocks = htmlToBlocks(f.html);
    if (!blocks.some(b=>b.text?.trim().length>5)) continue;
    const tocTitle = fileEntries[0]?.title;
    const firstHeading = blocks.find(b=>b.type==="heading"||b.type==="subheading");
    const title = tocTitle||firstHeading?.text||`Part ${++partNum}`;
    chapters.push({title, blocks:makeChapterBlocks(blocks,title)});
  }

  // Fallback: if TOC was empty and we got no chapters, re-run without TOC filter
  if (chapters.length === 0) {
    for (const f of rawFiles) {
      if (!f) continue;
      const blocks = htmlToBlocks(f.html);
      if (!blocks.some(b => b.text?.trim().length > 5)) continue;
      const base = f.href.split("/").pop().split("?")[0];
      const firstHeading = blocks.find(b => b.type === "heading" || b.type === "subheading");
      const title = firstHeading?.text || `Part ${++partNum}`;
      const startsWithHeading = blocks[0]?.type === "heading" || blocks[0]?.type === "subheading";
      const chapterBlocks = startsWithHeading ? blocks : [{ type: "subheading", text: title }, ...blocks];
      chapters.push({ title, blocks: chapterBlocks });
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  if (chapters.length === 0) throw new Error("Could not extract any text");

  return { title: epubTitle, author: epubAuthor, chapters, coverDataUrl };
}

// ============================================================================
// READING STREAK & SESSION TRACKING  (unchanged)
// ============================================================================
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function startReadingSession(bookId) {
  state.sessionStart = Date.now();
  state.sessionBookId = bookId;
}

function endReadingSession() {
  if (!state.sessionStart || !state.sessionBookId) return;
  const mins = (Date.now() - state.sessionStart) / 60000;
  const key = todayKey();
  state.readingLog[key] = (state.readingLog[key] || 0) + mins;
  saveReadingLog();
  state.sessionStart = null;
  state.sessionBookId = null;
}

async function saveReadingLog() {
  await window.storage.set("reading_log", JSON.stringify(state.readingLog));
}

function getStreakDays() {
  const days = [];
  // i = 6 → oldest day (leftmost), i = 0 → today (rightmost).
  // Reads chronologically left-to-right: oldest → yesterday → today.
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const mins = state.readingLog[key] || 0;
    days.push({ key, mins, filled: mins >= 5, isToday: i === 0 });
  }
  return days;
}

function getCurrentStreak() {
  let streak = 0;
  const d = new Date();
  const todayMins = state.readingLog[d.toISOString().slice(0, 10)] || 0;
  if (todayMins < 5) d.setDate(d.getDate() - 1);
  while (true) {
    const key = d.toISOString().slice(0, 10);
    if ((state.readingLog[key] || 0) >= 5) { streak++; d.setDate(d.getDate() - 1); }
    else break;
  }
  return streak;
}

function renderStreakDots() {
  const days = getStreakDays();
  const dotsEl = document.getElementById("streak-dots");
  const countEl = document.getElementById("streak-count-label");
  if (!dotsEl) return;
  // Fix: build oldest→newest so CSS row-reverse puts today on the right
  dotsEl.innerHTML = days.map(d => {
    let cls = "streak-dot";
    if (d.filled) cls += " filled";
    else if (d.isToday) cls += " today-empty";
    return `<div class="${cls}" title="${d.key}: ${Math.round(d.mins)}m"></div>`;
  }).join("");
  const streak = getCurrentStreak();
  countEl.textContent = `${streak} day streak`;
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
    if (parsed.highlightWords !== undefined) state.highlightWords = parsed.highlightWords;
    if (parsed.underlineLine !== undefined) state.underlineLine = parsed.underlineLine;
    if (parsed.justifyText !== undefined) state.justifyText = parsed.justifyText;
    if (parsed.connectedFolder !== undefined) state.connectedFolder = parsed.connectedFolder;
    if (parsed.ollamaUrl !== undefined) state.ollamaUrl = parsed.ollamaUrl;
    if (parsed.ollamaModel !== undefined) state.ollamaModel = parsed.ollamaModel;
    if (parsed.fontSize !== undefined) state.fontSize = parsed.fontSize;
    if (parsed.lineSpacing !== undefined) state.lineSpacing = parsed.lineSpacing;
    if (parsed.fontFamily !== undefined) state.fontFamily = parsed.fontFamily;
  }

  const readingLogData = await window.storage.get("reading_log");
  if (readingLogData) state.readingLog = JSON.parse(readingLogData.value);

  applyTheme(state.themeKey);
  renderLibrary();
  renderAudiobooks();
  renderStreakDots();

  const notesData = await window.storage.get("reader_notes");
  if (notesData) { try { state.notes = JSON.parse(notesData.value); } catch {} }

  const nbMeta = await window.storage.get("notebooks_meta");
  if (nbMeta) { try { state.notebooks = JSON.parse(nbMeta.value); } catch {} }

  initSelectionToolbar();

  const searchInput = document.getElementById("library-search");
  searchInput.oninput = (e) => {
    state.searchQuery = e.target.value.toLowerCase();
    if (state.searchQuery.length > 0) renderSearchDropdown();
    else closeSearchDropdown();
    renderLibrary();
  };
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeSearchDropdown(); searchInput.blur(); }
    if (e.key === "Enter") {
      const first = document.querySelector(".search-result-item");
      if (first) first.click();
    }
  });
  searchInput.addEventListener("focus", () => {
    if (state.searchQuery.length > 0) renderSearchDropdown();
  });

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      searchInput.focus(); searchInput.select();
    }
  });

  document.getElementById("btn-add-book").onclick = (e) => {
    e.stopPropagation();
    const popup = document.getElementById("add-choice-popup");
    const btn   = document.getElementById("btn-add-book");
    const rect  = btn.getBoundingClientRect();
    popup.style.top  = `${rect.bottom + 8}px`;
    popup.style.left = `${Math.min(rect.left, window.innerWidth - 230)}px`;
    popup.classList.toggle("hidden");
  };
  document.getElementById("choice-add-book").onclick = () => {
    document.getElementById("add-choice-popup").classList.add("hidden");
    document.getElementById("file-input").click();
  };
  document.getElementById("choice-new-notebook").onclick = () => {
    document.getElementById("add-choice-popup").classList.add("hidden");
    createNewNotebook();
  };
  document.addEventListener("click", (e) => {
    const popup = document.getElementById("add-choice-popup");
    if (!popup?.classList.contains("hidden") && !popup.contains(e.target) && e.target.id !== "btn-add-book")
      popup.classList.add("hidden");
  });
  document.getElementById("btn-settings").onclick = () => openModal("settings-modal");
  document.getElementById("btn-close-settings").onclick = () => closeModal("settings-modal");
  document.getElementById("btn-exit-reader").onclick = exitReader;
  document.getElementById("btn-exit-notebook").onclick = exitNotebook;
  document.getElementById("btn-profile").onclick = openProfile;
  document.getElementById("btn-close-profile").onclick = () => closeModal("profile-modal");

  document.getElementById("file-input").onchange = handleFileUpload;
  document.getElementById("folder-input").onchange = handleFolderSelect;
  document.getElementById("audio-input").onchange = handleAudioUpload;

  document.querySelectorAll(".tab").forEach(t => t.onclick = (e) => switchModalTab(e.target.dataset.tab));

  document.querySelectorAll(".lib-tab").forEach(t => t.onclick = (e) => {
    const tab = e.target.dataset.libtab;
    state.activeLibTab = tab;
    if (tab === "notebooks") renderNotebooks();
    document.querySelectorAll(".lib-tab").forEach(x => x.classList.toggle("active", x.dataset.libtab === tab));
    document.querySelectorAll(".lib-tab-panel").forEach(p => {
      p.classList.toggle("active", p.id === `tab-${tab}`);
      p.classList.toggle("hidden", p.id !== `tab-${tab}`);
    });
    if (tab === "audiobooks") renderAudiobooks();
  });

  document.getElementById("btn-prev-page").onclick = prevPage;
  document.getElementById("btn-next-page").onclick = nextPage;
  document.getElementById("tap-zone-prev").onclick = prevPage;
  document.getElementById("tap-zone-next").onclick = nextPage;
  document.getElementById("btn-toggle-audio").onclick = toggleAudio;
  document.getElementById("btn-upload-audio").onclick = () => showAudioPanel();
  document.getElementById("btn-reader-notes").onclick = openNotesViewer;
  document.getElementById("btn-reader-settings").onclick = () => document.getElementById("reader-settings-panel").classList.toggle("hidden");
  document.getElementById("btn-chapter-drop").onclick = () => {
    const drop = document.getElementById("chapter-dropdown");
    const isOpening = drop.classList.contains("hidden");
    drop.classList.toggle("hidden");
    if (isOpening) {
      const searchEl = document.getElementById("chapter-search");
      searchEl.value = "";
      // Wire search handler once here, not inside buildChapterDropdown
      searchEl.oninput = buildChapterDropdown;
      buildChapterDropdown();
      requestAnimationFrame(() => searchEl.focus());
    }
  };

  window.addEventListener("keydown", (e) => {
    if (state.view !== "reader") return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") nextPage();
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") prevPage();
    else if (e.key === "Escape") {
      document.getElementById("reader-settings-panel").classList.add("hidden");
      document.getElementById("chapter-dropdown").classList.add("hidden");
    }
  });

  document.getElementById("audio-player").onended = () => { state.isPlaying = false; updateAudioBtn(); };

  const isMac = navigator.platform.toUpperCase().includes("MAC");
  document.querySelector(".search-shortcut").textContent = isMac ? "⌘K" : "Ctrl+K";

  // Debounced resize: simply rebuild current strip so columns reflow
  window.addEventListener("resize", () => {
    if (state.view !== "reader") return;
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      _currentRenderedChapter = -1; // card dimensions changed — recompute page breaks
      rebuildReaderForSettings();
    }, 200);
  });
}

// ============================================================================
// SEARCH DROPDOWN  (unchanged)
// ============================================================================
function renderSearchDropdown() {
  const drop = document.getElementById("search-results-dropdown");
  const q = state.searchQuery;
  const results = state.library.filter(b =>
    b.title.toLowerCase().includes(q) || (b.author && b.author.toLowerCase().includes(q))
  ).slice(0, 6);

  if (results.length === 0) {
    drop.innerHTML = `<div class="search-no-results">No books found for "${q}"</div>`;
  } else {
    drop.innerHTML = results.map(b => {
      const [c1, c2] = generateCoverColor(b.title);
      const coverHtml = b.coverDataUrl
        ? `<img src="${b.coverDataUrl}" alt="">`
        : `<div style="width:100%;height:100%;background:linear-gradient(135deg,${c1},${c2});display:flex;align-items:center;justify-content:center;font-size:7px;color:rgba(255,255,255,0.7);font-weight:700;text-align:center;padding:2px;">${b.title.slice(0,8)}</div>`;
      const fmt = (b.format === "epub" || b.format === "epub3") ? "EPUB" : (b.format?.toUpperCase() || "TXT");
      const pct = b.totalChapters > 0 ? Math.round(((b.currentChapter || 0) / b.totalChapters) * 100) : 0;
      return `<div class="search-result-item" data-id="${b.id}">
        <div class="search-result-cover">${coverHtml}</div>
        <div class="search-result-info">
          <div class="search-result-title">${b.title}</div>
          ${b.author ? `<div class="search-result-author">${b.author}</div>` : ""}
        </div>
        <span class="search-result-badge">${pct}%</span>
        <span class="search-result-badge">${fmt}</span>
      </div>`;
    }).join("");

    drop.querySelectorAll(".search-result-item").forEach(el => {
      el.onclick = () => {
        const book = state.library.find(b => b.id === el.dataset.id);
        if (book) { closeSearchDropdown(); openBook(book); }
      };
    });
  }
  drop.classList.remove("hidden");
}

function closeSearchDropdown() {
  document.getElementById("search-results-dropdown").classList.add("hidden");
}

function switchView(view) {
  state.view = view;
  document.querySelectorAll(".view").forEach(el => el.classList.remove("active"));
  document.getElementById(`${view}-view`).classList.add("active");
}

function applyTheme(key) {
  const allThemes = { ...BUILT_IN_THEMES, ...state.customThemes };
  const theme = allThemes[key] || BUILT_IN_THEMES.dark;
  const root = document.documentElement;
  Object.keys(theme).forEach(prop => root.style.setProperty(`--${prop}`, theme[prop]));
  // Rebuild page styles if in reader (theme changes readerText etc.)
  if (state.view === "reader") ensurePageStyle();
}

function savePreferences() {
  window.storage.set("app_theme", JSON.stringify({
    themeKey: state.themeKey, customThemes: state.customThemes,
    tapToTurn: state.tapToTurn, twoPage: state.twoPage,
    highlightWords: state.highlightWords, underlineLine: state.underlineLine,
    justifyText: state.justifyText,
    connectedFolder: state.connectedFolder,
    ollamaUrl: state.ollamaUrl, ollamaModel: state.ollamaModel,
    fontSize: state.fontSize, lineSpacing: state.lineSpacing, fontFamily: state.fontFamily
  }));
}

async function renderLibrary() {
  const grid = document.getElementById("library-grid");
  grid.innerHTML = "";

  const displayLibrary = state.library;

  if (displayLibrary.length === 0) {
    document.getElementById("empty-state").classList.remove("hidden");
    document.getElementById("library-header-text").classList.add("hidden");
  } else {
    document.getElementById("empty-state").classList.add("hidden");
    document.getElementById("library-header-text").classList.remove("hidden");
    document.getElementById("library-count").textContent = `${displayLibrary.length} book${displayLibrary.length !== 1 ? "s" : ""}`;
  }

  let _dragSrc = null;
  displayLibrary.forEach((book, idx) => {
    const el = createBookCard(book);
    el.draggable = true;
    el.addEventListener("dragstart", (e) => { _dragSrc=idx; e.dataTransfer.effectAllowed="move"; requestAnimationFrame(()=>el.classList.add("drag-ghost")); });
    el.addEventListener("dragend", () => { el.classList.remove("drag-ghost"); grid.querySelectorAll(".drag-over").forEach(c=>c.classList.remove("drag-over")); });
    el.addEventListener("dragover", (e) => { e.preventDefault(); if (_dragSrc!==idx){grid.querySelectorAll(".drag-over").forEach(c=>c.classList.remove("drag-over"));el.classList.add("drag-over");} });
    el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
    el.addEventListener("drop", (e) => { e.preventDefault(); el.classList.remove("drag-over"); if (_dragSrc===null||_dragSrc===idx) return; const[m]=state.library.splice(_dragSrc,1); state.library.splice(idx,0,m); _dragSrc=null; saveLibrary(); renderLibrary(); });
    grid.appendChild(el);
  });
  renderStreakDots();
}

function renderAudiobooks() {
  const grid = document.getElementById("audiobook-grid");
  const empty = document.getElementById("audiobook-empty-state");
  const count = document.getElementById("audiobook-count");
  const header = document.getElementById("audiobook-header-text");
  grid.innerHTML = "";
  const audiobBooks = state.library.filter(b => b.hasAudio);
  if (audiobBooks.length === 0) {
    count.textContent = "";
    if (header) header.classList.add("hidden");
    empty.innerHTML = `No audiobooks downloaded.<br/><span>Supports .mp3 · .m4b · .wav · .ogg · .flac</span>`;
    empty.classList.remove("hidden");
    return;
  }
  count.textContent = `${audiobBooks.length} audiobook${audiobBooks.length !== 1 ? "s" : ""}`;
  if (header) header.classList.remove("hidden");
  empty.classList.add("hidden");
  audiobBooks.forEach(book => {
    const [c1, c2] = generateCoverColor(book.title);
    const el = document.createElement("div");
    el.className = "audiobook-card";
    const thumbHtml = book.coverDataUrl
      ? `<img src="${book.coverDataUrl}" alt="">`
      : `<div style="width:44px;height:44px;background:linear-gradient(135deg,${c1},${c2});border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:9px;color:rgba(255,255,255,0.7);font-weight:700;text-align:center;padding:4px;">${book.title.slice(0,6)}</div>`;
    el.innerHTML = `
      <div class="audiobook-thumb">${thumbHtml}</div>
      <div class="audiobook-info">
        <div class="audiobook-title">${book.title}</div>
        ${book.author ? `<div class="audiobook-author">${book.author}</div>` : ""}
      </div>
      <div class="audiobook-play-btn">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"/><polygon points="10,8 17,12 10,16" fill="currentColor"/></svg>
      </div>
    `;
    el.onclick = () => openBook(book, true);
    grid.appendChild(el);
  });
}

function createBookCard(book) {
  const [c1, c2] = generateCoverColor(book.title);
  const totalChaps = book.totalChapters || 1;
  const pct = totalChaps > 1 ? ((book.currentChapter || 0) / (totalChaps - 1)) * 100 : 0;
  const fmt = (book.format === "epub" || book.format === "epub3") ? "EPUB" : (book.format?.toUpperCase() || "TXT");

  const el = document.createElement("div");
  el.className = "book-card-container";

  const coverContent = book.coverDataUrl
    ? `<img src="${book.coverDataUrl}" alt="${book.title}">`
    : `<div class="cover-spine"></div><div class="cover-crease"></div><div class="cover-edge"></div>
       <div class="cover-title">${book.title}</div>
       ${book.author ? `<div class="cover-author">${book.author}</div>` : ""}`;

  el.innerHTML = `
    <div class="book-cover" style="--c1:${c1}; --c2:${c2}">
      ${coverContent}
      <div class="cover-badge">${fmt}</div>
      ${book.hasAudio ? `<div class="cover-audio">🎧</div>` : ""}
      <div class="cover-prog-bg"><div class="cover-prog-fill" style="width:${pct}%"></div></div>
    </div>
    <div class="book-meta">
      <div class="meta-text">
        <div class="meta-title">${book.title}</div>
        ${book.author ? `<div class="meta-author">${book.author}</div>` : ""}
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
      <button class="ctx-item lookup-book-btn">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="6.5" cy="6.5" r="4" stroke="currentColor" stroke-width="1.5"/><line x1="9.8" y1="9.8" x2="14" y2="14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        Look up ${book.title.length > 22 ? book.title.slice(0,22)+'…' : book.title}
      </button>
      ${book.author ? `<button class="ctx-item lookup-author-btn">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="5.5" r="2.5" stroke="currentColor" stroke-width="1.4"/><path d="M2.5 13c0-2.485 2.462-4.5 5.5-4.5s5.5 2.015 5.5 4.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
        Look up ${book.author.length > 20 ? book.author.slice(0,20)+'…' : book.author}
      </button>` : ''}
      <button class="ctx-item summarize-book-btn">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="1" y="3" width="14" height="2" rx="1" fill="currentColor" opacity=".7"/><rect x="1" y="7" width="10" height="2" rx="1" fill="currentColor" opacity=".9"/><rect x="1" y="11" width="7" height="2" rx="1" fill="currentColor" opacity=".6"/></svg>
        Search summary
      </button>
      <button class="ctx-item reset-btn">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 8a5 5 0 1 1 1 3.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><polyline points="1,5 3,8 6,6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Reset progress
      </button>
      <button class="ctx-item danger delete-btn">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M6 4V2h4v2M5 4l1 9h4l1-9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Delete book
      </button>
    </div>
  `;

  el.querySelector(".book-cover").onclick = () => openBook(book);
  const menu = el.querySelector(".context-menu");
  el.querySelector(".btn-dots").onclick = (e) => {
    e.stopPropagation();
    document.querySelectorAll(".context-menu").forEach(m => { if (m !== menu) m.classList.add("hidden"); });
    const wasHidden = menu.classList.contains("hidden");
    menu.classList.toggle("hidden");
    if (wasHidden) {
      const btnRect = e.currentTarget.getBoundingClientRect();
      menu.style.top = "-9999px"; menu.style.left = "-9999px";
      const menuH = menu.offsetHeight || 170;
      const menuW = menu.offsetWidth || 215;
      const spaceBelow = window.innerHeight - btnRect.bottom - 8;
      const spaceAbove = btnRect.top - 8;
      let left = btnRect.left + btnRect.width / 2 - menuW / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - menuW - 8));
      menu.style.left = `${left}px`;
      if (spaceBelow >= menuH || spaceBelow >= spaceAbove) {
        menu.style.top = `${btnRect.bottom + 6}px`;
        menu.style.bottom = "auto";
      } else {
        menu.style.bottom = `${window.innerHeight - btnRect.top + 6}px`;
        menu.style.top = "auto";
      }
    }
  };
  el.querySelector(".reset-btn").onclick = (e) => { e.stopPropagation(); resetBookProgress(book.id); menu.classList.add("hidden"); };
  el.querySelector(".summarize-book-btn")?.addEventListener("click", (e) => {
    e.stopPropagation(); menu.classList.add("hidden");
    if (state.ollamaUrl) {
      showBookSummaryModal(book);
    } else {
      const q = encodeURIComponent(book.title + (book.author ? " by " + book.author : "") + " book summary");
      window.open("https://duckduckgo.com/?q=" + q, "_blank");
    }
  });
  el.querySelector(".delete-btn").onclick = (e) => { e.stopPropagation(); deleteBook(book.id); menu.classList.add("hidden"); };
  el.querySelector(".lookup-book-btn")?.addEventListener("click", (e) => {
    e.stopPropagation(); menu.classList.add("hidden");
    window.open(`https://www.google.com/search?q=${encodeURIComponent(book.title + " book")}`, "_blank");
  });
  el.querySelector(".lookup-author-btn")?.addEventListener("click", (e) => {
    e.stopPropagation(); menu.classList.add("hidden");
    window.open(`https://www.google.com/search?q=${encodeURIComponent(book.author + " author")}`, "_blank");
  });

  return el;
}

function showBookSummaryModal(book) {
  const existing = document.getElementById("book-summary-modal");
  if (existing) existing.remove();

  const abortCtrl = new AbortController();

  const modal = document.createElement("div");
  modal.id = "book-summary-modal";
  modal.className = "modal-overlay";
  modal.innerHTML = `
    <div class="modal-content" style="max-width:440px;">
      <div class="modal-header">
        <h2>Book Summary</h2>
        <button class="btn-close" id="bsm-close">×</button>
      </div>
      <div style="padding:18px 22px 22px;">
        <div style="display:flex;gap:12px;align-items:center;margin-bottom:16px;">
          ${book.coverDataUrl
            ? `<img src="${book.coverDataUrl}" style="width:40px;height:56px;border-radius:4px;object-fit:cover;flex-shrink:0;">`
            : `<div style="width:40px;height:56px;border-radius:4px;background:linear-gradient(135deg,#2C3E50,#3498DB);flex-shrink:0;"></div>`}
          <div>
            <div style="font-size:14px;font-weight:700;color:var(--text);">${book.title}</div>
            ${book.author ? `<div style="font-size:12px;color:var(--textDim);margin-top:2px;">${book.author}</div>` : ""}
          </div>
        </div>
        <div id="bsm-body" style="font-size:13px;color:var(--textMuted);line-height:1.65;min-height:80px;">
          <span style="color:var(--textDim);font-style:italic;">Generating summary…</span>
        </div>
        <div style="margin-top:16px;display:flex;gap:10px;">
          <a href="https://duckduckgo.com/?q=${encodeURIComponent('Summary of ' + book.title + (book.author ? ' by ' + book.author : ''))}"
             target="_blank" class="btn secondary" style="flex:1;justify-content:center;text-decoration:none;">
            🔍 Search DuckDuckGo
          </a>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  const closeModal = () => { abortCtrl.abort(); modal.remove(); };
  modal.querySelector("#bsm-close").onclick = closeModal;
  modal.onclick = (e) => { if (e.target === modal) closeModal(); };

  (async () => {
    const bodyEl = document.getElementById("bsm-body");
    if (!bodyEl) return;
    try {
      let summary = "";
      const prompt = `In 4 sentences or fewer, summarize "${book.title}"${book.author ? ` by ${book.author}` : ""}. Cover themes, plot and significance. Reply with only the summary.`;

      if (state.ollamaUrl) {
        const model = state.ollamaModel || "llama3";
        const r = await fetch(`${getOllamaUrl()}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, prompt, stream: false, keep_alive: "10m" }),
          signal: abortCtrl.signal
        });
        if (r.ok) {
          const d = await r.json();
          summary = d?.response?.trim() || "";
        }
      }

      const bsmBody = document.getElementById("bsm-body");
      if (bsmBody) {
        if (summary) {
          bsmBody.innerHTML = `<p style="margin:0;">${summary}</p>`;
        } else {
          bsmBody.innerHTML = `<span style="color:var(--textDim);font-size:12px;">Could not generate summary. Try searching DuckDuckGo.</span>`;
        }
      }
    } catch(err) {
      if (err.name === "AbortError") return;
      const bsmBody = document.getElementById("bsm-body");
      if (bsmBody) bsmBody.innerHTML = `<span style="color:var(--textDim);font-size:12px;">Summary unavailable. Try searching DuckDuckGo for more information.</span>`;
    }
  })();
}

async function openBook(book, autoPlay = false) {
  state.activeBook = book;
  state.chapters = [];
  state.currentChapter = book.currentChapter || 0;
  state.currentPage = book.currentPage || 0;

  switchView("reader");
  document.getElementById("reader-book-title").textContent = book.title;

  // ── Cover loading screen ──────────────────────────────────────────────────
  // Show the book's cover (or gradient fallback) with a spinner while
  // IndexedDB loads. Fades in immediately so the user sees a response at once.
  const card = document.getElementById("reader-card");
  const [c1, c2] = generateCoverColor(book.title);
  const coverHTML = book.coverDataUrl
    ? `<img src="${book.coverDataUrl}" style="max-width:220px;max-height:300px;
         object-fit:contain;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,0.35);
         display:block;">`
    : `<div style="width:160px;height:220px;border-radius:8px;
         background:linear-gradient(135deg,${c1},${c2});
         box-shadow:0 8px 40px rgba(0,0,0,0.3);display:flex;align-items:flex-end;
         padding:14px;box-sizing:border-box;">
         <span style="color:rgba(255,255,255,0.9);font-size:13px;font-weight:700;
           font-family:Georgia,serif;line-height:1.3;">${book.title}</span>
       </div>`;

  const loadScreen = document.createElement("div");
  loadScreen.style.cssText = `display:flex;flex-direction:column;align-items:center;
    justify-content:center;height:100%;gap:24px;opacity:0;
    transition:opacity 0.3s ease;background:var(--readerCard);`;
  loadScreen.innerHTML = `
    ${coverHTML}
    <div style="display:flex;align-items:center;gap:8px;color:var(--textDim);font-size:12px;font-family:var(--font-ui);">
      <div class="spinner"></div>
      <span>Loading…</span>
    </div>`;
  card.innerHTML = "";
  card.appendChild(loadScreen);

  // Wait for two animation frames — the first commits the DOM mutation,
  // the second guarantees the browser has actually painted the opacity:0 state.
  // Only after that do we set opacity:1 (triggering the CSS transition) and
  // start the IndexedDB load. Without this, the load completes so quickly that
  // the browser batches both opacity changes into a single frame and the
  // transition never renders.
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  loadScreen.style.opacity = "1";

  // Record when the cover became visible so we can enforce a minimum display time
  const coverVisibleAt = Date.now();

  // Load content — browser has already painted the cover screen
  const chapters = await loadBookContent(book.id);

  if (!chapters) {
    card.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;
      height:100%;color:var(--textDim);font-size:14px;">Could not load book content.</div>`;
    return;
  }

  // ── Inject a cover page as the first chapter ──────────────────────────────
  // This gives readers the tactile feel of opening a physical book.
  // We only inject it on first open (currentChapter === 0 and currentPage === 0)
  // so returning readers land back at their reading position.
  const coverChapter = {
    title: "_cover_",
    blocks: [{ type: "cover", text: "", src: book.coverDataUrl || "" }]
  };
  state.chapters = [coverChapter, ...chapters];

  // If this is a returning reader, offset chapter index by 1 to account for
  // the injected cover chapter
  if (book.currentChapter > 0 || book.currentPage > 0) {
    state.currentChapter = (book.currentChapter || 0) + 1;
  }

  const audSrc = await window.storage.get(`audio_${book.id}`);
  state.audioSrc = audSrc ? audSrc.value : null;
  const player = document.getElementById("audio-player");
  if (state.audioSrc) player.src = state.audioSrc;
  updateAudioBtn();

  if (autoPlay && state.audioSrc) {
    player.play(); state.isPlaying = true; updateAudioBtn();
  }

  // Enforce a minimum 1.5 s of cover screen visibility so the user always
  // sees it, even on fast devices where loadBookContent is near-instant.
  const elapsed = Date.now() - coverVisibleAt;
  const MIN_COVER_MS = 1500;
  if (elapsed < MIN_COVER_MS) {
    await new Promise(r => setTimeout(r, MIN_COVER_MS - elapsed));
  }

  // Fade out the loading screen, then render
  loadScreen.style.opacity = "0";
  await new Promise(r => setTimeout(r, 300));

  // ── Compute all chapter page breaks ───────────────────────────────────────
  // We compute every chapter's page breaks NOW, while the loading screen is
  // still visible. This is the same approach Kindle and Apple Books use:
  // reflow everything upfront so the reader always opens with exact page
  // counts — no estimation, no "~", no jumps as background work completes.
  //
  // A typical novel (~300 chapters) takes 100–300ms. We already have a
  // 1.5 s loading screen, so this is invisible to the user.
  _chapterBreaksCache = {};
  _lazyComputeGen++;
  document.getElementById("reader-card").classList.toggle("two-page", state.twoPage);
  for (let i = 0; i < state.chapters.length; i++) {
    _chapterBreaksCache[i] = computePageBreaks(i);
  }

  renderReader();
  startReadingSession(book.id);
  warmUpOllama();
}

function warmUpOllama() {
  if (!state.ollamaUrl) return;
  fetch(`${getOllamaUrl()}/api/generate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: state.ollamaModel || "llama3", prompt: "", keep_alive: "10m", stream: false })
  }).catch(() => {});
}

function exitReader() {
  endReadingSession();
  // Clean up paginator
  _pageBreaks = [];
  _currentRenderedChapter = -1;
  _chapterBreaksCache = {};
  _lazyComputeGen++;
  if (_pageStyleEl) { _pageStyleEl.remove(); _pageStyleEl = null; }

  state.activeBook = null;
  state.chapters = [];
  document.getElementById("audio-player").pause();
  state.isPlaying = false;
  switchView("library");
  renderLibrary();
}

function renderReader() {
  document.getElementById("reader-book-title").textContent = state.activeBook.title;
  buildChapterDropdown();
  buildReaderSettings();
  applyAccessibilityClasses();
  document.getElementById("reader-card").classList.toggle("two-page", state.twoPage);
  ensurePageStyle();

  // FIX — slow open: show the first page immediately without computing ALL
  // page breaks up front. We render just the first page using a fast
  // single-chapter computation, let the browser paint, then compute
  // remaining chapter breaks lazily in the background so the UI never blocks.
  _currentRenderedChapter = -1;
  renderPage(state.currentChapter, state.currentPage, false);
}

function applyAccessibilityClasses() {
  const card = document.getElementById("reader-card");
  card.classList.toggle("highlight-words", state.highlightWords);
  card.classList.toggle("underline-line", state.underlineLine);
}

function buildChapterDropdown() {
  const chaps = state.chapters || [];
  const list = document.getElementById("chapter-list");
  if (!list) return;
  const q = document.getElementById("chapter-search")?.value.trim().toLowerCase() || "";

  list.innerHTML = "";
  const realChapCount = chaps.filter(c => c.title !== "_cover_").length;
  document.getElementById("drop-book-title").textContent = state.activeBook?.title || "";
  document.getElementById("drop-book-stats").textContent = `${realChapCount} chapter(s)`;

  // Build a global page number map from the breaks cache.
  // For chapters not yet computed, we leave page start as "?" so the user
  // always sees real numbers once computed rather than unreliable estimates.
  let globalPageStart = 0;
  const chapterStartPages = []; // chapterStartPages[i] = global page number where chapter i starts
  for (let i = 0; i < chaps.length; i++) {
    chapterStartPages[i] = globalPageStart;
    const cached = _chapterBreaksCache[i];
    if (cached) {
      globalPageStart += cached.length;
    } else {
      // Mark remaining as unknown — will update once computed
      for (let j = i; j < chaps.length; j++) chapterStartPages[j] = null;
      break;
    }
  }

  const pageNumMatch = q.match(/^p(?:age)?\s*(\d+)$|^(\d+)$/);
  const isPureNumber = pageNumMatch && /^\d+$/.test(q);
  const queryNum = isPureNumber ? parseInt(q, 10) : null;

  chaps.forEach((ch, i) => {
    if (i === 0 && ch.title === "_cover_") return;

    // Text search: filter by title substring
    if (q && !isPureNumber && !ch.title.toLowerCase().includes(q)) return;

    // Number search: show chapters whose 1-based index matches OR whose title
    // contains the number string — always show all for empty query
    if (isPureNumber && queryNum !== null) {
      const chapterNum = i; // cover=0, first real chapter=1
      const titleMatch = ch.title.toLowerCase().includes(q);
      if (chapterNum !== queryNum && !titleMatch) return;
    }

    const displayNum = i;
    const pgStart = chapterStartPages[i];
    const pgLabel = pgStart != null ? `p. ${pgStart + 1}` : "";
    const el = document.createElement("div");
    el.className = `chapter-item ${i === state.currentChapter ? "active" : ""}`;
    el.innerHTML = `
      <div class="ch-flex">
        <div class="ch-title">${ch.title}</div>
        ${pgLabel ? `<div style="font-size:11px;color:var(--textDim);margin-left:8px;flex-shrink:0;">${pgLabel}</div>` : ""}
      </div>
      <div class="ch-sub">Chapter ${displayNum}</div>`;
    el.onclick = () => {
      jumpToChapter(i, 0);
      document.getElementById("chapter-dropdown").classList.add("hidden");
    };
    list.appendChild(el);
  });

  // Page jump — shown for any numeric query alongside chapter results
  if (pageNumMatch) {
    const pageNum = parseInt(pageNumMatch[1] || pageNumMatch[2], 10) - 1;
    const knownTotal = chapterStartPages.at(-1) != null
      ? (chapterStartPages.at(-1) || 0) + (_chapterBreaksCache[chaps.length - 1]?.length || 1)
      : estimateTotalPages();
    if (pageNum >= 0 && pageNum < knownTotal) {
      const sep = document.createElement("div");
      sep.style.cssText = "height:1px;background:var(--borderSubtle);margin:4px 12px;";
      list.appendChild(sep);
      const el = document.createElement("div");
      el.className = "chapter-item";
      el.innerHTML = `
        <div class="ch-flex">
          <div class="ch-title" style="color:var(--accent);">Go to page ${pageNum + 1}</div>
        </div>
        <div class="ch-sub">of ${knownTotal} pages total</div>`;
      el.onclick = () => {
        let remaining = pageNum;
        for (let i = 0; i < chaps.length; i++) {
          const chPgs = _chapterBreaksCache[i]?.length || 1;
          if (remaining < chPgs) { jumpToChapter(i, remaining); break; }
          remaining -= chPgs;
        }
        document.getElementById("chapter-dropdown").classList.add("hidden");
      };
      list.appendChild(el);
    }
  }

  // Note: chapter-search oninput is wired once at dropdown open time, not here.
}

// Recompute all chapter page breaks synchronously.
// Called after font size / line spacing / justify / two-page changes.
// Takes ~100–300ms for a full novel — fast enough to do inline after a
// slider release, matching how Kindle handles font size changes.
function recomputeAllChapterBreaks() {
  _chapterBreaksCache = {};
  _lazyComputeGen++;
  const chaps = state.chapters || [];
  for (let i = 0; i < chaps.length; i++) {
    _chapterBreaksCache[i] = computePageBreaks(i);
  }
}

// ============================================================================
// READER SETTINGS PANEL  (font/layout changes now call rebuildReaderForSettings)
// ============================================================================
function buildReaderSettings() {
  const panel = document.getElementById("reader-settings-panel");
  const tapOn = state.tapToTurn;
  const twoOn = state.twoPage;
  const hlOn = state.highlightWords;
  const ulOn = state.underlineLine;
  const justOn = state.justifyText !== false;

  panel.innerHTML = `
    <div class="section-label">THEME</div>
    <div class="radio-list" id="reader-theme-list" style="margin-bottom:14px;">
      ${Object.entries({...BUILT_IN_THEMES,...state.customThemes}).map(([k,t]) => `
        <label class="radio-item ${state.themeKey===k?'active':''}" style="cursor:pointer;">
          <input type="radio" name="reader-theme" value="${k}" ${state.themeKey===k?'checked':''} style="accent-color:var(--accent);">
          <div style="display:flex; gap:4px;">
            <div class="swatch" style="background:${t.bg}"></div>
            <div class="swatch" style="background:${t.surface}"></div>
            <div class="swatch" style="background:${t.accent||'#888'}"></div>
          </div>
          <span style="font-size:12px; font-weight:500; color:var(--text); flex:1;">${t.name}</span>
          ${k.startsWith("custom_") ? `<span style="font-size:10px; color:var(--textDim);">Custom</span>` : ""}
        </label>
      `).join("")}
    </div>
    <div class="section-label">DISPLAY</div>
    <label style="display:block; margin-bottom:12px; font-size:12px;">
      <div style="display:flex; justify-content:space-between; margin-bottom:5px;"><span>Font Size</span><span style="color:var(--textDim)" id="fs-val">${state.fontSize}px</span></div>
      <input type="range" id="fs-slider" min="14" max="28" step="1" value="${state.fontSize}">
    </label>
    <label style="display:block; margin-bottom:12px; font-size:12px;">
      <div style="display:flex; justify-content:space-between; margin-bottom:5px;"><span>Line Spacing</span><span style="color:var(--textDim)" id="ls-val">${state.lineSpacing}</span></div>
      <input type="range" id="ls-slider" min="1.4" max="2.4" step="0.1" value="${state.lineSpacing}">
    </label>
    <label style="display:block; font-size:12px;">
      <div style="margin-bottom:5px;">Font</div>
      <select id="font-select">
        <option value="Georgia, serif" ${state.fontFamily.includes("Georgia")?"selected":""}>Georgia</option>
        <option value="'Palatino Linotype', serif" ${state.fontFamily.includes("Palatino")?"selected":""}>Palatino</option>
        <option value="system-ui, sans-serif" ${state.fontFamily.includes("system")?"selected":""}>System UI</option>
      </select>
    </label>
    <div style="margin-top:14px; padding-top:14px; border-top:1px solid var(--borderSubtle)">
      <div class="section-label">NAVIGATION & LAYOUT</div>
      <label style="display:flex; align-items:center; justify-content:space-between; cursor:pointer; margin-bottom:10px;">
        <div style="font-size:12px; font-weight:500;">Tap margins to turn</div>
        <div id="tap-toggle" class="toggle-track ${tapOn?"on":"off"}"><div class="toggle-thumb"></div></div>
      </label>
      <label style="display:flex; align-items:center; justify-content:space-between; cursor:pointer; margin-bottom:10px;">
        <div style="font-size:12px; font-weight:500;">Justify text</div>
        <div id="justify-toggle" class="toggle-track ${justOn?"on":"off"}"><div class="toggle-thumb"></div></div>
      </label>
      <label style="display:flex; align-items:center; justify-content:space-between; cursor:pointer;">
        <div style="font-size:12px; font-weight:500;">Two-page spread</div>
        <div id="two-page-toggle" class="toggle-track ${twoOn?"on":"off"}"><div class="toggle-thumb"></div></div>
      </label>
    </div>
    <div style="margin-top:14px; padding-top:14px; border-top:1px solid var(--borderSubtle)">
      <div class="section-label">ACCESSIBILITY</div>
      <label style="display:flex; align-items:center; justify-content:space-between; cursor:pointer; margin-bottom:10px;">
        <div style="font-size:12px; font-weight:500;">Highlight words on hover</div>
        <div id="hl-toggle" class="toggle-track ${hlOn?"on":"off"}"><div class="toggle-thumb"></div></div>
      </label>
      <label style="display:flex; align-items:center; justify-content:space-between; cursor:pointer;">
        <div style="font-size:12px; font-weight:500;">Underline current line</div>
        <div id="ul-toggle" class="toggle-track ${ulOn?"on":"off"}"><div class="toggle-thumb"></div></div>
      </label>
    </div>
  `;

  panel.querySelectorAll("input[name='reader-theme']").forEach(radio => {
    radio.onchange = (e) => {
      state.themeKey = e.target.value;
      applyTheme(state.themeKey);
      savePreferences();
      buildReaderSettings();
    };
  });

  // Font size: update CSS live, re-measure columns
  document.getElementById("fs-slider").oninput = (e) => {
    state.fontSize = +e.target.value;
    document.getElementById("fs-val").textContent = `${state.fontSize}px`;
    ensurePageStyle(); _currentRenderedChapter = -1;
    renderPage(state.currentChapter, state.currentPage, false);
  };
  document.getElementById("fs-slider").onchange = (e) => {
    state.fontSize = +e.target.value;
    const anchor = (_pageBreaks||[])[state.currentPage]??0;
    ensurePageStyle(); recomputeAllChapterBreaks(); _currentRenderedChapter = -1; buildChapterDropdown();
    const nb = _chapterBreaksCache[state.currentChapter]||[0];
    let pg=0; for (let i=nb.length-1;i>=0;i--) { if (nb[i]<=anchor){pg=i;break;} }
    state.currentPage=pg; renderPage(state.currentChapter,pg,false); updateReaderNav(); savePreferences();
  };
  document.getElementById("ls-slider").oninput = (e) => {
    state.lineSpacing = +e.target.value;
    document.getElementById("ls-val").textContent = state.lineSpacing;
    ensurePageStyle(); _currentRenderedChapter = -1;
    renderPage(state.currentChapter, state.currentPage, false);
  };
  document.getElementById("ls-slider").onchange = (e) => {
    state.lineSpacing = +e.target.value;
    const anchor = (_pageBreaks||[])[state.currentPage]??0;
    ensurePageStyle(); recomputeAllChapterBreaks(); _currentRenderedChapter = -1; buildChapterDropdown();
    const nb = _chapterBreaksCache[state.currentChapter]||[0];
    let pg=0; for (let i=nb.length-1;i>=0;i--) { if (nb[i]<=anchor){pg=i;break;} }
    state.currentPage=pg; renderPage(state.currentChapter,pg,false); updateReaderNav(); savePreferences();
  };
  document.getElementById("font-select").onchange = (e) => {
    state.fontFamily = e.target.value;
    rebuildReaderForSettings();
    savePreferences();
  };

  document.getElementById("tap-toggle").onclick = () => {
    state.tapToTurn = !state.tapToTurn;
    buildReaderSettings(); updateReaderNav(); savePreferences();
  };
  document.getElementById("justify-toggle").onclick = () => {
    state.justifyText = !state.justifyText;
    const tog = document.getElementById("justify-toggle");
    if (tog) { tog.classList.toggle("on", state.justifyText!==false); tog.classList.toggle("off", state.justifyText===false); }
    savePreferences();
    _currentRenderedChapter = -1;
    setTimeout(() => rebuildReaderForSettings(), 220);
  };
  document.getElementById("two-page-toggle").onclick = () => {
    state.twoPage = !state.twoPage;
    document.getElementById("reader-card").classList.toggle("two-page", state.twoPage);
    savePreferences();
    // Recompute page breaks for the new column width, then re-render.
    ensurePageStyle();
    _currentRenderedChapter = -1;
    renderPage(state.currentChapter, state.currentPage, false);
    updateReaderNav();
    // Rebuild settings panel in background after paint so the toggle label updates
    requestAnimationFrame(() => buildReaderSettings());
  };
  document.getElementById("hl-toggle").onclick = () => {
    state.highlightWords = !state.highlightWords;
    buildReaderSettings();
    applyAccessibilityClasses();
    savePreferences();
  };
  document.getElementById("ul-toggle").onclick = () => {
    state.underlineLine = !state.underlineLine;
    buildReaderSettings();
    applyAccessibilityClasses();
    savePreferences();
  };
}

// ============================================================================
// TEXT SELECTION TOOLBAR (Summarize + Add Note + Play)
// ============================================================================
let _selToolbarEl = null;
let _notePanelEl = null;
let _notesViewerEl = null;
let _summaryPopupEl = null;
let _summaryAbortCtrl = null;
let _selectionTimer = null;

if (!state.notes) state.notes = {};

function removeSelToolbar() {
  if (_selToolbarEl) { _selToolbarEl.remove(); _selToolbarEl = null; }
}
function removeNotePanel() {
  if (_notePanelEl) { _notePanelEl.remove(); _notePanelEl = null; }
}
function removeNotesViewer() {
  if (_notesViewerEl) { _notesViewerEl.remove(); _notesViewerEl = null; }
}
function removeSummaryPopup() {
  if (_summaryAbortCtrl) { _summaryAbortCtrl.abort(); _summaryAbortCtrl = null; }
  if (_summaryPopupEl) { _summaryPopupEl.remove(); _summaryPopupEl = null; }
}

function initSelectionToolbar() {
  document.addEventListener("selectionchange", () => {
    clearTimeout(_selectionTimer);
    _selectionTimer = setTimeout(() => {
      if (state.view !== "reader") return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) { return; }
      const text = sel.toString().trim();
      if (text.length < 3) { removeSelToolbar(); return; }

      const card = document.getElementById("reader-card");
      if (!card) return;
      try {
        const range = sel.getRangeAt(0);
        if (!card.contains(range.commonAncestorContainer)) { removeSelToolbar(); return; }
        showSelectionToolbar(text, range);
      } catch {}
    }, 250);
  });
}

function showSelectionToolbar(selectedText, range) {
  removeSelToolbar();
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return;

  const toolbar = document.createElement("div");
  toolbar.className = "selection-toolbar";
  _selToolbarEl = toolbar;

  toolbar.innerHTML = `
    <button class="sel-btn" id="sel-summarize">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="1" y="3" width="14" height="2" rx="1" fill="currentColor" opacity=".7"/><rect x="1" y="7" width="10" height="2" rx="1" fill="currentColor" opacity=".9"/><rect x="1" y="11" width="7" height="2" rx="1" fill="currentColor" opacity=".6"/></svg>
      Summarize
    </button>
    <button class="sel-btn" id="sel-add-note">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M2 2h12v10H8l-4 3V2z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><line x1="5" y1="6" x2="11" y2="6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="5" y1="9" x2="9" y2="9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
      Note
    </button>
    <button class="sel-btn" id="sel-play-audio">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21" opacity="0.8"/></svg>
      Play
    </button>
  `;
  document.body.appendChild(toolbar);

  const tbW = toolbar.offsetWidth || 180;
  const tbH = toolbar.offsetHeight || 36;
  let left = rect.left + rect.width / 2 - tbW / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tbW - 8));
  let top = rect.top - tbH - 10;
  if (top < 8) top = rect.bottom + 10;

  toolbar.style.left = `${left}px`;
  toolbar.style.top = `${top}px`;

  toolbar.querySelector("#sel-summarize").onclick = (e) => {
    e.stopPropagation();
    const txt = window.getSelection()?.toString().trim() || selectedText;
    removeSelToolbar();
    showSummaryPopup(txt, rect);
  };
  toolbar.querySelector("#sel-add-note").onclick = (e) => {
    e.stopPropagation();
    const txt = window.getSelection()?.toString().trim() || selectedText;
    removeSelToolbar();
    showAddNotePanel(txt, rect);
  };
  toolbar.querySelector("#sel-play-audio").onclick = (e) => {
    e.stopPropagation();
    removeSelToolbar();
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
      const utt = new SpeechSynthesisUtterance(selectedText);
      utt.rate = 0.95;
      window.speechSynthesis.speak(utt);
    } else {
      showToast(false, "Text-to-speech not supported in this browser.");
      setTimeout(hideToast, 2000);
    }
  };
}

async function showSummaryPopup(text, anchorRect) {
  removeSummaryPopup();
  _summaryAbortCtrl = new AbortController();
  const abortCtrl = _summaryAbortCtrl;
  const popup = document.createElement("div");
  popup.className = "summary-popup";
  _summaryPopupEl = popup;

  const excerpt = text.length > 120 ? text.slice(0, 120) + "…" : text;
  popup.innerHTML = `
    <div class="summary-popup-header">
      <span class="summary-popup-title">✦ AI Summary</span>
      <button class="summary-popup-close">×</button>
    </div>
    <div class="summary-popup-quote">"${excerpt}"</div>
    <div class="summary-popup-body" id="summary-body">
      <span class="summary-loading">Summarizing…</span>
    </div>
  `;
  document.body.appendChild(popup);

  const popW = popup.offsetWidth || 340;
  const popH = popup.offsetHeight || 180;
  let left = anchorRect.left + anchorRect.width / 2 - popW / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - popW - 8));
  let top = anchorRect.bottom + 10;
  if (top + popH > window.innerHeight - 8) top = anchorRect.top - popH - 10;
  if (top < 8) top = 8;
  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;

  popup.querySelector(".summary-popup-close").onclick = () => removeSummaryPopup();

  try {
    let summary = "";
    if (state.ollamaUrl) {
      const model = state.ollamaModel || "llama3";
      const r = await fetch(`${getOllamaUrl()}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt: `Summarize this passage in 4 sentences or fewer. Reply with only the summary: "${text.split(" ").slice(0,200).join(" ")}"`,
          keep_alive: "10m",
          stream: false
        }),
        signal: abortCtrl.signal
      });
      if (r.ok) {
        const d = await r.json();
        summary = d?.response?.trim() || "Could not generate summary.";
      } else {
        throw new Error("Ollama error " + r.status);
      }
    }
    const body = document.getElementById("summary-body");
    if (body) body.innerHTML = summary
      ? `<p style="margin:0;">${summary}</p>`
      : `<span style="color:var(--textDim);font-size:12px;">Configure an Ollama server in Settings → AI to enable summaries.</span>`;
  } catch(err) {
    if (err.name === "AbortError") return;
    const body = document.getElementById("summary-body");
    if (body) body.innerHTML = `<span style="color:var(--textDim);font-size:12px;">Summary unavailable. ${state.ollamaUrl ? "Check Ollama connection." : "Configure Ollama in Settings → AI."}</span>`;
  }
}

function showAddNotePanel(selectedText, anchorRect) {
  removeNotePanel();
  if (!state.activeBook) return;

  const panel = document.createElement("div");
  panel.className = "note-add-panel";
  _notePanelEl = panel;

  const excerpt = selectedText.length > 90 ? selectedText.slice(0, 90) + "…" : selectedText;
  panel.innerHTML = `
    <div class="note-panel-header">
      <span class="note-panel-title">Add Note</span>
      <button class="note-panel-close">×</button>
    </div>
    <div class="note-panel-quote">"${excerpt}"</div>
    <div class="note-panel-body">
      <textarea class="note-textarea" placeholder="Write your note…" rows="3"></textarea>
      <div class="note-panel-actions">
        <button class="note-cancel-btn">Cancel</button>
        <button class="note-save-btn">Save Note</button>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  const panW = panel.offsetWidth || 320;
  const panH = panel.offsetHeight || 180;
  let left = anchorRect.left + anchorRect.width / 2 - panW / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - panW - 8));
  let top = anchorRect.bottom + 10;
  if (top + panH > window.innerHeight - 8) top = anchorRect.top - panH - 10;
  if (top < 8) top = 8;
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;

  panel.querySelector(".note-panel-close").onclick = () => removeNotePanel();
  panel.querySelector(".note-cancel-btn").onclick = () => removeNotePanel();
  panel.querySelector(".note-save-btn").onclick = () => {
    const noteText = panel.querySelector(".note-textarea").value.trim();
    if (!noteText) { panel.querySelector(".note-textarea").focus(); return; }
    if (!state.notes) state.notes = {};
    if (!state.notes[state.activeBook.id]) state.notes[state.activeBook.id] = [];
    state.notes[state.activeBook.id].push({
      id: `note_${Date.now()}`,
      quote: selectedText.slice(0, 200),
      text: noteText,
      chapter: state.currentChapter,
      page: state.currentPage,
      createdAt: new Date().toISOString()
    });
    window.storage.set("reader_notes", JSON.stringify(state.notes));
    removeNotePanel();
    showToast(true, "Note saved");
    setTimeout(hideToast, 1200);
    const _nc = document.getElementById("reader-card");
    if (_nc) addBookmarkIcons(_nc);
  };
  setTimeout(() => panel.querySelector(".note-textarea")?.focus(), 60);
}

// ============================================================================
// WORD LOOKUP POPUP  (unchanged)
// ============================================================================
let _wordPopupEl = null;

function removeWordPopup() {
  if (_wordPopupEl) { _wordPopupEl.remove(); _wordPopupEl = null; }
}

function showWordPopup(word, anchorEl) {
  removeWordPopup();
  if (!word) return;

  const popup = document.createElement("div");
  popup.className = "word-popup";
  _wordPopupEl = popup;

  popup.innerHTML = `
    <div class="word-popup-actions">
      <button class="word-popup-btn" id="wp-define">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/><line x1="5" y1="6" x2="11" y2="6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="5" y1="9" x2="9" y2="9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        Define
      </button>
      <button class="word-popup-btn" id="wp-translate">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M2 4h6M5 2v2M3 7c0 1.5 1 2.5 2.5 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M9 6l3 8M11 10h2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Translate
      </button>
    </div>
    <div class="word-popup-result" id="wp-result">
      <div class="wp-word">${word}</div>
      <div class="wp-def" style="color:var(--textDim); font-style:italic; font-size:11px;">Click Define or Translate</div>
    </div>
  `;

  document.body.appendChild(popup);

  const rect = anchorEl.getBoundingClientRect();
  let top = rect.bottom + 6, left = rect.left;
  if (left + 310 > window.innerWidth) left = window.innerWidth - 318;
  if (top + 200 > window.innerHeight) top = rect.top - 208;
  popup.style.top = `${top}px`;
  popup.style.left = `${left}px`;

  popup.querySelector("#wp-define").onclick = async () => {
    const res = document.getElementById("wp-result");
    res.innerHTML = `<div class="wp-loading">Looking up "${word}"…</div>`;
    try {
      const r = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`);
      if (!r.ok) throw new Error("not found");
      const data = await r.json();
      const entry = data[0];
      const meaning = entry?.meanings?.[0];
      const def = meaning?.definitions?.[0]?.definition || "No definition found.";
      const pos = meaning?.partOfSpeech || "";
      const phonetic = entry?.phonetic || "";
      res.innerHTML = `
        <div class="wp-word">${entry?.word || word} <span style="font-size:11px;color:var(--textDim);font-weight:400;">${phonetic}</span></div>
        ${pos ? `<div class="wp-pos">${pos}</div>` : ""}
        <div class="wp-def">${def}</div>
      `;
    } catch {
      res.innerHTML = `<div class="wp-error">No definition found for "${word}".</div>`;
    }
  };

  popup.querySelector("#wp-translate").onclick = () => {
    const res = document.getElementById("wp-result");
    const langs = [
      ["es","Spanish"],["fr","French"],["de","German"],["it","Italian"],
      ["pt","Portuguese"],["ja","Japanese"],["zh","Chinese"],["ko","Korean"],
      ["ru","Russian"],["ar","Arabic"],["hi","Hindi"],["nl","Dutch"],
    ];
    res.innerHTML = `
      <div class="word-popup-translate-row">
        <select id="wp-lang-select">
          ${langs.map(([code, name]) => `<option value="${code}">${name}</option>`).join("")}
        </select>
        <button class="word-popup-btn" id="wp-do-translate" style="flex:none;padding:5px 10px;border-radius:5px;border:1px solid var(--border);">Go</button>
      </div>
      <div id="wp-trans-result" class="wp-def" style="color:var(--textDim); font-style:italic; margin-top:4px;">Select a language above.</div>
    `;
    res.querySelector("#wp-do-translate").onclick = async () => {
      const lang = res.querySelector("#wp-lang-select").value;
      const out = res.querySelector("#wp-trans-result");
      out.innerHTML = `<span class="wp-loading">Translating…</span>`;
      try {
        const r = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(word)}&langpair=en|${lang}`);
        const d = await r.json();
        const t = d?.responseData?.translatedText || "";
        if (t && t.toLowerCase() !== word.toLowerCase()) {
          out.style.fontStyle = "normal";
          out.innerHTML = `<strong style="color:var(--text);font-size:14px;">${t}</strong>`;
        } else {
          out.innerHTML = `<span class="wp-error">Translation unavailable.</span>`;
        }
      } catch {
        out.innerHTML = `<span class="wp-error">Translation failed.</span>`;
      }
    };
  };
}

function handleWordClick(e) {
  const target = e.target;
  if (target.tagName !== "SPAN" || !target.classList.contains("col-word")) return;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.toString().trim().length > 1) return;
  const word = target.dataset.word;
  if (word && word.length >= 2) showWordPopup(word, target);
}

function handleWordMouseover(e) {
  if (!state.underlineLine) return;
  const target = e.target;
  if (target.tagName !== "SPAN" || !target.classList.contains("col-word")) return;
  const page = target.closest(".page-content");
  if (!page) return;
  const targetTop = target.getBoundingClientRect().top;
  page.querySelectorAll(".col-word.same-line").forEach(s => s.classList.remove("same-line"));
  page.querySelectorAll(".col-word").forEach(s => {
    if (Math.abs(s.getBoundingClientRect().top - targetTop) < 4) s.classList.add("same-line");
  });
}

// Bookmark icons for notes on current chapter/page
function addBookmarkIcons(card) {
  if (!state.activeBook || !state.notes) return;
  card.querySelectorAll(".note-marked-para").forEach(p => {
    p.classList.remove("note-marked-para"); p.removeAttribute("title");
  });
  const notes = state.notes[state.activeBook.id] || [];
  const pageNotes = notes.filter(n => n.chapter === state.currentChapter);
  if (pageNotes.length === 0) return;
  const paras = card.querySelectorAll("p");
  pageNotes.forEach(note => {
    const quote = note.quote.slice(0, 40).toLowerCase();
    for (const para of paras) {
      if (para.textContent.toLowerCase().includes(quote)) {
        para.classList.add("note-marked-para");
        para.title = note.text;
        break;
      }
    }
  });
}

// ============================================================================
// DATA & FILE HANDLING
// ============================================================================
async function saveLibrary() {
  await window.storage.set("library_meta", JSON.stringify(state.library));
}

// Storage format: chapters array, chunked
async function saveBookContent(id, chapters) {
  const json = JSON.stringify(chapters);
  if (json.length < MAX_SINGLE_KB) {
    await window.storage.set(`book_${id}_data`, json);
    await window.storage.set(`book_${id}_chunks`, "0");
    return;
  }
  const chunks = [];
  for (let i = 0; i < chapters.length; i += CHUNK_SIZE) chunks.push(chapters.slice(i, i + CHUNK_SIZE));
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
    const chapters = []; for (const r of results) if (r) chapters.push(...JSON.parse(r.value));
    return chapters;
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
  if (idx > -1) {
    state.library[idx].currentChapter = 0;
    state.library[idx].currentPage = 0;
  }
  saveLibrary(); renderLibrary();
}

// ============================================================================
// PDF PARSER
// ============================================================================
async function parsePdf(file) {
  if (typeof pdfjsLib === "undefined") throw new Error("PDF.js not loaded");
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const offscreen = document.createElement("canvas");

  async function renderPage(pageNum, scale) {
    const page = await pdf.getPage(pageNum);
    const vp   = page.getViewport({ scale });
    offscreen.width  = vp.width;
    offscreen.height = vp.height;
    const ctx = offscreen.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, vp.width, vp.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return offscreen.toDataURL("image/jpeg", 0.85);
  }

  // Cover thumbnail: page 1 at scale 1.5 (good quality for the grid card)
  let coverDataUrl = null;
  try { coverDataUrl = await renderPage(1, 1.5); } catch {}

  // Render every page at scale 1.5 → each page is one "chapter" with a pdfPage block
  // 1.5× on a 612pt-wide PDF → 918px wide, JPEG85 ≈ 60-100 KB per page
  const chapters = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    try {
      const src = await renderPage(i, 1.5);
      chapters.push({
        title: `Page ${i}`,
        blocks: [{ type: "pdfPage", src, text: "" }]
      });
    } catch {}
  }

  if (!chapters.length) throw new Error("No pages could be rendered from this PDF");
  return { chapters, coverDataUrl };
}

// ============================================================================
// NOTEBOOKS
// ============================================================================
let _activeNotebook = null;
let _nbSaveTimer    = null;

async function saveNotebooksMeta() {
  await window.storage.set("notebooks_meta", JSON.stringify(
    state.notebooks.map(({ id, title, createdAt, updatedAt, wordCount, coverDataUrl, coverColor }) =>
      ({ id, title, createdAt, updatedAt, wordCount, coverDataUrl, coverColor }))
  ));
}

async function saveNotebookContent(id, content) {
  await window.storage.set(`notebook_${id}`, content);
}

async function loadNotebookContent(id) {
  const res = await window.storage.get(`notebook_${id}`);
  return res ? res.value : "";
}

function createNewNotebook() {
  state.activeLibTab = "notebooks";
  document.querySelectorAll(".lib-tab").forEach(x =>
    x.classList.toggle("active", x.dataset.libtab === "notebooks"));
  document.querySelectorAll(".lib-tab-panel").forEach(p => {
    const show = p.id === "tab-notebooks";
    p.classList.toggle("active", show); p.classList.toggle("hidden", !show);
  });
  const id = `nb_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
  const _nbColors = ["#c62828","#1565c0","#2e7d32","#4a148c","#e65100","#00695c","#37474f","#6a1520"];
  const nb = { id, title: "Untitled", content: "",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), wordCount: 0,
    coverColor: _nbColors[Math.floor(Math.random()*_nbColors.length)] };
  state.notebooks.unshift(nb);
  saveNotebooksMeta();
  saveNotebookContent(id, "");
  renderNotebooks();
  openNotebook(nb);
}

function renderNotebooks() {
  const grid  = document.getElementById("notebook-grid");
  const empty = document.getElementById("notebook-empty-state");
  if (!grid) return;
  grid.innerHTML = "";
  if (!state.notebooks.length) { empty?.classList.remove("hidden"); return; }
  empty?.classList.add("hidden");
  state.notebooks.forEach(nb => {
    const el = document.createElement("div");
    el.className = "book-card-container notebook-card";
    el.innerHTML = `
      <div class="notebook-cover" style="--nb-color:${nb.coverColor||'#c62828'}">
        ${nb.coverDataUrl
          ? `<img src="${nb.coverDataUrl}" alt="" class="nb-custom-cover">`
          : `<div class="nb-comp-cover">
              <div class="nb-comp-binding"></div>
              <div class="nb-comp-label">
                <div class="nb-comp-label-title">${nb.title}</div>
              </div>
              <div class="nb-comp-texture"></div>
            </div>`}
      </div>
      <div class="book-meta">
        <div class="meta-text">
          <div class="meta-title">${nb.title}</div>
          <div class="meta-author">${nb.wordCount || 0} words · ${new Date(nb.updatedAt).toLocaleDateString()}</div>
        </div>
        <button class="btn-dots">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="3" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="13" cy="8" r="1.5"/></svg>
        </button>
      </div>
      <div class="context-menu hidden">
        <button class="ctx-item nb-cover-btn">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="1" y="1" width="14" height="14" rx="2" stroke="currentColor" stroke-width="1.4"/><circle cx="5.5" cy="5.5" r="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M1 11l4-4 3 3 2-2 5 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Change cover
        </button>
        <button class="ctx-item nb-delete-btn danger">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M6 4V2h4v2M5 4l1 9h4l1-9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Delete notebook
        </button>
      </div>`;
    el.querySelector(".notebook-cover").onclick = () => openNotebook(nb);
    const menu = el.querySelector(".context-menu");
    el.querySelector(".btn-dots").onclick = (e) => {
      e.stopPropagation();
      document.querySelectorAll(".context-menu").forEach(m => { if (m !== menu) m.classList.add("hidden"); });
      menu.classList.toggle("hidden");
    };
    el.querySelector(".nb-cover-btn")?.addEventListener("click", (e) => {
      e.stopPropagation(); menu.classList.add("hidden");
      const inp = document.createElement("input");
      inp.type = "file"; inp.accept = "image/*";
      inp.onchange = async () => {
        const file = inp.files[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = async (ev) => {
          nb.coverDataUrl = ev.target.result;
          const idx = state.notebooks.findIndex(n => n.id === nb.id);
          if (idx !== -1) state.notebooks[idx] = nb;
          await saveNotebooksMeta();
          renderNotebooks();
        };
        reader.readAsDataURL(file);
      };
      inp.click();
    });
    el.querySelector(".nb-delete-btn").onclick = async (e) => {
      e.stopPropagation();
      state.notebooks = state.notebooks.filter(n => n.id !== nb.id);
      await saveNotebooksMeta(); await window.storage.delete(`notebook_${nb.id}`);
      renderNotebooks();
    };
    grid.appendChild(el);
  });
}

async function openNotebook(nb) {
  _activeNotebook = nb;
  switchView("notebook");

  const content  = await loadNotebookContent(nb.id);
  nb.content     = content;

  const titleInput = document.getElementById("notebook-title-input");
  const textarea   = document.getElementById("notebook-textarea");
  const preview    = document.getElementById("notebook-preview");
  const status     = document.getElementById("notebook-save-status");
  const panes      = document.getElementById("notebook-panes");

  titleInput.value = nb.title;
  textarea.value   = content;

  // Live mode: both panes visible at all times — source left, rendered right.
  // "preview mode" (focus) hides the source pane so only rendered is visible.
  panes.classList.remove("preview-mode");
  textarea.classList.remove("hidden");
  preview.classList.remove("hidden");

  function renderMarkdown(src) {
    if (typeof marked === "undefined") return `<pre>${src}</pre>`;
    // Resolve [[wikilinks]] before marked
    const resolved = src.replace(/\[\[([^\]]+)\]\]/g, (_, target) => {
      const nb2 = state.notebooks.find(n => n.title.toLowerCase() === target.toLowerCase());
      const bk  = state.library.find(b => b.title.toLowerCase() === target.toLowerCase());
      if (nb2)  return `<a href="#" class="wikilink wikilink-nb"  data-nbid="${nb2.id}">${target}</a>`;
      if (bk)   return `<a href="#" class="wikilink wikilink-book" data-bookid="${bk.id}">${target}</a>`;
      return `<span class="wikilink wikilink-unresolved">[[${target}]]</span>`;
    });
    return marked.parse(resolved);
  }

  function updatePreview() {
    preview.innerHTML = renderMarkdown(textarea.value || "*Start writing…*");
    // Wire wikilink clicks
    preview.querySelectorAll(".wikilink-nb").forEach(a => {
      a.onclick = (e) => { e.preventDefault(); const nb2 = state.notebooks.find(n => n.id===a.dataset.nbid); if (nb2) openNotebook(nb2); };
    });
    preview.querySelectorAll(".wikilink-book").forEach(a => {
      a.onclick = (e) => { e.preventDefault(); const bk = state.library.find(b => b.id===a.dataset.bookid); if (bk) openBook(bk); };
    });
  }

  // Render immediately on open
  updatePreview();

  function scheduleSave() {
    status.textContent = "Unsaved";
    clearTimeout(_nbSaveTimer);
    _nbSaveTimer = setTimeout(async () => {
      nb.updatedAt = new Date().toISOString();
      nb.wordCount = textarea.value.trim().split(/\s+/).filter(Boolean).length;
      nb.content   = textarea.value;
      const idx = state.notebooks.findIndex(n => n.id === nb.id);
      if (idx !== -1) state.notebooks[idx] = nb;
      await saveNotebookContent(nb.id, textarea.value);
      await saveNotebooksMeta();
      status.textContent = "Saved";
      renderNotebooks();
    }, 1200);
  }

  titleInput.oninput = () => { nb.title = titleInput.value || "Untitled"; scheduleSave(); };
  textarea.oninput   = () => { scheduleSave(); updatePreview(); };
  // Sync scroll between panes
  textarea.onscroll  = () => {
    const ratio = textarea.scrollTop / (textarea.scrollHeight - textarea.clientHeight || 1);
    preview.scrollTop = ratio * (preview.scrollHeight - preview.clientHeight);
  };

  // Toggle focus mode (source hidden, preview fills width)
  document.getElementById("btn-notebook-mode").onclick = () => {
    const focused = panes.classList.toggle("preview-mode");
    textarea.classList.toggle("hidden", focused);
  };

  document.getElementById("notebook-toolbar").querySelectorAll(".nb-tool-btn").forEach(btn => {
    btn.onclick = () => {
      const action = btn.dataset.action;
      const s = textarea.selectionStart, e = textarea.selectionEnd;
      const sel = textarea.value.slice(s, e);
      const wrap = (pre, suf) => {
        suf = suf ?? pre;
        const rep = `${pre}${sel||"text"}${suf}`;
        textarea.value = textarea.value.slice(0,s)+rep+textarea.value.slice(e);
        textarea.focus(); textarea.setSelectionRange(s+pre.length, s+pre.length+(sel||"text").length);
        scheduleSave();
      };
      const prepend = (pre) => {
        const ls = textarea.value.lastIndexOf("\n", s-1)+1;
        textarea.value = textarea.value.slice(0,ls)+pre+textarea.value.slice(ls);
        textarea.focus(); scheduleSave();
      };
      if      (action==="bold")   wrap("**");
      else if (action==="italic") wrap("_");
      else if (action==="code")   wrap("`");
      else if (action==="h1")     prepend("# ");
      else if (action==="h2")     prepend("## ");
      else if (action==="ul")     prepend("- ");
      else if (action==="hr")     { textarea.value=textarea.value.slice(0,e)+"\n\n---\n\n"+textarea.value.slice(e); textarea.focus(); scheduleSave(); }
      else if (action==="link")   wrap("[","](url)");
      else if (action==="wiki")   wrap("[[","]]");
    };
  });

  textarea.onkeydown = (e) => {
    if ((e.ctrlKey||e.metaKey)&&e.key==="b") { e.preventDefault(); document.querySelector('[data-action="bold"]')?.click(); }
    if ((e.ctrlKey||e.metaKey)&&e.key==="i") { e.preventDefault(); document.querySelector('[data-action="italic"]')?.click(); }
    if (e.key==="Tab") { e.preventDefault(); const p=textarea.selectionStart; textarea.value=textarea.value.slice(0,p)+"  "+textarea.value.slice(p); textarea.selectionStart=textarea.selectionEnd=p+2; }
  };

  document.getElementById("btn-notebook-delete").onclick = async () => {
    if (!confirm(`Delete "${nb.title}"?`)) return;
    state.notebooks = state.notebooks.filter(n => n.id !== nb.id);
    await saveNotebooksMeta(); await window.storage.delete(`notebook_${nb.id}`);
    renderNotebooks(); exitNotebook();
  };
}

function exitNotebook() {
  clearTimeout(_nbSaveTimer);
  _activeNotebook = null;
  switchView("library");
  state.activeLibTab = "notebooks";
  document.querySelectorAll(".lib-tab").forEach(x =>
    x.classList.toggle("active", x.dataset.libtab === "notebooks"));
  document.querySelectorAll(".lib-tab-panel").forEach(p => {
    const show = p.id === "tab-notebooks";
    p.classList.toggle("active", show); p.classList.toggle("hidden", !show);
  });
  renderNotebooks();
}

// ============================================================================
// FILE UPLOAD HANDLERS
// ============================================================================
async function handleFileUpload(e) {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  showToast(true, "Processing…");
  let successCount = 0;

  for (const file of files) {
    if (file.name.startsWith(".") || (!/\.(txt|md|epub3?|pdf)$/i.test(file.name))) continue;

    try {
      const isEpub = /\.epub3?$/i.test(file.name);
      const isPdf  = /\.pdf$/i.test(file.name);
      let bookTitle, bookAuthor="", chapters, format, coverDataUrl=null;

      if (isEpub) {
        format = "epub";
        const parsed = await parseEpub(file);
        bookTitle = parsed.title; bookAuthor = parsed.author;
        chapters = parsed.chapters;
        coverDataUrl = parsed.coverDataUrl || null;
      } else if (isPdf) {
        format = "pdf";
        const parsed = await parsePdf(file);
        bookTitle = file.name.replace(/\.pdf$/i,"").replace(/[_-]/g," ");
        chapters = parsed.chapters;
        coverDataUrl = parsed.coverDataUrl || null;
      } else {
        format = /\.md$/i.test(file.name) ? "md" : "txt";
        const text = await readFileAsText(file);
        bookTitle = file.name.replace(/\.(txt|md)$/i,"").replace(/[_-]/g," ");
        const blocks = textToBlocks(text);
        chapters = blocksToChapters(blocks);
      }

      const id = `book_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
      await saveBookContent(id, chapters);
      state.library.push({
        id, title: bookTitle, author: bookAuthor, format,
        totalChapters: chapters.length,
        currentChapter: 0, currentPage: 0,
        addedAt: new Date().toISOString(), hasAudio: false,
        coverDataUrl: coverDataUrl || null
      });
      await saveLibrary();
      successCount++;
    } catch (err) {
      console.error("File upload error:", err);
      showToast(false, `Failed: "${file.name}" — ${err.message || "unknown error"}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (successCount > 0) {
    showToast(true, `Added ${successCount} book${successCount > 1 ? "s" : ""}!`);
  }
  renderLibrary();
  hideToast();
  e.target.value = "";
}

async function handleFolderSelect(e) {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;

  const folderName = files[0]?.webkitRelativePath?.split("/")[0] || "Selected folder";
  state.connectedFolder = { name: folderName, fileCount: files.filter(f => /\.(txt|md|epub3?)$/i.test(f.name)).length };
  savePreferences();

  showToast(true, `Loading ${state.connectedFolder.fileCount} files from "${folderName}"...`);

  for (const file of files) {
    if (file.name.startsWith(".") || (!/\.(txt|md|epub3?|pdf)$/i.test(file.name))) continue;
    const derivedTitle = file.name.replace(/\.(txt|md|epub3?)$/i,"").replace(/[_-]/g," ").toLowerCase().trim();
    const alreadyAdded = state.library.some(b =>
      b.title.toLowerCase().trim() === derivedTitle ||
      b.title.toLowerCase().replace(/[\s\-_]+/g,"") === derivedTitle.replace(/[\s\-_]+/g,"")
    );
    if (alreadyAdded) continue;

    try {
      const isEpub = /\.epub3?$/i.test(file.name);
      const isPdf  = /\.pdf$/i.test(file.name);
      let bookTitle, bookAuthor="", chapters, format, coverDataUrl=null;
      if (isEpub) {
        format = "epub";
        const parsed = await parseEpub(file);
        bookTitle = parsed.title; bookAuthor = parsed.author;
        chapters = parsed.chapters;
        coverDataUrl = parsed.coverDataUrl || null;
      } else if (isPdf) {
        format = "pdf";
        const parsed = await parsePdf(file);
        bookTitle = file.name.replace(/\.pdf$/i,"").replace(/[_-]/g," ");
        chapters = parsed.chapters;
        coverDataUrl = parsed.coverDataUrl || null;
      } else {
        format = /\.md$/i.test(file.name) ? "md" : "txt";
        const text = await readFileAsText(file);
        bookTitle = file.name.replace(/\.(txt|md)$/i,"").replace(/[_-]/g," ");
        chapters = blocksToChapters(textToBlocks(text));
      }
      const parsedNorm = bookTitle.toLowerCase().trim().replace(/[\s\-_]+/g, "");
      if (state.library.some(b => b.title.toLowerCase().trim().replace(/[\s\-_]+/g, "") === parsedNorm)) continue;

      const id = `book_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
      await saveBookContent(id, chapters);
      state.library.push({ id, title: bookTitle, author: bookAuthor, format, totalChapters: chapters.length, currentChapter: 0, currentPage: 0, addedAt: new Date().toISOString(), hasAudio: false, coverDataUrl: coverDataUrl || null });
      await saveLibrary();
    } catch(err) { console.error(err); }
  }
  renderLibrary();
  hideToast();
  const body = document.getElementById("modal-body");
  if (body && !document.getElementById("settings-modal").classList.contains("hidden")) {
    switchModalTab("library");
  }
  e.target.value = "";
}

// Audio panel
let _audioPanelEl = null;

function removeAudioPanel() {
  if (_audioPanelEl) { _audioPanelEl.remove(); _audioPanelEl = null; }
}

function showAudioPanel() {
  if (_audioPanelEl && document.body.contains(_audioPanelEl)) { removeAudioPanel(); return; }
  removeAudioPanel();

  const panel = document.createElement("div");
  panel.className = "audio-panel";
  _audioPanelEl = panel;

  const hasAudio = !!state.audioSrc;
  const player = document.getElementById("audio-player");

  if (hasAudio) {
    const dur = player.duration && !isNaN(player.duration) ? player.duration : 0;
    const cur = player.currentTime || 0;
    const pct = dur > 0 ? (cur / dur) * 100 : 0;
    const fmt = (s) => {
      const m = Math.floor(s / 60), sec = Math.floor(s % 60);
      return `${m}:${sec.toString().padStart(2,"0")}`;
    };

    panel.innerHTML = `
      <div class="audio-panel-header">
        <span class="audio-panel-title">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style="opacity:0.7">
            <path d="M9 19c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2v-1c0-1.1.9-2 2-2h2c1.1 0 2 .9 2 2v1zM21 16c0 1.1-.9 2-2 2h-2c-1.1 0-2-.9-2-2v-1c0-1.1.9-2 2-2h2c1.1 0 2 .9 2 2v1z" stroke="currentColor" stroke-width="1.6"/>
            <path d="M9 20V8l12-3v11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Audiobook
        </span>
        <button class="audio-panel-close">×</button>
      </div>
      <div class="audio-panel-body">
        <div class="audio-progress-row">
          <span class="audio-time-cur">${fmt(cur)}</span>
          <div class="audio-progress-track">
            <div class="audio-progress-fill" style="width:${pct}%"></div>
            <input type="range" class="audio-seek" min="0" max="${Math.floor(dur) || 100}" value="${Math.floor(cur)}" style="position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;margin:0;">
          </div>
          <span class="audio-time-dur">${dur > 0 ? fmt(dur) : "--:--"}</span>
        </div>
        <div class="audio-controls-row">
          <button class="audio-ctrl-btn" id="apanel-skip-back" title="−30s">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" fill="currentColor" opacity=".8"/><text x="12" y="14" text-anchor="middle" font-size="6" fill="currentColor" font-weight="700">30</text></svg>
          </button>
          <button class="audio-ctrl-btn audio-play-btn" id="apanel-play" title="${state.isPlaying ? 'Pause' : 'Play'}">
            ${state.isPlaying
              ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`
              : `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>`}
          </button>
          <button class="audio-ctrl-btn" id="apanel-skip-fwd" title="+30s">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z" fill="currentColor" opacity=".8"/><text x="12" y="14" text-anchor="middle" font-size="6" fill="currentColor" font-weight="700">30</text></svg>
          </button>
        </div>
        <div style="text-align:center;margin-top:10px;">
          <button class="audio-ctrl-btn" id="apanel-replace" style="font-size:11px;width:auto;padding:4px 10px;border-radius:5px;gap:4px;">Replace audio</button>
        </div>
      </div>
    `;
  } else {
    panel.innerHTML = `
      <div class="audio-panel-header">
        <span class="audio-panel-title">Audiobook</span>
        <button class="audio-panel-close">×</button>
      </div>
      <div class="audio-panel-body">
        <div class="audio-no-file">
          <div style="font-size:13px;font-weight:600;color:var(--textMuted);margin-bottom:4px;">No audio file</div>
          <div style="font-size:11px;color:var(--textDim);margin-bottom:12px;line-height:1.55;">.mp3 · .m4b · .wav · .ogg · .flac</div>
          <button class="btn primary" id="apanel-upload" style="gap:6px;justify-content:center;">Upload audio file</button>
        </div>
      </div>
    `;
  }

  document.body.appendChild(panel);

  const audioBtn = document.getElementById("btn-upload-audio");
  if (audioBtn) {
    const rect = audioBtn.getBoundingClientRect();
    panel.style.top = `${rect.bottom + 8}px`;
    const panW = 280;
    let left = rect.left + rect.width / 2 - panW / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - panW - 8));
    panel.style.left = `${left}px`;
  }

  panel.querySelector(".audio-panel-close").onclick = () => removeAudioPanel();

  if (hasAudio) {
    panel.querySelector("#apanel-play").onclick = () => { toggleAudio(); removeAudioPanel(); showAudioPanel(); };
    panel.querySelector("#apanel-skip-back").onclick = () => { player.currentTime = Math.max(0, player.currentTime - 30); removeAudioPanel(); showAudioPanel(); };
    panel.querySelector("#apanel-skip-fwd").onclick = () => { player.currentTime = Math.min(player.duration || 0, player.currentTime + 30); removeAudioPanel(); showAudioPanel(); };
    panel.querySelector("#apanel-replace").onclick = () => { removeAudioPanel(); document.getElementById("audio-input").click(); };
    const seekEl = panel.querySelector(".audio-seek");
    if (seekEl) {
      seekEl.oninput = (e) => {
        player.currentTime = parseInt(e.target.value);
        const fill = panel.querySelector(".audio-progress-fill");
        const dur = player.duration || 1;
        if (fill) fill.style.width = ((parseInt(e.target.value) / dur) * 100) + "%";
        const cur = panel.querySelector(".audio-time-cur");
        if (cur) cur.textContent = (() => { const s = parseInt(e.target.value); return `${Math.floor(s/60)}:${(s%60).toString().padStart(2,"0")}`; })();
      };
    }
  } else {
    panel.querySelector("#apanel-upload")?.addEventListener("click", () => { removeAudioPanel(); document.getElementById("audio-input").click(); });
  }
}

async function handleAudioUpload(e) {
  const file = e.target.files[0]; if (!file || !state.activeBook) return;
  const url = await readFileAsDataURL(file);
  await window.storage.set(`audio_${state.activeBook.id}`, url);
  state.audioSrc = url;

  const idx = state.library.findIndex(b => b.id === state.activeBook.id);
  if (idx > -1) { state.library[idx].hasAudio = true; saveLibrary(); }
  state.activeBook.hasAudio = true;

  document.getElementById("audio-player").src = url;
  updateAudioBtn();
  e.target.value = "";
}

function updateAudioBtn() {
  const btn = document.getElementById("btn-toggle-audio");
  if (state.audioSrc) {
    btn.classList.remove("hidden");
    btn.classList.toggle("playing", state.isPlaying);
    btn.title = state.isPlaying ? "Pause audiobook" : "Play audiobook";
  } else {
    btn.classList.add("hidden");
  }
}

function toggleAudio() {
  const player = document.getElementById("audio-player");
  if (!player.src) return;
  if (state.isPlaying) { player.pause(); state.isPlaying = false; }
  else { player.play(); state.isPlaying = true; }
  updateAudioBtn();
}

// ============================================================================
// MODALS & TOASTS
// ============================================================================
function openModal(id) {
  document.getElementById(id).classList.remove("hidden");
  if (id === "settings-modal") switchModalTab("theme");
}

function closeModal(id) { document.getElementById(id).classList.add("hidden"); }

function showToast(isLoading, text) {
  const t = document.getElementById("upload-toast");
  t.classList.remove("hidden", "error");
  if (!isLoading) t.classList.add("error");
  document.getElementById("upload-spinner").style.display = isLoading ? "block" : "none";
  document.getElementById("upload-toast-text").textContent = text;
}
function hideToast() { setTimeout(() => document.getElementById("upload-toast").classList.add("hidden"), 800); }

function switchModalTab(tabId) {
  document.querySelectorAll(".tab").forEach(t => {
    if (t.dataset.tab === tabId) t.classList.add("active"); else t.classList.remove("active");
  });
  const body = document.getElementById("modal-body");

  if (tabId === "theme") {
    const all = { ...BUILT_IN_THEMES, ...state.customThemes };
    body.innerHTML = `
      <div class="section-label">THEME</div>
      <div class="radio-list">
        ${Object.keys(all).map(k => `
          <label class="radio-item ${state.themeKey === k ? "active" : ""}">
            <input type="radio" name="theme" value="${k}" ${state.themeKey === k ? "checked" : ""}>
            <div style="display:flex; gap:4px;">
              <div class="swatch" style="background:${all[k].bg}"></div>
              <div class="swatch" style="background:${all[k].surface}"></div>
              <div class="swatch" style="background:${all[k].accent||"#888"}"></div>
            </div>
            <span style="font-size:13px; font-weight:500; color:var(--text); flex:1;">${all[k].name}</span>
            ${k.startsWith("custom_") ? "<span style=\"font-size:10px; color:var(--textDim)\">Custom</span>" : ""}
          </label>
        `).join("")}
      </div>
      <div class="theme-import-box">
        <div style="font-size:12px; color:var(--textMuted); margin-bottom:8px;">Import custom theme <strong>.json</strong></div>
        <button id="btn-import-theme" class="btn secondary">Import theme (.json)</button>
      </div>
    `;

    body.querySelectorAll("input[name=\"theme\"]").forEach(rad => {
      rad.onchange = (e) => {
        state.themeKey = e.target.value;
        savePreferences();
        applyTheme(state.themeKey); switchModalTab("theme");
      };
    });
    body.querySelector("#btn-import-theme").onclick = () => document.getElementById("theme-input").click();

    document.getElementById("theme-input").onchange = async (e) => {
      const file = e.target.files[0]; if (!file) return;
      try {
        const p = JSON.parse(await readFileAsText(file));
        if (p.name && p.bg && p.text) {
          const k = `custom_${Date.now()}`;
          state.customThemes[k] = p; state.themeKey = k;
          savePreferences();
          applyTheme(k); switchModalTab("theme");
        }
      } catch (err) { alert("Invalid theme file"); }
      e.target.value = "";
    };

  } else if (tabId === "library") {
    const folderHtml = state.connectedFolder
      ? `<div class="folder-connected">
           <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M1 4a1 1 0 0 1 1-1h4l1 2h7a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
           <span class="folder-path">${state.connectedFolder.name} (${state.connectedFolder.fileCount} files)</span>
           <button style="background:none;border:none;color:var(--textDim);cursor:pointer;font-size:12px;padding:2px 4px;" id="btn-disconnect-folder">✕</button>
         </div>`
      : "";

    body.innerHTML = `
      <div class="section-label">DISCOVER BOOKS</div>
      <a href="https://www.gutenberg.org" target="_blank" class="gutenberg-btn">
        <span class="gutenberg-btn-icon">📚</span>
        <div class="gutenberg-btn-text">
          <div class="title">Project Gutenberg</div>
          <div class="sub">Free public domain ebooks — 70,000+ titles</div>
        </div>
        <svg class="gutenberg-btn-arrow" width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 7h8M8 4l3 3-3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </a>
      <a href="https://librivox.org" target="_blank" class="gutenberg-btn" style="margin-top:8px;">
        <span class="gutenberg-btn-icon">🎧</span>
        <div class="gutenberg-btn-text">
          <div class="title">LibriVox</div>
          <div class="sub">Free public domain audiobooks — 20,000+ titles</div>
        </div>
        <svg class="gutenberg-btn-arrow" width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 7h8M8 4l3 3-3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </a>

      <div class="section-label" style="margin-top:18px;">LIBRARY DATA</div>
      <p style="font-size:13px; color:var(--textMuted); margin-bottom:14px; line-height:1.6;">Export your library as <strong>gnos-library.json</strong> to back it up.</p>
      <div style="display:flex; gap:10px; margin-bottom:18px;">
        <button id="btn-export-lib" class="btn secondary" style="flex:1; justify-content:center;">↓ Export</button>
        <button id="btn-import-lib" class="btn primary" style="flex:1; justify-content:center;">↑ Import</button>
      </div>

      <div class="section-label">CONNECTED FOLDERS</div>
      ${folderHtml}
      <div style="display:flex; gap:10px; margin-top:8px;">
        <button id="btn-settings-add-folder" class="btn primary" style="flex:1; justify-content:center;">⊞ Connect Folder</button>
        <button id="btn-settings-add-book" class="btn secondary" style="flex:1; justify-content:center;">+ Add Books</button>
      </div>
    `;

    body.querySelector("#btn-export-lib").onclick = () => {
      const blob = new Blob([JSON.stringify({ _readme: "Gnos Library", books: state.library }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      Object.assign(document.createElement("a"), { href: url, download: "gnos-library.json" }).click();
      URL.revokeObjectURL(url);
    };
    body.querySelector("#btn-import-lib").onclick = () => document.getElementById("lib-import-input").click();
    body.querySelector("#btn-settings-add-book").onclick = () => document.getElementById("file-input").click();
    body.querySelector("#btn-settings-add-folder").onclick = () => document.getElementById("folder-input").click();
    body.querySelector("#btn-disconnect-folder")?.addEventListener("click", () => {
      state.connectedFolder = null; savePreferences(); switchModalTab("library");
    });

    document.getElementById("lib-import-input").onchange = async (e) => {
      const file = e.target.files[0]; if (!file) return;
      try {
        const d = JSON.parse(await readFileAsText(file));
        if (Array.isArray(d.books)) {
          const ids = new Set(state.library.map((b) => b.id));
          state.library.push(...d.books.filter((b) => !ids.has(b.id)));
          saveLibrary(); renderLibrary();
        }
      } catch (err) { alert("Invalid library file"); }
      e.target.value = "";
    };

  } else if (tabId === "accessibility") {
    body.innerHTML = `
      <p style="font-size:12px; color:var(--textMuted); margin-bottom:16px; line-height:1.6;">These settings apply in the reader and help improve reading comfort.</p>
      <div class="accessibility-row">
        <div>
          <div class="accessibility-label">Highlight words on hover</div>
          <div class="accessibility-sub">Highlights individual words when you hover over them.</div>
        </div>
        <div id="acc-hl-toggle" class="toggle-track ${state.highlightWords?"on":"off"}"><div class="toggle-thumb"></div></div>
      </div>
      <div class="accessibility-row">
        <div>
          <div class="accessibility-label">Underline current line</div>
          <div class="accessibility-sub">Underlines the line you're hovering over to help focus.</div>
        </div>
        <div id="acc-ul-toggle" class="toggle-track ${state.underlineLine?"on":"off"}"><div class="toggle-thumb"></div></div>
      </div>
    `;
    body.querySelector("#acc-hl-toggle").onclick = () => {
      state.highlightWords = !state.highlightWords;
      savePreferences();
      switchModalTab("accessibility");
      if (state.view === "reader") applyAccessibilityClasses();
    };
    body.querySelector("#acc-ul-toggle").onclick = () => {
      state.underlineLine = !state.underlineLine;
      savePreferences();
      switchModalTab("accessibility");
      if (state.view === "reader") applyAccessibilityClasses();
    };
  } else if (tabId === "ai") {
    const ollamaUrl = state.ollamaUrl || "";
    const ollamaModel = state.ollamaModel || "";
    body.innerHTML = `
      <div class="section-label">AI ASSISTANT</div>
      <p style="font-size:12px; color:var(--textMuted); margin-bottom:16px; line-height:1.6;">
        Connect a local Ollama instance for AI-powered text summarization.
      </p>
      <label style="display:block; margin-bottom:14px; font-size:12px;">
        <div style="margin-bottom:5px; font-weight:600; color:var(--text);">Ollama Server URL</div>
        <input id="ollama-url-input" type="text" placeholder="http://localhost:11434" value="${ollamaUrl}"
          style="width:100%; background:var(--bg); border:1px solid var(--border); color:var(--text); border-radius:6px; padding:8px 10px; font-size:12px; outline:none; font-family:inherit;">
      </label>
      <label style="display:block; margin-bottom:14px; font-size:12px;">
        <div style="margin-bottom:5px; font-weight:600; color:var(--text);">Model Name</div>
        <input id="ollama-model-input" type="text" placeholder="llama3, mistral, phi3..." value="${ollamaModel}"
          style="width:100%; background:var(--bg); border:1px solid var(--border); color:var(--text); border-radius:6px; padding:8px 10px; font-size:12px; outline:none; font-family:inherit;">
      </label>
      <div style="display:flex; gap:10px; margin-top:6px;">
        <button id="btn-save-ai" class="btn primary" style="flex:1; justify-content:center;">Save Settings</button>
        <button id="btn-test-ai" class="btn secondary" style="flex:1; justify-content:center;">Test Connection</button>
      </div>
      <div id="ai-test-result" style="margin-top:12px; font-size:12px; color:var(--textDim); min-height:20px;"></div>
      <div style="margin-top:20px; padding-top:16px; border-top:1px solid var(--borderSubtle);">
        <div class="section-label">CURRENT AI SOURCE</div>
        <div style="font-size:12px; color:var(--textMuted); padding:10px 12px; background:var(--surfaceAlt); border-radius:7px; border:1px solid var(--border);">
          ${ollamaUrl
            ? `<span style="color:#3fb950;">●</span> Ollama at <strong style="color:var(--accent);">${ollamaUrl}</strong>${ollamaModel ? ` using <strong>${ollamaModel}</strong>` : " (no model set)"}`
            : `<span style="color:#f85149;">○</span> <strong style="color:var(--textMuted);">No local LLM configured.</strong>`}
        </div>
      </div>
    `;
    body.querySelector("#btn-save-ai").onclick = () => {
      const rawUrl = body.querySelector("#ollama-url-input").value.trim().replace(/\/$/, "");
      state.ollamaUrl = rawUrl || "";
      state.ollamaModel = body.querySelector("#ollama-model-input").value.trim();
      savePreferences();
      switchModalTab("ai");
    };
    body.querySelector("#btn-test-ai").onclick = async () => {
      const resultEl = body.querySelector("#ai-test-result");
      const url = (body.querySelector("#ollama-url-input").value.trim() || "http://localhost:11434").replace(/\/$/, "");
      const model = body.querySelector("#ollama-model-input").value.trim() || "llama3";
      resultEl.textContent = "Testing connection…"; resultEl.style.color = "var(--textDim)";
      try {
        const r = await fetch(`${url}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, prompt: "Say: OK", stream: false })
        });
        if (r.ok) { resultEl.textContent = "✓ Connected successfully!"; resultEl.style.color = "#3fb950"; }
        else { resultEl.textContent = `✗ Server returned ${r.status}`; resultEl.style.color = "#f85149"; }
      } catch (err) {
        resultEl.textContent = `✗ Could not connect: ${err.message}`; resultEl.style.color = "#f85149";
      }
    };
  }
}

// ============================================================================
// PROFILE
// ============================================================================
function openProfile() {
  const modal = document.getElementById("profile-modal");
  modal.classList.remove("hidden");
  renderProfile();
}

function renderProfile() {
  const body = document.getElementById("profile-body");
  const streak = getCurrentStreak();
  const totalMinutes = Object.values(state.readingLog).reduce((a, b) => a + b, 0);
  const avgDaily = Object.keys(state.readingLog).length > 0
    ? totalMinutes / Object.keys(state.readingLog).length : 0;
  const todayMins = Math.round((state.readingLog[todayKey()] || 0) +
    // Add the in-progress session so the counter updates in real time
    (state.sessionStart ? (Date.now() - state.sessionStart) / 60000 : 0));
  const booksFinished = state.library.filter(b => (b.currentChapter || 0) >= (b.totalChapters || 1) - 1).length;

  const heatmapDays = [];
  for (let i = 83; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const mins = state.readingLog[key] || 0;
    const level = mins === 0 ? 0 : mins < 10 ? 1 : mins < 30 ? 2 : mins < 60 ? 3 : 4;
    heatmapDays.push({ key, mins, level });
  }

  const bookStats = state.library.map(b => ({
    ...b,
    chaptersRead: b.currentChapter || 0,
  })).sort((a, b) => b.chaptersRead - a.chaptersRead).slice(0, 5);

  body.innerHTML = `
    <div class="profile-stats-grid">
      <div class="profile-stat-card">
        <div class="profile-stat-value">${streak}</div>
        <div class="profile-stat-label">Day Streak</div>
      </div>
      <div class="profile-stat-card">
        <div class="profile-stat-value">${Math.round(avgDaily)}</div>
        <div class="profile-stat-label">Avg Min / Day</div>
      </div>
      <div class="profile-stat-card">
        <div class="profile-stat-value">${todayMins}</div>
        <div class="profile-stat-label">Min Today</div>
      </div>
      <div class="profile-stat-card">
        <div class="profile-stat-value">${booksFinished}</div>
        <div class="profile-stat-label">Finished</div>
      </div>
      <div class="profile-stat-card">
        <div class="profile-stat-value">${Math.round(totalMinutes)}</div>
        <div class="profile-stat-label">Total Min Read</div>
      </div>
      <div class="profile-stat-card">
        <div class="profile-stat-value">${Math.round(totalMinutes / 60 * 10) / 10}</div>
        <div class="profile-stat-label">Hours Read</div>
      </div>
    </div>

    <div class="profile-section-title">Reading Activity — Last 12 Weeks</div>
    <div class="heatmap-grid">
      ${heatmapDays.map(d => `<div class="heatmap-cell" data-level="${d.level}" title="${d.key}: ${Math.round(d.mins)} min"></div>`).join("")}
    </div>
    <div class="heatmap-legend">
      <span>Less</span>
      <div class="heatmap-legend-cell" style="background:var(--surfaceAlt);border:1px solid var(--borderSubtle)"></div>
      <div class="heatmap-legend-cell" style="background:rgba(56,139,253,0.25)"></div>
      <div class="heatmap-legend-cell" style="background:rgba(56,139,253,0.5)"></div>
      <div class="heatmap-legend-cell" style="background:rgba(56,139,253,0.75)"></div>
      <div class="heatmap-legend-cell" style="background:var(--accent)"></div>
      <span>More</span>
    </div>

    <div class="profile-section-title" style="margin-top:24px;">Most Read Books</div>
    <div class="top-books-list">
      ${bookStats.length === 0 ? `<div style="color:var(--textDim);font-size:13px;">No reading data yet.</div>` :
        bookStats.map((b, i) => {
          const [c1, c2] = generateCoverColor(b.title);
          const coverHtml = b.coverDataUrl
            ? `<img src="${b.coverDataUrl}" alt="">`
            : `<div style="width:100%;height:100%;background:linear-gradient(135deg,${c1},${c2});"></div>`;
          const progressPct = b.totalChapters > 1 ? Math.round((b.chaptersRead / (b.totalChapters - 1)) * 100) : 0;
          return `<div class="top-book-row">
            <span class="top-book-rank">${i+1}</span>
            <div class="top-book-cover">${coverHtml}</div>
            <div class="top-book-info">
              <div class="top-book-title">${b.title}</div>
              <div class="top-book-pgs">Ch ${b.chaptersRead} / ${b.totalChapters}</div>
            </div>
            <div class="top-book-bar-wrap" title="${progressPct}% complete">
              <div class="top-book-bar-track"><div class="top-book-bar-fill" style="width:${progressPct}%"></div></div>
              <div style="font-size:9px;color:var(--textDim);text-align:right;margin-top:2px;">${progressPct}%</div>
            </div>
          </div>`;
        }).join("")}
    </div>
  `;
}

function openNotesViewer() {
  if (!state.activeBook) return;
  if (_notesViewerEl && document.body.contains(_notesViewerEl)) { removeNotesViewer(); return; }
  const notes = (state.notes && state.notes[state.activeBook.id]) || [];
  const panel = document.createElement("div");
  panel.className = "notes-viewer-panel";
  _notesViewerEl = panel;

  panel.innerHTML = `
    <div class="note-panel-header">
      <span class="note-panel-title">Notes (${notes.length})</span>
      <button class="note-panel-close">×</button>
    </div>
    <div class="notes-scroll">
      ${notes.length === 0
        ? `<div style="padding:24px 16px;text-align:center;color:var(--textDim);font-size:13px;line-height:1.6;">No notes yet.<br><span style="font-size:11px;">Highlight text in the reader to add notes.</span></div>`
        : notes.slice().reverse().map(n => {
            const chapTitle = (state.chapters && state.chapters[n.chapter ?? 0]?.title) || `Chapter ${(n.chapter ?? 0) + 1}`;
            return `
          <div class="note-item">
            <div class="note-item-context">${chapTitle}</div>
            <div class="note-item-quote">"${n.quote.slice(0,80)}${n.quote.length>80?"…":""}"</div>
            <div class="note-item-text">${n.text}</div>
            <div class="note-item-meta">
              <span>${new Date(n.createdAt).toLocaleDateString()}</span>
              <div style="display:flex;gap:10px;align-items:center;">
                <button class="note-item-jump" data-chapter="${n.chapter ?? 0}" data-page="${n.page ?? 0}">Go to page</button>
                <button class="note-item-delete" data-id="${n.id}">Delete</button>
              </div>
            </div>
          </div>`;
          }).join("")}
    </div>
  `;
  document.body.appendChild(panel);
  panel.querySelector(".note-panel-close").onclick = () => removeNotesViewer();
  panel.querySelectorAll(".note-item-delete").forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.id;
      if (state.notes[state.activeBook.id]) {
        state.notes[state.activeBook.id] = state.notes[state.activeBook.id].filter(n => n.id !== id);
        window.storage.set("reader_notes", JSON.stringify(state.notes));
      }
      const card = document.getElementById("reader-card");
      if (card) addBookmarkIcons(card);
      removeNotesViewer();
      openNotesViewer();
    };
  });
  panel.querySelectorAll(".note-item-jump").forEach(btn => {
    btn.onclick = () => {
      const chapterIdx = parseInt(btn.dataset.chapter, 10) || 0;
      const pageIdx    = parseInt(btn.dataset.page, 10)    || 0;
      removeNotesViewer();
      jumpToChapter(chapterIdx, pageIdx);
    };
  });
}

// ============================================================================
// CLICK OUTSIDE CLOSERS
// ============================================================================
document.addEventListener("mousedown", (e) => {
  const panel = document.getElementById("reader-settings-panel");
  const drop = document.getElementById("chapter-dropdown");
  const searchDrop = document.getElementById("search-results-dropdown");
  const ctxMenus = document.querySelectorAll(".context-menu");

  if (_wordPopupEl && !_wordPopupEl.contains(e.target)) removeWordPopup();
  if (_audioPanelEl && !_audioPanelEl.contains(e.target) && e.target.id !== "btn-upload-audio" && !document.getElementById("btn-upload-audio")?.contains(e.target)) removeAudioPanel();
  if (_selToolbarEl && !_selToolbarEl.contains(e.target)) removeSelToolbar();
  if (_summaryPopupEl && !_summaryPopupEl.contains(e.target)) removeSummaryPopup();
  if (_notePanelEl && !_notePanelEl.contains(e.target)) removeNotePanel();
  if (_notesViewerEl && !_notesViewerEl.contains(e.target) && e.target.id !== "btn-reader-notes") removeNotesViewer();
  if (panel && !panel.classList.contains("hidden") && !panel.contains(e.target) && e.target.id !== "btn-reader-settings") panel.classList.add("hidden");
  if (drop && !drop.classList.contains("hidden") && !drop.contains(e.target) && !document.getElementById("btn-chapter-drop")?.contains(e.target)) drop.classList.add("hidden");
  if (searchDrop && !searchDrop.classList.contains("hidden") && !searchDrop.contains(e.target) && !document.getElementById("library-search")?.contains(e.target)) closeSearchDropdown();
  ctxMenus.forEach(m => { if (!m.classList.contains("hidden") && !m.contains(e.target)) m.classList.add("hidden"); });
});

window.onload = initApp;