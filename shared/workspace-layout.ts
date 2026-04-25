export const WORKSPACE_LAYOUT_VERSION = 3

export interface Workspace {
  id: string
  name: string
  sessionIds: string[]
  openSessionIds: string[]
}

export interface PersistedLayout {
  version: typeof WORKSPACE_LAYOUT_VERSION
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  lastActiveSessionPerWorkspace: Record<string, string>
}

export function makeId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`
}

export function makeWorkspace(name: string, id = makeId('ws')): Workspace {
  return { id, name, sessionIds: [], openSessionIds: [] }
}

export function normalizeWorkspace(workspace: Workspace): Workspace {
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

export function defaultLayout(): PersistedLayout {
  const workspace = makeWorkspace('Default')

  return {
    version: WORKSPACE_LAYOUT_VERSION,
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
    lastActiveSessionPerWorkspace: {},
  }
}

export function repairLayout(
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
    version: WORKSPACE_LAYOUT_VERSION,
    workspaces: finalWorkspaces,
    activeWorkspaceId,
    lastActiveSessionPerWorkspace,
  }
}

export function resolveActiveSession(
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
  if (
    currentWorkspaceId &&
    nextWorkspaces.some((workspace) => workspace.id === currentWorkspaceId)
  ) {
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

export function createWorkspace(
  layout: PersistedLayout,
  name = 'Workspace',
  workspaceId = makeId('ws'),
) {
  const workspace = makeWorkspace(name, workspaceId)

  return {
    workspaceId: workspace.id,
    layout: {
      ...layout,
      workspaces: [...layout.workspaces, workspace],
    },
  }
}

export function deleteWorkspace(layout: PersistedLayout, workspaceId: string) {
  if (layout.workspaces.length <= 1) {
    return layout
  }

  const workspaceIndex = layout.workspaces.findIndex(
    (workspace) => workspace.id === workspaceId,
  )

  if (workspaceIndex === -1) {
    return layout
  }

  const workspace = layout.workspaces[workspaceIndex]
  const remainingWorkspaces = layout.workspaces.filter(
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
    ...layout.lastActiveSessionPerWorkspace,
  }
  delete lastActiveSessionPerWorkspace[workspaceId]

  return {
    ...layout,
    workspaces,
    activeWorkspaceId: pickReplacementWorkspaceId(
      layout.workspaces,
      workspaces,
      layout.activeWorkspaceId,
    ),
    lastActiveSessionPerWorkspace,
  }
}

export function renameWorkspace(
  layout: PersistedLayout,
  workspaceId: string,
  name: string,
) {
  return {
    ...layout,
    workspaces: layout.workspaces.map((workspace) =>
      workspace.id === workspaceId ? { ...workspace, name } : workspace,
    ),
  }
}

export function setActiveWorkspace(layout: PersistedLayout, workspaceId: string) {
  return {
    ...layout,
    activeWorkspaceId: workspaceId,
  }
}

export function addSessionToWorkspace(
  layout: PersistedLayout,
  sessionId: string,
  workspaceId: string | undefined,
  options?: { open?: boolean; focus?: boolean },
) {
  const targetWorkspaceId = workspaceId ?? layout.activeWorkspaceId

  if (!targetWorkspaceId) {
    return layout
  }

  const shouldOpen = options?.open !== false
  const shouldFocus = options?.focus !== false
  const workspaces = layout.workspaces.map((workspace) => {
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
      openSessionIds: shouldOpen ? [...nextOpenSessionIds, sessionId] : nextOpenSessionIds,
    })
  })

  return {
    ...layout,
    workspaces,
    activeWorkspaceId: shouldFocus ? targetWorkspaceId : layout.activeWorkspaceId,
    lastActiveSessionPerWorkspace: shouldFocus
      ? {
          ...layout.lastActiveSessionPerWorkspace,
          [targetWorkspaceId]: sessionId,
        }
      : layout.lastActiveSessionPerWorkspace,
  }
}

export function removeSession(layout: PersistedLayout, sessionId: string) {
  const removedWorkspaceIds = new Set<string>()
  const workspaces = layout.workspaces
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
    Object.entries(layout.lastActiveSessionPerWorkspace).filter(
      ([workspaceId, activeId]) =>
        !removedWorkspaceIds.has(workspaceId) && activeId !== sessionId,
    ),
  )

  return {
    ...layout,
    workspaces,
    activeWorkspaceId: pickReplacementWorkspaceId(
      layout.workspaces,
      workspaces,
      layout.activeWorkspaceId,
    ),
    lastActiveSessionPerWorkspace,
  }
}

export function closeTab(layout: PersistedLayout, sessionId: string) {
  return {
    ...layout,
    workspaces: layout.workspaces.map((workspace) =>
      normalizeWorkspace({
        ...workspace,
        openSessionIds: workspace.openSessionIds.filter(
          (candidateId) => candidateId !== sessionId,
        ),
      }),
    ),
    lastActiveSessionPerWorkspace: Object.fromEntries(
      Object.entries(layout.lastActiveSessionPerWorkspace).filter(
        ([, activeId]) => activeId !== sessionId,
      ),
    ),
  }
}

export function setActiveSession(layout: PersistedLayout, sessionId: string) {
  const ownerWorkspace = layout.workspaces.find((workspace) =>
    workspace.sessionIds.includes(sessionId),
  )

  if (!ownerWorkspace) {
    return layout
  }

  const workspaces = layout.workspaces.map((workspace) => {
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
    ...layout,
    workspaces,
    activeWorkspaceId: ownerWorkspace.id,
    lastActiveSessionPerWorkspace: {
      ...layout.lastActiveSessionPerWorkspace,
      [ownerWorkspace.id]: sessionId,
    },
  }
}

export function moveSessionToWorkspace(
  layout: PersistedLayout,
  sessionId: string,
  targetWorkspaceId: string,
  atIndex?: number,
) {
  const sourceWorkspace = layout.workspaces.find((workspace) =>
    workspace.sessionIds.includes(sessionId),
  )

  if (!sourceWorkspace || sourceWorkspace.id === targetWorkspaceId) {
    return layout
  }

  const wasOpen = sourceWorkspace.openSessionIds.includes(sessionId)
  const workspaces = layout.workspaces.map((workspace) => {
    if (workspace.id === sourceWorkspace.id) {
      return normalizeWorkspace({
        ...workspace,
        sessionIds: workspace.sessionIds.filter((candidateId) => candidateId !== sessionId),
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

  return {
    ...layout,
    workspaces,
  }
}

export function reorderSessionsInWorkspace(
  layout: PersistedLayout,
  workspaceId: string,
  newSessionIds: string[],
) {
  return {
    ...layout,
    workspaces: layout.workspaces.map((workspace) => {
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
  }
}

export function reorderOpenTabs(
  layout: PersistedLayout,
  workspaceId: string,
  newOpenSessionIds: string[],
) {
  return {
    ...layout,
    workspaces: layout.workspaces.map((workspace) => {
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
  }
}

export function reorderWorkspaces(
  layout: PersistedLayout,
  newWorkspaceIds: string[],
) {
  const workspaceMap = new Map(
    layout.workspaces.map((workspace) => [workspace.id, workspace]),
  )
  const workspaces = newWorkspaceIds
    .map((workspaceId) => workspaceMap.get(workspaceId) ?? null)
    .filter(isWorkspace)

  for (const workspace of layout.workspaces) {
    if (!newWorkspaceIds.includes(workspace.id)) {
      workspaces.push(workspace)
    }
  }

  return {
    ...layout,
    workspaces,
  }
}
