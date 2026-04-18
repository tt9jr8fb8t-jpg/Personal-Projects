import { create } from 'zustand'
import { loadLibrary, saveLibrary, loadNotebooksMeta, saveNotebooksMeta, loadPreferences, savePreferences, loadSketchbooksMeta, saveSketchbooksMeta, migrateBooksToNamedFolders, migrateNotebooksToFolders, migrateSketchbooksToFolders, migrateAudiobooksToFolders, saveArchivePointer, loadArchivePointer, cleanupTrash, getJSON, setJSON, loadCalendarEvents, saveCalendarEvents } from '@/lib/storage'
import { applyTheme, BUILT_IN_THEMES } from '@/lib/themes'
import { makeId } from '@/lib/utils'

// ─────────────────────────────────────────────────────────────────────────────
// App-wide state store
// ─────────────────────────────────────────────────────────────────────────────

const useAppStore = create((set, get) => ({

  // ── View routing ────────────────────────────────────────────────────────────
  view: 'library',
  activeLibTab: 'library',
  setView: (view) => set(s => ({ view, tabs: s.tabs.map(t => t.id === s.activeTabId ? { ...t, view } : t) })),
  setActiveLibTab: (tab) => set({ activeLibTab: tab }),

  // ── Side nav ────────────────────────────────────────────────────────────────
  sideNavOpen: false,
  openSideNav:  () => set(s => ({ sideNavOpen: true, tabs: s.tabs.map(t => t.id === s.activeTabId ? { ...t, sideNavOpen: true } : t) })),
  closeSideNav: () => set(s => ({ sideNavOpen: false, tabs: s.tabs.map(t => t.id === s.activeTabId ? { ...t, sideNavOpen: false } : t) })),
  toggleSideNav: () => set(s => { const next = !s.sideNavOpen; return { sideNavOpen: next, tabs: s.tabs.map(t => t.id === s.activeTabId ? { ...t, sideNavOpen: next } : t) } }),
  /** Open/close sidebar for a specific tab by id */
  setTabSideNavOpen: (tabId, open) => set(s => ({
    sideNavOpen: tabId === s.activeTabId ? open : s.sideNavOpen,
    tabs: s.tabs.map(t => t.id === tabId ? { ...t, sideNavOpen: open } : t),
  })),

  // ── Tabs (max 2) ─────────────────────────────────────────────────────────────
  // Each tab: { id, view, activeLibTab, activeBook, activeNotebook, activeAudioBook, activeSketchbook }
  tabs: [{ id: 'tab_main', view: 'library', activeLibTab: 'library', activeBook: null, activeNotebook: null, activeAudioBook: null, activeSketchbook: null, activeFlashcardDeck: null, sideNavOpen: false }],
  activeTabId: 'tab_main',

  /** Snapshot current view state into the active tab, then switch to target tab */
  switchTab(targetId) {
    const s = get()
    const updatedTabs = s.tabs.map(t =>
      t.id === s.activeTabId
        ? { ...t, view: s.view, activeLibTab: s.activeLibTab, activeBook: s.activeBook, activeNotebook: s.activeNotebook, activeAudioBook: s.activeAudioBook, activeSketchbook: s.activeSketchbook, activeFlashcardDeck: s.activeFlashcardDeck, sideNavOpen: s.sideNavOpen }
        : t
    )
    const target = updatedTabs.find(t => t.id === targetId)
    if (!target) return
    set({
      tabs: updatedTabs,
      activeTabId: targetId,
      view: target.view,
      activeLibTab: target.activeLibTab,
      activeBook: target.activeBook,
      activeNotebook: target.activeNotebook,
      activeAudioBook: target.activeAudioBook,
      activeSketchbook: target.activeSketchbook,
      activeFlashcardDeck: target.activeFlashcardDeck,
      sideNavOpen: target.sideNavOpen ?? false,
    })
  },

  /** Open a new tab (no limit). */
  openNewTab(snapshot = {}) {
    const s = get()
    // Save current state into active tab
    const updatedTabs = s.tabs.map(t =>
      t.id === s.activeTabId
        ? { ...t, view: s.view, activeLibTab: s.activeLibTab, activeBook: s.activeBook, activeNotebook: s.activeNotebook, activeAudioBook: s.activeAudioBook, activeSketchbook: s.activeSketchbook, activeFlashcardDeck: s.activeFlashcardDeck }
        : t
    )
    const newTab = {
      id: makeId('tab'),
      view: snapshot.view || 'library',
      activeLibTab: snapshot.activeLibTab || 'library',
      activeBook: snapshot.activeBook || null,
      activeNotebook: snapshot.activeNotebook || null,
      activeAudioBook: snapshot.activeAudioBook || null,
      activeSketchbook: snapshot.activeSketchbook || null,
      activeFlashcardDeck: snapshot.activeFlashcardDeck || null,
      sideNavOpen: false,
    }
    // Always append — no tab limit
    const finalTabs = [...updatedTabs, newTab]
    set({
      tabs: finalTabs,
      activeTabId: newTab.id,
      view: newTab.view,
      activeLibTab: newTab.activeLibTab,
      activeBook: newTab.activeBook,
      activeNotebook: newTab.activeNotebook,
      activeAudioBook: newTab.activeAudioBook,
      activeSketchbook: newTab.activeSketchbook,
      activeFlashcardDeck: newTab.activeFlashcardDeck,
    })
  },

  /** Directly update a specific tab's snapshot without switching to it.
   *  Used by split-pane views to keep their own state independent. */
  updateTab(tabId, patch) {
    set(s => ({
      tabs: s.tabs.map(t => t.id === tabId ? { ...t, ...patch } : t),
    }))
  },

  /** Reorder tabs by swapping indices */
  reorderTabs: (fromIdx, toIdx) => set(s => {
    const tabs = [...s.tabs]
    const [moved] = tabs.splice(fromIdx, 1)
    tabs.splice(toIdx, 0, moved)
    return { tabs }
  }),

  // ── Per-tab navigation history ────────────────────────────────────────────
  tabHistories: {},

  /** Navigate to a new view state, pushing the current state onto the back stack.
   *  Also updates the active tab's snapshot so TabPane renders the correct view. */
  navigate: (patch) => {
    const s = get()
    const curState = {
      view: s.view, activeLibTab: s.activeLibTab, activeBook: s.activeBook,
      activeNotebook: s.activeNotebook, activeAudioBook: s.activeAudioBook,
      activeSketchbook: s.activeSketchbook, activeFlashcardDeck: s.activeFlashcardDeck,
    }
    const tabId = s.activeTabId
    const hist = s.tabHistories[tabId] || { back: [], forward: [] }
    set({
      ...patch,
      tabs: s.tabs.map(t => t.id === tabId ? { ...t, ...patch } : t),
      tabHistories: {
        ...s.tabHistories,
        [tabId]: { back: [...hist.back, curState], forward: [] },
      },
    })
  },

  goBack: () => {
    const s = get()
    const tabId = s.activeTabId
    const hist = s.tabHistories[tabId]
    if (!hist || !hist.back.length) return
    const curState = {
      view: s.view, activeLibTab: s.activeLibTab, activeBook: s.activeBook,
      activeNotebook: s.activeNotebook, activeAudioBook: s.activeAudioBook,
      activeSketchbook: s.activeSketchbook, activeFlashcardDeck: s.activeFlashcardDeck,
    }
    const snapshot = hist.back[hist.back.length - 1]
    set({
      view: snapshot.view, activeLibTab: snapshot.activeLibTab, activeBook: snapshot.activeBook,
      activeNotebook: snapshot.activeNotebook, activeAudioBook: snapshot.activeAudioBook,
      activeSketchbook: snapshot.activeSketchbook, activeFlashcardDeck: snapshot.activeFlashcardDeck,
      tabs: s.tabs.map(t => t.id === tabId ? { ...t, view: snapshot.view, activeLibTab: snapshot.activeLibTab, activeBook: snapshot.activeBook, activeNotebook: snapshot.activeNotebook, activeAudioBook: snapshot.activeAudioBook, activeSketchbook: snapshot.activeSketchbook, activeFlashcardDeck: snapshot.activeFlashcardDeck } : t),
      tabHistories: {
        ...s.tabHistories,
        [tabId]: { back: hist.back.slice(0, -1), forward: [curState, ...hist.forward] },
      },
    })
  },

  goForward: () => {
    const s = get()
    const tabId = s.activeTabId
    const hist = s.tabHistories[tabId]
    if (!hist || !hist.forward.length) return
    const curState = {
      view: s.view, activeLibTab: s.activeLibTab, activeBook: s.activeBook,
      activeNotebook: s.activeNotebook, activeAudioBook: s.activeAudioBook,
      activeSketchbook: s.activeSketchbook, activeFlashcardDeck: s.activeFlashcardDeck,
    }
    const snapshot = hist.forward[0]
    set({
      view: snapshot.view, activeLibTab: snapshot.activeLibTab, activeBook: snapshot.activeBook,
      activeNotebook: snapshot.activeNotebook, activeAudioBook: snapshot.activeAudioBook,
      activeSketchbook: snapshot.activeSketchbook, activeFlashcardDeck: snapshot.activeFlashcardDeck,
      tabs: s.tabs.map(t => t.id === tabId ? { ...t, view: snapshot.view, activeLibTab: snapshot.activeLibTab, activeBook: snapshot.activeBook, activeNotebook: snapshot.activeNotebook, activeAudioBook: snapshot.activeAudioBook, activeSketchbook: snapshot.activeSketchbook, activeFlashcardDeck: snapshot.activeFlashcardDeck } : t),
      tabHistories: {
        ...s.tabHistories,
        [tabId]: { back: [...hist.back, curState], forward: hist.forward.slice(1) },
      },
    })
  },

  /** Close a tab, switch to the remaining one */
  closeTab(tabId) {
    const s = get()
    if (s.tabs.length <= 1) return // never close the last tab
    const remaining = s.tabs.filter(t => t.id !== tabId)
    const next = remaining[0]
    set({
      tabs: remaining,
      activeTabId: next.id,
      view: next.view,
      activeLibTab: next.activeLibTab,
      activeBook: next.activeBook,
      activeNotebook: next.activeNotebook,
      activeAudioBook: next.activeAudioBook,
      activeSketchbook: next.activeSketchbook,
      activeFlashcardDeck: next.activeFlashcardDeck,
    })
  },

  // ── Library ─────────────────────────────────────────────────────────────────
  library: [],
  setLibrary: (library) => set({ library }),
  addBook: (book) => set(s => ({ library: [...s.library, book] })),
  updateBook: (id, patch) => set(s => ({
    library: s.library.map(b => b.id === id ? { ...b, ...patch } : b),
  })),
  removeBook: (id) => set(s => {
    const updatedTabs = s.tabs.map(t =>
      t.activeBook?.id === id ? { ...t, view: 'library', activeBook: null } : t
    )
    const activeAffected = s.activeBook?.id === id
    return {
      library: s.library.filter(b => b.id !== id),
      tabs: updatedTabs,
      ...(activeAffected ? { view: 'library', activeBook: null } : {}),
    }
  }),
  reorderLibrary: (fromIdx, toIdx) => set(s => {
    const lib = [...s.library]
    const [moved] = lib.splice(fromIdx, 1)
    lib.splice(toIdx, 0, moved)
    return { library: lib }
  }),

  // ── Notebooks ───────────────────────────────────────────────────────────────
  notebooks: [],
  setNotebooks: (notebooks) => set({ notebooks }),
  addNotebook: (nb) => set(s => ({ notebooks: [nb, ...s.notebooks] })),
  updateNotebook: (id, patch) => set(s => ({
    notebooks: s.notebooks.map(n => n.id === id ? { ...n, ...patch } : n),
  })),
  removeNotebook: (id) => set(s => {
    const updatedTabs = s.tabs.map(t =>
      t.activeNotebook?.id === id ? { ...t, view: 'library', activeNotebook: null } : t
    )
    const activeAffected = s.activeNotebook?.id === id
    return {
      notebooks: s.notebooks.filter(n => n.id !== id),
      tabs: updatedTabs,
      ...(activeAffected ? { view: 'library', activeNotebook: null } : {}),
    }
  }),
  reorderNotebooks: (fromIdx, toIdx) => set(s => {
    const nbs = [...s.notebooks]
    const [moved] = nbs.splice(fromIdx, 1)
    nbs.splice(toIdx, 0, moved)
    return { notebooks: nbs }
  }),

  // ── Active reader ────────────────────────────────────────────────────────────
  activeBook: null,
  chapters: [],
  currentChapter: 0,
  currentPage: 0,
  setActiveBook: (book) => set({ activeBook: book }),
  setChapters: (chapters) => set({ chapters }),
  setCurrentChapter: (n) => set({ currentChapter: n }),
  setCurrentPage: (n) => set({ currentPage: n }),

  // ── Active notebook ──────────────────────────────────────────────────────────
  activeNotebook: null,
  setActiveNotebook: (nb) => set({ activeNotebook: nb }),

  // ── Sketchbooks ──────────────────────────────────────────────────────────────
  sketchbooks: [],
  activeSketchbook: null,
  setSketchbooks: (sketchbooks) => set({ sketchbooks }),
  setActiveSketchbook: (sb) => set({ activeSketchbook: sb }),
  addSketchbook: (sb) => set(s => ({ sketchbooks: [sb, ...s.sketchbooks] })),
  updateSketchbook: (id, patch) => set(s => ({
    sketchbooks: s.sketchbooks.map(sb => sb.id === id ? { ...sb, ...patch } : sb),
  })),
  removeSketchbook: (id) => set(s => {
    const updatedTabs = s.tabs.map(t =>
      t.activeSketchbook?.id === id ? { ...t, view: 'library', activeSketchbook: null } : t
    )
    const activeAffected = s.activeSketchbook?.id === id
    return {
      sketchbooks: s.sketchbooks.filter(sb => sb.id !== id),
      tabs: updatedTabs,
      ...(activeAffected ? { view: 'library', activeSketchbook: null } : {}),
    }
  }),
  reorderSketchbooks: (fromIdx, toIdx) => set(s => {
    const sbs = [...s.sketchbooks]
    const [moved] = sbs.splice(fromIdx, 1)
    sbs.splice(toIdx, 0, moved)
    return { sketchbooks: sbs }
  }),

  // ── Flashcard Decks ────────────────────────────────────────────────────────
  flashcardDecks: [],
  activeFlashcardDeck: null,
  setFlashcardDecks: (flashcardDecks) => set({ flashcardDecks }),
  setActiveFlashcardDeck: (deck) => set({ activeFlashcardDeck: deck }),
  addDeck: (deck) => set(s => ({ flashcardDecks: [deck, ...s.flashcardDecks] })),
  updateDeck: (id, patch) => set(s => ({
    flashcardDecks: s.flashcardDecks.map(d => d.id === id ? { ...d, ...patch } : d),
  })),
  removeDeck: (id) => set(s => ({ flashcardDecks: s.flashcardDecks.filter(d => d.id !== id) })),
  reorderFlashcardDecks: (fromIdx, toIdx) => set(s => {
    const fds = [...s.flashcardDecks]
    const [moved] = fds.splice(fromIdx, 1)
    fds.splice(toIdx, 0, moved)
    return { flashcardDecks: fds }
  }),

  // ── Collections ─────────────────────────────────────────────────────────────
  collections: [],
  setCollections: (collections) => set({ collections }),
  addCollection: (col) => set(s => ({ collections: [col, ...s.collections] })),
  updateCollection: (id, patch) => set(s => ({
    collections: s.collections.map(c => c.id === id ? { ...c, ...patch } : c),
  })),
  removeCollection: (id) => set(s => ({ collections: s.collections.filter(c => c.id !== id) })),
  addToCollection: (collectionId, itemId) => set(s => ({
    collections: s.collections.map(c =>
      c.id === collectionId && !c.items.includes(itemId)
        ? { ...c, items: [...c.items, itemId] }
        : c
    ),
  })),
  removeFromCollection: (collectionId, itemId) => set(s => ({
    collections: s.collections.map(c =>
      c.id === collectionId
        ? { ...c, items: c.items.filter(i => i !== itemId) }
        : c
    ),
  })),
  moveCollection: (collectionId, newParentId) => set(s => ({
    collections: s.collections.map(c =>
      c.id === collectionId ? { ...c, parentId: newParentId || null } : c
    ),
  })),

  // ── Calendar events ──────────────────────────────────────────────────────────
  calendarEvents: [],
  setCalendarEventsStore: (events) => set({ calendarEvents: events }),
  async persistCalendarEvents() { await saveCalendarEvents(get().calendarEvents) },

  // ── Active audio book ────────────────────────────────────────────────────────
  activeAudioBook: null,
  setActiveAudioBook: (book) => set({ activeAudioBook: book }),

  // ── Notes (keyed by bookId) ──────────────────────────────────────────────────
  notes: {},
  setNotes: (notes) => set({ notes }),
  addNote: (bookId, note) => set(s => ({
    notes: { ...s.notes, [bookId]: [...(s.notes[bookId] ?? []), note] },
  })),

  // ── Reader preferences ───────────────────────────────────────────────────────
  themeKey: 'dark',
  customThemes: {},
  fontSize: 18,
  lineSpacing: 1.7,
  fontFamily: 'Georgia, serif',
  tapToTurn: true,
  twoPage: false,
  justifyText: true,
  highlightWords: false,
  underlineLine: false,
  pageTransition: 'slide',
  // Notebook prefs
  defaultViewMode: 'live',
  autosave: true,
  nbFontSize: 15,
  smartListContinuation: true,
  syntaxAutocomplete: true,
  // TTS prefs
  ttsEnabled: false,
  ttsVoice: '',
  ttsSpeed: 1,
  // Audio prefs
  rememberPosition: true,
  defaultPlaybackSpeed: 1,
  // Calendar prefs
  calendarStartHour: 7,
  calendarEndHour: 21,
  calendarWeekStart: 0,
  // Cross-tab notebook content sync — holds the most recently saved text per notebook id
  // so other tabs showing the same notebook can detect and apply the new content.
  notebookContentCache: {},
  setNotebookContentCache: (id, text) => set(s => ({
    notebookContentCache: { ...s.notebookContentCache, [id]: { text, ts: Date.now() } },
  })),

  // Filter persistence
  libSubFilter: 'all',
  setLibSubFilter: (f) => { set({ libSubFilter: f }); get().persistPreferences() },

  // Unified cross-type order for the main library tab
  unifiedLibraryOrder: [],
  setUnifiedLibraryOrder: (order) => set({ unifiedLibraryOrder: order }),

  // Creation behaviour
  openOnCreate: true,
  setPreference: (key, value) => set({ [key]: value }),
  setPref: (key, value) => set({ [key]: value }),
  updateBookProgress: (id, chapter, page) => set(s => ({
    library: s.library.map(b => b.id === id ? { ...b, currentChapter: chapter, currentPage: page } : b),
  })),

  // ── Ollama (optional AI) ─────────────────────────────────────────────────────
  ollamaUrl: '',
  ollamaModel: 'llama3',

  // ── Mini audio player ────────────────────────────────────────────────────────
  miniAudioBook: null,
  miniAudioPlaying: false,
  miniAudioTitle: '',
  setMiniAudioBook: (book) => set({ miniAudioBook: book }),
  setMiniAudioPlaying: (v) => set({ miniAudioPlaying: v }),
  setMiniAudioTitle: (t) => set({ miniAudioTitle: t }),

  // ── User profile & archive ──────────────────────────────────────────────────────
  username: '',
  archivePath: '',
  onboardingComplete: false,
  setUsername: (username) => set({ username }),
  setArchivePath: (archivePath) => set({ archivePath }),
  setOnboardingComplete: (v) => set({ onboardingComplete: v }),

  // ── Async actions ─────────────────────────────────────────────────────────────

  async init() {
    // ── Step 1: read the pointer file from appDataDir/gnos/archive_path.json ──
    // This is a tiny file that always lives in the default location regardless
    // of where the user's archive is. It tells us the archive path so we can
    // point storage there before loading anything else.
    const savedArchivePath = await loadArchivePointer()
    if (savedArchivePath) {
      // Set archivePath in the store NOW so getBaseDir() resolves to the archive
      set({ archivePath: savedArchivePath })
    }

    // ── Step 2: load everything from the correct location ─────────────────────
    const [library, notebooks, sketchbooks, prefs, collections, flashcardDecks, calendarEvents] = await Promise.all([
      loadLibrary(),
      loadNotebooksMeta(),
      loadSketchbooksMeta(),
      loadPreferences(),
      getJSON('collections_meta', []),
      getJSON('flashcard_decks', []),
      loadCalendarEvents(),
    ])

    if (prefs) {
      const {
        themeKey = 'dark', customThemes = {},
        fontSize = 18, lineSpacing = 1.7, fontFamily = 'Georgia, serif',
        tapToTurn = true, twoPage = false,
        justifyText = true, highlightWords = false, underlineLine = false, pageTransition = 'slide',
        defaultViewMode = 'live', autosave = true, smartListContinuation = true, syntaxAutocomplete = true, nbFontSize = 15,
        rememberPosition = true, defaultPlaybackSpeed = 1,
        ttsEnabled = false, ttsVoice = '', ttsSpeed = 1,
        ollamaUrl = '', ollamaModel = 'llama3',
        username = '', archivePath = '', onboardingComplete = false,
        libSubFilter = 'all',
        calendarStartHour = 7, calendarEndHour = 21, calendarWeekStart = 0,
        unifiedLibraryOrder = [], openOnCreate = true,
      } = prefs
      // archivePath from prefs wins over the pointer (they should match, but prefs is authoritative)
      set({ themeKey, customThemes, fontSize, lineSpacing, fontFamily,
            tapToTurn, twoPage, justifyText, highlightWords, underlineLine, pageTransition,
            defaultViewMode, autosave, smartListContinuation, syntaxAutocomplete, nbFontSize,
            rememberPosition, defaultPlaybackSpeed,
            ttsEnabled, ttsVoice, ttsSpeed,
            ollamaUrl, ollamaModel, username, libSubFilter,
            calendarStartHour, calendarEndHour, calendarWeekStart,
            unifiedLibraryOrder, openOnCreate,
            archivePath: archivePath || savedArchivePath,
            onboardingComplete })
      applyTheme(themeKey, customThemes)
    } else {
      applyTheme('dark')
    }
    set({ library: library ?? [], notebooks: notebooks ?? [], sketchbooks: sketchbooks ?? [], collections: collections ?? [], flashcardDecks: flashcardDecks ?? [], calendarEvents: calendarEvents ?? [] })
    migrateBooksToNamedFolders(library ?? []).catch(err => console.warn('[Gnos] Migration error:', err))
    migrateNotebooksToFolders(notebooks ?? []).catch(err => console.warn('[Gnos] Notebook migration error:', err))
    migrateSketchbooksToFolders(sketchbooks ?? []).catch(err => console.warn('[Gnos] Sketchbook migration error:', err))
    migrateAudiobooksToFolders(library ?? []).catch(err => console.warn('[Gnos] Audio migration error:', err))
    cleanupTrash().catch(err => console.debug('[Gnos] Trash cleanup error:', err))
  },

  async persistLibrary() {
    await saveLibrary(get().library)
  },
  async persistNotebooks() {
    await saveNotebooksMeta(get().notebooks)
  },
  async persistSketchbooks() {
    await saveSketchbooksMeta(get().sketchbooks)
  },
  async persistFlashcardDecks() {
    await setJSON('flashcard_decks', get().flashcardDecks)
  },
  async persistCollections() {
    await setJSON('collections_meta', get().collections)
  },
  async persistPreferences() {
    const s = get()
    await savePreferences({
      themeKey: s.themeKey, customThemes: s.customThemes,
      fontSize: s.fontSize, lineSpacing: s.lineSpacing, fontFamily: s.fontFamily,
      tapToTurn: s.tapToTurn, twoPage: s.twoPage,
      justifyText: s.justifyText, highlightWords: s.highlightWords, underlineLine: s.underlineLine, pageTransition: s.pageTransition,
      defaultViewMode: s.defaultViewMode, autosave: s.autosave,
      smartListContinuation: s.smartListContinuation, syntaxAutocomplete: s.syntaxAutocomplete, nbFontSize: s.nbFontSize,
      rememberPosition: s.rememberPosition, defaultPlaybackSpeed: s.defaultPlaybackSpeed,
      ttsEnabled: s.ttsEnabled, ttsVoice: s.ttsVoice, ttsSpeed: s.ttsSpeed,
      ollamaUrl: s.ollamaUrl, ollamaModel: s.ollamaModel,
      username: s.username, archivePath: s.archivePath, onboardingComplete: s.onboardingComplete,
      libSubFilter: s.libSubFilter,
      calendarStartHour: s.calendarStartHour, calendarEndHour: s.calendarEndHour, calendarWeekStart: s.calendarWeekStart,
      unifiedLibraryOrder: s.unifiedLibraryOrder, openOnCreate: s.openOnCreate,
    })
    // Always keep the pointer file up to date so init() can find the archive on next launch
    if (s.archivePath) {
      await saveArchivePointer(s.archivePath)
    }
  },
  setTheme(key) {
    const { customThemes } = get()
    set({ themeKey: key })
    applyTheme(key, customThemes)
    get().persistPreferences()
  },
}))

export default useAppStore

import { useShallow } from 'zustand/react/shallow'
export const useAppStoreShallow = (selector) => useAppStore(useShallow(selector))