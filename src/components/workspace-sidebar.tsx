import { useState, useEffect, useRef } from 'react'
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
import { ChevronDown, ChevronRight, Layers, Pencil, Plus, X } from 'lucide-react'

import type { SessionSnapshot } from '../../shared/protocol'
import type { Workspace } from '../hooks/useAppState'
import { cn } from '../lib/utils'

const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)

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
  onSelectWorkspace: (workspaceId: string) => void
  onDeleteWorkspace: (workspaceId: string) => void
  onRenameWorkspace: (workspaceId: string, name: string) => void
  onCreateWorkspace: () => void
  onSelectSession: (sessionId: string) => void
  onKillSession: (sessionId: string) => void
  onCloseTab: (sessionId: string) => void
  onRenameSession: (sessionId: string, title: string) => void
  onNewSession: () => void
  onReorderWorkspaces: (newWorkspaceIds: string[]) => void
  onReorderSessionsInWorkspace: (workspaceId: string, newSessionIds: string[]) => void
  onMoveSessionToWorkspace: (sessionId: string, targetWorkspaceId: string, atIndex?: number) => void
}

function sessionMap(sessions: SessionSnapshot[]): Map<string, SessionSnapshot> {
  const map = new Map<string, SessionSnapshot>()
  for (const s of sessions) map.set(s.id, s)
  return map
}

function worstState(
  sessionIds: string[],
  map: Map<string, SessionSnapshot>,
): 'live' | 'detached' | 'exited' | null {
  let hasExited = false
  let hasDetached = false
  let hasLive = false
  for (const id of sessionIds) {
    const s = map.get(id)
    if (!s) continue
    if (s.state === 'exited') hasExited = true
    else if (s.state === 'detached') hasDetached = true
    else if (s.state === 'live') hasLive = true
  }
  if (hasExited) return 'exited'
  if (hasDetached) return 'detached'
  if (hasLive) return 'live'
  return null
}

