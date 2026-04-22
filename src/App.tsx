import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'

const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)
import { PanelLeft, Plus, Search, X } from 'lucide-react'
import { io, type Socket } from 'socket.io-client'

import type { SessionMetaPayload, SessionRemovedPayload, SessionSnapshot, SocketAck, SpawnSessionPayload } from '../shared/protocol'
import { CommandPalette, type PaletteAction } from './components/command-palette'
import {
  TerminalSurface,
  type TerminalSurfaceCommand,
} from './components/terminal-surface'
import { WorkspaceSidebar } from './components/workspace-sidebar'
import { useAppState } from './hooks/useAppState'
import { cn } from './lib/utils'
import './App.css'

const SIDEBAR_WIDTH_KEY = 'webterm.sidebar-width'
const SIDEBAR_MIN_WIDTH = 160
const SIDEBAR_MAX_WIDTH = 480
const SIDEBAR_DEFAULT_WIDTH = 248

function getInitialSidebarWidth(): number {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_WIDTH_KEY)
    if (stored) {
      return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, parseInt(stored, 10)))
    }
  } catch { /* ok */ }
  return SIDEBAR_DEFAULT_WIDTH
}

function App() {
  const socketRef = useRef<Socket | null>(null)
  const spawnLockRef = useRef(false)
  const [sessions, setSessions] = useState<SessionSnapshot[]>([])
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [socketState, setSocketState] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting')
  const [bootState, setBootState] = useState<'booting' | 'ready' | 'error'>('booting')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [terminalCommand, setTerminalCommand] =
    useState<TerminalSurfaceCommand | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(getInitialSidebarWidth)

  const sessionIds = useMemo(() => sessions.map((s) => s.id), [sessions])

  const {
    workspaces,
    sidebarItems,
    activeWorkspaceId,
    activeWorkspace,
    activeSessionId,
    backgroundSessionIds,
    createWorkspace,
    deleteWorkspace,
    renameWorkspace,
    setActiveWorkspace,
    addSessionToWorkspace,
    hideSessionFromWorkspace,
    setActiveSession,
    createFolder,
    renameFolder,
    deleteFolder,
    toggleFolder,
    reorderSidebarItems,
    reorderWorkspacesInFolder,
    moveWorkspaceToFolder,
  } = useAppState(sessionIds)

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

        addSessionToWorkspace(nextSession.id)
        setActiveSession(nextSession.id)
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
    [emitWithAck, addSessionToWorkspace, setActiveSession],
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
      const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null
      switch (action) {
        case 'new-session':
          await spawnSession()
          return
        case 'duplicate-session':
          if (!activeSession) return
          await spawnSession({
            cwd: activeSession.cwd,
            shell: activeSession.shell,
            title: `${activeSession.title} copy`,
          })
          return
        case 'restart-session':
          if (activeSessionId) await restartSession(activeSessionId)
          return
        case 'clear-terminal':
          if (activeSessionId) issueTerminalCommand(activeSessionId, 'clear')
          return
        case 'hide-from-workspace':
          if (activeSessionId) hideSessionFromWorkspace(activeSessionId)
          return
        case 'kill-session':
          if (activeSessionId) await closeSession(activeSessionId)
          return
        case 'toggle-sidebar':
          setSidebarOpen((current) => !current)
          return
        case 'focus-terminal':
          if (activeSessionId) issueTerminalCommand(activeSessionId, 'focus')
          return
      }
    },
    [activeSessionId, sessions, closeSession, hideSessionFromWorkspace, restartSession, spawnSession],
  )

  useEffect(() => {
    const socket = io({
      transports: ['websocket'],
    })

    socketRef.current = socket

    function syncSessionList(nextSessions: SessionSnapshot[]) {
      startTransition(() => {
        setSessions(nextSessions)
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
      })
    }

    socket.on('connect', () => {
      setSocketState('connected')
      setBootState('ready')
      setErrorMessage(null)
    })
    socket.on('disconnect', () => setSocketState('reconnecting'))
    socket.on('connect_error', (error: Error) => {
      setSocketState('reconnecting')
      setBootState('error')
      setErrorMessage(error.message)
    })
    socket.on('session-list', ({ sessions: nextSessions }: { sessions: SessionSnapshot[] }) => {
      syncSessionList(nextSessions)
    })
    socket.on('session-meta', ({ session }: SessionMetaPayload) => upsertSession(session))
    socket.on('session-removed', ({ sessionId }: SessionRemovedPayload) => removeSession(sessionId))

    return () => {
      socket.close()
      socketRef.current = null
    }
  }, [spawnSession])

  // Keyboard shortcuts including Alt+Up/Down (workspaces) and Alt+Left/Right (tabs)
  useEffect(() => {
    function getAllWorkspaceIds(): string[] {
      const ids: string[] = []
      for (const item of sidebarItems) {
        if (item.type === 'workspace') ids.push(item.workspaceId)
        else ids.push(...item.workspaceIds)
      }
      return ids
    }

    function handleKeyboardShortcuts(event: KeyboardEvent) {
      const commandKey = event.ctrlKey || event.metaKey

      if (commandKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen(true)
      }

      if (event.shiftKey && !commandKey && event.key.toLowerCase() === 't') {
        event.preventDefault()
        void spawnSession()
      }

      if (commandKey && event.key.toLowerCase() === 'w' && activeSessionId) {
        event.preventDefault()
        hideSessionFromWorkspace(activeSessionId)
      }

      if (event.altKey && !commandKey) {
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault()
          const allWsIds = getAllWorkspaceIds()
          if (allWsIds.length === 0) return
          const currentIdx = allWsIds.indexOf(activeWorkspaceId ?? '')
          const delta = event.key === 'ArrowDown' ? 1 : -1
          setActiveWorkspace(allWsIds[(currentIdx + delta + allWsIds.length) % allWsIds.length])
          return
        }

        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          const tabIds = activeWorkspace?.sessionIds ?? []
          if (tabIds.length === 0) return
          const currentIdx = tabIds.indexOf(activeSessionId ?? '')
          const delta = event.key === 'ArrowRight' ? 1 : -1
          setActiveSession(tabIds[(currentIdx + delta + tabIds.length) % tabIds.length])
          return
        }
      }
    }

    function handleXtermShortcut(event: Event) {
      const detail = (event as CustomEvent<string>).detail
      const allWsIds = (() => {
        const ids: string[] = []
        for (const item of sidebarItems) {
          if (item.type === 'workspace') ids.push(item.workspaceId)
          else ids.push(...item.workspaceIds)
        }
        return ids
      })()

      switch (detail) {
        case 'open-palette':
          setPaletteOpen(true)
          break
        case 'new-session':
          void spawnSession()
          break
        case 'hide-from-workspace':
          if (activeSessionId) hideSessionFromWorkspace(activeSessionId)
          break
        case 'alt-prev-workspace': {
          if (allWsIds.length === 0) break
          const idx = allWsIds.indexOf(activeWorkspaceId ?? '')
          setActiveWorkspace(allWsIds[(idx - 1 + allWsIds.length) % allWsIds.length])
          break
        }
        case 'alt-next-workspace': {
          if (allWsIds.length === 0) break
          const idx = allWsIds.indexOf(activeWorkspaceId ?? '')
          setActiveWorkspace(allWsIds[(idx + 1) % allWsIds.length])
          break
        }
        case 'alt-prev-tab': {
          const tabIds = activeWorkspace?.sessionIds ?? []
          if (tabIds.length === 0) break
          const idx = tabIds.indexOf(activeSessionId ?? '')
          setActiveSession(tabIds[(idx - 1 + tabIds.length) % tabIds.length])
          break
        }
        case 'alt-next-tab': {
          const tabIds = activeWorkspace?.sessionIds ?? []
          if (tabIds.length === 0) break
          const idx = tabIds.indexOf(activeSessionId ?? '')
          setActiveSession(tabIds[(idx + 1) % tabIds.length])
          break
        }
      }
    }

    window.addEventListener('keydown', handleKeyboardShortcuts)
    window.addEventListener('webterm:shortcut', handleXtermShortcut)

    return () => {
      window.removeEventListener('keydown', handleKeyboardShortcuts)
      window.removeEventListener('webterm:shortcut', handleXtermShortcut)
    }
  }, [
    activeSessionId,
    activeWorkspaceId,
    activeWorkspace,
    sidebarItems,
    hideSessionFromWorkspace,
    setActiveSession,
    setActiveWorkspace,
    spawnSession,
  ])

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

  function handleResizerPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = sidebarWidth
    let lastWidth = startWidth

    function onMove(e: PointerEvent) {
      lastWidth = Math.min(
        SIDEBAR_MAX_WIDTH,
        Math.max(SIDEBAR_MIN_WIDTH, startWidth + (e.clientX - startX)),
      )
      setSidebarWidth(lastWidth)
    }

    function onUp() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      try {
        window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(lastWidth))
      } catch { /* ok */ }
      window.dispatchEvent(new Event('webterm:refit'))
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // Tab strip: only sessions belonging to the active workspace
  const workspaceTabs = (activeWorkspace?.sessionIds ?? [])
    .map((id) => sessions.find((s) => s.id === id))
    .filter(Boolean) as SessionSnapshot[]

  return (
    <div
      className="app-root"
      style={{ '--sidebar-w': `${sidebarWidth}px` } as React.CSSProperties}
    >
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

        <WorkspaceSidebar
          workspaces={workspaces}
          sidebarItems={sidebarItems}
          sessions={sessions}
          activeWorkspaceId={activeWorkspaceId}
          activeSessionId={activeSessionId}
          backgroundSessionIds={backgroundSessionIds}
          socketConnected={socketState === 'connected'}
          onSelectWorkspace={setActiveWorkspace}
          onDeleteWorkspace={deleteWorkspace}
          onRenameWorkspace={renameWorkspace}
          onCreateWorkspace={() => {
            const id = createWorkspace()
            setActiveWorkspace(id)
          }}
          onCreateFolder={createFolder}
          onRenameFolder={renameFolder}
          onDeleteFolder={deleteFolder}
          onToggleFolder={toggleFolder}
          onReorderSidebarItems={reorderSidebarItems}
          onReorderWorkspacesInFolder={reorderWorkspacesInFolder}
          onMoveWorkspaceToFolder={moveWorkspaceToFolder}
          onSelectSession={(id) => {
            setActiveSession(id)
            setSidebarOpen(false)
          }}
          onKillSession={(id) => void closeSession(id)}
          onAddBackgroundSession={(id) => addSessionToWorkspace(id)}
          onNewSession={() => void spawnSession()}
        />
      </aside>

      {/* Draggable sidebar resize handle */}
      <div className="sidebar-resizer" onPointerDown={handleResizerPointerDown} />

      {/* Main workspace */}
      <main className="workspace">
        {/* Titlebar */}
        <div className="workspace-titlebar">
          <button
            aria-label="Open sidebar"
            className="mobile-menu-btn"
            onClick={() => setSidebarOpen(true)}
            type="button"
          >
            <PanelLeft className="h-4 w-4" />
          </button>

          {activeWorkspace && (
            <div className="workspace-name-label">{activeWorkspace.name}</div>
          )}

          {/* Tab strip — only shows sessions in the active workspace */}
          <div className="workspace-tabs" role="tablist">
            {workspaceTabs.map((session) => {
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
                    onClick={() => setActiveSession(session.id)}
                    type="button"
                  >
                    <span className={cn('tab-state-dot', session.state === 'live' && 'is-live')} />
                    <span className="workspace-tab-title">{session.title}</span>
                  </button>
                  <button
                    aria-label={`Hide ${session.title} from workspace`}
                    className="workspace-tab-close"
                    onClick={() => hideSessionFromWorkspace(session.id)}
                    type="button"
                    title="Hide from workspace (PTY keeps running)"
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
              <span className="shortcut-chip">{isMac ? '⌘K' : 'Ctrl K'}</span>
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

        {/* Terminal body — ALL sessions stay mounted to keep PTY alive */}
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
          setActiveSession(sessionId)
          issueTerminalCommand(sessionId, 'focus')
        }}
        open={paletteOpen}
        sessions={sessions}
      />
    </div>
  )
}

export default App
