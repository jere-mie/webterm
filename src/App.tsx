import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PanelLeft, Search, Settings, X } from 'lucide-react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { io, type Socket } from 'socket.io-client'

import type { SessionMetaPayload, SessionRemovedPayload, SessionSnapshot, SocketAck, SpawnSessionPayload } from '../shared/protocol'
import { CommandPalette, type PaletteAction } from './components/command-palette'
import { SettingsModal, type AppSettings } from './components/settings-modal'
import {
  TerminalSurface,
  type TerminalSurfaceCommand,
} from './components/terminal-surface'
import { WorkspaceSidebar } from './components/workspace-sidebar'
import { useAppState } from './hooks/useAppState'
import { cn, formatShortcut } from './lib/utils'
import './App.css'

const SIDEBAR_WIDTH_KEY = 'webterm.sidebar-width'
const SETTINGS_KEY = 'webterm.settings'
const SIDEBAR_MIN_WIDTH = 160
const SIDEBAR_MAX_WIDTH = 480
const SIDEBAR_DEFAULT_WIDTH = 248
const MOBILE_SIDEBAR_MEDIA_QUERY = '(max-width: 767px)'

interface SpawnSessionOptions {
  workspaceId?: string
  focus?: boolean
}

interface PendingSpawn {
  sessionId: string
  workspaceId?: string
  focus?: boolean
}

function getInitialSidebarWidth(): number {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_WIDTH_KEY)
    if (stored) {
      return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, parseInt(stored, 10)))
    }
  } catch { /* ok */ }
  return SIDEBAR_DEFAULT_WIDTH
}

const VALID_SHELLS = new Set(['powershell', 'bash', 'zsh', 'cmd', 'git-bash'])

function loadSettings(): AppSettings {
  try {
    const stored = window.localStorage.getItem(SETTINGS_KEY)
    if (stored) {
      const parsed = JSON.parse(stored) as Record<string, unknown>
      if (typeof parsed === 'object' && parsed !== null) {
        const fontSize = Number(parsed.fontSize)
        return {
          cwd: typeof parsed.cwd === 'string' ? parsed.cwd : undefined,
          shell: VALID_SHELLS.has(String(parsed.shell)) ? parsed.shell as AppSettings['shell'] : undefined,
          customShellPath: typeof parsed.customShellPath === 'string' ? parsed.customShellPath : undefined,
          copyOnSelect: parsed.copyOnSelect === true ? true : undefined,
          fontSize: Number.isFinite(fontSize) && fontSize >= 10 && fontSize <= 28 ? fontSize : undefined,
        }
      }
    }
  } catch { /* ok */ }
  return {}
}

// ─── Sortable tab (for tab strip DnD) ────────────────────────────────────────

interface SortableTabProps {
  session: SessionSnapshot
  isActive: boolean
  isBelling: boolean
  onSelect: () => void
  onClose: () => void
}

function SortableTab({ session, isActive, isBelling, onSelect, onClose }: SortableTabProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: session.id,
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }
  return (
    <div
      ref={setNodeRef}
      style={style}
      aria-selected={isActive}
      className={cn('workspace-tab', isActive && 'is-active', isDragging && 'is-dragging', isBelling && 'is-belling')}
      role="tab"
      {...attributes}
      {...listeners}
    >
      <button
        className="workspace-tab-btn"
        onClick={onSelect}
        type="button"
      >
        <span className={cn('tab-state-dot', session.state === 'live' && 'is-live')} />
        <span className="workspace-tab-title">{session.title}</span>
      </button>
      <button
        aria-label={`Close ${session.title} tab`}
        className="workspace-tab-close"
        onClick={(e) => { e.stopPropagation(); onClose() }}
        onPointerDown={(e) => e.stopPropagation()}
        type="button"
        title="Close tab (session stays in sidebar)"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}


