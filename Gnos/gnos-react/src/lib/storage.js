import { readTextFile, writeTextFile, writeFile, readFile, remove, readDir, exists, mkdir, rename } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'

// ── Base directory ────────────────────────────────────────────────────────────

let _baseDir = null

export function resetBaseDir() {
  _baseDir = null
}

function getArchivePath() {
  try {
    const store = window.__appStore
    if (store) return store.getState().archivePath || ''
  // eslint-disable-next-line no-empty
  } catch { }
  return ''
}

async function getBaseDir() {
  const archivePath = getArchivePath()

  if (archivePath) {
    if (_baseDir === archivePath) return _baseDir
    _baseDir = archivePath
  } else {
    if (_baseDir) return _baseDir
    const base = await appDataDir()
    _baseDir = await join(base, 'gnos')
  }

  const dirExists = await exists(_baseDir)
  if (!dirExists) await mkdir(_baseDir, { recursive: true })
  return _baseDir
}

// ── Key → subfolder routing ───────────────────────────────────────────────────

function getSubfolder(key) {
  if (key.startsWith('book_') || key.startsWith('library'))            return 'books'
  if (key.startsWith('notebook_') || key.startsWith('notebooks_'))     return 'notebooks'
  if (key.startsWith('sketchbook_') || key.startsWith('sketchbooks_')) return 'sketches'
  if (key.startsWith('audiochap_') || key.startsWith('audiodata_') || key.startsWith('audiochaps_')) return 'audio'
  return ''
}

async function keyToPath(key) {
  const base = await getBaseDir()
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, '_')
  const subfolder = getSubfolder(key)

  if (subfolder) {
    const subPath = await join(base, subfolder)
    const subExists = await exists(subPath)
    if (!subExists) await mkdir(subPath, { recursive: true })
    return await join(subPath, `${safe}.json`)
  }

  return await join(base, `${safe}.json`)
}

// ── Core storage API ──────────────────────────────────────────────────────────

const storage = {
  async get(key) {
    try {
      const filePath = await keyToPath(key)
      const fileExists = await exists(filePath)
      if (!fileExists) return null
      const value = await readTextFile(filePath)
      return { key, value }
    } catch { return null }
  },

  async set(key, value) {
    try {
      const filePath = await keyToPath(key)
      const str = typeof value === 'string' ? value : JSON.stringify(value)
      await writeTextFile(filePath, str)
      return true
    } catch (err) {
      console.error(`storage.set(${key}) failed:`, err)
      return false
    }
  },

  async delete(key) {
    try {
      const filePath = await keyToPath(key)
      const fileExists = await exists(filePath)
      if (fileExists) await remove(filePath)
      return true
    } catch { return false }
  },

  async list(prefix = '') {
    try {
      const base = await getBaseDir()
      const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, '_')

      const allEntries = []
      const rootEntries = await readDir(base)
      allEntries.push(...rootEntries
        .filter(e => e.name?.endsWith('.json') && !e.children)
        .map(e => e.name.replace(/\.json$/, ''))
      )

      const subfolders = ['books', 'notebooks', 'sketches', 'audio']
      for (const sub of subfolders) {
        const subPath = await join(base, sub)
        const subExists = await exists(subPath)
        if (subExists) {
          const subEntries = await readDir(subPath)
          allEntries.push(...subEntries
            .filter(e => e.name?.endsWith('.json'))
            .map(e => e.name.replace(/\.json$/, ''))
          )
        }
      }

      return safePrefix
        ? allEntries.filter(k => k.startsWith(safePrefix))
        : allEntries
    } catch { return [] }
  },
}

export default storage

// ── Trash system ──────────────────────────────────────────────────────────────

async function getTrashDir() {
  const base = await getBaseDir()
  const dir = await join(base, 'trash')
  if (!(await exists(dir))) await mkdir(dir, { recursive: true })
  return dir
}

/** Scan a parent directory for a subfolder whose meta.json has the given id. */
async function _findFolderById(parentDir, id) {
  try {
    const entries = await readDir(parentDir)
    for (const entry of entries) {
      if (!entry.name || entry.name.startsWith('.')) continue
      const metaPath = await join(parentDir, entry.name, 'meta.json')
      if (await exists(metaPath)) {
        try {
          const meta = JSON.parse(await readTextFile(metaPath))
          if (meta.id === id) return await join(parentDir, entry.name)
        } catch { /* skip corrupt */ }
      }
    }
  } catch { /* parent dir may not exist */ }
  return null
}

/**
 * Move an item's on-disk content folder into the trash directory and write a manifest.
 * For audiobooks, keyed-store audio payload (which can be 100s of MB) is deleted
 * immediately — it is too large to keep in trash.
 * @param {'book'|'audio'|'notebook'|'sketchbook'} type
 * @param {string} id
 * @param {string} title
 * @param {object} [bookObj]  Full book object — needed for audio payload cleanup.
 */
