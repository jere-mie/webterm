import { useState } from 'react'
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
import { ChevronDown, ChevronRight, GripVertical, Layers, Plus, X } from 'lucide-react'

import type { SessionSnapshot } from '../../shared/protocol'
import type { Workspace } from '../hooks/useAppState'
import { cn } from '../lib/utils'

const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)

interface DragData {
  type: 'workspace' | 'session'
  workspaceId: string
  sessionId?: string
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
// Session row (sortable, supports open/closed state)
// ─────────────────────────────────────────────────────

interface SessionRowProps {
  session: SessionSnapshot | undefined
  sessionId: string
  workspaceId: string
  isActiveSession: boolean
  isOpen: boolean
  isDragOverlay?: boolean
  onSelect: () => void
  onKill: () => void
}

function SessionRow({
  session,
  sessionId,
  workspaceId,
  isActiveSession,
  isOpen,
  isDragOverlay = false,
  onSelect,
  onKill,
}: SessionRowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({
      id: sessionId,
      data: { type: 'session', sessionId, workspaceId } satisfies DragData,
    })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
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
    >
      <button
        ref={setActivatorNodeRef}
        className="drag-handle"
        aria-label="Drag session"
        tabIndex={-1}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-3 w-3" />
      </button>
      <button className="ws-session-main" onClick={onSelect} type="button">
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
        type="button"
        title="Kill process"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}

// ─────────────────────────────────────────────────────
// Workspace row (sortable)
// ─────────────────────────────────────────────────────

interface WorkspaceRowProps {
  workspace: Workspace
  sMap: Map<string, SessionSnapshot>
  isActive: boolean
  activeSessionId: string | null
  isDragOverlay?: boolean
  onSelect: () => void
  onDelete: () => void
  onRename: (name: string) => void
  onSelectSession: (sessionId: string) => void
  onKillSession: (sessionId: string) => void
}

function WorkspaceRow({
  workspace,
  sMap,
  isActive,
  activeSessionId,
  isDragOverlay = false,
  onSelect,
  onDelete,
  onRename,
  onSelectSession,
  onKillSession,
}: WorkspaceRowProps) {
  const [expanded, setExpanded] = useState(true)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(workspace.name)

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

  const wsState = worstState(workspace.sessionIds, sMap)

  function commitRename() {
    const trimmed = renameValue.trim()
    if (trimmed) onRename(trimmed)
    setRenaming(false)
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn('ws-item', isActive && 'is-active', isDragOverlay && 'is-drag-overlay')}
    >
      <div className={cn('ws-item-header', isActive && 'is-active')}>
        <button
          ref={setActivatorNodeRef}
          className="drag-handle"
          aria-label="Drag workspace"
          tabIndex={-1}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-3 w-3" />
        </button>

        <button
          className="ws-item-toggle"
          onClick={() => setExpanded((e) => !e)}
          tabIndex={-1}
          type="button"
        >
          {expanded
            ? <ChevronDown className="h-3.5 w-3.5" />
            : <ChevronRight className="h-3.5 w-3.5" />}
        </button>

        {renaming ? (
          <input
            autoFocus
            className="ws-rename-input"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') setRenaming(false)
            }}
          />
        ) : (
          <button
            className="ws-item-name"
            onClick={onSelect}
            onDoubleClick={() => { setRenameValue(workspace.name); setRenaming(true) }}
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
                onSelect={() => onSelectSession(sessionId)}
                onKill={() => onKillSession(sessionId)}
              />
            ))}
            {workspace.sessionIds.length === 0 && (
              <div className="ws-empty-hint">No sessions — press + to spawn one</div>
            )}
          </div>
        </SortableContext>
      )}
    </div>
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
  onNewSession,
  onReorderWorkspaces,
  onReorderSessionsInWorkspace,
  onMoveSessionToWorkspace,
}: WorkspaceSidebarProps) {
  const sMap = sessionMap(sessions)
  const [activeDragData, setActiveDragData] = useState<DragData | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  )

  function handleDragStart({ active }: DragStartEvent) {
    setActiveDragData((active.data.current as DragData) ?? null)
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    setActiveDragData(null)
    if (!over || active.id === over.id) return

    const activeData = active.data.current as DragData | undefined
    const overData = over.data.current as DragData | undefined

    if (!activeData) return

    if (activeData.type === 'workspace') {
      // Reorder workspaces
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
          // Reorder within same workspace
          const ws = workspaces.find((w) => w.id === sourceWsId)
          if (!ws) return
          const oldIdx = ws.sessionIds.indexOf(sessionId)
          const newIdx = ws.sessionIds.indexOf(over.id as string)
          if (oldIdx !== -1 && newIdx !== -1 && oldIdx !== newIdx) {
            onReorderSessionsInWorkspace(sourceWsId, arrayMove(ws.sessionIds, oldIdx, newIdx))
          }
        } else {
          // Cross-workspace move, insert at target session's index
          const targetWs = workspaces.find((w) => w.id === targetWsId)
          if (!targetWs) return
          const atIndex = targetWs.sessionIds.indexOf(over.id as string)
          onMoveSessionToWorkspace(sessionId, targetWsId, atIndex === -1 ? undefined : atIndex)
        }
      } else if (overData?.type === 'workspace') {
        // Dropped onto a workspace header — move to end
        const targetWsId = overData.workspaceId
        if (sourceWsId !== targetWsId) {
          onMoveSessionToWorkspace(sessionId, targetWsId)
        }
      } else if (typeof over.id === 'string' && over.id.startsWith('ws:')) {
        // Dropped onto workspace sortable when no over.data (e.g. empty workspace)
        const targetWsId = over.id.slice(3)
        if (sourceWsId !== targetWsId) {
          onMoveSessionToWorkspace(sessionId, targetWsId)
        }
      }
    }
  }

  const workspaceIds = workspaces.map((w) => `ws:${w.id}`)

  // Find the active drag item for the overlay
  const overlayWorkspace = activeDragData?.type === 'workspace'
    ? workspaces.find((w) => w.id === activeDragData.workspaceId)
    : null
  const overlaySession = activeDragData?.type === 'session'
    ? { session: sMap.get(activeDragData.sessionId!), ...activeDragData }
    : null

  const mod = isMac ? '⌘' : 'Ctrl'

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
                onSelect={() => onSelectWorkspace(ws.id)}
                onDelete={() => onDeleteWorkspace(ws.id)}
                onRename={(name) => onRenameWorkspace(ws.id, name)}
                onSelectSession={onSelectSession}
                onKillSession={onKillSession}
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
                isDragOverlay
                onSelect={() => {}}
                onDelete={() => {}}
                onRename={() => {}}
                onSelectSession={() => {}}
                onKillSession={() => {}}
              />
            ) : overlaySession ? (
              <SessionRow
                session={overlaySession.session}
                sessionId={overlaySession.sessionId!}
                workspaceId={overlaySession.workspaceId}
                isActiveSession={overlaySession.sessionId === activeSessionId}
                isOpen
                isDragOverlay
                onSelect={() => {}}
                onKill={() => {}}
              />
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>

      <div className="shortcuts-bar">
        <div className="shortcuts-bar-row">
          <span className="shortcut-label">New session</span>
          <span className="shortcut-key">{mod}⇧N</span>
        </div>
        <div className="shortcuts-bar-row">
          <span className="shortcut-label">New workspace</span>
          <span className="shortcut-key">{mod}⇧T</span>
        </div>
        <div className="shortcuts-bar-row">
          <span className="shortcut-label">Command palette</span>
          <span className="shortcut-key">{mod}K</span>
        </div>
        <div className="shortcuts-bar-row">
          <span className="shortcut-label">Switch workspace</span>
          <span className="shortcut-key">Alt ↑↓</span>
        </div>
        <div className="shortcuts-bar-row">
          <span className="shortcut-label">Switch tab</span>
          <span className="shortcut-key">Alt ←→</span>
        </div>
        <div className="shortcuts-bar-row">
          <span className="shortcut-label">New session (+)</span>
          <button className="shortcut-action-btn" onClick={onNewSession} type="button" title="New session">
            <Plus className="h-3 w-3" />
          </button>
        </div>
        <div className="shortcuts-bar-row">
          <span className="shortcut-label">New workspace</span>
          <button className="shortcut-action-btn" onClick={onCreateWorkspace} type="button" title="New workspace">
            <Layers className="h-3 w-3" />
          </button>
        </div>
      </div>
    </div>
  )
}


