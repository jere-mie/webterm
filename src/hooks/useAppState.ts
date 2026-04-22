import { useCallback, useEffect, useState } from 'react'

const SCHEMA_VERSION = 2
const STORAGE_KEY = 'webterm.workspace-layout'

export interface Workspace {
  id: string
  name: string
  sessionIds: string[]
}

export interface SidebarFolder {
  type: 'folder'
  id: string
  name: string
  collapsed: boolean
  workspaceIds: string[]
}

export interface SidebarWorkspaceRef {
  type: 'workspace'
  workspaceId: string
}

export type SidebarItem = SidebarFolder | SidebarWorkspaceRef

interface PersistedLayout {
  version: 2
  workspaces: Workspace[]
  sidebarItems: SidebarItem[]
  activeWorkspaceId: string | null
  lastActiveSessionPerWorkspace: Record<string, string>
}

function makeId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`
}

function makeWorkspace(name: string): Workspace {
  return { id: makeId('ws'), name, sessionIds: [] }
}

function defaultLayout(): PersistedLayout {
  const ws = makeWorkspace('Default')
  return {
    version: 2,
    workspaces: [ws],
    sidebarItems: [{ type: 'workspace', workspaceId: ws.id }],
    activeWorkspaceId: ws.id,
    lastActiveSessionPerWorkspace: {},
  }
}

function loadLayout(): PersistedLayout {
  try {
    if (typeof window === 'undefined') return defaultLayout()
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaultLayout()
    const parsed = JSON.parse(raw) as Partial<PersistedLayout>
    if (
      parsed.version !== SCHEMA_VERSION ||
      !Array.isArray(parsed.workspaces) ||
      !Array.isArray(parsed.sidebarItems)
    ) {
      return defaultLayout()
    }
    return parsed as PersistedLayout
  } catch {
    return defaultLayout()
  }
}

function saveLayout(layout: PersistedLayout): void {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout))
  }
}

function repairSidebarItems(items: SidebarItem[], validWorkspaceIds: Set<string>): SidebarItem[] {
  const seenWorkspaces = new Set<string>()
  const result: SidebarItem[] = []

  for (const item of items) {
    if (item.type === 'workspace') {
      if (validWorkspaceIds.has(item.workspaceId) && !seenWorkspaces.has(item.workspaceId)) {
        seenWorkspaces.add(item.workspaceId)
        result.push(item)
      }
    } else {
      const validIds = item.workspaceIds.filter(
        (id) => validWorkspaceIds.has(id) && !seenWorkspaces.has(id),
      )
      for (const id of validIds) seenWorkspaces.add(id)
      result.push({ ...item, workspaceIds: validIds })
    }
  }

  // Append workspaces not referenced in sidebar yet
  for (const id of validWorkspaceIds) {
    if (!seenWorkspaces.has(id)) {
      result.push({ type: 'workspace', workspaceId: id })
    }
  }

  return result
}

function repairLayout(layout: PersistedLayout, serverSessionIds: string[]): PersistedLayout {
  const sessionSet = new Set(serverSessionIds)
  const seenSessions = new Set<string>()

  // Remove stale session IDs from workspaces; deduplicate
  const workspaces = layout.workspaces.map((ws) => ({
    ...ws,
    sessionIds: ws.sessionIds.filter((id) => {
      if (!sessionSet.has(id) || seenSessions.has(id)) return false
      seenSessions.add(id)
      return true
    }),
  }))

  const finalWorkspaces = workspaces.length > 0 ? workspaces : [makeWorkspace('Default')]
  const workspaceIds = new Set(finalWorkspaces.map((w) => w.id))
  const sidebarItems = repairSidebarItems(layout.sidebarItems, workspaceIds)

  let activeWorkspaceId = layout.activeWorkspaceId
  if (!activeWorkspaceId || !workspaceIds.has(activeWorkspaceId)) {
    activeWorkspaceId = finalWorkspaces[0].id
  }

  const lastActiveSessionPerWorkspace: Record<string, string> = {}
  for (const [wsId, sessionId] of Object.entries(layout.lastActiveSessionPerWorkspace ?? {})) {
    const ws = finalWorkspaces.find((w) => w.id === wsId)
    if (ws && sessionSet.has(sessionId) && ws.sessionIds.includes(sessionId)) {
      lastActiveSessionPerWorkspace[wsId] = sessionId
    }
  }

  return {
    version: 2,
    workspaces: finalWorkspaces,
    sidebarItems,
    activeWorkspaceId,
    lastActiveSessionPerWorkspace,
  }
}

function resolveActiveSession(
  ws: Workspace | undefined,
  lastActive: Record<string, string>,
): string | null {
  if (!ws || ws.sessionIds.length === 0) return null
  const stored = lastActive[ws.id]
  if (stored && ws.sessionIds.includes(stored)) return stored
  return ws.sessionIds[0]
}

function removeSidebarWorkspace(items: SidebarItem[], workspaceId: string): SidebarItem[] {
  return items
    .map((item): SidebarItem | null => {
      if (item.type === 'workspace' && item.workspaceId === workspaceId) return null
      if (item.type === 'folder') {
        return { ...item, workspaceIds: item.workspaceIds.filter((id) => id !== workspaceId) }
      }
      return item
    })
    .filter((item): item is SidebarItem => item !== null)
}

export interface AppStateReturn {
  workspaces: Workspace[]
  sidebarItems: SidebarItem[]
  activeWorkspaceId: string | null
  activeWorkspace: Workspace | undefined
  activeSessionId: string | null
  backgroundSessionIds: string[]
  createWorkspace: (name?: string) => string
  deleteWorkspace: (workspaceId: string) => void
  renameWorkspace: (workspaceId: string, name: string) => void
  setActiveWorkspace: (workspaceId: string) => void
  addSessionToWorkspace: (sessionId: string, workspaceId?: string) => void
  hideSessionFromWorkspace: (sessionId: string) => void
  setActiveSession: (sessionId: string) => void
  createFolder: (name: string) => string
  renameFolder: (folderId: string, name: string) => void
  deleteFolder: (folderId: string) => void
  toggleFolder: (folderId: string) => void
  reorderSidebarItems: (newItems: SidebarItem[]) => void
  reorderWorkspacesInFolder: (folderId: string, newWorkspaceIds: string[]) => void
  moveWorkspaceToFolder: (workspaceId: string, folderId: string | null) => void
}

export function useAppState(serverSessionIds: string[]): AppStateReturn {
  const [layout, setLayout] = useState<PersistedLayout>(() => {
    const stored = loadLayout()
    return repairLayout(stored, serverSessionIds)
  })

  const sessionIdsKey = serverSessionIds.join(',')

  // Re-run repair whenever server session list changes (removes stale, does NOT add new sessions)
  useEffect(() => {
    setLayout((current) => repairLayout(current, serverSessionIds))
  }, [sessionIdsKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    saveLayout(layout)
  }, [layout])

  const activeWorkspace = layout.workspaces.find((w) => w.id === layout.activeWorkspaceId)
  const activeSessionId = resolveActiveSession(activeWorkspace, layout.lastActiveSessionPerWorkspace)
  const allWorkspaceSessionIds = new Set(layout.workspaces.flatMap((w) => w.sessionIds))
  const backgroundSessionIds = serverSessionIds.filter((id) => !allWorkspaceSessionIds.has(id))

  const createWorkspace = useCallback((name?: string): string => {
    const ws = makeWorkspace(name ?? 'Workspace')
    setLayout((l) => ({
      ...l,
      workspaces: [...l.workspaces, ws],
      sidebarItems: [...l.sidebarItems, { type: 'workspace', workspaceId: ws.id }],
    }))
    return ws.id
  }, [])

  const deleteWorkspace = useCallback((workspaceId: string) => {
    setLayout((l) => {
      const workspaces = l.workspaces.filter((w) => w.id !== workspaceId)
      const sidebarItems = removeSidebarWorkspace(l.sidebarItems, workspaceId)
      const activeWorkspaceId =
        l.activeWorkspaceId === workspaceId ? (workspaces[0]?.id ?? null) : l.activeWorkspaceId
      const lastActive = { ...l.lastActiveSessionPerWorkspace }
      delete lastActive[workspaceId]
      return { ...l, workspaces, sidebarItems, activeWorkspaceId, lastActiveSessionPerWorkspace: lastActive }
    })
  }, [])

  const renameWorkspace = useCallback((workspaceId: string, name: string) => {
    setLayout((l) => ({
      ...l,
      workspaces: l.workspaces.map((w) => (w.id === workspaceId ? { ...w, name } : w)),
    }))
  }, [])

  const setActiveWorkspace = useCallback((workspaceId: string) => {
    setLayout((l) => ({ ...l, activeWorkspaceId: workspaceId }))
  }, [])

  const addSessionToWorkspace = useCallback((sessionId: string, workspaceId?: string) => {
    setLayout((l) => {
      const targetId = workspaceId ?? l.activeWorkspaceId
      if (!targetId) return l
      // Remove from any current workspace first (session can only be in one workspace)
      const workspaces = l.workspaces.map((w) => ({
        ...w,
        sessionIds: w.sessionIds.filter((id) => id !== sessionId),
      }))
      return {
        ...l,
        workspaces: workspaces.map((w) =>
          w.id === targetId ? { ...w, sessionIds: [...w.sessionIds, sessionId] } : w,
        ),
      }
    })
  }, [])

  const hideSessionFromWorkspace = useCallback((sessionId: string) => {
    setLayout((l) => ({
      ...l,
      workspaces: l.workspaces.map((w) => ({
        ...w,
        sessionIds: w.sessionIds.filter((id) => id !== sessionId),
      })),
    }))
  }, [])

  const setActiveSession = useCallback((sessionId: string) => {
    setLayout((l) => {
      if (!l.activeWorkspaceId) return l
      const ws = l.workspaces.find((w) => w.id === l.activeWorkspaceId)
      if (!ws) return l
      // If session is not in the workspace yet (clicked from background), add it first
      let workspaces = l.workspaces
      if (!ws.sessionIds.includes(sessionId)) {
        workspaces = l.workspaces.map((w) =>
          w.id === l.activeWorkspaceId ? { ...w, sessionIds: [...w.sessionIds, sessionId] } : w,
        )
      }
      return {
        ...l,
        workspaces,
        lastActiveSessionPerWorkspace: {
          ...l.lastActiveSessionPerWorkspace,
          [l.activeWorkspaceId]: sessionId,
        },
      }
    })
  }, [])

  const createFolder = useCallback((name: string): string => {
    const id = makeId('folder')
    setLayout((l) => ({
      ...l,
      sidebarItems: [
        ...l.sidebarItems,
        { type: 'folder', id, name, collapsed: false, workspaceIds: [] },
      ],
    }))
    return id
  }, [])

  const renameFolder = useCallback((folderId: string, name: string) => {
    setLayout((l) => ({
      ...l,
      sidebarItems: l.sidebarItems.map((item) =>
        item.type === 'folder' && item.id === folderId ? { ...item, name } : item,
      ),
    }))
  }, [])

  const deleteFolder = useCallback((folderId: string) => {
    setLayout((l) => {
      const folder = l.sidebarItems.find(
        (item): item is SidebarFolder => item.type === 'folder' && item.id === folderId,
      )
      if (!folder) return l
      // Move workspaces out of folder to top level
      const newItems: SidebarItem[] = []
      for (const item of l.sidebarItems) {
        if (item.type === 'folder' && item.id === folderId) {
          for (const wsId of folder.workspaceIds) {
            newItems.push({ type: 'workspace', workspaceId: wsId })
          }
        } else {
          newItems.push(item)
        }
      }
      return { ...l, sidebarItems: newItems }
    })
  }, [])

  const toggleFolder = useCallback((folderId: string) => {
    setLayout((l) => ({
      ...l,
      sidebarItems: l.sidebarItems.map((item) =>
        item.type === 'folder' && item.id === folderId
          ? { ...item, collapsed: !item.collapsed }
          : item,
      ),
    }))
  }, [])

  const reorderSidebarItems = useCallback((newItems: SidebarItem[]) => {
    setLayout((l) => ({ ...l, sidebarItems: newItems }))
  }, [])

  const reorderWorkspacesInFolder = useCallback((folderId: string, newWorkspaceIds: string[]) => {
    setLayout((l) => ({
      ...l,
      sidebarItems: l.sidebarItems.map((item) =>
        item.type === 'folder' && item.id === folderId
          ? { ...item, workspaceIds: newWorkspaceIds }
          : item,
      ),
    }))
  }, [])

  const moveWorkspaceToFolder = useCallback((workspaceId: string, folderId: string | null) => {
    setLayout((l) => {
      const itemsWithoutWs: SidebarItem[] = []
      for (const item of l.sidebarItems) {
        if (item.type === 'workspace' && item.workspaceId === workspaceId) {
          // Remove from top level
        } else if (item.type === 'folder') {
          itemsWithoutWs.push({
            ...item,
            workspaceIds: item.workspaceIds.filter((id) => id !== workspaceId),
          })
        } else {
          itemsWithoutWs.push(item)
        }
      }
      if (folderId === null) {
        return { ...l, sidebarItems: [...itemsWithoutWs, { type: 'workspace', workspaceId }] }
      }
      return {
        ...l,
        sidebarItems: itemsWithoutWs.map((item) =>
          item.type === 'folder' && item.id === folderId
            ? { ...item, workspaceIds: [...item.workspaceIds, workspaceId] }
            : item,
        ),
      }
    })
  }, [])

  return {
    workspaces: layout.workspaces,
    sidebarItems: layout.sidebarItems,
    activeWorkspaceId: layout.activeWorkspaceId,
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
  }
}