export async function moveToTrash(type, id, title, bookObj = null) {
  const ts = Date.now()
  const safeName = (title || id).replace(/[^a-zA-Z0-9_\- ]/g, '_').slice(0, 80)
  try {
    const trashDir = await getTrashDir()
    const trashEntry = await join(trashDir, `${type}_${safeName}_${ts}`)
    await mkdir(trashEntry, { recursive: true })

    // Find and atomically move the content folder into the trash entry.
    // rename() is O(1) on the same filesystem and never leaves a partial state.
    let contentFolder = null
    try {
      if (type === 'book')       contentFolder = await _findFolderById(await getBooksDir(), id)
      else if (type === 'audio') contentFolder = await _findFolderById(await getAudioDir(), id)
      else if (type === 'notebook')   contentFolder = await _findFolderById(await getNotebooksDir(), id)
      else if (type === 'sketchbook') contentFolder = await _findFolderById(await getSketchesDir(), id)
    } catch { /* folder lookup failed — non-fatal */ }

    if (contentFolder && (await exists(contentFolder))) {
      try {
        await rename(contentFolder, await join(trashEntry, 'content'))
      } catch (renameErr) {
        console.warn('[Gnos] moveToTrash: rename failed, content left in place', renameErr)
        // Rename failed — remove meta.json from the original folder so
        // loadNotebooksMeta / loadLibrary won't resurrect this item on next launch.
        try {
          const staleMeta = await join(contentFolder, 'meta.json')
          if (await exists(staleMeta)) await remove(staleMeta)
        } catch { /* non-fatal */ }
      }
    }

    // Audio keyed-store payload is too large to keep; delete it immediately.
    if (type === 'audio') {
      try {
        const obj = bookObj
        if (obj?.format === 'audiofolder' && obj?.audioChapters) {
          for (let i = 0; i < obj.audioChapters.length; i++) {
            await storage.delete(`audiochap_${id}_${i}`)
          }
          await storage.delete(`audiochaps_${id}`)
        } else {
          await storage.delete(`audiodata_${id}`)
        }
      } catch { /* non-fatal */ }
    }

    // Write manifest last — a missing manifest means an interrupted delete, not a valid entry.
    await writeTextFile(await join(trashEntry, '_trash_meta.json'), JSON.stringify({
      type, id, title,
      deletedAt: new Date(ts).toISOString(),
      expiresAt: new Date(ts + 7 * 24 * 60 * 60 * 1000).toISOString(),
    }, null, 2))

    return trashEntry
  } catch (err) {
    console.warn('[Gnos] moveToTrash failed:', err)
    return null
  }
}

export async function cleanupTrash() {
  try {
    const trashDir = await getTrashDir()
    const entries = await readDir(trashDir)
    const now = Date.now()
    for (const entry of entries) {
      if (!entry.name) continue
      const entryPath = await join(trashDir, entry.name)
      const metaPath = await join(entryPath, '_trash_meta.json')
      if (await exists(metaPath)) {
        try {
          const meta = JSON.parse(await readTextFile(metaPath))
          if (meta.expiresAt && new Date(meta.expiresAt).getTime() < now) {
            // Recursively remove the entire trash entry (includes moved content folder).
            await remove(entryPath, { recursive: true })
          }
        } catch { /* skip corrupt entry */ }
      }
    }
  } catch (err) { console.debug('[Gnos] cleanupTrash error:', err) }
}

// ── JSON helpers ──────────────────────────────────────────────────────────────

export async function getJSON(key, fallback = null) {
  const result = await storage.get(key)
  if (!result) return fallback
  const raw = result.value ?? result
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch { return fallback }
}

export async function setJSON(key, value) {
  return storage.set(key, JSON.stringify(value))
}

// ── Library ───────────────────────────────────────────────────────────────────

export async function loadLibrary() {
  const library = await getJSON('library', [])
  if (!library?.length) return library ?? []
  // Attach cover images from book folders for any entry that doesn't already have one
  try {
    const booksDir = await getBooksDir()
    const entries = await readDir(booksDir)
    // Build id → folder name map from meta.json files
    const folderById = {}
    for (const entry of entries) {
      if (!entry.name || entry.name.startsWith('.')) continue
      const metaPath = await join(booksDir, entry.name, 'meta.json')
      if (await exists(metaPath)) {
        try {
          const meta = JSON.parse(await readTextFile(metaPath))
          if (meta.id) folderById[meta.id] = entry.name
        } catch { /* skip corrupt */ }
      }
    }
    // Also scan audio folder for audiobook covers
    let audioFolderById = {}
    try {
      const audioDir = await getAudioDir()
      const audioEntries = await readDir(audioDir)
      for (const entry of audioEntries) {
        if (!entry.name || entry.name.startsWith('.')) continue
        const metaPath = await join(audioDir, entry.name, 'meta.json')
        if (await exists(metaPath)) {
          try {
            const meta = JSON.parse(await readTextFile(metaPath))
            if (meta.id) audioFolderById[meta.id] = { folder: entry.name, dir: audioDir }
          } catch { /* skip */ }
        }
      }
    } catch { /* audio dir may not exist */ }

    async function loadCoverFromFolder(baseDir, folder) {
      for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
        const coverPath = await join(baseDir, folder, `cover.${ext}`)
        if (await exists(coverPath)) {
          try {
            const data = await readFile(coverPath)
            let binary = ''
            const chunkSize = 8192
            for (let i = 0; i < data.length; i += chunkSize) {
              binary += String.fromCharCode(...data.subarray(i, Math.min(i + chunkSize, data.length)))
            }
            const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
            return `data:${mime};base64,${btoa(binary)}`
          } catch { /* skip */ }
          break
        }
      }
      return null
    }

    return await Promise.all(library.map(async (book) => {
      if (book.coverDataUrl) return book
      const bookFolder = folderById[book.id]
      if (bookFolder) {
        const cover = await loadCoverFromFolder(booksDir, bookFolder)
        if (cover) return { ...book, coverDataUrl: cover }
      }
      const audioEntry = audioFolderById[book.id]
      if (audioEntry) {
        const cover = await loadCoverFromFolder(audioEntry.dir, audioEntry.folder)
        if (cover) return { ...book, coverDataUrl: cover }
      }
      return book
    }))
  } catch { return library }
}

export async function saveLibrary(library) {
  // coverDataUrl is kept in the JSON as a reliable fallback.
  // Covers are also written as cover.jpg files in each book's folder,
  // but the folder-based reload can silently fail for books not yet migrated
  // or whose cover file write failed. Keeping it in JSON prevents any stripping.
  return setJSON('library', library)
}

// ── Notebooks (named-folder format) ──────────────────────────────────────────
//
// Folder layout:
//   archive/notebooks/<Title>/
//     <Title>.md      — raw markdown content
//     meta.json       — { id, title, wordCount, createdAt, updatedAt, coverColor }
//
// Legacy flat-file format (migrated on first load):
//   archive/notebooks/notebook_<id>.json  — JSON string of markdown content

async function getNotebooksDir() {
  const base = await getBaseDir()
  const dir = await join(base, 'notebooks')
  if (!(await exists(dir))) await mkdir(dir, { recursive: true })
  return dir
}

