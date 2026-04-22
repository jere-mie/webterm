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
      fontFamily: 'IBM Plex Mono, monospace',
      fontSize: 14,
      lineHeight: 1.28,
      scrollback: 5000,
      theme: {
        background: '#090a08',
        foreground: '#f7dfb3',
        cursor: '#f8b54c',
        cursorAccent: '#130f0b',
        selectionBackground: 'rgba(247, 191, 96, 0.28)',
        black: '#090a08',
        red: '#ef825d',
        green: '#8acb8d',
        yellow: '#f8b54c',
        blue: '#7ab0ff',
        magenta: '#d1a3ff',
        cyan: '#7dc8c2',
        white: '#f7dfb3',
        brightBlack: '#5f5545',
        brightRed: '#ff9c7a',
        brightGreen: '#b5f1a9',
        brightYellow: '#ffda8a',
        brightBlue: '#9dc3ff',
        brightMagenta: '#e0bcff',
        brightCyan: '#9ce3d9',
        brightWhite: '#fff4da',
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
      <div className="terminal-surface">
        <div className="terminal-topbar">
          <div className="flex items-center gap-4">
            <div className="terminal-stat">
              <span className="edge-label">Session</span>
              <strong>{session.title}</strong>
            </div>
            <div className="terminal-stat">
              <span className="edge-label">Shell</span>
              <strong>{session.shellLabel}</strong>
            </div>
          </div>
          <div className="flex items-center gap-4 text-right">
            <div className="terminal-stat">
              <span className="edge-label">State</span>
              <strong>{session.state}</strong>
            </div>
            <div className="terminal-stat">
              <span className="edge-label">PTY</span>
              <strong>{session.pid}</strong>
            </div>
          </div>
        </div>
        <div className="terminal-canvas">
          <div ref={hostRef} />
        </div>
      </div>
    </div>
  )
}