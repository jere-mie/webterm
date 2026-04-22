import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ChevronDown, ChevronRight, Layers, Plus, X } from 'lucide-react'

import type { SessionSnapshot } from '../../shared/protocol'
import type { Workspace } from '../hooks/useAppState'
import { cn, formatShortcut } from '../lib/utils'

interface DragData {
  type: 'workspace' | 'session'
  workspaceId: string
  sessionId?: string
}

interface CtxMenu {
  type: 'session' | 'workspace'
  id: string
  workspaceId: string
  isOpen: boolean
  x: number
  y: number
}

interface WorkspaceSidebarProps {
  workspaces: Workspace[]
  sessions: SessionSnapshot[]
  activeWorkspaceId: string | null
  activeSessionId: string | null
  renamingWorkspaceId: string | null
  onRenamingWorkspaceChange: (workspaceId: string | null) => void
  onSelectWorkspace: (workspaceId: string) => void
  onDeleteWorkspace: (workspaceId: string) => void
  onRenameWorkspace: (workspaceId: string, name: string) => void
  onCreateWorkspace: () => void
  onSelectSession: (sessionId: string) => void
  onKillSession: (sessionId: string) => void
  onCloseTab: (sessionId: string) => void
  onRenameSession: (sessionId: string, title: string) => void
  onNewSession: (workspaceId?: string) => void
  onReorderWorkspaces: (newWorkspaceIds: string[]) => void
  onReorderSessionsInWorkspace: (
    workspaceId: string,
    newSessionIds: string[],
  ) => void
  onMoveSessionToWorkspace: (
    sessionId: string,
    targetWorkspaceId: string,
    atIndex?: number,
  ) => void
}

function sessionMap(sessions: SessionSnapshot[]): Map<string, SessionSnapshot> {
  const map = new Map<string, SessionSnapshot>()

  for (const session of sessions) {
    map.set(session.id, session)
  }

  return map
}

function worstState(
  sessionIds: string[],
  map: Map<string, SessionSnapshot>,
): 'live' | 'detached' | 'exited' | null {
  let hasExited = false
  let hasDetached = false
  let hasLive = false

  for (const sessionId of sessionIds) {
    const session = map.get(sessionId)

    if (!session) {
      continue
    }

    if (session.state === 'exited') {
      hasExited = true
    } else if (session.state === 'detached') {
      hasDetached = true
    } else if (session.state === 'live') {
      hasLive = true
    }
  }

  if (hasExited) {
    return 'exited'
  }

  if (hasDetached) {
    return 'detached'
  }

  if (hasLive) {
    return 'live'
  }

  return null
}

interface SessionRowProps {
  session: SessionSnapshot | undefined
  sessionId: string
  workspaceId: string
  isActiveSession: boolean
  isOpen: boolean
  isRenaming: boolean
  isDragOverlay?: boolean
  onSelect: () => void
  onKill: () => void
  onRenameCommit: (title: string) => void
  onRenameCancel: () => void
  onContextMenu: (event: React.MouseEvent) => void
}

function SessionRow({
  session,
  sessionId,
  workspaceId,
  isActiveSession,
  isOpen,
  isRenaming,
  isDragOverlay = false,
  onSelect,
  onKill,
  onRenameCommit,
  onRenameCancel,
  onContextMenu,
}: SessionRowProps) {
  const renameInputRef = useRef<HTMLInputElement>(null)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({
      id: sessionId,
      data: { type: 'session', sessionId, workspaceId } satisfies DragData,
    })

  useEffect(() => {
    if (!isRenaming) {
      return
    }

    requestAnimationFrame(() => {
      renameInputRef.current?.select()
    })
  }, [isRenaming])

  function commitRename() {
    const trimmed = renameInputRef.current?.value.trim() ?? ''

    if (trimmed) {
      onRenameCommit(trimmed)
      return
    }

    onRenameCancel()
  }

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.3 : 1,
      }}
      className={cn(
        'ws-session-item',
        isActiveSession && 'is-active',
        !isOpen && 'is-closed',
        isDragOverlay && 'is-drag-overlay',
      )}
      {...attributes}
      {...listeners}
      onContextMenu={onContextMenu}
    >
      {isRenaming ? (
        <input
          ref={renameInputRef}
          key={`${sessionId}:${session?.title ?? sessionId}`}
          autoFocus
          className="ws-rename-input ws-session-rename-input"
          defaultValue={session?.title ?? sessionId}
          id={`session-rename-${sessionId}`}
          name={`session-rename-${sessionId}`}
          onBlur={commitRename}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commitRename()
            }

            if (event.key === 'Escape') {
              onRenameCancel()
            }

            event.stopPropagation()
          }}
        />
      ) : (
        <>
          <button
            className="ws-session-main"
            onClick={onSelect}
            type="button"
          >
            <span
              className={cn(
                'session-state-dot',
                session ? `state-${session.state}` : 'state-exited',
              )}
            />
            <span className="ws-session-info">
              <span className="ws-session-title">{session?.title ?? sessionId}</span>
              <span className="ws-session-path">{session?.cwd ?? ''}</span>
            </span>
          </button>
          <button
            aria-label={`Kill ${session?.title ?? sessionId}`}
            className="ws-session-kill"
            onClick={onKill}
            onPointerDown={(event) => event.stopPropagation()}
            title={`Kill session (${formatShortcut(['Alt', 'Shift', 'W'])})`}
            type="button"
          >
            <X className="h-3 w-3" />
          </button>
        </>
      )}
    </div>
  )
}