// ─────────────────────────────────────────────────────
// Session row (sortable, supports open/closed state, inline rename)
// ─────────────────────────────────────────────────────

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
  onContextMenu: (e: React.MouseEvent) => void
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
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({
      id: sessionId,
      data: { type: 'session', sessionId, workspaceId } satisfies DragData,
    })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
  }

  useEffect(() => {
    if (isRenaming) {
      setRenameValue(session?.title ?? sessionId)
      requestAnimationFrame(() => {
        renameInputRef.current?.select()
      })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRenaming])

  function commitRename() {
    const trimmed = renameValue.trim()
    if (trimmed) onRenameCommit(trimmed)
    else onRenameCancel()
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'ws-session-item',
        isActiveSession && 'is-active',
        !isOpen && 'is-closed',
        isDragOverlay && 'is-drag-overlay',
      )}
      {...listeners}
      {...attributes}
      onContextMenu={onContextMenu}
    >
      {isRenaming ? (
        <input
          ref={renameInputRef}
          autoFocus
          className="ws-rename-input ws-session-rename-input"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename()
            if (e.key === 'Escape') onRenameCancel()
            e.stopPropagation()
          }}
        />
      ) : (
        <>
          <button
            className="ws-session-main"
            onClick={onSelect}
            onPointerDown={(e) => e.stopPropagation()}
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
            onPointerDown={(e) => e.stopPropagation()}
            type="button"
            title="Kill process"
          >
            <X className="h-3 w-3" />
          </button>
        </>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────
// Workspace row (sortable, header-only drag)
// ─────────────────────────────────────────────────────

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
  onRenameCommit: (name: string) => void
  onRenameCancel: () => void
  onSelectSession: (sessionId: string) => void
  onKillSession: (sessionId: string) => void
  onCloseTab: (sessionId: string) => void
  onRenameSession: (sessionId: string, title: string) => void
  onSessionRenameCommit: (sessionId: string, title: string) => void
  onSessionRenameCancel: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onSessionContextMenu: (e: React.MouseEvent, sessionId: string) => void
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
  const [renameValue, setRenameValue] = useState(workspace.name)
  const renameInputRef = useRef<HTMLInputElement>(null)

  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({
      id: `ws:${workspace.id}`,
      data: { type: 'workspace', workspaceId: workspace.id } satisfies DragData,
    })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
  }

  useEffect(() => {
    if (isRenaming) {
      setRenameValue(workspace.name)
      requestAnimationFrame(() => {
        renameInputRef.current?.select()
      })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRenaming])

  const wsState = worstState(workspace.sessionIds, sMap)

  function commitRename() {
    const trimmed = renameValue.trim()
    if (trimmed) onRenameCommit(trimmed)
    else onRenameCancel()
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn('ws-item', isActive && 'is-active', isDragOverlay && 'is-drag-overlay')}
    >
      <div
        ref={setActivatorNodeRef}
        className={cn('ws-item-header', isActive && 'is-active', isRenaming && 'is-renaming')}
        {...listeners}
        {...attributes}
        onContextMenu={onContextMenu}
      >
        <button
          className="ws-item-toggle"
          onClick={() => setExpanded((e) => !e)}
          onPointerDown={(e) => e.stopPropagation()}
          tabIndex={-1}
          type="button"
        >
          {expanded
            ? <ChevronDown className="h-3.5 w-3.5" />
            : <ChevronRight className="h-3.5 w-3.5" />}
        </button>

        {isRenaming ? (
          <input
            ref={renameInputRef}
            autoFocus
            className="ws-rename-input"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={commitRename}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') onRenameCancel()
              e.stopPropagation()
            }}
          />
        ) : (
          <button
            className="ws-item-name"
            onClick={onSelect}
            onDoubleClick={() => { setRenameValue(workspace.name) }}
            onPointerDown={(e) => e.stopPropagation()}
            type="button"
          >
            <Layers className="h-3.5 w-3.5 ws-icon" />
            <span className="ws-item-name-text">{workspace.name}</span>
            {workspace.sessionIds.length > 0 && (
              <span className="ws-session-count">{workspace.sessionIds.length}</span>
            )}
          </button>
        )}

        {wsState && <span className={cn('ws-state-dot', `state-${wsState}`)} />}
        {isActive && <span className="ws-active-badge">active</span>}

        <button
          aria-label={`Delete ${workspace.name}`}
          className="ws-delete-btn"
          onClick={onDelete}
          onPointerDown={(e) => e.stopPropagation()}
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
                onContextMenu={(e) => onSessionContextMenu(e, sessionId)}
              />
            ))}
            {workspace.sessionIds.length === 0 && (
              <div className="ws-empty-hint">No sessions — right-click or press Alt+N</div>
            )}
          </div>
        </SortableContext>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────
// Context menu portal
// ─────────────────────────────────────────────────────

