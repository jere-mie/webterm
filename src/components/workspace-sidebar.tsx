import { useCallback, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ChevronDown, ChevronRight, Folder, FolderPlus, GripVertical, Plus, Terminal, X } from 'lucide-react'

import type { SessionSnapshot } from '../../shared/protocol'
import type {
  WorkspaceFolder,
  WorkspaceItem,
  WorkspaceSession,
} from '../hooks/useWorkspaceLayout'
import { cn } from '../lib/utils'

interface WorkspaceSidebarProps {
  items: WorkspaceItem[]
  sessions: SessionSnapshot[]
  activeSessionId: string | null
  onSelectSession: (sessionId: string) => void
  onCloseSession: (sessionId: string) => void
  onNewSession: () => void
  onCreateFolder: (name: string) => void
  onRenameFolder: (folderId: string, name: string) => void
  onDeleteFolder: (folderId: string) => void
  onToggleFolder: (folderId: string) => void
  onMoveSessionToFolder: (sessionId: string, folderId: string | null) => void
  onReorderItems: (newItems: WorkspaceItem[]) => void
  onReorderSessionsInFolder: (folderId: string, sessionIds: string[]) => void
  socketConnected: boolean
}

function sessionMap(sessions: SessionSnapshot[]) {
  const map = new Map<string, SessionSnapshot>()
  for (const s of sessions) map.set(s.id, s)
  return map
}

function worstState(sessionIds: string[], map: Map<string, SessionSnapshot>): SessionSnapshot['state'] | null {
  let hasExited = false
  let hasDetached = false
  for (const id of sessionIds) {
    const s = map.get(id)
    if (!s) continue
    if (s.state === 'exited') hasExited = true
    if (s.state === 'detached') hasDetached = true
  }
  if (hasExited) return 'exited'
  if (hasDetached) return 'detached'
  const hasLive = sessionIds.some((id) => map.get(id)?.state === 'live')
  return hasLive ? 'live' : null
}

// ─────────────────────────────────────────────────────
// Sortable session row
// ─────────────────────────────────────────────────────

interface SessionRowProps {
  sessionId: string
  session: SessionSnapshot | undefined
  isActive: boolean
  indented?: boolean
  isDragOverlay?: boolean
  onSelect: () => void
  onClose: () => void
}

function SessionRow({
  sessionId,
  session,
  isActive,
  indented = false,
  isDragOverlay = false,
  onSelect,
  onClose,
}: SessionRowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: sessionId })

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
        'session-item',
        isActive && 'is-active',
        indented && 'is-indented',
        isDragOverlay && 'is-drag-overlay',
      )}
    >
      <button
        ref={setActivatorNodeRef}
        className="drag-handle"
        aria-label="Drag to reorder"
        tabIndex={-1}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-3 w-3" />
      </button>
      <button className="session-item-main" onClick={onSelect} type="button">
        <span
          className={cn(
            'session-state-dot',
            session ? `state-${session.state}` : 'state-exited',
          )}
        />
        <span className="session-item-info">
          <span className="session-item-title">{session?.title ?? sessionId}</span>
          <span className="session-item-path">{session?.cwd ?? ''}</span>
        </span>
      </button>
      <button
        aria-label={`Close ${session?.title ?? sessionId}`}
        className="session-item-close"
        onClick={onClose}
        type="button"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}

// ─────────────────────────────────────────────────────
// Sortable folder
// ─────────────────────────────────────────────────────

interface FolderRowProps {
  folder: WorkspaceFolder
  sessions: SessionSnapshot[]
  activeSessionId: string | null
  isOverFolder: boolean
  isDragOverlay?: boolean
  onSelectSession: (id: string) => void
  onCloseSession: (id: string) => void
  onToggle: () => void
  onRename: (name: string) => void
  onDelete: () => void
}