interface WorkspaceRowProps {
  workspace: Workspace
  sMap: Map<string, SessionSnapshot>
  isActive: boolean
  activeSessionId: string | null
  isRenaming: boolean
  isDragOverlay?: boolean
  renamingSessionId: string | null
  onSelect: () => void
  onDelete: () => void
  onNewSession: () => void
  onStartRename: () => void
  onRenameCommit: (name: string) => void
  onRenameCancel: () => void
  onSelectSession: (sessionId: string) => void
  onKillSession: (sessionId: string) => void
  onSessionRenameCommit: (sessionId: string, title: string) => void
  onSessionRenameCancel: () => void
  onContextMenu: (event: React.MouseEvent) => void
  onSessionContextMenu: (event: React.MouseEvent, sessionId: string) => void
}

function WorkspaceRow({
  workspace,
  sMap,
  isActive,
  activeSessionId,
  isRenaming,
  isDragOverlay = false,
  renamingSessionId,
  onSelect,
  onDelete,
  onNewSession,
  onStartRename,
  onRenameCommit,
  onRenameCancel,
  onSelectSession,
  onKillSession,
  onSessionRenameCommit,
  onSessionRenameCancel,
  onContextMenu,
  onSessionContextMenu,
}: WorkspaceRowProps) {
  const [expanded, setExpanded] = useState(true)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: `ws:${workspace.id}`,
    data: { type: 'workspace', workspaceId: workspace.id } satisfies DragData,
  })

  useEffect(() => {
    if (!isRenaming) {
      return
    }

    requestAnimationFrame(() => {
      renameInputRef.current?.select()
    })
  }, [isRenaming])

  function commitRename() {
    const trimmed = renameInputRef.current?.value.trim() ?? ''

    if (trimmed) {
      onRenameCommit(trimmed)
      return
    }

    onRenameCancel()
  }

  const workspaceState = worstState(workspace.sessionIds, sMap)

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.3 : 1,
      }}
      className={cn('ws-item', isActive && 'is-active', isDragOverlay && 'is-drag-overlay')}
    >
      <div
        ref={setActivatorNodeRef}
        className={cn('ws-item-header', isActive && 'is-active', isRenaming && 'is-renaming')}
        {...attributes}
        {...listeners}
        onContextMenu={onContextMenu}
      >
        <button
          className="ws-item-toggle"
          onClick={() => setExpanded((current) => !current)}
          onPointerDown={(event) => event.stopPropagation()}
          tabIndex={-1}
          type="button"
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>

        {isRenaming ? (
          <input
            ref={renameInputRef}
            key={`${workspace.id}:${workspace.name}`}
            autoFocus
            className="ws-rename-input ws-workspace-rename-input"
            defaultValue={workspace.name}
            id={`workspace-rename-${workspace.id}`}
            name={`workspace-rename-${workspace.id}`}
            onBlur={commitRename}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commitRename()
              }

              if (event.key === 'Escape') {
                onRenameCancel()
              }

              event.stopPropagation()
            }}
          />
        ) : (
          <button
            className="ws-item-name"
            onClick={onSelect}
            onDoubleClick={onStartRename}
            type="button"
          >
            <Layers className="h-3.5 w-3.5 ws-icon" />
            <span className="ws-item-name-text">{workspace.name}</span>
            {workspace.sessionIds.length > 0 && (
              <span className="ws-session-count">{workspace.sessionIds.length}</span>
            )}
          </button>
        )}

        {workspaceState && <span className={cn('ws-state-dot', `state-${workspaceState}`)} />}

        <button
          aria-label={`Create a new session in ${workspace.name}`}
          className="ws-new-session-btn"
          onClick={onNewSession}
          onPointerDown={(event) => event.stopPropagation()}
          title={`New session in ${workspace.name} (${formatShortcut(['Alt', 'N'])})`}
          type="button"
        >
          <Plus className="h-3 w-3" />
        </button>
        <button
          aria-label={`Delete ${workspace.name}`}
          className="ws-delete-btn"
          onClick={onDelete}
          onPointerDown={(event) => event.stopPropagation()}
          type="button"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      {expanded && !isDragOverlay && (
        <SortableContext items={workspace.sessionIds} strategy={verticalListSortingStrategy}>
          <div className="ws-sessions">
            {workspace.sessionIds.map((sessionId) => (
              <SessionRow
                key={sessionId}
                session={sMap.get(sessionId)}
                sessionId={sessionId}
                workspaceId={workspace.id}
                isActiveSession={sessionId === activeSessionId}
                isOpen={workspace.openSessionIds.includes(sessionId)}
                isRenaming={renamingSessionId === sessionId}
                onSelect={() => onSelectSession(sessionId)}
                onKill={() => onKillSession(sessionId)}
                onRenameCommit={(title) => onSessionRenameCommit(sessionId, title)}
                onRenameCancel={onSessionRenameCancel}
                onContextMenu={(event) => onSessionContextMenu(event, sessionId)}
              />
            ))}
            {workspace.sessionIds.length === 0 && (
              <div className="ws-empty-hint">
                No sessions — use the + button or press {formatShortcut(['Alt', 'N'])}
              </div>
            )}
          </div>
        </SortableContext>
      )}
    </div>
  )
}