interface ContextMenuProps {
  menu: CtxMenu
  workspaces: Workspace[]
  onClose: () => void
  onStartRename: () => void
  onStartSessionRename: () => void
  onSelectSession: (id: string) => void
  onCloseTab: (id: string) => void
  onKillSession: (id: string) => void
  onDeleteWorkspace: (id: string) => void
  onNewSessionInWorkspace: () => void
  onOpenNewSession: () => void
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
    function handleDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleDown)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleDown)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  const style: React.CSSProperties = {
    position: 'fixed',
    left: menu.x,
    top: menu.y,
    zIndex: 9999,
  }

  function item(label: string, action: () => void, danger = false) {
    return (
      <button
        key={label}
        className={cn('ctx-menu-item', danger && 'danger')}
        onPointerDown={(e) => { e.stopPropagation(); e.preventDefault() }}
        onClick={() => { action(); onClose() }}
        type="button"
      >
        {label}
      </button>
    )
  }

  return createPortal(
    <div ref={ref} className="ctx-menu" style={style}>
      {menu.type === 'session' ? (
        <>
          {item('Rename', onStartSessionRename)}
          {menu.isOpen
            ? item('Close tab', () => onCloseTab(menu.id))
            : item('Open as tab', () => onSelectSession(menu.id))
          }
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

// ─────────────────────────────────────────────────────
// Main WorkspaceSidebar
// ─────────────────────────────────────────────────────

export function WorkspaceSidebar({
  workspaces,
  sessions,
  activeWorkspaceId,
  activeSessionId,
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
  const [renamingWsId, setRenamingWsId] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  )

  function openCtxMenu(e: React.MouseEvent, type: CtxMenu['type'], id: string, workspaceId: string) {
    e.preventDefault()
    e.stopPropagation()
    const ws = workspaces.find((w) => w.id === workspaceId)
    const isOpen = ws ? ws.openSessionIds.includes(id) : false
    setCtxMenu({ type, id, workspaceId, isOpen, x: e.clientX, y: e.clientY })
  }

  function handleDragStart({ active }: DragStartEvent) {
    setActiveDragData((active.data.current as DragData) ?? null)
    setCtxMenu(null)
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    setActiveDragData(null)
    if (!over || active.id === over.id) return

    const activeData = active.data.current as DragData | undefined
    const overData = over.data.current as DragData | undefined

    if (!activeData) return

    if (activeData.type === 'workspace') {
      const overWsId = overData?.workspaceId ?? (
        typeof over.id === 'string' && over.id.startsWith('ws:') ? over.id.slice(3) : null
      )
      if (!overWsId) return
      const currentOrder = workspaces.map((w) => w.id)
      const oldIdx = currentOrder.indexOf(activeData.workspaceId)
      const newIdx = currentOrder.indexOf(overWsId)
      if (oldIdx !== -1 && newIdx !== -1 && oldIdx !== newIdx) {
        onReorderWorkspaces(arrayMove(currentOrder, oldIdx, newIdx))
      }
    } else if (activeData.type === 'session') {
      const sessionId = activeData.sessionId!
      const sourceWsId = activeData.workspaceId

      if (overData?.type === 'session') {
        const targetWsId = overData.workspaceId
        if (sourceWsId === targetWsId) {
          const ws = workspaces.find((w) => w.id === sourceWsId)
          if (!ws) return
          const oldIdx = ws.sessionIds.indexOf(sessionId)
          const newIdx = ws.sessionIds.indexOf(over.id as string)
          if (oldIdx !== -1 && newIdx !== -1 && oldIdx !== newIdx) {
            onReorderSessionsInWorkspace(sourceWsId, arrayMove(ws.sessionIds, oldIdx, newIdx))
          }
        } else {
          const targetWs = workspaces.find((w) => w.id === targetWsId)
          if (!targetWs) return
          const atIndex = targetWs.sessionIds.indexOf(over.id as string)
          onMoveSessionToWorkspace(sessionId, targetWsId, atIndex === -1 ? undefined : atIndex)
        }
      } else if (overData?.type === 'workspace') {
        const targetWsId = overData.workspaceId
        if (sourceWsId !== targetWsId) {
          onMoveSessionToWorkspace(sessionId, targetWsId)
        }
      } else if (typeof over.id === 'string' && over.id.startsWith('ws:')) {
        const targetWsId = over.id.slice(3)
        if (sourceWsId !== targetWsId) {
          onMoveSessionToWorkspace(sessionId, targetWsId)
        }
      }
    }
  }

  const workspaceIds = workspaces.map((w) => `ws:${w.id}`)

  const overlayWorkspace = activeDragData?.type === 'workspace'
    ? workspaces.find((w) => w.id === activeDragData.workspaceId)
    : null
  const overlaySession = activeDragData?.type === 'session'
    ? { session: sMap.get(activeDragData.sessionId!), ...activeDragData }
    : null

  const mod = isMac ? '⌘' : 'Ctrl'

  // Context menu actions
  const ctxWorkspace = ctxMenu ? workspaces.find((w) => w.id === ctxMenu.workspaceId) : null

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
            {workspaces.map((ws) => (
              <WorkspaceRow
                key={ws.id}
                workspace={ws}
                sMap={sMap}
                isActive={ws.id === activeWorkspaceId}
                activeSessionId={activeSessionId}
                isRenaming={renamingWsId === ws.id}
                renamingSessionId={renamingSessionId}
                onSelect={() => onSelectWorkspace(ws.id)}
                onDelete={() => onDeleteWorkspace(ws.id)}
                onRenameCommit={(name) => { onRenameWorkspace(ws.id, name); setRenamingWsId(null) }}
                onRenameCancel={() => setRenamingWsId(null)}
                onSelectSession={onSelectSession}
                onKillSession={onKillSession}
                onCloseTab={onCloseTab}
                onRenameSession={onRenameSession}
                onSessionRenameCommit={(sessionId, title) => {
                  onRenameSession(sessionId, title)
                  setRenamingSessionId(null)
                }}
                onSessionRenameCancel={() => setRenamingSessionId(null)}
                onContextMenu={(e) => openCtxMenu(e, 'workspace', ws.id, ws.id)}
                onSessionContextMenu={(e, sessionId) => openCtxMenu(e, 'session', sessionId, ws.id)}
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
                onRenameCommit={() => {}}
                onRenameCancel={() => {}}
                onSelectSession={() => {}}
                onKillSession={() => {}}
                onCloseTab={() => {}}
                onRenameSession={() => {}}
                onSessionRenameCommit={() => {}}
                onSessionRenameCancel={() => {}}
                onContextMenu={() => {}}
                onSessionContextMenu={() => {}}
              />
            ) : overlaySession ? (
              <SessionRow
                session={overlaySession.session}
                sessionId={overlaySession.sessionId!}
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

      {/* Bottom action bar */}
      <div className="shortcuts-bar">
        <div className="shortcuts-legend">
          <span>Alt↑↓ workspace</span>
          <span>Alt←→ tab</span>
          <span>{mod}K palette</span>
          <span>Alt+M new workspace</span>
          <span>Alt+W close tab</span>
        </div>
        <div className="shortcuts-actions">
          <button className="sidebar-create-btn" onClick={onNewSession} type="button">
            <Plus className="h-3.5 w-3.5 shrink-0" />
            <span>New Session</span>
            <span className="btn-shortcut">Alt N</span>
          </button>
          <button className="sidebar-create-btn" onClick={onCreateWorkspace} type="button">
            <Layers className="h-3.5 w-3.5 shrink-0" />
            <span>New Workspace</span>
            <span className="btn-shortcut">Alt M</span>
          </button>
        </div>
      </div>

      {/* Context menu portal */}
      {ctxMenu && (
        <ContextMenu
          menu={ctxMenu}
          workspaces={workspaces}
          onClose={() => setCtxMenu(null)}
          onStartRename={() => { setRenamingWsId(ctxMenu.id); setCtxMenu(null) }}
          onStartSessionRename={() => { setRenamingSessionId(ctxMenu.id); setCtxMenu(null) }}
          onSelectSession={(id) => { onSelectSession(id); setCtxMenu(null) }}
          onCloseTab={(id) => { onCloseTab(id); setCtxMenu(null) }}
          onKillSession={(id) => { onKillSession(id); setCtxMenu(null) }}
          onDeleteWorkspace={(id) => { onDeleteWorkspace(id); setCtxMenu(null) }}
          onNewSessionInWorkspace={() => {
            if (ctxWorkspace) onSelectWorkspace(ctxWorkspace.id)
            onNewSession()
            setCtxMenu(null)
          }}
          onOpenNewSession={() => { onNewSession(); setCtxMenu(null) }}
        />
      )}
    </div>
  )
}
