import { useCallback, useEffect, useState } from 'react'

// Schema version — bump when the shape changes to trigger migration
const SCHEMA_VERSION = 1
const STORAGE_KEY = 'webterm.workspace-layout'

export interface WorkspaceFolder {
  type: 'folder'
  id: string
  name: string
  collapsed: boolean
  sessionIds: string[]
}

export interface WorkspaceSession {
  type: 'session'
  sessionId: string
}

export type WorkspaceItem = WorkspaceFolder | WorkspaceSession

export interface WorkspaceLayout {
  version: number
  items: WorkspaceItem[]
}

function emptyLayout(): WorkspaceLayout {
  return { version: SCHEMA_VERSION, items: [] }
}

function loadLayout(): WorkspaceLayout {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return emptyLayout()
    const parsed = JSON.parse(raw) as Partial<WorkspaceLayout>
    if (parsed.version !== SCHEMA_VERSION || !Array.isArray(parsed.items)) {
      return emptyLayout()
    }
    return parsed as WorkspaceLayout
  } catch {
    return emptyLayout()
  }
}

function saveLayout(layout: WorkspaceLayout) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout))
}

function repairLayout(layout: WorkspaceLayout, sessionIds: string[]): WorkspaceLayout {
  const sessionSet = new Set(sessionIds)
  const seen = new Set<string>()

  const repairedItems = layout.items
    .map((item): WorkspaceItem | null => {
      if (item.type === 'folder') {
        const keptSessions = item.sessionIds.filter((id) => {
          if (!sessionSet.has(id) || seen.has(id)) return false
          seen.add(id)
          return true
        })
        return { ...item, sessionIds: keptSessions }
      } else {
        if (!sessionSet.has(item.sessionId) || seen.has(item.sessionId)) return null
        seen.add(item.sessionId)
        return item
      }
    })
    .filter((item): item is WorkspaceItem => item !== null)

  // Append any sessions not yet tracked
  const newItems: WorkspaceItem[] = []
  for (const id of sessionIds) {
    if (!seen.has(id)) {
      newItems.push({ type: 'session', sessionId: id })
    }
  }

  return { version: SCHEMA_VERSION, items: [...repairedItems, ...newItems] }
}

export function useWorkspaceLayout(sessionIds: string[]) {
  const [layout, setLayout] = useState<WorkspaceLayout>(() => {
    const stored = loadLayout()
    return repairLayout(stored, sessionIds)
  })

  // Sync layout when session list changes
  useEffect(() => {
    setLayout((current) => repairLayout(current, sessionIds))
  }, [sessionIds.join(',')])  // eslint-disable-line react-hooks/exhaustive-deps

  // Persist whenever layout changes
  useEffect(() => {
    saveLayout(layout)
  }, [layout])

  const createFolder = useCallback((name: string) => {
    const folder: WorkspaceFolder = {
      type: 'folder',
      id: `folder-${Date.now()}`,
      name,
      collapsed: false,
      sessionIds: [],
    }
    setLayout((l) => ({ ...l, items: [...l.items, folder] }))
    return folder.id
  }, [])

  const renameFolder = useCallback((folderId: string, name: string) => {
    setLayout((l) => ({
      ...l,
      items: l.items.map((item) =>
        item.type === 'folder' && item.id === folderId ? { ...item, name } : item,
      ),
    }))
  }, [])

  const toggleFolder = useCallback((folderId: string) => {
    setLayout((l) => ({
      ...l,
      items: l.items.map((item) =>
        item.type === 'folder' && item.id === folderId
          ? { ...item, collapsed: !item.collapsed }
          : item,
      ),
    }))
  }, [])

  const deleteFolder = useCallback((folderId: string) => {
    setLayout((l) => {
      const folder = l.items.find(
        (item): item is WorkspaceFolder => item.type === 'folder' && item.id === folderId,
      )
      if (!folder) return l

      // Move folder's sessions to top level before the folder's position
      const insertedSessions: WorkspaceItem[] = folder.sessionIds.map((id) => ({
        type: 'session',
        sessionId: id,
      }))

      const newItems: WorkspaceItem[] = []
      for (const item of l.items) {
        if (item.type === 'folder' && item.id === folderId) {
          newItems.push(...insertedSessions)
        } else {
          newItems.push(item)
        }
      }

      return { ...l, items: newItems }
    })
  }, [])

  const moveSessionToFolder = useCallback((sessionId: string, targetFolderId: string | null) => {
    setLayout((l) => {
      // Remove session from its current location
      const itemsWithoutSession = l.items
        .map((item): WorkspaceItem => {
          if (item.type === 'folder') {
            return { ...item, sessionIds: item.sessionIds.filter((id) => id !== sessionId) }
          }
          return item
        })
        .filter((item): item is WorkspaceItem => {
          if (item.type === 'session') return item.sessionId !== sessionId
          return true
        })

      if (targetFolderId === null) {
        // Move to top level (at the end)
        return {
          ...l,
          items: [...itemsWithoutSession, { type: 'session', sessionId }],
        }
      }

      // Add to target folder
      const newItems = itemsWithoutSession.map((item): WorkspaceItem => {
        if (item.type === 'folder' && item.id === targetFolderId) {
          return { ...item, sessionIds: [...item.sessionIds, sessionId] }
        }
        return item
      })

      return { ...l, items: newItems }
    })
  }, [])

  const reorderItems = useCallback((newItems: WorkspaceItem[]) => {
    setLayout((l) => ({ ...l, items: newItems }))
  }, [])

  const reorderSessionsInFolder = useCallback(
    (folderId: string, newSessionIds: string[]) => {
      setLayout((l) => ({
        ...l,
        items: l.items.map((item) =>
          item.type === 'folder' && item.id === folderId
            ? { ...item, sessionIds: newSessionIds }
            : item,
        ),
      }))
    },
    [],
  )

  return {
    layout,
    createFolder,
    renameFolder,
    toggleFolder,
    deleteFolder,
    moveSessionToFolder,
    reorderItems,
    reorderSessionsInFolder,
  }
}