interface ContextMenuProps {
  menu: CtxMenu
  onClose: () => void
  onStartRename: () => void
  onStartSessionRename: () => void
  onSelectSession: (sessionId: string) => void
  onCloseTab: (sessionId: string) => void
  onKillSession: (sessionId: string) => void
  onDeleteWorkspace: (workspaceId: string) => void
  onNewSessionInWorkspace: () => void
}

function ContextMenu({
  menu,
  onClose,
  onStartRename,
  onStartSessionRename,
  onSelectSession,
  onCloseTab,
  onKillSession,
  onDeleteWorkspace,
  onNewSessionInWorkspace,
}: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleMouseDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onClose()
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  function item(label: string, action: () => void, danger = false) {
    return (
      <button
        key={label}
        className={cn('ctx-menu-item', danger && 'danger')}
        onClick={() => {
          action()
          onClose()
        }}
        onPointerDown={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
        type="button"
      >
        {label}
      </button>
    )
  }

  return createPortal(
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left: menu.x, position: 'fixed', top: menu.y, zIndex: 9999 }}
    >
      {menu.type === 'session' ? (
        <>
          {item('Rename', onStartSessionRename)}
          {menu.isOpen
            ? item('Close tab', () => onCloseTab(menu.id))
            : item('Open as tab', () => onSelectSession(menu.id))}
          <div className="ctx-menu-sep" />
          {item('Kill session', () => onKillSession(menu.id), true)}
        </>
      ) : (
        <>
          {item('Rename', onStartRename)}
          {item('New session here', onNewSessionInWorkspace)}
          <div className="ctx-menu-sep" />
          {item('Delete workspace', () => onDeleteWorkspace(menu.id), true)}
        </>
      )}
    </div>,
    document.body,
  )
}

