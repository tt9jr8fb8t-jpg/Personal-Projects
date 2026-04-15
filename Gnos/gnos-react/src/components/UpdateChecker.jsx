import { useEffect, useState } from 'react'
import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

export default function UpdateChecker() {
  const [update, setUpdate]       = useState(null)  // update object from plugin
  const [phase, setPhase]         = useState('idle') // idle | downloading | error
  const [downloaded, setDownloaded] = useState(0)
  const [total, setTotal]         = useState(null)
  const [errorMsg, setErrorMsg]   = useState('')

  // Check ~3 seconds after launch so it doesn't block startup
  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const u = await check()
        if (u?.available) setUpdate(u)
      } catch {
        // silently ignore — update server may not be reachable in dev
      }
    }, 3000)
    return () => clearTimeout(t)
  }, [])

  function dismiss() {
    setUpdate(null)
    setPhase('idle')
    setDownloaded(0)
    setTotal(null)
    setErrorMsg('')
  }

  async function startUpdate() {
    setPhase('downloading')
    setDownloaded(0)
    setTotal(null)
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          setTotal(event.data.contentLength ?? null)
        } else if (event.event === 'Progress') {
          setDownloaded(d => d + (event.data.chunkLength ?? 0))
        }
      })
      await relaunch()
    } catch (e) {
      setPhase('error')
      setErrorMsg(String(e))
    }
  }

  if (!update) return null

  const percent = total && downloaded ? Math.min(100, Math.round((downloaded / total) * 100)) : null

  return (
    <div style={{
      position: 'fixed', bottom: 20, right: 20, zIndex: 99999,
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 12, padding: '16px 18px', width: 300,
      boxShadow: '0 8px 32px rgba(0,0,0,0.35)',
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text)' }}>
          Update available
        </span>
        {phase === 'idle' && (
          <button
            onClick={dismiss}
            style={{ background: 'none', border: 'none', color: 'var(--textDim)', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 0 }}
          >×</button>
        )}
      </div>

      {/* Version */}
      <div style={{ fontSize: 12, color: 'var(--textDim)' }}>
        v{update.currentVersion} → <strong style={{ color: 'var(--accent)' }}>v{update.version}</strong>
      </div>

      {/* Release notes */}
      {update.body && (
        <div style={{
          fontSize: 11, color: 'var(--textDim)', lineHeight: 1.5,
          maxHeight: 72, overflowY: 'auto',
          borderTop: '1px solid var(--borderSubtle)', paddingTop: 8,
        }}>
          {update.body}
        </div>
      )}

      {/* Progress bar */}
      {phase === 'downloading' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ height: 4, borderRadius: 4, background: 'var(--borderSubtle)', overflow: 'hidden' }}>
            <div style={{
              height: '100%', borderRadius: 4, background: 'var(--accent)',
              width: percent != null ? `${percent}%` : '40%',
              transition: percent != null ? 'width 0.2s ease' : undefined,
              animation: percent == null ? 'gnos-update-indeterminate 1.2s ease-in-out infinite' : undefined,
            }} />
          </div>
          <span style={{ fontSize: 11, color: 'var(--textDim)', textAlign: 'right' }}>
            {percent != null ? `${percent}%` : 'Downloading…'}
          </span>
        </div>
      )}

      {/* Error */}
      {phase === 'error' && (
        <div style={{ fontSize: 11, color: '#f85149', borderTop: '1px solid var(--borderSubtle)', paddingTop: 6 }}>
          {errorMsg}
        </div>
      )}

      {/* Actions */}
      {phase === 'idle' && (
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={dismiss} style={{
            flex: 1, padding: '6px 0', border: '1px solid var(--border)',
            borderRadius: 6, background: 'none', color: 'var(--textDim)',
            cursor: 'pointer', fontSize: 12, fontWeight: 500,
          }}>
            Later
          </button>
          <button onClick={startUpdate} style={{
            flex: 1, padding: '6px 0', border: 'none',
            borderRadius: 6, background: 'var(--accent)', color: '#fff',
            cursor: 'pointer', fontSize: 12, fontWeight: 600,
          }}>
            Update & Restart
          </button>
        </div>
      )}

      {phase === 'error' && (
        <button onClick={dismiss} style={{
          padding: '6px 0', border: '1px solid var(--border)',
          borderRadius: 6, background: 'none', color: 'var(--textDim)',
          cursor: 'pointer', fontSize: 12,
        }}>
          Dismiss
        </button>
      )}

      <style>{`
        @keyframes gnos-update-indeterminate {
          0%   { transform: translateX(-100%); width: 40%; }
          100% { transform: translateX(350%);  width: 40%; }
        }
      `}</style>
    </div>
  )
}
