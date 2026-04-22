import { useState } from 'react'
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
import { ChevronDown, ChevronRight, Folder, FolderPlus, GripVertical, Layers, Plus, Terminal, X } from 'lucide-react'

import type { SessionSnapshot } from '../../shared/protocol'
import type { SidebarFolder, SidebarItem, Workspace } from '../hooks/useAppState'
import { cn } from '../lib/utils'

interface WorkspaceSidebarProps {
  workspaces: Workspace[]
  sidebarItems: SidebarItem[]
  sessions: SessionSnapshot[]
  activeWorkspaceId: string | null
  activeSessionId: string | null
  backgroundSessionIds: string[]
  socketConnected: boolean
  onSelectWorkspace: (workspaceId: string) => void
  onDeleteWorkspace: (workspaceId: string) => void
  onRenameWorkspace: (workspaceId: string, name: string) => void
  onCreateWorkspace: () => void
  onCreateFolder: (name: string) => void
  onRenameFolder: (folderId: string, name: string) => void
  onDeleteFolder: (folderId: string) => void
  onToggleFolder: (folderId: string) => void
  onReorderSidebarItems: (items: SidebarItem[]) => void
  onReorderWorkspacesInFolder: (folderId: string, wsIds: string[]) => void
  onMoveWorkspaceToFolder: (workspaceId: string, folderId: string | null) => void
  onSelectSession: (sessionId: string) => void
  onKillSession: (sessionId: string) => void
  onAddBackgroundSession: (sessionId: string) => void
  onNewSession: () => void
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
// Session row inside a workspace
// ─────────────────────────────────────────────────────

interface SessionRowProps {
  session: SessionSnapshot | undefined
  sessionId: string
  isActiveSession: boolean
  onSelect: () => void
  onKill: () => void
}

function SessionRow({ session, sessionId, isActiveSession, onSelect, onKill }: SessionRowProps) {
  return (
    <div className={cn('ws-session-item', isActiveSession && 'is-active')}>
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
    useSortable({ id: workspace.id })

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
        <div className="ws-sessions">
          {workspace.sessionIds.map((sessionId) => (
            <SessionRow
              key={sessionId}
              session={sMap.get(sessionId)}
              sessionId={sessionId}
              isActiveSession={sessionId === activeSessionId}
              onSelect={() => onSelectSession(sessionId)}
              onKill={() => onKillSession(sessionId)}
            />
          ))}
          {workspace.sessionIds.length === 0 && (
            <div className="ws-empty-hint">No sessions — press + to spawn one</div>
          )}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────
// Folder row (sortable)
// ─────────────────────────────────────────────────────

interface FolderRowProps {
  folder: SidebarFolder
  workspaces: Workspace[]
  sMap: Map<string, SessionSnapshot>
  activeWorkspaceId: string | null
  activeSessionId: string | null
  isDropTarget: boolean
  isDragOverlay?: boolean
  onSelectWorkspace: (id: string) => void
  onDeleteWorkspace: (id: string) => void
  onRenameWorkspace: (id: string, name: string) => void
  onSelectSession: (id: string) => void
  onKillSession: (id: string) => void
  onToggle: () => void
  onRename: (name: string) => void
  onDelete: () => void
}

function FolderRow({
  folder,
  workspaces,
  sMap,
  activeWorkspaceId,
  activeSessionId,
  isDropTarget,
  isDragOverlay = false,
  onSelectWorkspace,
  onDeleteWorkspace,
  onRenameWorkspace,
  onSelectSession,
  onKillSession,
  onToggle,
  onRename,
  onDelete,
}: FolderRowProps) {
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(folder.name)

  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: folder.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
  }

  const allSessionIds = workspaces.flatMap((w) => w.sessionIds)
  const folderState = worstState(allSessionIds, sMap)
  const hasActiveWorkspace = folder.workspaceIds.includes(activeWorkspaceId ?? '')

  function commitRename() {
    const trimmed = renameValue.trim()
    if (trimmed) onRename(trimmed)
    setRenaming(false)
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn('folder-item', isDropTarget && 'is-drop-target', isDragOverlay && 'is-drag-overlay')}
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
            : <ChevronDown className="h-3.5 w-3.5" />}
        </button>

        {renaming ? (
          <input
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
            className={cn('folder-name', hasActiveWorkspace && !folder.collapsed && 'has-active-child')}
            onDoubleClick={() => { setRenameValue(folder.name); setRenaming(true) }}
            onClick={folder.collapsed ? onToggle : undefined}
            type="button"
          >
            <Folder className="h-3.5 w-3.5 folder-icon" />
            <span className="folder-name-text">{folder.name}</span>
            {folder.collapsed && folder.workspaceIds.length > 0 && (
              <span className="folder-count">{folder.workspaceIds.length}</span>
            )}
          </button>
        )}

        {folderState && <span className={cn('folder-state-dot', `state-${folderState}`)} />}

        <button
          aria-label={`Delete ${folder.name}`}
          className="folder-delete-btn"
          onClick={onDelete}
          type="button"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      {!folder.collapsed && !isDragOverlay && (
        <div className={cn('folder-children', isDropTarget && 'is-drop-target')}>
          <SortableContext items={folder.workspaceIds} strategy={verticalListSortingStrategy}>
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
          {folder.workspaceIds.length === 0 && (
            <div className="folder-empty-hint">Drop workspaces here</div>
          )}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────
// Background session row
// ─────────────────────────────────────────────────────

interface BackgroundSessionRowProps {
  session: SessionSnapshot
  onSelect: () => void
  onKill: () => void
}

function BackgroundSessionRow({ session, onSelect, onKill }: BackgroundSessionRowProps) {
  return (
    <div className="bg-session-item">
      <button className="bg-session-main" onClick={onSelect} type="button">
        <span className={cn('session-state-dot', `state-${session.state}`)} />
        <span className="ws-session-info">
          <span className="ws-session-title">{session.title}</span>
          <span className="ws-session-path">{session.cwd}</span>
        </span>
      </button>
      <button
        aria-label={`Kill ${session.title}`}
        className="ws-session-kill"
        onClick={onKill}
        type="button"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}

// ─────────────────────────────────────────────────────
// Main WorkspaceSidebar
// ─────────────────────────────────────────────────────

export function WorkspaceSidebar({
  workspaces,
  sidebarItems,
  sessions,
  activeWorkspaceId,
  activeSessionId,
  backgroundSessionIds,
  onSelectWorkspace,
  onDeleteWorkspace,
  onRenameWorkspace,
  onCreateWorkspace,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onToggleFolder,
  onReorderSidebarItems,
  onReorderWorkspacesInFolder,
  onMoveWorkspaceToFolder,
  onSelectSession,
  onKillSession,
  onNewSession,
}: WorkspaceSidebarProps) {
  const sMap = sessionMap(sessions)
  const wsMap = new Map(workspaces.map((w) => [w.id, w]))
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  )

  const activeDragItem = activeId
    ? sidebarItems.find((item) => {
        if (item.type === 'workspace') return item.workspaceId === activeId
        if (item.type === 'folder') return item.id === activeId
        return false
      }) ??
      sidebarItems
        .flatMap((item) =>
          item.type === 'folder'
            ? item.workspaceIds.map((wsId) => ({
                type: 'workspace' as const,
                workspaceId: wsId,
                parentFolderId: item.id,
              }))
            : [],
        )
        .find((item) => item.workspaceId === activeId)
    : null

  function handleDragStart({ active }: DragStartEvent) {
    setActiveId(active.id as string)
  }

  function handleDragOver({ over }: DragOverEvent) {
    setOverId((over?.id as string) ?? null)
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    setActiveId(null)
    setOverId(null)
    if (!over || active.id === over.id) return

    const activeIdStr = active.id as string
    const overIdStr = over.id as string

    const activeTopIdx = sidebarItems.findIndex(
      (item) =>
        (item.type === 'workspace' && item.workspaceId === activeIdStr) ||
        (item.type === 'folder' && item.id === activeIdStr),
    )

    const activeParentFolder = sidebarItems.find(
      (item): item is SidebarFolder =>
        item.type === 'folder' && item.workspaceIds.includes(activeIdStr),
    )

    const overIsFolder = sidebarItems.find(
      (item): item is SidebarFolder => item.type === 'folder' && item.id === overIdStr,
    )

    const overParentFolder = sidebarItems.find(
      (item): item is SidebarFolder =>
        item.type === 'folder' && item.workspaceIds.includes(overIdStr),
    )

    // Case 1: top-level workspace dragged onto a folder → move into folder
    if (
      !activeParentFolder &&
      overIsFolder &&
      activeTopIdx !== -1 &&
      sidebarItems[activeTopIdx].type === 'workspace'
    ) {
      onMoveWorkspaceToFolder(activeIdStr, overIdStr)
      return
    }

    // Case 2: workspace dragged out of folder to a top-level position
    if (activeParentFolder && !overParentFolder && !overIsFolder) {
      const overTopIdx = sidebarItems.findIndex(
        (item) =>
          (item.type === 'workspace' && item.workspaceId === overIdStr) ||
          (item.type === 'folder' && item.id === overIdStr),
      )
      if (overTopIdx !== -1) {
        onMoveWorkspaceToFolder(activeIdStr, null)
        return
      }
    }

    // Case 3: reorder within same folder
    if (
      activeParentFolder &&
      overParentFolder &&
      activeParentFolder.id === overParentFolder.id
    ) {
      const ids = activeParentFolder.workspaceIds
      const oldIdx = ids.indexOf(activeIdStr)
      const newIdx = ids.indexOf(overIdStr)
      if (oldIdx !== -1 && newIdx !== -1) {
        onReorderWorkspacesInFolder(activeParentFolder.id, arrayMove(ids, oldIdx, newIdx))
      }
      return
    }

    // Case 4: reorder top-level items
    if (activeTopIdx !== -1) {
      const overTopIdx = sidebarItems.findIndex(
        (item) =>
          (item.type === 'workspace' && item.workspaceId === overIdStr) ||
          (item.type === 'folder' && item.id === overIdStr),
      )
      if (overTopIdx !== -1) {
        onReorderSidebarItems(arrayMove(sidebarItems, activeTopIdx, overTopIdx))
      }
    }
  }

  const topLevelIds = sidebarItems.map((item) =>
    item.type === 'folder' ? item.id : item.workspaceId,
  )

  function handleNewFolder() {
    const folderCount = sidebarItems.filter((i) => i.type === 'folder').length
    onCreateFolder(`Folder ${folderCount + 1}`)
  }

  const bgSessions = backgroundSessionIds
    .map((id) => sessions.find((s) => s.id === id))
    .filter(Boolean) as SessionSnapshot[]

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
          {sidebarItems.map((item) => {
            if (item.type === 'folder') {
              const folderWorkspaces = item.workspaceIds
                .map((id) => wsMap.get(id))
                .filter(Boolean) as Workspace[]
              return (
                <FolderRow
                  key={item.id}
                  folder={item}
                  workspaces={folderWorkspaces}
                  sMap={sMap}
                  activeWorkspaceId={activeWorkspaceId}
                  activeSessionId={activeSessionId}
                  isDropTarget={overId === item.id}
                  onSelectWorkspace={onSelectWorkspace}
                  onDeleteWorkspace={onDeleteWorkspace}
                  onRenameWorkspace={onRenameWorkspace}
                  onSelectSession={onSelectSession}
                  onKillSession={onKillSession}
                  onToggle={() => onToggleFolder(item.id)}
                  onRename={(name) => onRenameFolder(item.id, name)}
                  onDelete={() => onDeleteFolder(item.id)}
                />
              )
            }

            const ws = wsMap.get(item.workspaceId)
            if (!ws) return null
            return (
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
            )
          })}
        </SortableContext>

        <DragOverlay dropAnimation={null}>
          {activeId && activeDragItem ? (
            activeDragItem.type === 'folder' ? (
              <FolderRow
                folder={activeDragItem as SidebarFolder}
                workspaces={[]}
                sMap={sMap}
                activeWorkspaceId={activeWorkspaceId}
                activeSessionId={activeSessionId}
                isDropTarget={false}
                isDragOverlay
                onSelectWorkspace={() => {}}
                onDeleteWorkspace={() => {}}
                onRenameWorkspace={() => {}}
                onSelectSession={() => {}}
                onKillSession={() => {}}
                onToggle={() => {}}
                onRename={() => {}}
                onDelete={() => {}}
              />
            ) : (
              <WorkspaceRow
                workspace={wsMap.get(activeId) ?? { id: activeId, name: '', sessionIds: [] }}
                sMap={sMap}
                isActive={activeId === activeWorkspaceId}
                activeSessionId={activeSessionId}
                isDragOverlay
                onSelect={() => {}}
                onDelete={() => {}}
                onRename={() => {}}
                onSelectSession={() => {}}
                onKillSession={() => {}}
              />
            )
          ) : null}
        </DragOverlay>
      </DndContext>

      {bgSessions.length > 0 && (
        <div className="bg-sessions-section">
          <div className="sidebar-section-label">Background</div>
          {bgSessions.map((session) => (
            <BackgroundSessionRow
              key={session.id}
              session={session}
              onSelect={() => onSelectSession(session.id)}
              onKill={() => onKillSession(session.id)}
            />
          ))}
        </div>
      )}

      {sidebarItems.length === 0 && bgSessions.length === 0 && (
        <div className="sidebar-empty">
          <Terminal className="h-6 w-6 opacity-20" />
          <span>No workspaces yet</span>
        </div>
      )}

      <div className="sidebar-tree-actions">
        <button className="sidebar-action-btn" onClick={onNewSession} type="button">
          <Plus className="h-3.5 w-3.5" />
          New terminal
        </button>
        <button className="sidebar-action-btn" onClick={onCreateWorkspace} type="button">
          <Layers className="h-3.5 w-3.5" />
          New workspace
        </button>
        <button className="sidebar-action-btn" onClick={handleNewFolder} type="button">
          <FolderPlus className="h-3.5 w-3.5" />
          New folder
        </button>
      </div>
    </div>
  )
}
