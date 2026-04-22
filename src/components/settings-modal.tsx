import { startTransition, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'

import type { ShellKind } from '../../shared/protocol'

export interface AppSettings {
  cwd?: string
  shell?: ShellKind
  customShellPath?: string
  copyOnSelect?: boolean
  fontSize?: number
}

const DEFAULT_FONT_SIZE = 14
const MIN_FONT_SIZE = 10
const MAX_FONT_SIZE = 28

interface ShellInfo {
  kind: ShellKind
  label: string
}

interface SettingsModalProps {
  open: boolean
  onClose: () => void
  settings: AppSettings
  onSave: (settings: AppSettings) => void
}

export function SettingsModal({ open, onClose, settings, onSave }: SettingsModalProps) {
  const [shells, setShells] = useState<ShellInfo[]>([])
  const [shellsError, setShellsError] = useState(false)
  const [cwd, setCwd] = useState(settings.cwd ?? '')
  const [shell, setShell] = useState<ShellKind | ''>(settings.shell ?? '')
  const [customShellPath, setCustomShellPath] = useState(settings.customShellPath ?? '')
  const [copyOnSelect, setCopyOnSelect] = useState(settings.copyOnSelect ?? false)
  const [fontSize, setFontSize] = useState(settings.fontSize ?? DEFAULT_FONT_SIZE)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false
    }
  }, [])

  // Reset form state whenever modal opens
  useEffect(() => {
    if (!open) return
    startTransition(() => {
      setCwd(settings.cwd ?? '')
      setShell(settings.shell ?? '')
      setCustomShellPath(settings.customShellPath ?? '')
      setCopyOnSelect(settings.copyOnSelect ?? false)
      setFontSize(settings.fontSize ?? DEFAULT_FONT_SIZE)
    })
  }, [open, settings])

  // Fetch available shells from the server whenever modal opens
  useEffect(() => {
    if (!open) return
    startTransition(() => setShellsError(false))

    fetch('/api/shells')
      .then((r) => r.json())
      .then((data: { shells: ShellInfo[] }) => {
        if (!mountedRef.current) return
        setShells(data.shells)
      })
      .catch(() => {
        if (!mountedRef.current) return
        setShellsError(true)
      })
  }, [open])

  if (!open) return null

  function handleSave() {
    const clampedFontSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, fontSize))
    const next: AppSettings = {
      cwd: cwd.trim() || undefined,
      shell: (shell as ShellKind) || undefined,
      customShellPath: customShellPath.trim() || undefined,
      copyOnSelect: copyOnSelect || undefined,
      fontSize: clampedFontSize !== DEFAULT_FONT_SIZE ? clampedFontSize : undefined,
    }
    onSave(next)
    onClose()
  }

  return (
    <div
      aria-modal="true"
      className="settings-modal-backdrop"
      role="dialog"
      onClick={onClose}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
    >
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-modal-header">
          <span className="settings-modal-title">Settings</span>
          <button
            aria-label="Close settings"
            className="settings-modal-close"
            onClick={onClose}
            type="button"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="settings-modal-body">
          {/* ── Working directory ── */}
          <div className="settings-field">
            <label className="settings-field-label" htmlFor="settings-cwd">
              Default working directory
            </label>
            <input
              autoComplete="off"
              className="settings-input"
              id="settings-cwd"
              name="settings-cwd"
              placeholder="/home/user/projects"
              type="text"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
            />
            <span className="settings-field-desc">
              Use <code className="settings-code">~</code> for your home directory (e.g.{' '}
              <code className="settings-code">~/projects</code>). Leave blank to open in the home
              directory.
            </span>
          </div>

          {/* ── Shell selection ── */}
          <div className="settings-field">
            <label className="settings-field-label" htmlFor="settings-shell">
              Default shell
            </label>
            {shellsError ? (
              <span className="settings-field-desc settings-field-error">
                Could not load shell list — sessions will use the system default.
              </span>
            ) : (
              <select
                className="settings-select"
                id="settings-shell"
                name="settings-shell"
                value={shell}
                onChange={(e) => setShell(e.target.value as ShellKind | '')}
              >
                <option value="">System default</option>
                {shells.map((s) => (
                  <option key={s.kind} value={s.kind}>{s.label}</option>
                ))}
              </select>
            )}
          </div>

          {/* ── Custom shell path ── */}
          <div className="settings-field">
            <label className="settings-field-label" htmlFor="settings-custom-shell">
              Custom shell path
            </label>
            <input
              autoComplete="off"
              className="settings-input"
              id="settings-custom-shell"
              name="settings-custom-shell"
              placeholder="/opt/homebrew/bin/fish"
              type="text"
              value={customShellPath}
              onChange={(e) => setCustomShellPath(e.target.value)}
            />
            <span className="settings-field-desc">
              Full path to any shell executable. When set, overrides the shell selection above.
            </span>
          </div>

          {/* ── Font size ── */}
          <div className="settings-field">
            <label className="settings-field-label" htmlFor="settings-font-size">
              Font size
            </label>
            <div className="settings-row">
              <input
                className="settings-input settings-input-number"
                id="settings-font-size"
                max={MAX_FONT_SIZE}
                min={MIN_FONT_SIZE}
                name="settings-font-size"
                step={1}
                type="number"
                value={fontSize}
                onChange={(e) => setFontSize(Number(e.target.value))}
              />
              <input
                aria-hidden="true"
                className="settings-range"
                max={MAX_FONT_SIZE}
                min={MIN_FONT_SIZE}
                step={1}
                tabIndex={-1}
                type="range"
                value={fontSize}
                onChange={(e) => setFontSize(Number(e.target.value))}
              />
            </div>
            <span className="settings-field-desc">
              Terminal font size in pixels ({MIN_FONT_SIZE}–{MAX_FONT_SIZE}px).
            </span>
          </div>

          {/* ── Copy on select ── */}
          <div className="settings-field">
            <label className="settings-field-label settings-checkbox-label" htmlFor="settings-copy-select">
              <input
                checked={copyOnSelect}
                className="settings-checkbox"
                id="settings-copy-select"
                name="settings-copy-select"
                type="checkbox"
                onChange={(e) => setCopyOnSelect(e.target.checked)}
              />
              Copy on select
            </label>
            <span className="settings-field-desc">
              Automatically copy selected text to the clipboard.
            </span>
          </div>
        </div>

        <div className="settings-modal-footer">
          <button className="settings-btn settings-btn-secondary" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="settings-btn settings-btn-primary" onClick={handleSave} type="button">
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