async function getNotebookDir(notebook) {
  const notebooksDir = await getNotebooksDir()
  const folderName = sanitizeFolderName(notebook.title || notebook.id)
  if (!folderName || folderName.startsWith('.')) throw new Error(`Invalid notebook folder name: ${folderName}`)
  const dir = await join(notebooksDir, folderName)
  if (!(await exists(dir))) await mkdir(dir, { recursive: true })
  return dir
}

/** Returns the absolute folder path for a notebook (for resolving relative asset paths). */
export async function getNotebookFolderPath(notebook) {
  try {
    const notebooksDir = await getNotebooksDir()
    const entries = await readDir(notebooksDir)
    for (const entry of entries) {
      if (!entry.name || entry.name.startsWith('.')) continue
      const metaPath = await join(notebooksDir, entry.name, 'meta.json')
      if (await exists(metaPath)) {
        try {
          const meta = JSON.parse(await readTextFile(metaPath))
          if (meta.id === notebook.id) return await join(notebooksDir, entry.name)
        } catch { /* skip */ }
      }
    }
    const folderName = sanitizeFolderName(notebook.title || notebook.id)
    return await join(notebooksDir, folderName)
  } catch { return null }
}

export async function loadNotebooksMeta() {
  // First try to reconstruct from on-disk named folders
  try {
    const notebooksDir = await getNotebooksDir()
    const entries = await readDir(notebooksDir)
    const metas = []
    for (const entry of entries) {
      if (!entry.name || entry.name.startsWith('.')) continue
      const metaPath = await join(notebooksDir, entry.name, 'meta.json')
      if (await exists(metaPath)) {
        try {
          const meta = JSON.parse(await readTextFile(metaPath))
          metas.push(meta)
        } catch { /* skip corrupt meta */ }
      }
    }

    // Filter out notebooks whose IDs appear in the trash manifests.
    // This handles the case where moveToTrash's folder rename failed (e.g. cross-device)
    // but the manifest was still written, leaving a stale meta.json in notebooksDir.
    try {
      const trashDir = await getTrashDir()
      const trashEntries = await readDir(trashDir)
      const trashedIds = new Set()
      for (const te of trashEntries) {
        if (!te.name) continue
        const tmPath = await join(trashDir, te.name, '_trash_meta.json')
        if (await exists(tmPath)) {
          try {
            const tm = JSON.parse(await readTextFile(tmPath))
            if (tm.type === 'notebook' && tm.id) trashedIds.add(tm.id)
          } catch { /* skip corrupt manifest */ }
        }
      }
      if (trashedIds.size > 0) {
        // For any notebook still on disk whose id is in the trash, remove the
        // meta.json so it won't resurface on the next launch either.
        for (const m of metas) {
          if (!trashedIds.has(m.id)) continue
          try {
            const staleFolder = await _findFolderById(notebooksDir, m.id)
            if (staleFolder) {
              const staleMeta = await join(staleFolder, 'meta.json')
              if (await exists(staleMeta)) await remove(staleMeta)
            }
          } catch { /* non-fatal */ }
        }
        metas.splice(0, metas.length, ...metas.filter(m => !trashedIds.has(m.id)))
      }
    } catch { /* trash dir may not exist yet — ignore */ }

    if (metas.length > 0) {
      // Deduplicate by ID — keep the entry with the most recent updatedAt (rename can create duplicates)
      const seen = new Map()
      for (const m of metas) {
        if (!m.id) continue
        const existing = seen.get(m.id)
        if (!existing || new Date(m.updatedAt) > new Date(existing.updatedAt)) {
          seen.set(m.id, m)
        }
      }
      const uniqueMetas = [...seen.values()]

      // Use the saved JSON order as the authoritative sort so manual reordering persists.
      // Items not in the saved order (newly created) go at the end sorted by updatedAt.
      const savedOrder = await getJSON('notebooks_meta', [])
      if (savedOrder.length > 0) {
        const idxMap = new Map(savedOrder.map((n, i) => [n.id, i]))
        return uniqueMetas.sort((a, b) => {
          const ai = idxMap.has(a.id) ? idxMap.get(a.id) : Infinity
          const bi = idxMap.has(b.id) ? idxMap.get(b.id) : Infinity
          if (ai !== bi) return ai - bi
          return new Date(b.updatedAt) - new Date(a.updatedAt)
        })
      }
      return uniqueMetas.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    }
  } catch { /* fall through to flat file */ }
  return getJSON('notebooks_meta', [])
}

export async function saveNotebooksMeta(notebooks) {
  const notebooksDir = await getNotebooksDir()
  const existingEntries = await readDir(notebooksDir).catch(() => [])

  // Persist meta.json inside each notebook's folder, renaming folder if title changed
  for (const nb of notebooks) {
    try {
      const expectedName = sanitizeFolderName(nb.title || nb.id)
      // Find the existing folder for this notebook by id
      let existingFolderName = null
      for (const entry of existingEntries) {
        if (!entry.name || entry.name === '.DS_Store') continue
        const metaPath = await join(notebooksDir, entry.name, 'meta.json')
        if (await exists(metaPath)) {
          try {
            const meta = JSON.parse(await readTextFile(metaPath))
            if (meta.id === nb.id) { existingFolderName = entry.name; break }
          } catch { /* skip */ }
        }
      }
      if (existingFolderName && existingFolderName !== expectedName) {
        // Rename folder and the .md file inside it
        const oldDir = await join(notebooksDir, existingFolderName)
        const newDir = await join(notebooksDir, expectedName)
        if (!(await exists(newDir))) {
          await rename(oldDir, newDir)
          // Rename the .md file if it has the old folder name
          const oldMd = await join(newDir, `${existingFolderName}.md`)
          const newMd = await join(newDir, `${expectedName}.md`)
          if (await exists(oldMd)) await rename(oldMd, newMd)
        }
        await writeTextFile(await join(newDir, 'meta.json'), JSON.stringify(nb, null, 2))
      } else {
        const dir = await getNotebookDir(nb)
        await writeTextFile(await join(dir, 'meta.json'), JSON.stringify(nb, null, 2))
      }
    } catch (err) {
      console.warn('[Gnos] saveNotebooksMeta folder write failed for', nb.id, err)
    }
  }
  // Also keep the flat index for quick cold-start
  return setJSON('notebooks_meta', notebooks)
}

