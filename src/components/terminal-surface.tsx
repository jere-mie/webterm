import { useCallback, useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import type { Socket } from 'socket.io-client'

import type {
  SessionBufferPayload,
  SessionOutputPayload,
  SessionResetPayload,
  SessionSnapshot,
  SocketAck,
} from '../../shared/protocol'
import { cn } from '../lib/utils'
import '@xterm/xterm/css/xterm.css'

export interface TerminalSurfaceCommand {
  sessionId: string
  kind: 'clear' | 'focus' | 'fit'
  nonce: number
}

interface TerminalSurfaceProps {
  command: TerminalSurfaceCommand | null
  session: SessionSnapshot
  socket: Socket
  isActive: boolean
}

export function TerminalSurface({ command, session, socket, isActive }: TerminalSurfaceProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)

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

  useEffect(() => {
    if (!hostRef.current) {
      return
    }

    const terminal = new Terminal({
      allowTransparency: true,
      convertEol: true,
      cursorBlink: true,
      cursorInactiveStyle: 'outline',
      fontFamily: '"JetBrainsMono Nerd Font", "JetBrains Mono", "IBM Plex Mono", monospace',
      fontSize: 14,
      lineHeight: 1.28,
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

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    terminal.loadAddon(fitAddon)

    try {
      terminal.loadAddon(new WebglAddon())
    } catch {
      // Canvas rendering is an acceptable fallback when WebGL is unavailable.
    }

    terminal.open(hostRef.current)
    terminal.writeln('[webterm] attaching to session...')

    // Intercept app-level shortcuts before xterm can swallow them.
    // Returns false → xterm skips this key; the DOM event still fires on window.
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      const isMod = event.ctrlKey || event.metaKey

      if (isMod && event.key.toLowerCase() === 'k') {
        window.dispatchEvent(new CustomEvent('webterm:shortcut', { detail: 'open-palette' }))
        return false
      }
      if (isMod && event.key.toLowerCase() === 'w') {
        window.dispatchEvent(new CustomEvent('webterm:shortcut', { detail: 'close-session' }))
        return false
      }
      if (!isMod && event.shiftKey && event.key.toLowerCase() === 't') {
        window.dispatchEvent(new CustomEvent('webterm:shortcut', { detail: 'new-session' }))
        return false
      }

      return true
    })

    // Refit after the Nerd Font finishes loading to avoid incorrect glyph metrics.
    void document.fonts.load('14px "JetBrainsMono Nerd Font"').then(() => {
      fitAndResize()
    })

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
      inputSubscription.dispose()
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
      terminalRef.current?.focus()
    })

    return () => {
      observer.disconnect()
    }
  }, [fitAndResize, isActive])

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

    fitAndResize()
  }, [command, fitAndResize, session.id])

  return (
    <div
      aria-hidden={!isActive}
      className={cn('terminal-stage', isActive ? 'is-active' : 'is-hidden')}
    >
      <div className="terminal-canvas" ref={hostRef} />
    </div>
  )
}