function App() {
  const socketRef = useRef<Socket | null>(null)
  const spawnLockRef = useRef(false)
  const pendingSpawnsRef = useRef<PendingSpawn[]>([])
  const [sessions, setSessions] = useState<SessionSnapshot[]>([])
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [socketState, setSocketState] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting')
  const [bootState, setBootState] = useState<'booting' | 'ready' | 'error'>('booting')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [terminalCommand, setTerminalCommand] =
    useState<TerminalSurfaceCommand | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(getInitialSidebarWidth)
  const [renamingWorkspaceId, setRenamingWorkspaceId] = useState<string | null>(null)
  const appSettingsRef = useRef<AppSettings>(loadSettings())
  const [appSettings, setAppSettings] = useState<AppSettings>(() => appSettingsRef.current)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [bellSessions, setBellSessions] = useState<Set<string>>(new Set())
  const bellTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const sessionIds = useMemo(() => sessions.map((s) => s.id), [sessions])

  const {
    workspaces,
    activeWorkspaceId,
    activeWorkspace,
    activeSessionId,
    createWorkspace,
    deleteWorkspace,
    renameWorkspace,
    setActiveWorkspace,
    addSessionToWorkspace,
    removeSession,
    closeTab,
    setActiveSession,
    moveSessionToWorkspace,
    reorderSessionsInWorkspace,
    reorderOpenTabs,
    reorderWorkspaces,
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
    async (
      payload: SpawnSessionPayload = {},
      options?: SpawnSessionOptions,
    ) => {
      try {
        const settings = appSettingsRef.current
        const mergedPayload: SpawnSessionPayload = {
          cwd: settings.cwd || undefined,
          shell: settings.shell || undefined,
          customShellPath: settings.customShellPath || undefined,
          ...payload,
        }
        const nextSession = await emitWithAck<SessionSnapshot>('spawn', mergedPayload)

        pendingSpawnsRef.current.push({
          sessionId: nextSession.id,
          workspaceId: options?.workspaceId,
          focus: options?.focus,
        })
        startTransition(() => {
          setSessions((currentSessions) => {
            if (currentSessions.some((session) => session.id === nextSession.id)) {
              return currentSessions
            }

            return [...currentSessions, nextSession]
          })
        })

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

  useEffect(() => {
    if (pendingSpawnsRef.current.length === 0) {
      return
    }

    const liveSessionIds = new Set(sessions.map((session) => session.id))
    const remainingSpawns: PendingSpawn[] = []

    for (const pendingSpawn of pendingSpawnsRef.current) {
      if (!liveSessionIds.has(pendingSpawn.sessionId)) {
        remainingSpawns.push(pendingSpawn)
        continue
      }

      addSessionToWorkspace(pendingSpawn.sessionId, pendingSpawn.workspaceId)

      if (pendingSpawn.focus !== false) {
        setActiveSession(pendingSpawn.sessionId)
      } else if (pendingSpawn.workspaceId) {
        setActiveWorkspace(pendingSpawn.workspaceId)
      }
    }

    pendingSpawnsRef.current = remainingSpawns
  }, [sessions, addSessionToWorkspace, setActiveSession, setActiveWorkspace])

  const closeSession = useCallback(
    async (sessionId: string) => {
      await emitWithAck('close-session', { sessionId })
      setErrorMessage(null)
    },
    [emitWithAck],
  )

  const renameSession = useCallback(
    async (sessionId: string, title: string) => {
      await emitWithAck('rename-session', { sessionId, title })
    },
    [emitWithAck],
  )

  const handleSaveSettings = useCallback((nextSettings: AppSettings) => {
    appSettingsRef.current = nextSettings
    setAppSettings(nextSettings)
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(nextSettings))
    } catch { /* ok */ }
  }, [])

  const createWorkspaceWithSession = useCallback(async () => {
    const workspaceId = createWorkspace()
    if (
      typeof window !== 'undefined' &&
      window.matchMedia(MOBILE_SIDEBAR_MEDIA_QUERY).matches
    ) {
      setSidebarOpen(true)
    }
    setActiveWorkspace(workspaceId)
    setRenamingWorkspaceId(workspaceId)
    await spawnSession({}, { workspaceId })
    return workspaceId
  }, [createWorkspace, setActiveWorkspace, spawnSession])

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
        case 'clear-terminal':
          if (activeSessionId) issueTerminalCommand(activeSessionId, 'clear')
          return
        case 'hide-from-workspace':
          if (activeSessionId) closeTab(activeSessionId)
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
    [activeSessionId, sessions, closeSession, closeTab, spawnSession],
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

    function handleSessionRemoved(sessionId: string) {
      startTransition(() => {
        setSessions((currentSessions) =>
          currentSessions.filter((session) => session.id !== sessionId),
        )
      })
      removeSession(sessionId)
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
    socket.on('session-removed', ({ sessionId }: SessionRemovedPayload) =>
      handleSessionRemoved(sessionId),
    )

    function handleBell(event: Event) {
      const sessionId = (event as CustomEvent<string>).detail
      if (!sessionId) return
      const timers = bellTimersRef.current
      const prev = timers.get(sessionId)
      if (prev !== undefined) clearTimeout(prev)
      setBellSessions((s) => { const next = new Set(s); next.add(sessionId); return next })
      timers.set(sessionId, setTimeout(() => {
        setBellSessions((s) => { const next = new Set(s); next.delete(sessionId); return next })
        timers.delete(sessionId)
      }, 800))
    }

    window.addEventListener('webterm:bell', handleBell)

    return () => {
      socket.close()
      socketRef.current = null
      window.removeEventListener('webterm:bell', handleBell)
    }
  }, [removeSession, spawnSession])

  useEffect(() => {
    function getAllWorkspaceIds(): string[] {
      return workspaces.map((w) => w.id)
    }

    function handleKeyboardShortcuts(event: KeyboardEvent) {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return

      const hasNonAltModifier = event.ctrlKey || event.metaKey

      if (!event.altKey || hasNonAltModifier) {
        return
      }

      if (!event.shiftKey && event.code === 'KeyK') {
        event.preventDefault()
        setPaletteOpen(true)
        return
      }

      if (!event.shiftKey && event.code === 'KeyN') {
        event.preventDefault()
        void spawnSession()
        return
      }

      if (!event.shiftKey && event.code === 'KeyM') {
        event.preventDefault()
        void createWorkspaceWithSession()
        return
      }

      if (event.shiftKey && event.code === 'KeyW' && activeSessionId) {
        event.preventDefault()
        void closeSession(activeSessionId)
        return
      }

      if (!event.shiftKey && event.code === 'KeyW' && activeSessionId) {
        event.preventDefault()
        closeTab(activeSessionId)
        return
      }

      // Alt+Shift+Arrow: reorder tabs (Left/Right) or workspaces (Up/Down)
      if (event.shiftKey && event.key === 'ArrowLeft') {
        event.preventDefault()
        const tabIds = activeWorkspace?.openSessionIds ?? []
        if (activeSessionId && tabIds.length > 1) {
          const currentIdx = tabIds.indexOf(activeSessionId)
          if (currentIdx !== -1) {
            const newIdx = (currentIdx - 1 + tabIds.length) % tabIds.length
            if (activeWorkspaceId) reorderOpenTabs(activeWorkspaceId, arrayMove(tabIds, currentIdx, newIdx))
          }
        }
        return
      }

      if (event.shiftKey && event.key === 'ArrowRight') {
        event.preventDefault()
        const tabIds = activeWorkspace?.openSessionIds ?? []
        if (activeSessionId && tabIds.length > 1) {
          const currentIdx = tabIds.indexOf(activeSessionId)
          if (currentIdx !== -1) {
            const newIdx = (currentIdx + 1) % tabIds.length
            if (activeWorkspaceId) reorderOpenTabs(activeWorkspaceId, arrayMove(tabIds, currentIdx, newIdx))
          }
        }
        return
      }

      if (event.shiftKey && event.key === 'ArrowUp') {
        event.preventDefault()
        const allWsIds = getAllWorkspaceIds()
        if (allWsIds.length > 1) {
          const currentIdx = allWsIds.indexOf(activeWorkspaceId ?? '')
          if (currentIdx !== -1) {
            const newIdx = (currentIdx - 1 + allWsIds.length) % allWsIds.length
            reorderWorkspaces(arrayMove(allWsIds, currentIdx, newIdx))
          }
        }
        return
      }

      if (event.shiftKey && event.key === 'ArrowDown') {
        event.preventDefault()
        const allWsIds = getAllWorkspaceIds()
        if (allWsIds.length > 1) {
          const currentIdx = allWsIds.indexOf(activeWorkspaceId ?? '')
          if (currentIdx !== -1) {
            const newIdx = (currentIdx + 1) % allWsIds.length
            reorderWorkspaces(arrayMove(allWsIds, currentIdx, newIdx))
          }
        }
        return
      }

      if (event.shiftKey) {
        return
      }

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
        const tabIds = activeWorkspace?.openSessionIds ?? []
        if (tabIds.length === 0) return
        const currentIdx = tabIds.indexOf(activeSessionId ?? '')
        const delta = event.key === 'ArrowRight' ? 1 : -1
        setActiveSession(tabIds[(currentIdx + delta + tabIds.length) % tabIds.length])
      }
    }

    function handleXtermShortcut(event: Event) {
      const detail = (event as CustomEvent<string>).detail
      const allWsIds = workspaces.map((w) => w.id)

      switch (detail) {
        case 'open-palette':
          setPaletteOpen(true)
          break
        case 'new-session':
          void spawnSession()
          break
        case 'new-workspace':
          void createWorkspaceWithSession()
          break
        case 'kill-session':
          if (activeSessionId) {
            void closeSession(activeSessionId)
          }
          break
        case 'hide-from-workspace':
          if (activeSessionId) closeTab(activeSessionId)
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
          const tabIds = activeWorkspace?.openSessionIds ?? []
          if (tabIds.length === 0) break
          const idx = tabIds.indexOf(activeSessionId ?? '')
          setActiveSession(tabIds[(idx - 1 + tabIds.length) % tabIds.length])
          break
        }
        case 'alt-next-tab': {
          const tabIds = activeWorkspace?.openSessionIds ?? []
          if (tabIds.length === 0) break
          const idx = tabIds.indexOf(activeSessionId ?? '')
          setActiveSession(tabIds[(idx + 1) % tabIds.length])
          break
        }
        case 'alt-shift-prev-tab': {
          const tabIds = activeWorkspace?.openSessionIds ?? []
          if (!activeSessionId || tabIds.length <= 1) break
          const idx = tabIds.indexOf(activeSessionId)
          if (idx === -1) break
          const newIdx = (idx - 1 + tabIds.length) % tabIds.length
          if (activeWorkspaceId) reorderOpenTabs(activeWorkspaceId, arrayMove(tabIds, idx, newIdx))
          break
        }
        case 'alt-shift-next-tab': {
          const tabIds = activeWorkspace?.openSessionIds ?? []
          if (!activeSessionId || tabIds.length <= 1) break
          const idx = tabIds.indexOf(activeSessionId)
          if (idx === -1) break
          const newIdx = (idx + 1) % tabIds.length
          if (activeWorkspaceId) reorderOpenTabs(activeWorkspaceId, arrayMove(tabIds, idx, newIdx))
          break
        }
        case 'alt-shift-prev-workspace': {
          if (allWsIds.length <= 1) break
          const idx = allWsIds.indexOf(activeWorkspaceId ?? '')
          if (idx === -1) break
          const newIdx = (idx - 1 + allWsIds.length) % allWsIds.length
          reorderWorkspaces(arrayMove(allWsIds, idx, newIdx))
          break
        }
        case 'alt-shift-next-workspace': {
          if (allWsIds.length <= 1) break
          const idx = allWsIds.indexOf(activeWorkspaceId ?? '')
          if (idx === -1) break
          const newIdx = (idx + 1) % allWsIds.length
          reorderWorkspaces(arrayMove(allWsIds, idx, newIdx))
          break
        }
        case 'search':
          if (activeSessionId) issueTerminalCommand(activeSessionId, 'search')
          break
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
    workspaces,
    closeSession,
    closeTab,
    createWorkspaceWithSession,
    reorderOpenTabs,
    reorderWorkspaces,
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

  // Tab strip: only open sessions in the active workspace, with DnD
  const openTabIds = activeWorkspace?.openSessionIds ?? []
  const workspaceTabs = openTabIds
    .map((id) => sessions.find((s) => s.id === id))
    .filter(Boolean) as SessionSnapshot[]

  const tabSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  )

  function handleTabDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id || !activeWorkspaceId) return
    const oldIdx = openTabIds.indexOf(active.id as string)
    const newIdx = openTabIds.indexOf(over.id as string)
    if (oldIdx !== -1 && newIdx !== -1) {
      reorderOpenTabs(activeWorkspaceId, arrayMove(openTabIds, oldIdx, newIdx))
    }
  }

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
          sessions={sessions}
          activeWorkspaceId={activeWorkspaceId}
          activeSessionId={activeSessionId}
          renamingWorkspaceId={renamingWorkspaceId}
          onRenamingWorkspaceChange={setRenamingWorkspaceId}
          onSelectWorkspace={setActiveWorkspace}
          onDeleteWorkspace={deleteWorkspace}
          onRenameWorkspace={renameWorkspace}
          onCreateWorkspace={() => {
            void createWorkspaceWithSession()
          }}
          onSelectSession={(id) => {
            setActiveSession(id)
            setSidebarOpen(false)
          }}
          onKillSession={(id) => void closeSession(id)}
          onCloseTab={closeTab}
          onRenameSession={(id, title) => void renameSession(id, title)}
          onNewSession={(workspaceId) =>
            void spawnSession({}, workspaceId ? { workspaceId } : undefined)
          }
          onReorderWorkspaces={reorderWorkspaces}
          onReorderSessionsInWorkspace={reorderSessionsInWorkspace}
          onMoveSessionToWorkspace={moveSessionToWorkspace}
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

          {/* Tab strip — only shows open sessions in the active workspace */}
          <DndContext
            sensors={tabSensors}
            collisionDetection={closestCenter}
            onDragEnd={handleTabDragEnd}
          >
            <SortableContext items={openTabIds} strategy={horizontalListSortingStrategy}>
              <div className="workspace-tabs" role="tablist">
                {workspaceTabs.map((session) => (
                  <SortableTab
                    key={session.id}
                    session={session}
                    isActive={session.id === activeSessionId}
                    isBelling={bellSessions.has(session.id)}
                    onSelect={() => setActiveSession(session.id)}
                    onClose={() => closeTab(session.id)}
                  />
                ))}
              </div>
            </SortableContext>
            <DragOverlay dropAnimation={null}>
              {null}
            </DragOverlay>
          </DndContext>

          <div className="workspace-actions">
            <button
              className="action-btn"
              onClick={() => setPaletteOpen(true)}
              type="button"
            >
              <Search className="h-3.5 w-3.5" />
              <span>Command</span>
              <span className="shortcut-chip">{formatShortcut(['Alt', 'K'])}</span>
            </button>
            <button
              aria-label="Settings"
              className="action-btn action-btn-icon"
              onClick={() => setSettingsOpen(true)}
              type="button"
            >
              <Settings className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Terminal body — ALL sessions stay mounted to keep PTY alive */}
        <div className="workspace-body">
          {sessions.length > 0 ? (
            sessions.map((session) => (
              <TerminalSurface
                autoFocusOnActivate={renamingWorkspaceId === null}
                command={terminalCommand}
                isActive={session.id === activeSessionId}
                key={session.id}
                session={session}
                settings={appSettings}
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

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={appSettings}
        onSave={handleSaveSettings}
      />
    </div>
  )
}

export default App
