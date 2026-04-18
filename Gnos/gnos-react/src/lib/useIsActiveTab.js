import { useContext } from 'react'
import { PaneContext } from '@/lib/PaneContext'
import useAppStore from '@/store/useAppStore'

/**
 * Returns true when the current view is the active tab (or is not inside a
 * tab pane at all). Use this to gate window.addEventListener handlers so that
 * background tabs cannot receive keyboard events.
 */
export function useIsActiveTab() {
  const paneTabId   = useContext(PaneContext)
  const activeTabId = useAppStore(s => s.activeTabId)
  // If paneTabId is null we're in single-pane mode — always active.
  return !paneTabId || activeTabId === paneTabId
}