export async function loadNotebookContent(id) {
  // Try named folder first
  try {
    const notebooksDir = await getNotebooksDir()
    const entries = await readDir(notebooksDir)
    for (const entry of entries) {
      if (!entry.name) continue
      const metaPath = await join(notebooksDir, entry.name, 'meta.json')
      if (await exists(metaPath)) {
        const meta = JSON.parse(await readTextFile(metaPath))
        if (meta.id === id) {
          const mdPath = await join(notebooksDir, entry.name, `${entry.name}.md`)
          if (await exists(mdPath)) {
            return await readTextFile(mdPath)
          }
          // Fallback: any .md file in the folder
          const folderEntries = await readDir(await join(notebooksDir, entry.name))
          const mdFile = folderEntries.find(e => e.name?.endsWith('.md'))
          if (mdFile) {
            return await readTextFile(await join(notebooksDir, entry.name, mdFile.name))
          }
          return ''
        }
      }
    }
  } catch (err) { console.debug('[Gnos] loadNotebookContent named folder failed', err) }
  // Legacy: JSON-wrapped string
  const raw = await getJSON(`notebook_${id}`, '')
  return typeof raw === 'string' ? raw : (raw?.content ?? '')
}

export async function saveNotebookContent(notebookOrId, content) {
  const id = typeof notebookOrId === 'string' ? notebookOrId : notebookOrId?.id
  const notebook = typeof notebookOrId === 'object' ? notebookOrId : null
  const mdContent = typeof content === 'string' ? content : (content?.content ?? '')
  try {
    const notebooksDir = await getNotebooksDir()
    const entries = await readDir(notebooksDir)
    // Try to find existing folder by id
    for (const entry of entries) {
      if (!entry.name) continue
      const metaPath = await join(notebooksDir, entry.name, 'meta.json')
      if (await exists(metaPath)) {
        const meta = JSON.parse(await readTextFile(metaPath))
        if (meta.id === id) {
          const mdPath = await join(notebooksDir, entry.name, `${entry.name}.md`)
          await writeTextFile(mdPath, mdContent)
          return true
        }
      }
    }
    // No folder yet — create one using notebook object or id as name
    const folderName = sanitizeFolderName(notebook?.title || id)
    const dir = await join(notebooksDir, folderName)
    if (!(await exists(dir))) await mkdir(dir, { recursive: true })
    const metaToWrite = notebook ?? { id, title: folderName }
    await writeTextFile(await join(dir, 'meta.json'), JSON.stringify(metaToWrite, null, 2))
    const mdPath = await join(dir, `${folderName}.md`)
    await writeTextFile(mdPath, mdContent)
    return true
  } catch (err) { console.debug('[Gnos] saveNotebookContent named folder failed', err) }
  return setJSON(`notebook_${id}`, content)
}

/** Save an image (Uint8Array) into the notebook's images/ subfolder.
 *  Returns the relative markdown path: `./images/filename` */
export async function saveNotebookImage(notebookId, filename, data) {
  try {
    const notebooksDir = await getNotebooksDir()
    const entries = await readDir(notebooksDir)
    for (const entry of entries) {
      if (!entry.name || entry.name.startsWith('.')) continue
      const metaPath = await join(notebooksDir, entry.name, 'meta.json')
      if (await exists(metaPath)) {
        const meta = JSON.parse(await readTextFile(metaPath))
        if (meta.id === notebookId) {
          const imagesDir = await join(notebooksDir, entry.name, 'images')
          if (!(await exists(imagesDir))) await mkdir(imagesDir, { recursive: true })
          const imgPath = await join(imagesDir, filename)
          await writeFile(imgPath, data)
          return `./images/${filename}`
        }
      }
    }
  } catch (err) { console.warn('[Gnos] saveNotebookImage failed:', err) }
  return null
}

export async function deleteNotebookContent(id) {
  try {
    const notebooksDir = await getNotebooksDir()
    const entries = await readDir(notebooksDir)
    for (const entry of entries) {
      if (!entry.name) continue
      const metaPath = await join(notebooksDir, entry.name, 'meta.json')
      if (await exists(metaPath)) {
        const meta = JSON.parse(await readTextFile(metaPath))
        if (meta.id === id) {
          const entryPath = await join(notebooksDir, entry.name)
          const folderEntries = await readDir(entryPath)
          for (const f of folderEntries) {
            if (f.name) await remove(await join(entryPath, f.name))
          }
          try { await remove(entryPath) } catch { /* not empty */ }
          break
        }
      }
    }
  } catch (err) { console.debug('[Gnos] deleteNotebookContent error', err) }
  return storage.delete(`notebook_${id}`)
}

// Migration: create named folders for notebooks that only exist as flat JSON files
export async function migrateNotebooksToFolders(notebooks) {
  if (!notebooks?.length) return
  for (const nb of notebooks) {
    try {
      const dir = await getNotebookDir(nb)
      const folderName = sanitizeFolderName(nb.title || nb.id)
      const mdPath = await join(dir, `${folderName}.md`)
      // Write meta.json
      await writeTextFile(await join(dir, 'meta.json'), JSON.stringify(nb, null, 2))
      // Only write .md if it doesn't already exist
      if (!(await exists(mdPath))) {
        const raw = await getJSON(`notebook_${nb.id}`, '')
        const mdContent = typeof raw === 'string' ? raw : (raw?.content ?? '')
        await writeTextFile(mdPath, mdContent)
      }
    } catch (err) {
      console.warn('[Gnos] migrateNotebooksToFolders failed for', nb.id, err)
    }
  }
}

// ── Books (named-folder format) ───────────────────────────────────────────────
//
// New format:
//   archive/books/Alexandre Dumas - The Count of Monte Cristo/
//     meta.json       — book metadata (title, author, format, progress, …)
//     content.json    — array of chapters
//
// Legacy flat-file format (read for migration, then cleaned up):
//   archive/books/book_<id>_data.json
//   archive/books/book_<id>_chunk_<n>.json
//   archive/books/book_<id>_chunks.json

