import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const STORAGE_KEY = 'webterm.workspace-layout'

export interface Workspace {
  id: string
  name: string
  sessionIds: string[]
  openSessionIds: string[]
}

interface PersistedLayout {
  version: 3
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  lastActiveSessionPerWorkspace: Record<string, string>
}

function makeId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`
}

function makeWorkspace(name: string): Workspace {
  return { id: makeId('ws'), name, sessionIds: [], openSessionIds: [] }
}

function normalizeWorkspace(workspace: Workspace): Workspace {
  const seen = new Set<string>()
  const openSessionIds: string[] = []

  for (const sessionId of workspace.openSessionIds) {
    if (seen.has(sessionId)) {
      continue
    }

    seen.add(sessionId)
    openSessionIds.push(sessionId)
  }

  const hiddenSessionIds: string[] = []

  for (const sessionId of workspace.sessionIds) {
    if (seen.has(sessionId)) {
      continue
    }

    seen.add(sessionId)
    hiddenSessionIds.push(sessionId)
  }

  return {
    ...workspace,
    sessionIds: [...openSessionIds, ...hiddenSessionIds],
    openSessionIds,
  }
}

function defaultLayout(): PersistedLayout {
  const workspace = makeWorkspace('Default')

  return {
    version: 3,
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
    lastActiveSessionPerWorkspace: {},
  }
}

function migrateFromV2(raw: Record<string, unknown>): PersistedLayout | null {
  if (!Array.isArray(raw.workspaces) || !Array.isArray(raw.sidebarItems)) {
    return null
  }

  const workspaceOrder: string[] = []

  for (const item of raw.sidebarItems as Array<{
    type: string
    workspaceId?: string
    workspaceIds?: string[]
  }>) {
    if (item.type === 'workspace' && item.workspaceId) {
      workspaceOrder.push(item.workspaceId)
    } else if (item.type === 'folder' && Array.isArray(item.workspaceIds)) {
      workspaceOrder.push(...item.workspaceIds)
    }
  }

  const workspacesById = new Map<
    string,
    { id: string; name: string; sessionIds: string[] }
  >()

  for (const workspace of raw.workspaces as Array<{
    id: string
    name: string
    sessionIds: string[]
  }>) {
    workspacesById.set(workspace.id, workspace)
  }

  const seenWorkspaceIds = new Set<string>()
  const orderedWorkspaces: Workspace[] = []

  for (const workspaceId of [...workspaceOrder, ...workspacesById.keys()]) {
    if (seenWorkspaceIds.has(workspaceId)) {
      continue
    }

    seenWorkspaceIds.add(workspaceId)
    const workspace = workspacesById.get(workspaceId)

    if (!workspace) {
      continue
    }

    orderedWorkspaces.push(
      normalizeWorkspace({
        id: workspace.id,
        name: workspace.name,
        sessionIds: workspace.sessionIds,
        openSessionIds: [...workspace.sessionIds],
      }),
    )
  }

  if (orderedWorkspaces.length === 0) {
    return null
  }

  const activeWorkspaceId =
    typeof raw.activeWorkspaceId === 'string'
      ? raw.activeWorkspaceId
      : orderedWorkspaces[0].id
  const lastActiveSessionPerWorkspace =
    typeof raw.lastActiveSessionPerWorkspace === 'object' &&
    raw.lastActiveSessionPerWorkspace !== null
      ? (raw.lastActiveSessionPerWorkspace as Record<string, string>)
      : {}

  return {
    version: 3,
    workspaces: orderedWorkspaces,
    activeWorkspaceId,
    lastActiveSessionPerWorkspace,
  }
}

function loadLayout(): PersistedLayout {
  try {
    if (typeof window === 'undefined') {
      return defaultLayout()
    }

    const raw = window.localStorage.getItem(STORAGE_KEY)

    if (!raw) {
      return defaultLayout()
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>

    if (parsed.version === 3 && Array.isArray(parsed.workspaces)) {
      return parsed as PersistedLayout
    }

    if (parsed.version === 2) {
      return migrateFromV2(parsed) ?? defaultLayout()
    }

    return defaultLayout()
  } catch {
    return defaultLayout()
  }
}

function saveLayout(layout: PersistedLayout): void {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout))
}

function repairLayout(
  layout: PersistedLayout,
  serverSessionIds: string[],
): PersistedLayout {
  const serverSessionIdSet = new Set(serverSessionIds)
  const seenSessionIds = new Set<string>()

  const workspaces = layout.workspaces.map((workspace) => {
    const sessionIds = workspace.sessionIds.filter((sessionId) => {
      if (!serverSessionIdSet.has(sessionId) || seenSessionIds.has(sessionId)) {
        return false
      }

      seenSessionIds.add(sessionId)
      return true
    })
    const sessionIdSet = new Set(sessionIds)

    return normalizeWorkspace({
      ...workspace,
      sessionIds,
      openSessionIds: (workspace.openSessionIds ?? sessionIds).filter((sessionId) =>
        sessionIdSet.has(sessionId),
      ),
    })
  })

  const finalWorkspaces =
    workspaces.length > 0 ? workspaces : [makeWorkspace('Default')]
  const workspaceIdSet = new Set(finalWorkspaces.map((workspace) => workspace.id))

  let activeWorkspaceId = layout.activeWorkspaceId
  if (!activeWorkspaceId || !workspaceIdSet.has(activeWorkspaceId)) {
    activeWorkspaceId = finalWorkspaces[0].id
  }

  const lastActiveSessionPerWorkspace: Record<string, string> = {}

  for (const [workspaceId, sessionId] of Object.entries(
    layout.lastActiveSessionPerWorkspace ?? {},
  )) {
    const workspace = finalWorkspaces.find((candidate) => candidate.id === workspaceId)

    if (workspace && workspace.openSessionIds.includes(sessionId)) {
      lastActiveSessionPerWorkspace[workspaceId] = sessionId
    }
  }

  return {
    version: 3,
    workspaces: finalWorkspaces,
    activeWorkspaceId,
    lastActiveSessionPerWorkspace,
  }
}

function resolveActiveSession(
  workspace: Workspace | undefined,
  lastActiveSessionPerWorkspace: Record<string, string>,
): string | null {
  if (!workspace || workspace.openSessionIds.length === 0) {
    return null
  }

  const storedSessionId = lastActiveSessionPerWorkspace[workspace.id]

  if (storedSessionId && workspace.openSessionIds.includes(storedSessionId)) {
    return storedSessionId
  }

  return workspace.openSessionIds[0]
}

function pickReplacementWorkspaceId(
  previousWorkspaces: Workspace[],
  nextWorkspaces: Workspace[],
  currentWorkspaceId: string | null,
) {
  if (currentWorkspaceId && nextWorkspaces.some((workspace) => workspace.id === currentWorkspaceId)) {
    return currentWorkspaceId
  }

  if (!currentWorkspaceId) {
    return nextWorkspaces[0]?.id ?? null
  }

  const previousIndex = previousWorkspaces.findIndex(
    (workspace) => workspace.id === currentWorkspaceId,
  )

  if (previousIndex === -1) {
    return nextWorkspaces[0]?.id ?? null
  }

  return nextWorkspaces[Math.min(previousIndex, nextWorkspaces.length - 1)]?.id ?? null
}

function isWorkspace(value: Workspace | null): value is Workspace {
  return value !== null
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
  removeSession: (sessionId: string) => void
  closeTab: (sessionId: string) => void
  setActiveSession: (sessionId: string) => void
  moveSessionToWorkspace: (
    sessionId: string,
    targetWorkspaceId: string,
    atIndex?: number,
  ) => void
  reorderSessionsInWorkspace: (
    workspaceId: string,
    newSessionIds: string[],
  ) => void
  reorderOpenTabs: (workspaceId: string, newOpenSessionIds: string[]) => void
  reorderWorkspaces: (newWorkspaceIds: string[]) => void
}

export function useAppState(serverSessionIds: string[]): AppStateReturn {
  const [layout, setLayout] = useState<PersistedLayout>(() => loadLayout())
  const sessionIdsKey = serverSessionIds.join(',')
  const stableServerSessionIds = useMemo(
    () => (sessionIdsKey ? sessionIdsKey.split(',') : []),
    [sessionIdsKey],
  )
  const serverSessionIdsRef = useRef(stableServerSessionIds)

  useEffect(() => {
    serverSessionIdsRef.current = stableServerSessionIds
  }, [stableServerSessionIds])

  const repairedLayout = useMemo(
    () => repairLayout(layout, stableServerSessionIds),
    [layout, stableServerSessionIds],
  )

  useEffect(() => {
    saveLayout(repairedLayout)
  }, [repairedLayout])

  const updateLayout = useCallback(
    (updater: (current: PersistedLayout) => PersistedLayout) => {
      setLayout((current) => {
        const repairedCurrent = repairLayout(current, serverSessionIdsRef.current)
        return repairLayout(updater(repairedCurrent), serverSessionIdsRef.current)
      })
    },
    [],
  )

  const activeWorkspace = repairedLayout.workspaces.find(
    (workspace) => workspace.id === repairedLayout.activeWorkspaceId,
  )
  const activeSessionId = resolveActiveSession(
    activeWorkspace,
    repairedLayout.lastActiveSessionPerWorkspace,
  )

  const createWorkspace = useCallback(
    (name?: string): string => {
      const workspace = makeWorkspace(name ?? 'Workspace')

      updateLayout((current) => ({
        ...current,
        workspaces: [...current.workspaces, workspace],
      }))

      return workspace.id
    },
    [updateLayout],
  )

  const deleteWorkspace = useCallback(
    (workspaceId: string) => {
      updateLayout((current) => {
        if (current.workspaces.length <= 1) {
          return current
        }

        const workspaceIndex = current.workspaces.findIndex(
          (workspace) => workspace.id === workspaceId,
        )

        if (workspaceIndex === -1) {
          return current
        }

        const workspace = current.workspaces[workspaceIndex]
        const remainingWorkspaces = current.workspaces.filter(
          (candidate) => candidate.id !== workspaceId,
        )
        const targetIndex = Math.min(workspaceIndex, remainingWorkspaces.length - 1)

        const workspaces = remainingWorkspaces.map((candidate, index) => {
          if (index !== targetIndex) {
            return candidate
          }

          return normalizeWorkspace({
            ...candidate,
            sessionIds: [...candidate.sessionIds, ...workspace.sessionIds],
            openSessionIds: [...candidate.openSessionIds, ...workspace.openSessionIds],
          })
        })

        const lastActiveSessionPerWorkspace = {
          ...current.lastActiveSessionPerWorkspace,
        }
        delete lastActiveSessionPerWorkspace[workspaceId]

        return {
          ...current,
          workspaces,
          activeWorkspaceId: pickReplacementWorkspaceId(
            current.workspaces,
            workspaces,
            current.activeWorkspaceId,
          ),
          lastActiveSessionPerWorkspace,
        }
      })
    },
    [updateLayout],
  )

  const renameWorkspace = useCallback(
    (workspaceId: string, name: string) => {
      updateLayout((current) => ({
        ...current,
        workspaces: current.workspaces.map((workspace) =>
          workspace.id === workspaceId ? { ...workspace, name } : workspace,
        ),
      }))
    },
    [updateLayout],
  )

  const setActiveWorkspace = useCallback(
    (workspaceId: string) => {
      updateLayout((current) => ({
        ...current,
        activeWorkspaceId: workspaceId,
      }))
    },
    [updateLayout],
  )

  const addSessionToWorkspace = useCallback(
    (sessionId: string, workspaceId?: string) => {
      updateLayout((current) => {
        const targetWorkspaceId = workspaceId ?? current.activeWorkspaceId

        if (!targetWorkspaceId) {
          return current
        }

        const workspaces = current.workspaces.map((workspace) => {
          const nextSessionIds = workspace.sessionIds.filter(
            (candidateId) => candidateId !== sessionId,
          )
          const nextOpenSessionIds = workspace.openSessionIds.filter(
            (candidateId) => candidateId !== sessionId,
          )

          if (workspace.id !== targetWorkspaceId) {
            return normalizeWorkspace({
              ...workspace,
              sessionIds: nextSessionIds,
              openSessionIds: nextOpenSessionIds,
            })
          }

          return normalizeWorkspace({
            ...workspace,
            sessionIds: [...nextSessionIds, sessionId],
            openSessionIds: [...nextOpenSessionIds, sessionId],
          })
        })

        return { ...current, workspaces }
      })
    },
    [updateLayout],
  )

  const removeSession = useCallback(
    (sessionId: string) => {
      updateLayout((current) => {
        const removedWorkspaceIds = new Set<string>()
        const workspaces = current.workspaces
          .map((workspace) => {
            if (
              !workspace.sessionIds.includes(sessionId) &&
              !workspace.openSessionIds.includes(sessionId)
            ) {
              return workspace
            }

            const sessionIds = workspace.sessionIds.filter(
              (candidateId) => candidateId !== sessionId,
            )
            const openSessionIds = workspace.openSessionIds.filter(
              (candidateId) => candidateId !== sessionId,
            )

            if (sessionIds.length === 0) {
              removedWorkspaceIds.add(workspace.id)
              return null
            }

            return normalizeWorkspace({ ...workspace, sessionIds, openSessionIds })
          })
          .filter(isWorkspace)

        const lastActiveSessionPerWorkspace = Object.fromEntries(
          Object.entries(current.lastActiveSessionPerWorkspace).filter(
            ([workspaceId, activeId]) =>
              !removedWorkspaceIds.has(workspaceId) && activeId !== sessionId,
          ),
        )

        return {
          ...current,
          workspaces,
          activeWorkspaceId: pickReplacementWorkspaceId(
            current.workspaces,
            workspaces,
            current.activeWorkspaceId,
          ),
          lastActiveSessionPerWorkspace,
        }
      })
    },
    [updateLayout],
  )

  const closeTab = useCallback(
    (sessionId: string) => {
      updateLayout((current) => ({
        ...current,
        workspaces: current.workspaces.map((workspace) =>
          normalizeWorkspace({
            ...workspace,
            openSessionIds: workspace.openSessionIds.filter(
              (candidateId) => candidateId !== sessionId,
            ),
          }),
        ),
        lastActiveSessionPerWorkspace: Object.fromEntries(
          Object.entries(current.lastActiveSessionPerWorkspace).filter(
            ([, activeId]) => activeId !== sessionId,
          ),
        ),
      }))
    },
    [updateLayout],
  )

  const setActiveSession = useCallback(
    (sessionId: string) => {
      updateLayout((current) => {
        const ownerWorkspace = current.workspaces.find((workspace) =>
          workspace.sessionIds.includes(sessionId),
        )

        if (!ownerWorkspace) {
          return current
        }

        const workspaces = current.workspaces.map((workspace) => {
          if (workspace.id !== ownerWorkspace.id) {
            return workspace
          }

          return workspace.openSessionIds.includes(sessionId)
            ? workspace
            : normalizeWorkspace({
                ...workspace,
                openSessionIds: [...workspace.openSessionIds, sessionId],
              })
        })

        return {
          ...current,
          workspaces,
          activeWorkspaceId: ownerWorkspace.id,
          lastActiveSessionPerWorkspace: {
            ...current.lastActiveSessionPerWorkspace,
            [ownerWorkspace.id]: sessionId,
          },
        }
      })
    },
    [updateLayout],
  )

  const moveSessionToWorkspace = useCallback(
    (sessionId: string, targetWorkspaceId: string, atIndex?: number) => {
      updateLayout((current) => {
        const sourceWorkspace = current.workspaces.find((workspace) =>
          workspace.sessionIds.includes(sessionId),
        )

        if (!sourceWorkspace || sourceWorkspace.id === targetWorkspaceId) {
          return current
        }

        const wasOpen = sourceWorkspace.openSessionIds.includes(sessionId)
        const workspaces = current.workspaces.map((workspace) => {
          if (workspace.id === sourceWorkspace.id) {
            return normalizeWorkspace({
              ...workspace,
              sessionIds: workspace.sessionIds.filter(
                (candidateId) => candidateId !== sessionId,
              ),
              openSessionIds: workspace.openSessionIds.filter(
                (candidateId) => candidateId !== sessionId,
              ),
            })
          }

          if (workspace.id !== targetWorkspaceId) {
            return workspace
          }

          const insertIndex =
            atIndex !== undefined
              ? Math.min(atIndex, workspace.sessionIds.length)
              : workspace.sessionIds.length
          const sessionIds = [...workspace.sessionIds]
          sessionIds.splice(insertIndex, 0, sessionId)

          const openSessionIds = wasOpen
            ? (() => {
                const nextOpenSessionIds = [...workspace.openSessionIds]
                nextOpenSessionIds.splice(
                  Math.min(insertIndex, nextOpenSessionIds.length),
                  0,
                  sessionId,
                )
                return nextOpenSessionIds
              })()
            : workspace.openSessionIds

          return normalizeWorkspace({ ...workspace, sessionIds, openSessionIds })
        })

        return { ...current, workspaces }
      })
    },
    [updateLayout],
  )

  const reorderSessionsInWorkspace = useCallback(
    (workspaceId: string, newSessionIds: string[]) => {
      updateLayout((current) => ({
        ...current,
        workspaces: current.workspaces.map((workspace) => {
          if (workspace.id !== workspaceId) {
            return workspace
          }

          const openSessionIdSet = new Set(workspace.openSessionIds)
          const nextOpenSessionIds = newSessionIds.filter((sessionId) =>
            openSessionIdSet.has(sessionId),
          )
          const hiddenSessionIds = newSessionIds.filter(
            (sessionId) => !openSessionIdSet.has(sessionId),
          )

          return normalizeWorkspace({
            ...workspace,
            sessionIds: [...nextOpenSessionIds, ...hiddenSessionIds],
            openSessionIds: nextOpenSessionIds,
          })
        }),
      }))
    },
    [updateLayout],
  )

  const reorderOpenTabs = useCallback(
    (workspaceId: string, newOpenSessionIds: string[]) => {
      updateLayout((current) => ({
        ...current,
        workspaces: current.workspaces.map((workspace) => {
          if (workspace.id !== workspaceId) {
            return workspace
          }

          const hiddenSessionIds = workspace.sessionIds.filter(
            (sessionId) => !newOpenSessionIds.includes(sessionId),
          )

          return normalizeWorkspace({
            ...workspace,
            sessionIds: [...newOpenSessionIds, ...hiddenSessionIds],
            openSessionIds: newOpenSessionIds,
          })
        }),
      }))
    },
    [updateLayout],
  )

  const reorderWorkspaces = useCallback(
    (newWorkspaceIds: string[]) => {
      updateLayout((current) => {
        const workspaceMap = new Map(
          current.workspaces.map((workspace) => [workspace.id, workspace]),
        )
        const workspaces = newWorkspaceIds
          .map((workspaceId) => workspaceMap.get(workspaceId) ?? null)
          .filter(isWorkspace)

        for (const workspace of current.workspaces) {
          if (!newWorkspaceIds.includes(workspace.id)) {
            workspaces.push(workspace)
          }
        }

        return { ...current, workspaces }
      })
    },
    [updateLayout],
  )

  return {
    workspaces: repairedLayout.workspaces,
    activeWorkspaceId: repairedLayout.activeWorkspaceId,
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
  }
}
