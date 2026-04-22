import { startTransition, useCallback, useEffect, useRef, useState } from 'react'
import {
  Activity,
  Command as CommandIcon,
  PanelLeft,
  Plus,
  Search,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react'
import { io, type Socket } from 'socket.io-client'

import type { SessionMetaPayload, SessionRemovedPayload, SessionSnapshot, SessionState, SocketAck, SpawnSessionPayload } from '../shared/protocol'
import { CommandPalette, type PaletteAction } from './components/command-palette'
import {
  TerminalSurface,
  type TerminalSurfaceCommand,
} from './components/terminal-surface'
import { Button } from './components/ui/button'
import { cn, compactId, formatClock, formatRelativeTime } from './lib/utils'
import './App.css'

function App() {
  const socketRef = useRef<Socket | null>(null)
  const spawnLockRef = useRef(false)
  const [sessions, setSessions] = useState<SessionSnapshot[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => {
    if (typeof window === 'undefined') {
      return null
    }

    return window.localStorage.getItem('webterm.active-session')
  })
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [socketState, setSocketState] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting')
  const [bootState, setBootState] = useState<'booting' | 'ready' | 'error'>('booting')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [terminalCommand, setTerminalCommand] =
    useState<TerminalSurfaceCommand | null>(null)

  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null
  const historySessions = [...sessions].sort(
    (left, right) => right.lastActiveAt - left.lastActiveAt,
  )
  const sessionCounts = summarizeSessions(sessions)

  const emitWithAck = useCallback(
    async <T,>(eventName: string, payload?: unknown): Promise<T> => {
      const socket = socketRef.current

      if (!socket) {
        throw new Error('WebSocket transport is not ready yet.')
      }

      return new Promise<T>((resolve, reject) => {
        socket.emit(eventName, payload, (ack: SocketAck<T>) => {
          if (ack.ok) {
            resolve(ack.data)
            return
          }

          reject(new Error(ack.error))
        })
      })
    },
    [],
  )

  const spawnSession = useCallback(
    async (payload: SpawnSessionPayload = {}) => {
      try {
        const nextSession = await emitWithAck<SessionSnapshot>('spawn', payload)

        setActiveSessionId(nextSession.id)
        setErrorMessage(null)
        setBootState('ready')

        return nextSession
      } catch (error) {
        setBootState('error')
        setErrorMessage(
          error instanceof Error ? error.message : 'Unable to create a shell session.',
        )
        throw error
      }
    },
    [emitWithAck],
  )

  const restartSession = useCallback(
    async (sessionId: string) => {
      await emitWithAck<SessionSnapshot>('restart-session', { sessionId })
      setErrorMessage(null)
    },
    [emitWithAck],
  )

  const closeSession = useCallback(
    async (sessionId: string) => {
      await emitWithAck('close-session', { sessionId })
      setErrorMessage(null)
    },
    [emitWithAck],
  )

  const handlePaletteAction = useCallback(
    async (action: PaletteAction) => {
      switch (action) {
        case 'new-session':
          await spawnSession()
          return
        case 'duplicate-session':
          if (!activeSession) {
            return
          }

          await spawnSession({
            cwd: activeSession.cwd,
            shell: activeSession.shell,
            title: `${activeSession.title} copy`,
          })
          return
        case 'restart-session':
          if (activeSessionId) {
            await restartSession(activeSessionId)
          }
          return
        case 'clear-terminal':
          if (activeSessionId) {
            issueTerminalCommand(activeSessionId, 'clear')
          }
          return
        case 'close-session':
          if (activeSessionId) {
            await closeSession(activeSessionId)
          }
          return
        case 'toggle-sidebar':
          setSidebarOpen((current) => !current)
          return
        case 'focus-terminal':
          if (activeSessionId) {
            issueTerminalCommand(activeSessionId, 'focus')
          }
          return
      }
    },
    [activeSession, activeSessionId, closeSession, restartSession, spawnSession],
  )

  useEffect(() => {
    const socket = io({
      transports: ['websocket'],
    })

    socketRef.current = socket

    function syncSessionList(nextSessions: SessionSnapshot[]) {
      startTransition(() => {
        setSessions(nextSessions)
        setActiveSessionId((currentActive) => pickActiveSession(currentActive, nextSessions))
      })
      setBootState('ready')
      setErrorMessage(null)

      if (nextSessions.length === 0 && !spawnLockRef.current) {
        spawnLockRef.current = true
        void spawnSession().finally(() => {
          spawnLockRef.current = false
        })
      }
    }

    function upsertSession(nextSession: SessionSnapshot) {
      startTransition(() => {
        setSessions((currentSessions) => {
          const index = currentSessions.findIndex(
            (session) => session.id === nextSession.id,
          )

          if (index === -1) {
            return [...currentSessions, nextSession]
          }

          const updatedSessions = [...currentSessions]

          updatedSessions[index] = nextSession

          return updatedSessions
        })
      })
    }

    function removeSession(sessionId: string) {
      startTransition(() => {
        setSessions((currentSessions) =>
          currentSessions.filter((session) => session.id !== sessionId),
        )
        setActiveSessionId((currentActive) =>
          currentActive === sessionId ? null : currentActive,
        )
      })
    }

    function handleConnect() {
      setSocketState('connected')
      setBootState('ready')
      setErrorMessage(null)
    }

    function handleDisconnect() {
      setSocketState('reconnecting')
    }

    function handleConnectError(error: Error) {
      setSocketState('reconnecting')
      setBootState('error')
      setErrorMessage(error.message)
    }

    function handleSessionList({ sessions: nextSessions }: { sessions: SessionSnapshot[] }) {
      syncSessionList(nextSessions)
    }

    function handleSessionMeta({ session }: SessionMetaPayload) {
      upsertSession(session)
    }

    function handleSessionRemoved({ sessionId }: SessionRemovedPayload) {
      removeSession(sessionId)
    }

    socket.on('connect', handleConnect)
    socket.on('disconnect', handleDisconnect)
    socket.on('connect_error', handleConnectError)
    socket.on('session-list', handleSessionList)
    socket.on('session-meta', handleSessionMeta)
    socket.on('session-removed', handleSessionRemoved)

    return () => {
      socket.off('connect', handleConnect)
      socket.off('disconnect', handleDisconnect)
      socket.off('connect_error', handleConnectError)
      socket.off('session-list', handleSessionList)
      socket.off('session-meta', handleSessionMeta)
      socket.off('session-removed', handleSessionRemoved)
      socket.close()
      socketRef.current = null
    }
  }, [spawnSession])

  useEffect(() => {
    if (!activeSessionId || typeof window === 'undefined') {
      return
    }

    window.localStorage.setItem('webterm.active-session', activeSessionId)
  }, [activeSessionId])

  useEffect(() => {
    function handleKeyboardShortcuts(event: KeyboardEvent) {
      const commandKey = event.ctrlKey || event.metaKey

      if (commandKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen(true)
      }

      if (event.shiftKey && event.key.toLowerCase() === 't') {
        event.preventDefault()
        void spawnSession()
      }

      if (commandKey && event.key.toLowerCase() === 'w' && activeSessionId) {
        event.preventDefault()
        void closeSession(activeSessionId)
      }
    }

    window.addEventListener('keydown', handleKeyboardShortcuts)

    return () => {
      window.removeEventListener('keydown', handleKeyboardShortcuts)
    }
  }, [activeSessionId, closeSession, spawnSession])

  function issueTerminalCommand(
    sessionId: string,
    kind: TerminalSurfaceCommand['kind'],
  ) {
    setTerminalCommand({
      sessionId,
      kind,
      nonce: Date.now(),
    })
  }

  return (
    <div className="relative min-h-screen overflow-hidden">
      <div className="ambient-orb ambient-orb-left"></div>
      <div className="ambient-orb ambient-orb-right"></div>
      <div
        aria-hidden={!sidebarOpen}
        className={cn('sidebar-overlay', sidebarOpen && 'is-visible')}
        onClick={() => setSidebarOpen(false)}
      ></div>

      <div className="mx-auto grid min-h-screen max-w-[1900px] grid-cols-1 gap-4 p-3 xl:grid-cols-[320px_minmax(0,1fr)] xl:p-5">
        <aside className={cn('sidebar-drawer surface-panel flex flex-col gap-4 p-4 xl:p-5', sidebarOpen && 'is-open')}>
          <div className="surface-subpanel p-4">
            <div className="section-kicker">Local Shell Observatory</div>
            <div className="mt-4 flex items-start justify-between gap-4">
              <div>
                <h1 className="display-heading">WebTerm</h1>
                <p className="mt-3 max-w-[28ch] text-sm text-[var(--muted-strong)]">
                  A localhost terminal deck with persistent PTY tabs, a command panel,
                  and a phosphor-lit operator interface.
                </p>
              </div>
              <div className={cn('status-pill', socketState === 'connected' ? 'is-live' : 'is-warn')}>
                <span className="signal-dot"></span>
                {socketState === 'connected' ? 'Link live' : 'Link reacquiring'}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="metric-card">
              <span className="section-kicker">Tabs</span>
              <strong className="metric-value">{sessions.length}</strong>
              <span className="metric-copy">Independent PTY lanes</span>
            </div>
            <div className="metric-card">
              <span className="section-kicker">Live</span>
              <strong className="metric-value">{sessionCounts.live}</strong>
              <span className="metric-copy">Attached or running shells</span>
            </div>
            <div className="metric-card">
              <span className="section-kicker">Detached</span>
              <strong className="metric-value">{sessionCounts.detached}</strong>
              <span className="metric-copy">Buffered after disconnect</span>
            </div>
            <div className="metric-card">
              <span className="section-kicker">Exited</span>
              <strong className="metric-value">{sessionCounts.exited}</strong>
              <span className="metric-copy">Ready to relaunch</span>
            </div>
          </div>

          <div className="surface-subpanel flex min-h-0 flex-1 flex-col p-3">
            <div className="mb-3 flex items-center justify-between gap-3 px-1">
              <span className="section-kicker">Session History</span>
              <span className="text-[0.68rem] uppercase tracking-[0.26em] text-[var(--muted)]">
                {historySessions.length} logs
              </span>
            </div>
            <div className="session-scroll flex min-h-0 flex-col gap-2">
              {historySessions.map((session) => {
                const isActive = session.id === activeSessionId

                return (
                  <button
                    className={cn('history-item', isActive && 'is-active')}
                    key={session.id}
                    onClick={() => {
                      setActiveSessionId(session.id)
                      setSidebarOpen(false)
                    }}
                    type="button"
                  >
                    <div className="history-item__meta">
                      <span>{session.state}</span>
                      <span>{compactId(session.id)}</span>
                    </div>
                    <div className="history-item__title">{session.title}</div>
                    <div className="history-item__path">{session.cwd}</div>
                    <div className="history-item__footer">
                      <span>{session.shellLabel}</span>
                      <span>{formatRelativeTime(session.lastActiveAt)}</span>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="surface-subpanel p-4 text-sm text-[var(--muted-strong)]">
            <div className="section-kicker">Persistence</div>
            <p className="mt-3 leading-6">
              Shell processes stay resident across refreshes and hold for 15 minutes after
              the last browser disconnect before cleanup.
            </p>
          </div>
        </aside>

        <main className="flex min-h-[calc(100vh-1.5rem)] flex-col gap-4">
          <header className="surface-panel p-3 xl:p-4">
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Button
                    aria-label="Toggle session history"
                    className="xl:hidden"
                    onClick={() => setSidebarOpen((current) => !current)}
                    size="icon"
                    variant="ghost"
                  >
                    <PanelLeft className="h-4 w-4" />
                  </Button>
                  <div className="flex items-center gap-3">
                    <div className="flex h-11 w-11 items-center justify-center rounded-full border border-[rgba(242,191,110,0.24)] bg-[rgba(16,15,11,0.65)] text-[var(--accent-bright)]">
                      <Activity className="h-5 w-5" />
                    </div>
                    <div>
                      <div className="section-kicker">Active Circuit</div>
                      <div className="text-lg font-semibold tracking-[0.01em] text-[var(--text-strong)]">
                        {activeSession?.title ?? 'Boot sequence'}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button onClick={() => setPaletteOpen(true)} variant="ghost">
                    <Search className="h-4 w-4" />
                    Command deck
                    <span className="shortcut-chip">Ctrl K</span>
                  </Button>
                  <Button onClick={() => void spawnSession()} variant="primary">
                    <Plus className="h-4 w-4" />
                    New tab
                  </Button>
                </div>
              </div>

              <div className="tab-strip">
                {sessions.map((session) => {
                  const isActive = session.id === activeSessionId

                  return (
                    <div className={cn('tab-shell', isActive && 'is-active')} key={session.id}>
                      <button
                        className="tab-shell__main"
                        onClick={() => setActiveSessionId(session.id)}
                        type="button"
                      >
                        <span className={cn('signal-dot tab-signal', session.state !== 'live' && 'is-dim')}></span>
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {session.title}
                        </span>
                        <span className="tab-shell__meta">{session.shellLabel}</span>
                      </button>
                      <button
                        aria-label={`Close ${session.title}`}
                        className="tab-shell__close"
                        onClick={() => void closeSession(session.id)}
                        type="button"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          </header>

          <section className="surface-panel flex min-h-0 flex-1 flex-col overflow-hidden p-3 xl:p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="hero-badge">Loopback only</span>
                <span className="hero-badge">{activeSession?.shellLabel ?? 'Awaiting shell'}</span>
                <span className="hero-badge">PID {activeSession?.pid ?? '----'}</span>
                <span className="hero-badge">{activeSession?.state ?? 'booting'}</span>
              </div>

              <div className="terminal-info">
                <div>
                  <span>Working directory</span>
                  <strong>{activeSession?.cwd ?? 'Launching session...'}</strong>
                </div>
                <div>
                  <span>Terminal grid</span>
                  <strong>
                    {activeSession ? `${activeSession.cols} x ${activeSession.rows}` : 'warming'}
                  </strong>
                </div>
              </div>
            </div>

            <div className="relative min-h-[540px] flex-1">
              {sessions.length > 0 ? (
                sessions.map((session) => (
                  <TerminalSurface
                    command={terminalCommand}
                    isActive={session.id === activeSessionId}
                    key={session.id}
                    session={session}
                    socket={socketRef.current as Socket}
                  />
                ))
              ) : (
                <div className="boot-panel">
                  <div className="max-w-xl space-y-4 px-6">
                    <div className="section-kicker">Operator Console</div>
                    <h2 className="text-4xl font-semibold tracking-[-0.04em] text-[var(--text-strong)]">
                      Booting the shell matrix.
                    </h2>
                    <p className="mx-auto max-w-lg text-sm leading-7 text-[var(--muted-strong)]">
                      {bootState === 'error'
                        ? errorMessage ?? 'The localhost PTY service did not answer.'
                        : 'The server is establishing the loopback bridge, preparing the PTY buffer, and reconnecting any preserved sessions.'}
                    </p>
                    {errorMessage ? (
                      <div className="status-pill is-warn mx-auto w-fit">
                        <span className="signal-dot"></span>
                        {errorMessage}
                      </div>
                    ) : null}
                  </div>
                </div>
              )}
            </div>
          </section>

          <footer className="surface-panel flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn('status-pill', socketState === 'connected' ? 'is-live' : 'is-warn')}>
                {socketState === 'connected' ? (
                  <Wifi className="h-3.5 w-3.5" />
                ) : (
                  <WifiOff className="h-3.5 w-3.5" />
                )}
                {socketState === 'connected' ? 'Socket synchronized' : 'Reconnecting transport'}
              </span>
              {activeSession ? (
                <span className="status-pill">
                  <CommandIcon className="h-3.5 w-3.5" />
                  Active since {formatClock(activeSession.lastActiveAt)}
                </span>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-2 text-[0.72rem] uppercase tracking-[0.2em] text-[var(--muted)]">
              <span>{sessions.length} tabs</span>
              <span className="utility-divider"></span>
              <span>{sessionCounts.live} live</span>
              <span className="utility-divider"></span>
              <span>{sessionCounts.detached} buffered</span>
              <span className="utility-divider"></span>
              <span>{activeSession ? compactId(activeSession.id) : 'idle'}</span>
            </div>
          </footer>
        </main>
      </div>

      <CommandPalette
        activeSessionId={activeSessionId}
        onAction={(action) => {
          void handlePaletteAction(action)
        }}
        onOpenChange={setPaletteOpen}
        onSelectSession={(sessionId) => {
          setActiveSessionId(sessionId)
          issueTerminalCommand(sessionId, 'focus')
        }}
        open={paletteOpen}
        sessions={sessions}
      />
    </div>
  )
}

export default App

function pickActiveSession(currentActive: string | null, sessions: SessionSnapshot[]) {
  if (currentActive && sessions.some((session) => session.id === currentActive)) {
    return currentActive
  }

  if (typeof window !== 'undefined') {
    const storedSessionId = window.localStorage.getItem('webterm.active-session')

    if (storedSessionId && sessions.some((session) => session.id === storedSessionId)) {
      return storedSessionId
    }
  }

  return sessions.at(-1)?.id ?? null
}

function summarizeSessions(sessions: SessionSnapshot[]) {
  return sessions.reduce(
    (summary, session) => {
      summary[session.state] += 1
      return summary
    },
    {
      live: 0,
      detached: 0,
      exited: 0,
    } as Record<SessionState, number>,
  )
}