function sanitizeFolderName(name) {
  return name
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

function bookFolderName(book) {
  const author = book.author?.trim() || ''
  const title  = book.title?.trim()  || book.id
  const name   = author ? `${author} - ${title}` : title
  return sanitizeFolderName(name)
}

async function getBooksDir() {
  const base = await getBaseDir()
  const booksDir = await join(base, 'books')
  if (!(await exists(booksDir))) await mkdir(booksDir, { recursive: true })
  return booksDir
}

async function getBookDir(book) {
  const booksDir = await getBooksDir()
  const folderName = bookFolderName(book)
  const bookDir = await join(booksDir, folderName)
  if (!(await exists(bookDir))) await mkdir(bookDir, { recursive: true })
  return bookDir
}

// Save book content into named folder.
// `book` must be the full book object so we can name the folder.
export async function saveBookContent(book, chapters) {
  // Legacy signature: saveBookContent(id, chapters)
  if (typeof book === 'string') {
    return _saveLegacyBookContent(book, chapters)
  }

  const bookDir = await getBookDir(book)

  // Write content
  await writeTextFile(await join(bookDir, 'content.json'), JSON.stringify(chapters))

  // Write meta (strip large binary fields)
  // eslint-disable-next-line no-unused-vars
  const { coverDataUrl, pdfDataUrl, rawDataUrl, ...meta } = book
  await writeTextFile(await join(bookDir, 'meta.json'), JSON.stringify(meta, null, 2))

  // Write cover image as a binary file so it persists independently of library.json
  if (coverDataUrl) {
    try {
      const match = coverDataUrl.match(/^data:([^;]+);base64,(.+)$/)
      if (match) {
        const ext = match[1].includes('png') ? 'png' : match[1].includes('webp') ? 'webp' : 'jpg'
        const binaryStr = atob(match[2])
        const bytes = new Uint8Array(binaryStr.length)
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i)
        await writeFile(await join(bookDir, `cover.${ext}`), bytes)
      }
    } catch { /* non-fatal */ }
  }
}

const CHUNK_SIZE = 20
const MAX_SINGLE_CHARS = 900_000

async function _saveLegacyBookContent(id, chapters) {
  const json = JSON.stringify(chapters)
  if (json.length < MAX_SINGLE_CHARS) {
    await storage.set(`book_${id}_data`, json)
    await storage.set(`book_${id}_chunks`, '0')
    return
  }
  const chunks = []
  for (let i = 0; i < chapters.length; i += CHUNK_SIZE) chunks.push(chapters.slice(i, i + CHUNK_SIZE))
  await Promise.all(chunks.map((c, ci) => storage.set(`book_${id}_chunk_${ci}`, JSON.stringify(c))))
  await storage.set(`book_${id}_chunks`, String(chunks.length))
}

// Load book content. Tries named folder first, then legacy flat files.
export async function loadBookContent(bookOrId) {
  const id = typeof bookOrId === 'string' ? bookOrId : bookOrId?.id

  // 1. Named folder — look up by id in meta.json
  try {
    const booksDir = await getBooksDir()
    const entries = await readDir(booksDir)
    for (const entry of entries) {
      if (!entry.name) continue
      try {
        const entryPath = await join(booksDir, entry.name)
        const metaPath = await join(entryPath, 'meta.json')
        if (await exists(metaPath)) {
          const meta = JSON.parse(await readTextFile(metaPath))
          if (meta.id === id) {
            const contentPath = await join(entryPath, 'content.json')
            if (await exists(contentPath)) {
              return JSON.parse(await readTextFile(contentPath))
            }
            // meta matched but no content.json — fall through to legacy
            break
          }
        }
      } catch (entryErr) { console.debug('[Gnos] skipping folder entry', entry.name, entryErr) }
    }
  } catch (err) { console.warn('[Gnos] named folder scan failed, trying legacy', err) }

  // 2. Legacy flat-file format
  const meta = await storage.get(`book_${id}_chunks`)
  const n = parseInt(meta?.value ?? '-1')
  if (n === 0) {
    const raw = await storage.get(`book_${id}_data`)
    return raw ? JSON.parse(raw.value) : null
  }
  if (n > 0) {
    const results = await Promise.all(
      Array.from({ length: n }, (_, ci) => storage.get(`book_${id}_chunk_${ci}`))
    )
    const chapters = []
    for (const r of results) if (r) chapters.push(...JSON.parse(r.value))
    return chapters
  }
  // Oldest legacy: single key
  const legacy = await storage.get(`book_${id}`)
  if (legacy) {
    const raw = legacy.value ?? legacy
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return null }
  }
  return null
}

// Delete book content — removes named folder and any legacy flat files.
export async function deleteBookContent(book) {
  const id = typeof book === 'string' ? book : book?.id

  // Remove named folder
  try {
    const booksDir = await getBooksDir()
    const entries = await readDir(booksDir)
    for (const entry of entries) {
      if (!entry.name) continue
      const entryPath = await join(booksDir, entry.name)
      const metaPath = await join(entryPath, 'meta.json')
      if (await exists(metaPath)) {
        const meta = JSON.parse(await readTextFile(metaPath))
        if (meta.id === id) {
          const contentPath = await join(entryPath, 'content.json')
          if (await exists(contentPath)) await remove(contentPath)
          await remove(metaPath)
          try { await remove(entryPath) } catch (err) { console.debug('[Gnos] folder not empty yet', err) }
          break
        }
      }
    }
  } catch (err) { console.debug('[Gnos] deleteBookContent named folder error', err) }

  // Remove legacy flat files
  await storage.delete(`book_${id}_data`)
  await storage.delete(`book_${id}_chunks`)
  for (let ci = 0; ci < 200; ci++) {
    const key = `book_${id}_chunk_${ci}`
    const filePath = await keyToPath(key)
    if (!(await exists(filePath))) break
    await remove(filePath)
  }
}

// ── Migration: flat files → named folders ─────────────────────────────────────
//
// Call this once on app startup (after library loads).
// Reads legacy flat JSON files and rewrites them into Author - Title/ folders.

