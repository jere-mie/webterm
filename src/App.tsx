import { startTransition, useCallback, useEffect, useRef, useState } from 'react'
import { PanelLeft, Plus, Search, X } from 'lucide-react'
import { io, type Socket } from 'socket.io-client'

import type { SessionMetaPayload, SessionRemovedPayload, SessionSnapshot, SessionState, SocketAck, SpawnSessionPayload } from '../shared/protocol'
import { CommandPalette, type PaletteAction } from './components/command-palette'
import {
  TerminalSurface,
  type TerminalSurfaceCommand,
} from './components/terminal-surface'
import { cn } from './lib/utils'
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
    <div className="app-root">
      {/* Mobile overlay */}
      <div
        aria-hidden={!sidebarOpen}
        className={cn('sidebar-overlay', sidebarOpen && 'is-visible')}
        onClick={() => setSidebarOpen(false)}
      />

      {/* Sidebar */}
      <aside className={cn('sidebar', sidebarOpen && 'is-open')}>
        <div className="sidebar-header">
          <div className="sidebar-brand">
            <span className="sidebar-brand-name">webterm</span>
            <span className={cn('conn-dot', socketState === 'connected' ? 'is-live' : 'is-warn')} />
          </div>
          <button
            aria-label="Close sidebar"
            className="sidebar-close-btn"
            onClick={() => setSidebarOpen(false)}
            type="button"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="sidebar-body">
          {historySessions.length > 0 && (
            <div className="sidebar-section-label">Sessions</div>
          )}
          {historySessions.map((session) => {
            const isActive = session.id === activeSessionId

            return (
              <div className={cn('session-item', isActive && 'is-active')} key={session.id}>
                <button
                  className="session-item-main"
                  onClick={() => {
                    setActiveSessionId(session.id)
                    setSidebarOpen(false)
                  }}
                  type="button"
                >
                  <span className={cn('session-state-dot', `state-${session.state}`)} />
                  <span className="session-item-info">
                    <span className="session-item-title">{session.title}</span>
                    <span className="session-item-path">{session.cwd}</span>
                  </span>
                </button>
                <button
                  aria-label={`Close ${session.title}`}
                  className="session-item-close"
                  onClick={() => void closeSession(session.id)}
                  type="button"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )
          })}
        </div>

        <div className="sidebar-footer">
          <button
            className="new-session-btn"
            onClick={() => void spawnSession()}
            type="button"
          >
            <Plus className="h-3.5 w-3.5" />
            New session
          </button>
        </div>
      </aside>

      {/* Main workspace */}
      <main className="workspace">
        {/* Titlebar with tabs */}
        <div className="workspace-titlebar">
          <button
            aria-label="Open sidebar"
            className="mobile-menu-btn"
            onClick={() => setSidebarOpen(true)}
            type="button"
          >
            <PanelLeft className="h-4 w-4" />
          </button>

          <div className="workspace-tabs" role="tablist">
            {sessions.map((session) => {
              const isActive = session.id === activeSessionId

              return (
                <div
                  aria-selected={isActive}
                  className={cn('workspace-tab', isActive && 'is-active')}
                  key={session.id}
                  role="tab"
                >
                  <button
                    className="workspace-tab-btn"
                    onClick={() => setActiveSessionId(session.id)}
                    type="button"
                  >
                    <span className={cn('tab-state-dot', session.state === 'live' && 'is-live')} />
                    <span className="workspace-tab-title">{session.title}</span>
                  </button>
                  <button
                    aria-label={`Close ${session.title}`}
                    className="workspace-tab-close"
                    onClick={() => void closeSession(session.id)}
                    type="button"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              )
            })}
          </div>

          <div className="workspace-actions">
            <button
              className="action-btn"
              onClick={() => setPaletteOpen(true)}
              type="button"
            >
              <Search className="h-3.5 w-3.5" />
              <span>Command</span>
              <span className="shortcut-chip">⌘K</span>
            </button>
            <button
              className="action-btn"
              onClick={() => void spawnSession()}
              type="button"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Terminal body */}
        <div className="workspace-body">
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
            <div className="boot-screen">
              <div className="boot-screen-title">
                {bootState === 'error' ? 'Connection failed' : 'Starting session…'}
              </div>
              <p className="boot-screen-msg">
                {bootState === 'error'
                  ? errorMessage ?? 'The PTY server did not respond.'
                  : 'Establishing the loopback bridge and preparing your shell environment.'}
              </p>
              {errorMessage && (
                <div className="boot-screen-err">{errorMessage}</div>
              )}
            </div>
          )}
        </div>
      </main>

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