export function WorkspaceSidebar({
  workspaces,
  sessions,
  activeWorkspaceId,
  activeSessionId,
  renamingWorkspaceId,
  onRenamingWorkspaceChange,
  onSelectWorkspace,
  onDeleteWorkspace,
  onRenameWorkspace,
  onCreateWorkspace,
  onSelectSession,
  onKillSession,
  onCloseTab,
  onRenameSession,
  onNewSession,
  onReorderWorkspaces,
  onReorderSessionsInWorkspace,
  onMoveSessionToWorkspace,
}: WorkspaceSidebarProps) {
  const sMap = sessionMap(sessions)
  const [activeDragData, setActiveDragData] = useState<DragData | null>(null)
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null)
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  )

  function openCtxMenu(
    event: React.MouseEvent,
    type: CtxMenu['type'],
    id: string,
    workspaceId: string,
  ) {
    event.preventDefault()
    event.stopPropagation()

    const workspace = workspaces.find((candidate) => candidate.id === workspaceId)
    const isOpen = workspace ? workspace.openSessionIds.includes(id) : false

    setCtxMenu({
      type,
      id,
      workspaceId,
      isOpen,
      x: event.clientX,
      y: event.clientY,
    })
  }

  function handleDragStart({ active }: DragStartEvent) {
    setActiveDragData((active.data.current as DragData) ?? null)
    setCtxMenu(null)
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    setActiveDragData(null)

    if (!over || active.id === over.id) {
      return
    }

    const activeData = active.data.current as DragData | undefined
    const overData = over.data.current as DragData | undefined

    if (!activeData) {
      return
    }

    if (activeData.type === 'workspace') {
      const overWorkspaceId =
        overData?.workspaceId ??
        (typeof over.id === 'string' && over.id.startsWith('ws:')
          ? over.id.slice(3)
          : null)

      if (!overWorkspaceId) {
        return
      }

      const currentOrder = workspaces.map((workspace) => workspace.id)
      const oldIndex = currentOrder.indexOf(activeData.workspaceId)
      const newIndex = currentOrder.indexOf(overWorkspaceId)

      if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        onReorderWorkspaces(arrayMove(currentOrder, oldIndex, newIndex))
      }

      return
    }

    const sessionId = activeData.sessionId

    if (!sessionId) {
      return
    }

    if (overData?.type === 'session') {
      if (activeData.workspaceId === overData.workspaceId) {
        const workspace = workspaces.find(
          (candidate) => candidate.id === activeData.workspaceId,
        )

        if (!workspace) {
          return
        }

        const oldIndex = workspace.sessionIds.indexOf(sessionId)
        const newIndex = workspace.sessionIds.indexOf(over.id as string)

        if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
          onReorderSessionsInWorkspace(
            activeData.workspaceId,
            arrayMove(workspace.sessionIds, oldIndex, newIndex),
          )
        }

        return
      }

      const targetWorkspace = workspaces.find(
        (candidate) => candidate.id === overData.workspaceId,
      )

      if (!targetWorkspace) {
        return
      }

      const targetIndex = targetWorkspace.sessionIds.indexOf(over.id as string)

      onMoveSessionToWorkspace(
        sessionId,
        overData.workspaceId,
        targetIndex === -1 ? undefined : targetIndex,
      )
      return
    }

    const targetWorkspaceId =
      overData?.type === 'workspace'
        ? overData.workspaceId
        : typeof over.id === 'string' && over.id.startsWith('ws:')
          ? over.id.slice(3)
          : null

    if (targetWorkspaceId && targetWorkspaceId !== activeData.workspaceId) {
      onMoveSessionToWorkspace(sessionId, targetWorkspaceId)
    }
  }

  const workspaceIds = workspaces.map((workspace) => `ws:${workspace.id}`)
  const overlayWorkspace =
    activeDragData?.type === 'workspace'
      ? workspaces.find((workspace) => workspace.id === activeDragData.workspaceId) ?? null
      : null
  const overlaySession =
    activeDragData?.type === 'session'
      ? {
          session: sMap.get(activeDragData.sessionId ?? ''),
          ...activeDragData,
        }
      : null
  const ctxWorkspace = ctxMenu
    ? workspaces.find((workspace) => workspace.id === ctxMenu.workspaceId) ?? null
    : null

  return (
    <div className="sidebar-body">
      <div className="sidebar-tree">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={workspaceIds} strategy={verticalListSortingStrategy}>
            {workspaces.map((workspace) => (
              <WorkspaceRow
                key={workspace.id}
                workspace={workspace}
                sMap={sMap}
                isActive={workspace.id === activeWorkspaceId}
                activeSessionId={activeSessionId}
                isRenaming={renamingWorkspaceId === workspace.id}
                renamingSessionId={renamingSessionId}
                onSelect={() => onSelectWorkspace(workspace.id)}
                onDelete={() => onDeleteWorkspace(workspace.id)}
                onNewSession={() => onNewSession(workspace.id)}
                onStartRename={() => onRenamingWorkspaceChange(workspace.id)}
                onRenameCommit={(name) => {
                  onRenameWorkspace(workspace.id, name)
                  onRenamingWorkspaceChange(null)
                }}
                onRenameCancel={() => onRenamingWorkspaceChange(null)}
                onSelectSession={onSelectSession}
                onKillSession={onKillSession}
                onSessionRenameCommit={(sessionId, title) => {
                  onRenameSession(sessionId, title)
                  setRenamingSessionId(null)
                }}
                onSessionRenameCancel={() => setRenamingSessionId(null)}
                onContextMenu={(event) =>
                  openCtxMenu(event, 'workspace', workspace.id, workspace.id)
                }
                onSessionContextMenu={(event, sessionId) =>
                  openCtxMenu(event, 'session', sessionId, workspace.id)
                }
              />
            ))}
          </SortableContext>

          <DragOverlay dropAnimation={null}>
            {overlayWorkspace ? (
              <WorkspaceRow
                workspace={overlayWorkspace}
                sMap={sMap}
                isActive={overlayWorkspace.id === activeWorkspaceId}
                activeSessionId={activeSessionId}
                isRenaming={false}
                renamingSessionId={null}
                isDragOverlay
                onSelect={() => {}}
                onDelete={() => {}}
                onNewSession={() => {}}
                onStartRename={() => {}}
                onRenameCommit={() => {}}
                onRenameCancel={() => {}}
                onSelectSession={() => {}}
                onKillSession={() => {}}
                onSessionRenameCommit={() => {}}
                onSessionRenameCancel={() => {}}
                onContextMenu={() => {}}
                onSessionContextMenu={() => {}}
              />
            ) : overlaySession ? (
              <SessionRow
                session={overlaySession.session}
                sessionId={overlaySession.sessionId ?? ''}
                workspaceId={overlaySession.workspaceId}
                isActiveSession={overlaySession.sessionId === activeSessionId}
                isOpen
                isRenaming={false}
                isDragOverlay
                onSelect={() => {}}
                onKill={() => {}}
                onRenameCommit={() => {}}
                onRenameCancel={() => {}}
                onContextMenu={() => {}}
              />
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>

      <div className="shortcuts-bar">
        <div className="shortcuts-legend">
          <span>{formatShortcut(['Alt', '↑↓'])} workspace</span>
          <span>{formatShortcut(['Alt', '←→'])} tab</span>
          <span>{formatShortcut(['Alt', 'Shift', '↑↓'])} move ws</span>
          <span>{formatShortcut(['Alt', 'Shift', '←→'])} move tab</span>
          <span>{formatShortcut(['Alt', 'K'])} palette</span>
          <span>{formatShortcut(['Alt', 'M'])} new ws</span>
          <span>{formatShortcut(['Alt', 'W'])} close</span>
          <span>{formatShortcut(['Alt', 'Shift', 'W'])} kill</span>
        </div>
        <div className="shortcuts-actions">
          <button className="sidebar-create-btn" onClick={() => onNewSession()} type="button">
            <Plus className="h-3.5 w-3.5 shrink-0" />
            <span>New Session</span>
            <span className="btn-shortcut">{formatShortcut(['Alt', 'N'])}</span>
          </button>
          <button className="sidebar-create-btn" onClick={onCreateWorkspace} type="button">
            <Layers className="h-3.5 w-3.5 shrink-0" />
            <span>New Workspace</span>
            <span className="btn-shortcut">{formatShortcut(['Alt', 'M'])}</span>
          </button>
        </div>
        <div className="sidebar-credit">
          <span>
            Made by{' '}
            <a
              href="https://jeremie.bornais.ca"
              rel="noreferrer"
              target="_blank"
            >
              Jeremie Bornais
            </a>
          </span>
          <a
            href="https://github.com/jere-mie/webterm"
            rel="noreferrer"
            target="_blank"
          >
            GitHub
          </a>
        </div>
      </div>

      {ctxMenu && (
        <ContextMenu
          menu={ctxMenu}
          onClose={() => setCtxMenu(null)}
          onStartRename={() => {
            onRenamingWorkspaceChange(ctxMenu.id)
            setCtxMenu(null)
          }}
          onStartSessionRename={() => {
            setRenamingSessionId(ctxMenu.id)
            setCtxMenu(null)
          }}
          onSelectSession={(sessionId) => {
            onSelectSession(sessionId)
            setCtxMenu(null)
          }}
          onCloseTab={(sessionId) => {
            onCloseTab(sessionId)
            setCtxMenu(null)
          }}
          onKillSession={(sessionId) => {
            onKillSession(sessionId)
            setCtxMenu(null)
          }}
          onDeleteWorkspace={(workspaceId) => {
            onDeleteWorkspace(workspaceId)
            setCtxMenu(null)
          }}
          onNewSessionInWorkspace={() => {
            if (ctxWorkspace) {
              onNewSession(ctxWorkspace.id)
            }
            setCtxMenu(null)
          }}
        />
      )}
    </div>
  )
}