export async function migrateBooksToNamedFolders(library) {
  if (!library || library.length === 0) return

  for (const book of library) {
    // Skip audiobooks — they don't use book content storage
    if (book.format === 'mp3' || book.format === 'm4b' || book.format === 'audiofolder') continue

    // Check if already migrated
    let alreadyMigrated = false
    try {
      const booksDir = await getBooksDir()
      const entries = await readDir(booksDir)
      for (const entry of entries) {
        if (!entry.name) continue
        const metaPath = await join(booksDir, entry.name, 'meta.json')
        if (await exists(metaPath)) {
          const meta = JSON.parse(await readTextFile(metaPath))
          if (meta.id === book.id) { alreadyMigrated = true; break }
        }
      }
    } catch (err) { console.debug('[Gnos] migration check error', err) }

    if (alreadyMigrated) continue

    // Load chapters from legacy flat files
    const chapters = await loadBookContent(book.id)
    if (!chapters) continue

    // Write into named folder
    try {
      await saveBookContent(book, chapters)

      // Clean up legacy files
      await storage.delete(`book_${book.id}_data`)
      await storage.delete(`book_${book.id}_chunks`)
      for (let ci = 0; ci < 200; ci++) {
        const key = `book_${book.id}_chunk_${ci}`
        const filePath = await keyToPath(key)
        if (!(await exists(filePath))) break
        await remove(filePath)
      }

      console.log(`[Gnos] Migrated: ${bookFolderName(book)}`)
    } catch (err) {
      console.warn(`[Gnos] Migration failed for ${book.id}:`, err)
    }
  }
}

// ── Archive pointer ────────────────────────────────────────────────────────────
// We write the archive path to appDataDir/gnos/archive_path.json on every
// preference save. On cold start, init() reads this file first so it knows
// where to find the full preferences before archivePath is in the store.

async function getDefaultDir() {
  const base = await appDataDir()
  const dir  = await join(base, 'gnos')
  if (!(await exists(dir))) await mkdir(dir, { recursive: true })
  return dir
}

export async function saveArchivePointer(archivePath) {
  try {
    const dir  = await getDefaultDir()
    const file = await join(dir, 'archive_path.json')
    await writeTextFile(file, JSON.stringify({ archivePath }))
  } catch (err) {
    console.warn('[Gnos] saveArchivePointer failed:', err)
  }
}

export async function loadArchivePointer() {
  try {
    const base = await appDataDir()
    const file = await join(base, 'gnos', 'archive_path.json')
    if (!(await exists(file))) return ''
    const raw = JSON.parse(await readTextFile(file))
    return raw.archivePath || ''
  } catch {
    return ''
  }
}

// ── Preferences ───────────────────────────────────────────────────────────────

export async function loadPreferences() {
  return getJSON('app_prefs', null)
}

export async function savePreferences(prefs) {
  return setJSON('app_prefs', prefs)
}

// ── Reading log ───────────────────────────────────────────────────────────────
// Stores a map of { "YYYY-MM-DD": minutesRead } for streak/stats calculation.

export async function loadReadingLog() {
  return getJSON('reading_log', {})
}

export async function addReadingMinutes(minutes) {
  if (!minutes || minutes <= 0) return
  const today = new Date().toISOString().slice(0, 10)
  const log = await loadReadingLog()
  log[today] = (log[today] || 0) + minutes
  return setJSON('reading_log', log)
}

// ── Audio (named-folder format) ───────────────────────────────────────────────
//
// Folder layout:
//   archive/audio/<Artist - Title>/
//     meta.json            — book metadata (title, author, format, chapters list, …)
//     audio.<ext>          — raw audio bytes for single-file audiobooks
//     chapter_<n>.<ext>    — raw audio bytes for multi-chapter audiobooks
//
// Audio binary data is stored as raw files using Tauri's writeFile/readFile APIs.
// Legacy base64 data-URL strings under audiodata_<id> / audiochap_<id>_<n> are
// still read as a backwards-compatibility fallback.

async function getAudioDir() {
  const base = await getBaseDir()
  const dir = await join(base, 'audio')
  if (!(await exists(dir))) await mkdir(dir, { recursive: true })
  return dir
}

async function getAudioBookDir(book) {
  const audioDir = await getAudioDir()
  const folderName = sanitizeFolderName(bookFolderName(book))
  const dir = await join(audioDir, folderName)
  if (!(await exists(dir))) await mkdir(dir, { recursive: true })
  return dir
}

// Write a meta.json for an audiobook so the audio folder is human-readable.
export async function saveAudiobookMeta(book) {
  try {
    const dir = await getAudioBookDir(book)
    // Strip binary payload — only persist descriptive metadata
    // eslint-disable-next-line no-unused-vars
    const { coverDataUrl, audioDataUrl, ...meta } = book
    await writeTextFile(await join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
    // Save cover image as a binary file alongside meta.json
    if (coverDataUrl) {
      const match = coverDataUrl.match(/^data:([^;]+);base64,(.+)$/)
      if (match) {
        const ext = match[1].includes('png') ? 'png' : match[1].includes('webp') ? 'webp' : 'jpg'
        const binaryStr = atob(match[2])
        const bytes = new Uint8Array(binaryStr.length)
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i)
        await writeFile(await join(dir, `cover.${ext}`), bytes)
      }
    }
  } catch (err) {
    console.warn('[Gnos] saveAudiobookMeta failed for', book?.id, err)
  }
}

export async function deleteAudiobookMeta(book) {
  try {
    const audioDir = await getAudioDir()
    const entries = await readDir(audioDir)
    for (const entry of entries) {
      if (!entry.name) continue
      const metaPath = await join(audioDir, entry.name, 'meta.json')
      if (await exists(metaPath)) {
        const meta = JSON.parse(await readTextFile(metaPath))
        if (meta.id === book.id) {
          const entryPath = await join(audioDir, entry.name)
          const folderEntries = await readDir(entryPath)
          for (const f of folderEntries) {
            if (f.name) await remove(await join(entryPath, f.name))
          }
          try { await remove(entryPath) } catch { /* not empty */ }
          break
        }
      }
    }
  } catch (err) { console.debug('[Gnos] deleteAudiobookMeta error', err) }
}