function FolderRow({
  folder,
  sessions,
  activeSessionId,
  isOverFolder,
  isDragOverlay = false,
  onSelectSession,
  onCloseSession,
  onToggle,
  onRename,
  onDelete,
}: FolderRowProps) {
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(folder.name)
  const inputRef = useRef<HTMLInputElement>(null)

  const sMap = sessionMap(sessions)
  const state = worstState(folder.sessionIds, sMap)
  const hasActive = folder.sessionIds.includes(activeSessionId ?? '')

  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: folder.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
  }

  function commitRename() {
    const trimmed = renameValue.trim()
    if (trimmed) onRename(trimmed)
    setRenaming(false)
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn('folder-item', isOverFolder && 'is-drop-target', isDragOverlay && 'is-drag-overlay')}
    >
      <div className="folder-header">
        <button
          ref={setActivatorNodeRef}
          className="drag-handle"
          aria-label="Drag folder"
          tabIndex={-1}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-3 w-3" />
        </button>

        <button className="folder-toggle" onClick={onToggle} type="button">
          {folder.collapsed
            ? <ChevronRight className="h-3.5 w-3.5" />
            : <ChevronDown className="h-3.5 w-3.5" />
          }
        </button>

        {renaming ? (
          <input
            ref={inputRef}
            autoFocus
            className="folder-rename-input"
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
            className={cn('folder-name', hasActive && !folder.collapsed && 'has-active-child')}
            onDoubleClick={() => {
              setRenameValue(folder.name)
              setRenaming(true)
            }}
            onClick={folder.collapsed ? onToggle : undefined}
            type="button"
          >
            <Folder className="h-3.5 w-3.5 folder-icon" />
            <span className="folder-name-text">{folder.name}</span>
            {folder.collapsed && folder.sessionIds.length > 0 && (
              <span className="folder-count">{folder.sessionIds.length}</span>
            )}
          </button>
        )}

        {state && (
          <span className={cn('folder-state-dot', `state-${state}`)} />
        )}
        {hasActive && folder.collapsed && (
          <span className="folder-active-indicator" />
        )}

        <button
          aria-label={`Delete ${folder.name}`}
          className="folder-delete-btn"
          onClick={onDelete}
          type="button"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      {!folder.collapsed && (
        <div className={cn('folder-children', isOverFolder && 'is-drop-target')}>
          <SortableContext
            items={folder.sessionIds}
            strategy={verticalListSortingStrategy}
          >
            {folder.sessionIds.map((sessionId) => (
              <SessionRow
                key={sessionId}
                sessionId={sessionId}
                session={sMap.get(sessionId)}
                isActive={sessionId === activeSessionId}
                indented
                onSelect={() => onSelectSession(sessionId)}
                onClose={() => onCloseSession(sessionId)}
              />
            ))}
          </SortableContext>
          {folder.sessionIds.length === 0 && (
            <div className="folder-empty-hint">Drop terminals here</div>
          )}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────
// Main WorkspaceSidebar
// ─────────────────────────────────────────────────────

export function WorkspaceSidebar({
  items,
  sessions,
  activeSessionId,
  onSelectSession,
  onCloseSession,
  onNewSession,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onToggleFolder,
  onMoveSessionToFolder,
  onReorderItems,
  onReorderSessionsInFolder,
  socketConnected,
}: WorkspaceSidebarProps) {
  const sMap = sessionMap(sessions)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  )

  // Derive the type of the active dragged item
  const activeDragItem = activeId
    ? items.find((item) => {
        if (item.type === 'session') return item.sessionId === activeId
        if (item.type === 'folder') return item.id === activeId
        return false
      }) ?? items.flatMap((item) =>
        item.type === 'folder' ? item.sessionIds.map((id) => ({ type: 'session' as const, sessionId: id, parentFolderId: item.id })) : []
      ).find((item) => item.sessionId === activeId)
    : null

  function handleDragStart({ active }: DragStartEvent) {
    setActiveId(active.id as string)
  }

  function handleDragOver({ over }: DragOverEvent) {
    setOverId(over?.id as string ?? null)
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    setActiveId(null)
    setOverId(null)
    if (!over || active.id === over.id) return

    const activeIdStr = active.id as string
    const overIdStr = over.id as string

    // Find where the active item lives
    const activeTopIdx = items.findIndex(
      (item) =>
        (item.type === 'session' && item.sessionId === activeIdStr) ||
        (item.type === 'folder' && item.id === activeIdStr),
    )

    // Check if active is a session inside a folder
    const activeParentFolder = items.find(
      (item): item is WorkspaceFolder =>
        item.type === 'folder' && item.sessionIds.includes(activeIdStr),
    )

    // Check if over is a folder
    const overIsFolder = items.find(
      (item): item is WorkspaceFolder => item.type === 'folder' && item.id === overIdStr,
    )

    // Check if over is a session inside a folder
    const overParentFolder = items.find(
      (item): item is WorkspaceFolder =>
        item.type === 'folder' && item.sessionIds.includes(overIdStr),
    )

    // ─── Case 1: dragging a top-level item onto a folder → move into folder
    if (!activeParentFolder && overIsFolder && activeTopIdx !== -1 && items[activeTopIdx].type === 'session') {
      onMoveSessionToFolder(activeIdStr, overIdStr)
      return
    }

    // ─── Case 2: dragging session out of folder to top level
    if (activeParentFolder && !overParentFolder && activeTopIdx === -1) {
      const overTopIdx = items.findIndex(
        (item) =>
          (item.type === 'session' && item.sessionId === overIdStr) ||
          (item.type === 'folder' && item.id === overIdStr),
      )
      if (overTopIdx !== -1) {
        onMoveSessionToFolder(activeIdStr, null)
        return
      }
    }

    // ─── Case 3: reordering within a folder
    if (activeParentFolder && overParentFolder && activeParentFolder.id === overParentFolder.id) {
      const ids = activeParentFolder.sessionIds
      const oldIdx = ids.indexOf(activeIdStr)
      const newIdx = ids.indexOf(overIdStr)
      if (oldIdx !== -1 && newIdx !== -1) {
        onReorderSessionsInFolder(activeParentFolder.id, arrayMove(ids, oldIdx, newIdx))
      }
      return
    }

    // ─── Case 4: reordering top-level items
    if (activeTopIdx !== -1) {
      const overTopIdx = items.findIndex(
        (item) =>
          (item.type === 'session' && item.sessionId === overIdStr) ||
          (item.type === 'folder' && item.id === overIdStr),
      )
      if (overTopIdx !== -1) {
        onReorderItems(arrayMove(items, activeTopIdx, overTopIdx))
      }
    }
  }

  const topLevelIds = items.map((item) =>
    item.type === 'folder' ? item.id : item.sessionId,
  )

  function handleNewFolder() {
    const name = `Folder ${items.filter((i) => i.type === 'folder').length + 1}`
    onCreateFolder(name)
  }

  return (
    <div className="sidebar-body">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={topLevelIds} strategy={verticalListSortingStrategy}>
          {items.map((item) => {
            if (item.type === 'folder') {
              return (
                <FolderRow
                  key={item.id}
                  folder={item}
                  sessions={sessions}
                  activeSessionId={activeSessionId}
                  isOverFolder={overId === item.id}
                  onSelectSession={onSelectSession}
                  onCloseSession={onCloseSession}
                  onToggle={() => onToggleFolder(item.id)}
                  onRename={(name) => onRenameFolder(item.id, name)}
                  onDelete={() => onDeleteFolder(item.id)}
                />
              )
            }

            return (
              <SessionRow
                key={item.sessionId}
                sessionId={item.sessionId}
                session={sMap.get(item.sessionId)}
                isActive={item.sessionId === activeSessionId}
                onSelect={() => onSelectSession(item.sessionId)}
                onClose={() => onCloseSession(item.sessionId)}
              />
            )
          })}
        </SortableContext>

        <DragOverlay dropAnimation={null}>
          {activeId ? (
            activeDragItem?.type === 'folder' ? (
              <FolderRow
                folder={activeDragItem as WorkspaceFolder}
                sessions={sessions}
                activeSessionId={activeSessionId}
                isOverFolder={false}
                isDragOverlay
                onSelectSession={() => {}}
                onCloseSession={() => {}}
                onToggle={() => {}}
                onRename={() => {}}
                onDelete={() => {}}
              />
            ) : (
              <SessionRow
                sessionId={activeId}
                session={sMap.get(activeId)}
                isActive={activeId === activeSessionId}
                isDragOverlay
                onSelect={() => {}}
                onClose={() => {}}
              />
            )
          ) : null}
        </DragOverlay>
      </DndContext>

      {items.length === 0 && (
        <div className="sidebar-empty">
          <Terminal className="h-6 w-6 opacity-20" />
          <span>No sessions yet</span>
        </div>
      )}

      {/* Sidebar footer actions */}
      <div className="sidebar-tree-actions">
        <button className="sidebar-action-btn" onClick={onNewSession} type="button">
          <Plus className="h-3.5 w-3.5" />
          New terminal
        </button>
        <button className="sidebar-action-btn" onClick={handleNewFolder} type="button">
          <FolderPlus className="h-3.5 w-3.5" />
          New folder
        </button>
      </div>
    </div>
  )
}
