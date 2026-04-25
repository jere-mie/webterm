import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Socket } from 'socket.io-client'

import type { LayoutSyncPayload } from '../../shared/protocol'
import {
  defaultLayout,
  resolveActiveSession,
  type PersistedLayout,
  type Workspace,
} from '../../shared/workspace-layout'

export type { Workspace } from '../../shared/workspace-layout'

async function requestJson<T>(input: RequestInfo, init?: RequestInit) {
  const response = await fetch(input, {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  })

  const data = (await response.json()) as T | { error?: string }

  if (!response.ok) {
    const errorMessage =
      typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `Request failed with status ${response.status}.`
    throw new Error(errorMessage)
  }

  return data as T
}

export interface AppStateReturn {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  activeWorkspace: Workspace | undefined
  activeSessionId: string | null
  createWorkspace: (name?: string) => Promise<string>
  deleteWorkspace: (workspaceId: string) => Promise<void>
  renameWorkspace: (workspaceId: string, name: string) => Promise<void>
  setActiveWorkspace: (workspaceId: string) => Promise<void>
  closeTab: (sessionId: string) => Promise<void>
  setActiveSession: (sessionId: string) => Promise<void>
  moveSessionToWorkspace: (
    sessionId: string,
    targetWorkspaceId: string,
    atIndex?: number,
  ) => Promise<void>
  reorderSessionsInWorkspace: (
    workspaceId: string,
    newSessionIds: string[],
  ) => Promise<void>
  reorderOpenTabs: (workspaceId: string, newOpenSessionIds: string[]) => Promise<void>
  reorderWorkspaces: (newWorkspaceIds: string[]) => Promise<void>
}

export function useAppState(socket: Socket | null): AppStateReturn {
  const [layout, setLayout] = useState<PersistedLayout>(() => defaultLayout())

  const syncLayout = useCallback((nextLayout: PersistedLayout) => {
    setLayout(nextLayout)
  }, [])

  const syncLayoutFromResponse = useCallback(
    <T extends { layout?: PersistedLayout }>(payload: T) => {
      if (payload.layout) {
        syncLayout(payload.layout)
      }

      return payload
    },
    [syncLayout],
  )

  useEffect(() => {
    let cancelled = false

    void requestJson<{ layout: PersistedLayout }>('/api/layout')
      .then((payload) => {
        if (!cancelled) {
          syncLayout(payload.layout)
        }
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [syncLayout])

  useEffect(() => {
    if (!socket) {
      return
    }

    const handleLayoutSync = ({ layout: nextLayout }: LayoutSyncPayload) => {
      syncLayout(nextLayout)
    }

    socket.on('layout-sync', handleLayoutSync)

    return () => {
      socket.off('layout-sync', handleLayoutSync)
    }
  }, [socket, syncLayout])

  const activeWorkspace = useMemo(
    () => layout.workspaces.find((workspace) => workspace.id === layout.activeWorkspaceId),
    [layout.activeWorkspaceId, layout.workspaces],
  )
  const activeSessionId = useMemo(
    () => resolveActiveSession(activeWorkspace, layout.lastActiveSessionPerWorkspace),
    [activeWorkspace, layout.lastActiveSessionPerWorkspace],
  )

  const createWorkspace = useCallback(
    async (name?: string) => {
      const payload = await requestJson<{ workspaceId: string; layout: PersistedLayout }>(
        '/api/workspaces',
        {
          method: 'POST',
          body: JSON.stringify({ name }),
        },
      )

      syncLayout(payload.layout)
      return payload.workspaceId
    },
    [syncLayout],
  )

  const deleteWorkspace = useCallback(
    async (workspaceId: string) => {
      const payload = await requestJson<{ layout: PersistedLayout }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}`,
        {
          method: 'DELETE',
        },
      )

      syncLayoutFromResponse(payload)
    },
    [syncLayoutFromResponse],
  )

  const renameWorkspace = useCallback(
    async (workspaceId: string, name: string) => {
      await syncLayoutFromResponse(
        await requestJson<{ layout: PersistedLayout }>(
          `/api/workspaces/${encodeURIComponent(workspaceId)}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ name }),
          },
        ),
      )
    },
    [syncLayoutFromResponse],
  )

  const setActiveWorkspace = useCallback(
    async (workspaceId: string) => {
      await syncLayoutFromResponse(
        await requestJson<{ layout: PersistedLayout }>(
          `/api/workspaces/${encodeURIComponent(workspaceId)}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ activate: true }),
          },
        ),
      )
    },
    [syncLayoutFromResponse],
  )

  const closeTab = useCallback(
    async (sessionId: string) => {
      await syncLayoutFromResponse(
        await requestJson<{ layout: PersistedLayout }>(
          `/api/sessions/${encodeURIComponent(sessionId)}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ open: false }),
          },
        ),
      )
    },
    [syncLayoutFromResponse],
  )

  const setActiveSession = useCallback(
    async (sessionId: string) => {
      await syncLayoutFromResponse(
        await requestJson<{ layout: PersistedLayout }>(
          `/api/sessions/${encodeURIComponent(sessionId)}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ activate: true }),
          },
        ),
      )
    },
    [syncLayoutFromResponse],
  )

  const moveSessionToWorkspace = useCallback(
    async (sessionId: string, targetWorkspaceId: string, atIndex?: number) => {
      await syncLayoutFromResponse(
        await requestJson<{ layout: PersistedLayout }>(
          `/api/sessions/${encodeURIComponent(sessionId)}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ workspaceId: targetWorkspaceId, atIndex }),
          },
        ),
      )
    },
    [syncLayoutFromResponse],
  )

  const reorderSessionsInWorkspace = useCallback(
    async (workspaceId: string, newSessionIds: string[]) => {
      await syncLayoutFromResponse(
        await requestJson<{ layout: PersistedLayout }>(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/reorder`,
          {
            method: 'POST',
            body: JSON.stringify({ sessionIds: newSessionIds }),
          },
        ),
      )
    },
    [syncLayoutFromResponse],
  )

  const reorderOpenTabs = useCallback(
    async (workspaceId: string, newOpenSessionIds: string[]) => {
      await syncLayoutFromResponse(
        await requestJson<{ layout: PersistedLayout }>(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/tabs/reorder`,
          {
            method: 'POST',
            body: JSON.stringify({ sessionIds: newOpenSessionIds }),
          },
        ),
      )
    },
    [syncLayoutFromResponse],
  )

  const reorderWorkspaces = useCallback(
    async (newWorkspaceIds: string[]) => {
      await syncLayoutFromResponse(
        await requestJson<{ layout: PersistedLayout }>('/api/workspaces/reorder', {
          method: 'POST',
          body: JSON.stringify({ workspaceIds: newWorkspaceIds }),
        }),
      )
    },
    [syncLayoutFromResponse],
  )

  return {
    workspaces: layout.workspaces,
    activeWorkspaceId: layout.activeWorkspaceId,
    activeWorkspace,
    activeSessionId,
    createWorkspace,
    deleteWorkspace,
    renameWorkspace,
    setActiveWorkspace,
    closeTab,
    setActiveSession,
    moveSessionToWorkspace,
    reorderSessionsInWorkspace,
    reorderOpenTabs,
    reorderWorkspaces,
  }
}
