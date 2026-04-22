import { startTransition, useCallback, useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import type { Socket } from 'socket.io-client'

import type {
  SessionBufferPayload,
  SessionOutputPayload,
  SessionResetPayload,
  SessionSnapshot,
  SocketAck,
} from '../../shared/protocol'
import type { AppSettings } from './settings-modal'
import { cn } from '../lib/utils'
import '@xterm/xterm/css/xterm.css'

export interface TerminalSurfaceCommand {
  sessionId: string
  kind: 'clear' | 'focus' | 'fit' | 'search'
  nonce: number
}

interface TerminalSurfaceProps {
  command: TerminalSurfaceCommand | null
  session: SessionSnapshot
  socket: Socket
  isActive: boolean
  autoFocusOnActivate?: boolean
  settings?: AppSettings
}

export function TerminalSurface({
  command,
  session,
  socket,
  isActive,
  autoFocusOnActivate = true,
  settings,
}: TerminalSurfaceProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const webglAddonRef = useRef<WebglAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const settingsRef = useRef<AppSettings | undefined>(settings)
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  // Keep settingsRef in sync with settings prop
  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  const fitAndResize = useCallback(() => {
    const host = hostRef.current
    const terminal = terminalRef.current
    const fitAddon = fitAddonRef.current

    if (!host || !terminal || !fitAddon || host.clientWidth === 0 || host.clientHeight === 0) {
      return
    }

    fitAddon.fit()
    socket.emit('resize', {
      sessionId: session.id,
      cols: terminal.cols,
      rows: terminal.rows,
    })
  }, [session.id, socket])

  const replayBuffer = useCallback((payload: SessionBufferPayload) => {
    if (payload.sessionId !== session.id || !terminalRef.current) {
      return
    }

    terminalRef.current.reset()

    if (payload.data) {
      terminalRef.current.write(payload.data)
    }

    requestAnimationFrame(() => {
      fitAndResize()
    })
  }, [fitAndResize, session.id])

  const writeOutput = useCallback((payload: SessionOutputPayload) => {
    if (payload.sessionId !== session.id) {
      return
    }

    terminalRef.current?.write(payload.data)
  }, [session.id])

  const resetTerminal = useCallback((payload: SessionResetPayload) => {
    if (payload.sessionId !== session.id) {
      return
    }

    terminalRef.current?.reset()
  }, [session.id])

  const attachToSession = useCallback(() => {
    socket.emit(
      'attach',
      { sessionId: session.id },
      (ack: SocketAck<SessionSnapshot>) => {
        if (!ack.ok && terminalRef.current) {
          terminalRef.current.writeln(`\r\n[webterm] ${ack.error}`)
        }
      },
    )
  }, [session.id, socket])

  const setWebglRendererEnabled = useCallback((enabled: boolean) => {
    const terminal = terminalRef.current

    if (!terminal) {
      return
    }

    if (!enabled) {
      webglAddonRef.current?.dispose()
      webglAddonRef.current = null
      return
    }

    if (webglAddonRef.current) {
      return
    }

    try {
      const addon = new WebglAddon()
      terminal.loadAddon(addon)
      webglAddonRef.current = addon
      // Force full repaint so WebGL re-renders all existing cells correctly
      // (avoids first-cell rendering artifacts in apps like vim)
      requestAnimationFrame(() => {
        terminal.refresh(0, terminal.rows - 1)
      })
    } catch {
      // Canvas rendering is an acceptable fallback when WebGL is unavailable.
    }
  }, [])

  useEffect(() => {
    if (!hostRef.current) {
      return
    }

    const terminal = new Terminal({
      allowTransparency: true,
      convertEol: false,
      cursorBlink: true,
      cursorInactiveStyle: 'outline',
      fontFamily: '"JetBrainsMono Nerd Font", "JetBrains Mono", "IBM Plex Mono", monospace',
      fontSize: settingsRef.current?.fontSize ?? 14,
      lineHeight: 1.0,
      scrollback: 5000,
      theme: {
        background: '#0c0c0c',
        foreground: '#c8c8c8',
        cursor: '#3b82f6',
        cursorAccent: '#0c0c0c',
        selectionBackground: 'rgba(59,130,246,0.25)',
        black: '#1a1a1a',
        red: '#f87171',
        green: '#4ade80',
        yellow: '#fbbf24',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#e2e8f0',
        brightBlack: '#404040',
        brightRed: '#fca5a5',
        brightGreen: '#86efac',
        brightYellow: '#fcd34d',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9',
        brightWhite: '#f8fafc',
      },
    })
    const fitAddon = new FitAddon()
    const searchAddon = new SearchAddon()
    const webLinksAddon = new WebLinksAddon((event, uri) => {
      if (event.ctrlKey || event.metaKey) {
        window.open(uri, '_blank', 'noopener,noreferrer')
      }
    })

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon
    searchAddonRef.current = searchAddon

    terminal.loadAddon(fitAddon)
    terminal.loadAddon(searchAddon)
    terminal.loadAddon(webLinksAddon)

    terminal.open(hostRef.current)
    terminal.writeln('[webterm] attaching to session...')

    terminal.onBell(() => {
      window.dispatchEvent(new CustomEvent('webterm:bell', { detail: session.id }))
    })

    terminal.onSelectionChange(() => {
      if (!settingsRef.current?.copyOnSelect) return
      const text = terminal.getSelection()
      if (!text) return
      navigator.clipboard.writeText(text).catch(() => {
        // Fallback for older browsers
        const el = document.createElement('textarea')
        el.value = text
        el.style.position = 'fixed'
        el.style.opacity = '0'
        document.body.appendChild(el)
        el.select()
        document.execCommand('copy')
        document.body.removeChild(el)
      })
    })

    // Intercept app-level shortcuts before xterm can swallow them.
    // Returns false → xterm skips this key; the DOM event still fires on window.
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true

      // Ctrl+Shift+F → open terminal search (before altKey guard)
      if (event.ctrlKey && event.shiftKey && event.code === 'KeyF') {
        event.preventDefault()
        window.dispatchEvent(new CustomEvent('webterm:shortcut', { detail: 'search' }))
        return false
      }

      const hasNonAltModifier = event.ctrlKey || event.metaKey

      if (!event.altKey || hasNonAltModifier) {
        return true
      }

      if (!event.shiftKey && event.code === 'KeyK') {
        window.dispatchEvent(new CustomEvent('webterm:shortcut', { detail: 'open-palette' }))
        return false
      }
      if (event.shiftKey && event.code === 'KeyW') {
        window.dispatchEvent(new CustomEvent('webterm:shortcut', { detail: 'kill-session' }))
        return false
      }
      if (!event.shiftKey && event.code === 'KeyW') {
        window.dispatchEvent(new CustomEvent('webterm:shortcut', { detail: 'hide-from-workspace' }))
        return false
      }
      if (!event.shiftKey && event.code === 'KeyM') {
        window.dispatchEvent(new CustomEvent('webterm:shortcut', { detail: 'new-workspace' }))
        return false
      }
      if (!event.shiftKey && event.code === 'KeyN') {
        window.dispatchEvent(new CustomEvent('webterm:shortcut', { detail: 'new-session' }))
        return false
      }
      if (!event.shiftKey && event.key === 'ArrowLeft') {
        window.dispatchEvent(new CustomEvent('webterm:shortcut', { detail: 'alt-prev-tab' }))
        return false
      }
      if (!event.shiftKey && event.key === 'ArrowRight') {
        window.dispatchEvent(new CustomEvent('webterm:shortcut', { detail: 'alt-next-tab' }))
        return false
      }
      if (event.shiftKey && event.key === 'ArrowLeft') {
        window.dispatchEvent(new CustomEvent('webterm:shortcut', { detail: 'alt-shift-prev-tab' }))
        return false
      }
      if (event.shiftKey && event.key === 'ArrowRight') {
        window.dispatchEvent(new CustomEvent('webterm:shortcut', { detail: 'alt-shift-next-tab' }))
        return false
      }
      if (!event.shiftKey && event.key === 'ArrowUp') {
        window.dispatchEvent(new CustomEvent('webterm:shortcut', { detail: 'alt-prev-workspace' }))
        return false
      }
      if (!event.shiftKey && event.key === 'ArrowDown') {
        window.dispatchEvent(new CustomEvent('webterm:shortcut', { detail: 'alt-next-workspace' }))
        return false
      }
      if (event.shiftKey && event.key === 'ArrowUp') {
        window.dispatchEvent(new CustomEvent('webterm:shortcut', { detail: 'alt-shift-prev-workspace' }))
        return false
      }
      if (event.shiftKey && event.key === 'ArrowDown') {
        window.dispatchEvent(new CustomEvent('webterm:shortcut', { detail: 'alt-shift-next-workspace' }))
        return false
      }

      return true
    })

    // Refit after the Nerd Font finishes loading to avoid incorrect glyph metrics.
    void document.fonts.load('14px "JetBrainsMono Nerd Font"').then(() => {
      fitAndResize()
    })

    // Refit when the sidebar is resized.
    function handleRefit() { fitAndResize() }
    window.addEventListener('webterm:refit', handleRefit)

    const inputSubscription = terminal.onData((data) => {
      socket.emit('input', {
        sessionId: session.id,
        data,
      })
    })

    requestAnimationFrame(() => {
      fitAndResize()
    })

    return () => {
      window.removeEventListener('webterm:refit', handleRefit)
      inputSubscription.dispose()
      webglAddonRef.current?.dispose()
      webglAddonRef.current = null
      searchAddonRef.current = null
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [fitAndResize, session.id, socket])

  useEffect(() => {
    attachToSession()

    const handleConnect = () => {
      attachToSession()
    }

    socket.on('connect', handleConnect)

    return () => {
      socket.off('connect', handleConnect)
    }
  }, [attachToSession, socket])

  useEffect(() => {
    socket.on('session-buffer', replayBuffer)
    socket.on('output', writeOutput)
    socket.on('session-reset', resetTerminal)

    return () => {
      socket.off('session-buffer', replayBuffer)
      socket.off('output', writeOutput)
      socket.off('session-reset', resetTerminal)
    }
  }, [replayBuffer, resetTerminal, socket, writeOutput])

  useEffect(() => {
    setWebglRendererEnabled(isActive)

    return () => {
      if (isActive) {
        setWebglRendererEnabled(false)
      }
    }
  }, [isActive, setWebglRendererEnabled])

  useEffect(() => {
    if (!isActive) {
      return
    }

    const observer = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        fitAndResize()
      })
    })

    if (hostRef.current) {
      observer.observe(hostRef.current)
    }

    requestAnimationFrame(() => {
      fitAndResize()
      if (autoFocusOnActivate) {
        terminalRef.current?.focus()
      }
    })

    return () => {
      observer.disconnect()
    }
  }, [autoFocusOnActivate, fitAndResize, isActive])

  // Update font size dynamically when settings change
  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    const size = settings?.fontSize ?? 14
    if (terminal.options.fontSize !== size) {
      terminal.options.fontSize = size
      requestAnimationFrame(() => fitAndResize())
    }
  }, [settings?.fontSize, fitAndResize])

  useEffect(() => {
    if (!command || command.sessionId !== session.id) {
      return
    }

    if (command.kind === 'clear') {
      terminalRef.current?.clear()
      terminalRef.current?.focus()
      return
    }

    if (command.kind === 'focus') {
      terminalRef.current?.focus()
      return
    }

    if (command.kind === 'search') {
      startTransition(() => setShowSearch(true))
      return
    }

    fitAndResize()
  }, [command, fitAndResize, session.id])

  useEffect(() => {
    if (showSearch) {
      requestAnimationFrame(() => searchInputRef.current?.focus())
    }
  }, [showSearch])

  function closeSearch() {
    setShowSearch(false)
    setSearchQuery('')
    searchAddonRef.current?.clearDecorations()
    terminalRef.current?.focus()
  }

  return (
    <div
      aria-hidden={!isActive}
      className={cn('terminal-stage', isActive ? 'is-active' : 'is-hidden')}
    >
      <div className="terminal-canvas" ref={hostRef} />
      {showSearch && isActive && (
        <div className="terminal-search-bar">
          <input
            ref={searchInputRef}
            className="terminal-search-input"
            placeholder="Find…"
            type="text"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value)
              searchAddonRef.current?.findNext(e.target.value, { incremental: true })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.stopPropagation(); closeSearch() }
              if (e.key === 'Enter') {
                if (e.shiftKey) {
                  searchAddonRef.current?.findPrevious(searchQuery)
                } else {
                  searchAddonRef.current?.findNext(searchQuery)
                }
              }
            }}
          />
          <button
            aria-label="Previous match"
            className="terminal-search-btn"
            onClick={() => searchAddonRef.current?.findPrevious(searchQuery)}
            title="Previous match (Shift+Enter)"
            type="button"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            aria-label="Next match"
            className="terminal-search-btn"
            onClick={() => searchAddonRef.current?.findNext(searchQuery)}
            title="Next match (Enter)"
            type="button"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            aria-label="Close search"
            className="terminal-search-btn terminal-search-close"
            onClick={closeSearch}
            type="button"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}