function _extToMime(ext) {
  const map = { mp3: 'audio/mpeg', m4b: 'audio/mp4', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac', opus: 'audio/ogg; codecs=opus' }
  return map[ext?.toLowerCase()] || 'audio/mpeg'
}

export async function writeAudioFile(book, fileName, uint8Array) {
  const dir = await getAudioBookDir(book)
  await writeFile(await join(dir, fileName), uint8Array)
}

export async function readAudioFile(book, fileName) {
  try {
    const dir = await getAudioBookDir(book)
    const filePath = await join(dir, fileName)
    if (!(await exists(filePath))) return null
    return await readFile(filePath)
  } catch { return null }
}

export async function loadAudioChapter(bookOrId, chapterIdx) {
  // New binary path: pass the full book object with audioChapters[n].ext set
  if (bookOrId && typeof bookOrId === 'object') {
    const book = bookOrId
    const ext = book.audioChapters?.[chapterIdx]?.ext
    if (ext) {
      const bytes = await readAudioFile(book, `chapter_${chapterIdx}.${ext}`)
      if (bytes) return new Blob([bytes], { type: _extToMime(ext) })
    }
    // Fall back to legacy keyed-store format
    return storage.get(`audiochap_${book.id}_${chapterIdx}`)
  }
  // Legacy: bookOrId is a string ID
  return storage.get(`audiochap_${bookOrId}_${chapterIdx}`)
}

export async function saveAudioChapter(bookId, chapterIdx, dataUrl) {
  return storage.set(`audiochap_${bookId}_${chapterIdx}`, dataUrl)
}

export async function deleteAudiobook(book) {
  // Remove the named meta folder
  await deleteAudiobookMeta(book)
  // Remove audio payload keys
  if (book.format === 'audiofolder' && book.audioChapters) {
    for (let i = 0; i < book.audioChapters.length; i++) {
      await storage.delete(`audiochap_${book.id}_${i}`)
    }
    await storage.delete(`audiochaps_${book.id}`)
  } else {
    await storage.delete(`audiodata_${book.id}`)
  }
}

export async function loadSingleAudioData(bookOrId) {
  if (bookOrId && typeof bookOrId === 'object') {
    const book = bookOrId
    const ext = book.audioExt
    if (ext) {
      const bytes = await readAudioFile(book, `audio.${ext}`)
      if (bytes) return new Blob([bytes], { type: _extToMime(ext) })
    }
    return storage.get(`audiodata_${book.id}`)
  }
  return storage.get(`audiodata_${bookOrId}`)
}

// Migration: write meta.json folders for any audiobooks that don't have one yet.
export async function migrateAudiobooksToFolders(library) {
  if (!library?.length) return
  const audiobooks = library.filter(b => b.type === 'audio')
  for (const book of audiobooks) {
    try {
      const audioDir = await getAudioDir()
      // Check if already migrated
      const entries = await readDir(audioDir)
      let found = false
      for (const entry of entries) {
        if (!entry.name || entry.name.startsWith('.')) continue
        const metaPath = await join(audioDir, entry.name, 'meta.json')
        if (await exists(metaPath)) {
          const meta = JSON.parse(await readTextFile(metaPath))
          if (meta.id === book.id) { found = true; break }
        }
      }
      if (!found) await saveAudiobookMeta(book)
    } catch (err) {
      console.warn('[Gnos] migrateAudiobooksToFolders failed for', book.id, err)
    }
  }
}

// ── Sketchbooks (named-folder format) ────────────────────────────────────────
//
// Folder layout:
//   archive/sketches/<Title>/
//     sketch.json    — Excalidraw scene data
//     meta.json      — { id, title, elementCount, createdAt, updatedAt, coverColor }
//
// Legacy flat-file: archive/sketches/sketchbook_<id>.json

async function getSketchesDir() {
  const base = await getBaseDir()
  const dir = await join(base, 'sketches')
  if (!(await exists(dir))) await mkdir(dir, { recursive: true })
  return dir
}

async function getSketchDir(sketchbook) {
  const sketchesDir = await getSketchesDir()
  // Include a short ID suffix to guarantee uniqueness when multiple sketchbooks share the same title
  const safeName = sanitizeFolderName(sketchbook.title || 'sketch')
  const shortId = (sketchbook.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(-12)
  const folderName = shortId ? `${safeName}_${shortId}` : safeName
  // Scan all existing sketch folders for one whose meta.id matches — handles renames
  try {
    const entries = await readDir(sketchesDir)
    for (const entry of entries) {
      if (!entry.name) continue
      try {
        const metaPath = await join(sketchesDir, entry.name, 'meta.json')
        if (await exists(metaPath)) {
          const meta = JSON.parse(await readTextFile(metaPath))
          if (meta.id === sketchbook.id) return await join(sketchesDir, entry.name)
        }
      } catch { /* skip unreadable */ }
    }
  } catch { /* fall through to new folder */ }
  const dir = await join(sketchesDir, folderName)
  if (!(await exists(dir))) await mkdir(dir, { recursive: true })
  return dir
}

export async function loadSketchbooksMeta() {
  try {
    const sketchesDir = await getSketchesDir()
    const entries = await readDir(sketchesDir)
    const metas = []
    for (const entry of entries) {
      if (!entry.name) continue
      const metaPath = await join(sketchesDir, entry.name, 'meta.json')
      if (await exists(metaPath)) {
        try {
          const meta = JSON.parse(await readTextFile(metaPath))
          metas.push(meta)
        } catch { /* skip corrupt */ }
      }
    }
    if (metas.length > 0) {
      // Deduplicate by ID — keep the entry with the most recent updatedAt (rename can create duplicates)
      const seen = new Map()
      for (const m of metas) {
        if (!m.id) continue
        const existing = seen.get(m.id)
        if (!existing || new Date(m.updatedAt) > new Date(existing.updatedAt)) {
          seen.set(m.id, m)
        }
      }
      const uniqueMetas = [...seen.values()]

      // Use the saved JSON order as the authoritative sort so manual reordering persists.
      // Items not in the saved order (newly created) go at the end sorted by updatedAt.
      const savedOrder = await getJSON('sketchbooks_meta', [])
      if (savedOrder.length > 0) {
        const idxMap = new Map(savedOrder.map((s, i) => [s.id, i]))
        return uniqueMetas.sort((a, b) => {
          const ai = idxMap.has(a.id) ? idxMap.get(a.id) : Infinity
          const bi = idxMap.has(b.id) ? idxMap.get(b.id) : Infinity
          if (ai !== bi) return ai - bi
          return new Date(b.updatedAt) - new Date(a.updatedAt)
        })
      }
      return uniqueMetas.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    }
  } catch { /* fall through */ }
  return getJSON('sketchbooks_meta', [])
}

export async function saveSketchbooksMeta(sketchbooks) {
  for (const sb of sketchbooks) {
    try {
      const dir = await getSketchDir(sb)
      await writeTextFile(await join(dir, 'meta.json'), JSON.stringify(sb, null, 2))
    } catch (err) {
      console.warn('[Gnos] saveSketchbooksMeta folder write failed for', sb.id, err)
    }
  }
  return setJSON('sketchbooks_meta', sketchbooks)
}

export async function loadSketchbookContent(id) {
  try {
    const sketchesDir = await getSketchesDir()
    const entries = await readDir(sketchesDir)
    for (const entry of entries) {
      if (!entry.name) continue
      try {
        const metaPath = await join(sketchesDir, entry.name, 'meta.json')
        if (await exists(metaPath)) {
          const meta = JSON.parse(await readTextFile(metaPath))
          if (meta.id === id) {
            const sketchPath = await join(sketchesDir, entry.name, 'sketch.json')
            if (await exists(sketchPath)) {
              return JSON.parse(await readTextFile(sketchPath))
            }
            // sketch.json missing — fall through to JSON fallback below
            break
          }
        }
      } catch { /* skip malformed entry */ }
    }
  } catch (err) { console.debug('[Gnos] loadSketchbookContent named folder failed', err) }
  return getJSON(`sketchbook_${id}`, null)
}

// sketchbookOrId can be a full sketchbook object (preferred) or just an id string (legacy)
export async function saveSketchbookContent(sketchbookOrId, data) {
  const id = typeof sketchbookOrId === 'string' ? sketchbookOrId : sketchbookOrId?.id
  // If we have the full object, use getSketchDir directly — no directory scan needed
  if (sketchbookOrId && typeof sketchbookOrId === 'object') {
    try {
      const dir = await getSketchDir(sketchbookOrId)
      await writeTextFile(await join(dir, 'meta.json'), JSON.stringify(sketchbookOrId, null, 2))
      await writeTextFile(await join(dir, 'sketch.json'), JSON.stringify(data))
      return true
    } catch (err) { console.error('[Gnos] saveSketchbookContent failed', err) }
    return setJSON(`sketchbook_${id}`, data)
  }
  // Legacy path: only id was passed — scan folders for matching meta.id
  try {
    const sketchesDir = await getSketchesDir()
    const entries = await readDir(sketchesDir)
    for (const entry of entries) {
      if (!entry.name) continue
      try {
        const metaPath = await join(sketchesDir, entry.name, 'meta.json')
        if (await exists(metaPath)) {
          const meta = JSON.parse(await readTextFile(metaPath))
          if (meta.id === id) {
            const sketchPath = await join(sketchesDir, entry.name, 'sketch.json')
            await writeTextFile(sketchPath, JSON.stringify(data))
            return true
          }
        }
      } catch { /* skip malformed entry */ }
    }
    // No folder found — create one using sketchbook metadata from store
    try {
      const store = window.__appStore
      const sb = store?.getState?.()?.sketchbooks?.find(s => s.id === id)
      if (sb) {
        const dir = await getSketchDir(sb)
        await writeTextFile(await join(dir, 'meta.json'), JSON.stringify(sb, null, 2))
        await writeTextFile(await join(dir, 'sketch.json'), JSON.stringify(data))
        return true
      }
    } catch { /* fall through */ }
  } catch (err) { console.error('[Gnos] saveSketchbookContent failed', err) }
  return setJSON(`sketchbook_${id}`, data)
}

export async function deleteSketchbookContent(id) {
  try {
    const sketchesDir = await getSketchesDir()
    const entries = await readDir(sketchesDir)
    for (const entry of entries) {
      if (!entry.name) continue
      const metaPath = await join(sketchesDir, entry.name, 'meta.json')
      if (await exists(metaPath)) {
        const meta = JSON.parse(await readTextFile(metaPath))
        if (meta.id === id) {
          const entryPath = await join(sketchesDir, entry.name)
          const folderEntries = await readDir(entryPath)
          for (const f of folderEntries) {
            if (f.name) await remove(await join(entryPath, f.name))
          }
          try { await remove(entryPath) } catch { /* not empty */ }
          break
        }
      }
    }
  } catch (err) { console.debug('[Gnos] deleteSketchbookContent error', err) }
  return storage.delete(`sketchbook_${id}`)
}

// ── Calendar events ───────────────────────────────────────────────────────────

export async function loadCalendarEvents() {
  return getJSON('calendar_events', [])
}

export async function saveCalendarEvents(events) {
  return setJSON('calendar_events', events)
}

// ── Kanban boards ─────────────────────────────────────────────────────────────

export async function loadKanbanBoards() {
  return getJSON('kanban_boards', null)
}

export async function saveKanbanBoards(boards) {
  return setJSON('kanban_boards', boards)
}

// Migration: create named folders for sketchbooks that only exist as flat JSON files
export async function migrateSketchbooksToFolders(sketchbooks) {
  if (!sketchbooks?.length) return
  for (const sb of sketchbooks) {
    try {
      const dir = await getSketchDir(sb)
      await writeTextFile(await join(dir, 'meta.json'), JSON.stringify(sb, null, 2))
      const sketchPath = await join(dir, 'sketch.json')
      if (!(await exists(sketchPath))) {
        const raw = await getJSON(`sketchbook_${sb.id}`, null)
        if (raw) await writeTextFile(sketchPath, JSON.stringify(raw, null, 2))
      }
    } catch (err) {
      console.warn('[Gnos] migrateSketchbooksToFolders failed for', sb.id, err)
    }
  }
}