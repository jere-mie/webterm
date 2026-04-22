import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'webterm.workspace-layout'

export interface Workspace {
  id: string
  name: string
  sessionIds: string[]      // all sessions in this workspace (shown in sidebar)
  openSessionIds: string[]  // currently open as tabs (subset of sessionIds)
}

interface PersistedLayout {
  version: 3
  workspaces: Workspace[]   // ordered by display position
  activeWorkspaceId: string | null
  lastActiveSessionPerWorkspace: Record<string, string>
}

function makeId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`
}

function makeWorkspace(name: string): Workspace {
  return { id: makeId('ws'), name, sessionIds: [], openSessionIds: [] }
}

function defaultLayout(): PersistedLayout {
  const ws = makeWorkspace('Default')
  return {
    version: 3,
    workspaces: [ws],
    activeWorkspaceId: ws.id,
    lastActiveSessionPerWorkspace: {},
  }
}

// Migrate from schema v2 (with folders/sidebarItems) to v3
function migrateFromV2(raw: Record<string, unknown>): PersistedLayout | null {
  if (!Array.isArray(raw.workspaces) || !Array.isArray(raw.sidebarItems)) return null

  // Flatten sidebarItems to determine workspace order
  const workspaceOrder: string[] = []
  for (const item of raw.sidebarItems as Array<{ type: string; workspaceId?: string; workspaceIds?: string[] }>) {
    if (item.type === 'workspace' && item.workspaceId) {
      workspaceOrder.push(item.workspaceId)
    } else if (item.type === 'folder' && Array.isArray(item.workspaceIds)) {
      workspaceOrder.push(...item.workspaceIds)
    }
  }

  const workspacesById = new Map<string, { id: string; name: string; sessionIds: string[] }>()
  for (const ws of raw.workspaces as Array<{ id: string; name: string; sessionIds: string[] }>) {
    workspacesById.set(ws.id, ws)
  }

  const seen = new Set<string>()
  const ordered: Workspace[] = []
  for (const id of [...workspaceOrder, ...workspacesById.keys()]) {
    if (seen.has(id)) continue
    seen.add(id)
    const ws = workspacesById.get(id)
    if (ws) {
      ordered.push({ id: ws.id, name: ws.name, sessionIds: ws.sessionIds, openSessionIds: [...ws.sessionIds] })
    }
  }

  if (ordered.length === 0) return null

  const activeWorkspaceId =
    typeof raw.activeWorkspaceId === 'string' ? raw.activeWorkspaceId : ordered[0].id
  const lastActive =
    typeof raw.lastActiveSessionPerWorkspace === 'object' && raw.lastActiveSessionPerWorkspace !== null
      ? (raw.lastActiveSessionPerWorkspace as Record<string, string>)
      : {}

  return { version: 3, workspaces: ordered, activeWorkspaceId, lastActiveSessionPerWorkspace: lastActive }
}

function loadLayout(): PersistedLayout {
  try {
    if (typeof window === 'undefined') return defaultLayout()
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaultLayout()
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (parsed.version === 3 && Array.isArray(parsed.workspaces)) {
      return parsed as unknown as PersistedLayout
    }
    if (parsed.version === 2) {
      const migrated = migrateFromV2(parsed)
      if (migrated) return migrated
    }
    return defaultLayout()
  } catch {
    return defaultLayout()
  }
}

function saveLayout(layout: PersistedLayout): void {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout))
  }
}

function repairLayout(layout: PersistedLayout, serverSessionIds: string[]): PersistedLayout {
  const sessionSet = new Set(serverSessionIds)
  const seenSessions = new Set<string>()

  const workspaces = layout.workspaces.map((ws) => {
    const sessionIds = ws.sessionIds.filter((id) => {
      if (!sessionSet.has(id) || seenSessions.has(id)) return false
      seenSessions.add(id)
      return true
    })
    const sessionIdSet = new Set(sessionIds)
    const openSessionIds = (ws.openSessionIds ?? sessionIds).filter((id) => sessionIdSet.has(id))
    return { ...ws, sessionIds, openSessionIds }
  })

  const finalWorkspaces = workspaces.length > 0 ? workspaces : [makeWorkspace('Default')]
  const workspaceIdSet = new Set(finalWorkspaces.map((w) => w.id))

  let activeWorkspaceId = layout.activeWorkspaceId
  if (!activeWorkspaceId || !workspaceIdSet.has(activeWorkspaceId)) {
    activeWorkspaceId = finalWorkspaces[0].id
  }

  const lastActiveSessionPerWorkspace: Record<string, string> = {}
  for (const [wsId, sessionId] of Object.entries(layout.lastActiveSessionPerWorkspace ?? {})) {
    const ws = finalWorkspaces.find((w) => w.id === wsId)
    if (ws && ws.openSessionIds.includes(sessionId)) {
      lastActiveSessionPerWorkspace[wsId] = sessionId
    }
  }

  return { version: 3, workspaces: finalWorkspaces, activeWorkspaceId, lastActiveSessionPerWorkspace }
}

function resolveActiveSession(
  ws: Workspace | undefined,
  lastActive: Record<string, string>,
): string | null {
  if (!ws || ws.openSessionIds.length === 0) return null
  const stored = lastActive[ws.id]
  if (stored && ws.openSessionIds.includes(stored)) return stored
  return ws.openSessionIds[0]
}

export interface AppStateReturn {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  activeWorkspace: Workspace | undefined
  activeSessionId: string | null
  createWorkspace: (name?: string) => string
  deleteWorkspace: (workspaceId: string) => void
  renameWorkspace: (workspaceId: string, name: string) => void
  setActiveWorkspace: (workspaceId: string) => void
  addSessionToWorkspace: (sessionId: string, workspaceId?: string) => void
  closeTab: (sessionId: string) => void
  setActiveSession: (sessionId: string) => void
  moveSessionToWorkspace: (sessionId: string, targetWorkspaceId: string, atIndex?: number) => void
  reorderSessionsInWorkspace: (workspaceId: string, newSessionIds: string[]) => void
  reorderOpenTabs: (workspaceId: string, newOpenSessionIds: string[]) => void
  reorderWorkspaces: (newWorkspaceIds: string[]) => void
}

export function useAppState(serverSessionIds: string[]): AppStateReturn {
  const [layout, setLayout] = useState<PersistedLayout>(() => {
    const stored = loadLayout()
    return repairLayout(stored, serverSessionIds)
  })

  const sessionIdsKey = serverSessionIds.join(',')

  useEffect(() => {
    setLayout((current) => repairLayout(current, serverSessionIds))
  }, [sessionIdsKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    saveLayout(layout)
  }, [layout])

  const activeWorkspace = layout.workspaces.find((w) => w.id === layout.activeWorkspaceId)
  const activeSessionId = resolveActiveSession(activeWorkspace, layout.lastActiveSessionPerWorkspace)

  const createWorkspace = useCallback((name?: string): string => {
    const ws = makeWorkspace(name ?? 'Workspace')
    setLayout((l) => ({ ...l, workspaces: [...l.workspaces, ws] }))
    return ws.id
  }, [])

  const deleteWorkspace = useCallback((workspaceId: string) => {
    setLayout((l) => {
      if (l.workspaces.length <= 1) return l
      const idx = l.workspaces.findIndex((w) => w.id === workspaceId)
      if (idx === -1) return l

      const ws = l.workspaces[idx]
      const remaining = l.workspaces.filter((w) => w.id !== workspaceId)
      const targetIdx = Math.min(idx, remaining.length - 1)

      // Move orphaned sessions to adjacent workspace
      const orphanedSessionIds = ws.sessionIds
      const orphanedOpenIds = ws.openSessionIds

      const finalWorkspaces = remaining.map((w, i) => {
        if (i !== targetIdx) return w
        return {
          ...w,
          sessionIds: [...w.sessionIds, ...orphanedSessionIds],
          openSessionIds: [...w.openSessionIds, ...orphanedOpenIds],
        }
      })

      const newActive =
        l.activeWorkspaceId === workspaceId
          ? (finalWorkspaces[targetIdx]?.id ?? null)
          : l.activeWorkspaceId
      const lastActive = { ...l.lastActiveSessionPerWorkspace }
      delete lastActive[workspaceId]

      return { ...l, workspaces: finalWorkspaces, activeWorkspaceId: newActive, lastActiveSessionPerWorkspace: lastActive }
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
      const withoutSession = l.workspaces.map((w) => ({
        ...w,
        sessionIds: w.sessionIds.filter((id) => id !== sessionId),
        openSessionIds: w.openSessionIds.filter((id) => id !== sessionId),
      }))
      return {
        ...l,
        workspaces: withoutSession.map((w) =>
          w.id === targetId
            ? { ...w, sessionIds: [...w.sessionIds, sessionId], openSessionIds: [...w.openSessionIds, sessionId] }
            : w,
        ),
      }
    })
  }, [])

  const closeTab = useCallback((sessionId: string) => {
    setLayout((l) => ({
      ...l,
      workspaces: l.workspaces.map((w) => ({
        ...w,
        openSessionIds: w.openSessionIds.filter((id) => id !== sessionId),
      })),
      lastActiveSessionPerWorkspace: Object.fromEntries(
        Object.entries(l.lastActiveSessionPerWorkspace).filter(([, sid]) => sid !== sessionId),
      ),
    }))
  }, [])

  const setActiveSession = useCallback((sessionId: string) => {
    setLayout((l) => {
      // Find which workspace contains this session
      const ownerWs = l.workspaces.find((w) => w.sessionIds.includes(sessionId))
      if (!ownerWs) return l

      const workspaceId = ownerWs.id
      const workspaces = l.workspaces.map((w) => {
        if (w.id !== workspaceId) return w
        const openSessionIds = w.openSessionIds.includes(sessionId)
          ? w.openSessionIds
          : [...w.openSessionIds, sessionId]
        return { ...w, openSessionIds }
      })

      return {
        ...l,
        workspaces,
        activeWorkspaceId: workspaceId,
        lastActiveSessionPerWorkspace: { ...l.lastActiveSessionPerWorkspace, [workspaceId]: sessionId },
      }
    })
  }, [])

  const moveSessionToWorkspace = useCallback(
    (sessionId: string, targetWorkspaceId: string, atIndex?: number) => {
      setLayout((l) => {
        const sourceWs = l.workspaces.find((w) => w.sessionIds.includes(sessionId))
        if (!sourceWs || sourceWs.id === targetWorkspaceId) return l

        const wasOpen = sourceWs.openSessionIds.includes(sessionId)

        const workspaces = l.workspaces.map((w) => {
          if (w.id === sourceWs.id) {
            return {
              ...w,
              sessionIds: w.sessionIds.filter((id) => id !== sessionId),
              openSessionIds: w.openSessionIds.filter((id) => id !== sessionId),
            }
          }
          if (w.id === targetWorkspaceId) {
            const insertAt =
              atIndex !== undefined ? Math.min(atIndex, w.sessionIds.length) : w.sessionIds.length
            const newSessionIds = [...w.sessionIds]
            newSessionIds.splice(insertAt, 0, sessionId)
            const newOpenIds = wasOpen
              ? (() => {
                  const arr = [...w.openSessionIds]
                  arr.splice(Math.min(insertAt, arr.length), 0, sessionId)
                  return arr
                })()
              : w.openSessionIds
            return { ...w, sessionIds: newSessionIds, openSessionIds: newOpenIds }
          }
          return w
        })

        return { ...l, workspaces }
      })
    },
    [],
  )

  const reorderSessionsInWorkspace = useCallback((workspaceId: string, newSessionIds: string[]) => {
    setLayout((l) => ({
      ...l,
      workspaces: l.workspaces.map((w) => (w.id === workspaceId ? { ...w, sessionIds: newSessionIds } : w)),
    }))
  }, [])

  const reorderOpenTabs = useCallback((workspaceId: string, newOpenSessionIds: string[]) => {
    setLayout((l) => ({
      ...l,
      workspaces: l.workspaces.map((w) =>
        w.id === workspaceId ? { ...w, openSessionIds: newOpenSessionIds } : w,
      ),
    }))
  }, [])

  const reorderWorkspaces = useCallback((newWorkspaceIds: string[]) => {
    setLayout((l) => {
      const wsMap = new Map(l.workspaces.map((w) => [w.id, w]))
      const reordered = newWorkspaceIds.map((id) => wsMap.get(id)).filter(Boolean) as Workspace[]
      for (const ws of l.workspaces) {
        if (!newWorkspaceIds.includes(ws.id)) reordered.push(ws)
      }
      return { ...l, workspaces: reordered }
    })
  }, [])

  return {
    workspaces: layout.workspaces,
    activeWorkspaceId: layout.activeWorkspaceId,
    activeWorkspace,
    activeSessionId,
    createWorkspace,
    deleteWorkspace,
    renameWorkspace,
    setActiveWorkspace,
    addSessionToWorkspace,
    closeTab,
    setActiveSession,
    moveSessionToWorkspace,
    reorderSessionsInWorkspace,
    reorderOpenTabs,
    reorderWorkspaces,
  }
}
