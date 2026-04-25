import fs from 'node:fs'
import path from 'node:path'

import type { Server } from 'socket.io'

import {
  addSessionToWorkspace,
  closeTab,
  createWorkspace,
  defaultLayout,
  deleteWorkspace,
  moveSessionToWorkspace,
  removeSession,
  renameWorkspace,
  reorderOpenTabs,
  reorderSessionsInWorkspace,
  reorderWorkspaces,
  repairLayout,
  setActiveSession,
  setActiveWorkspace,
  type PersistedLayout,
} from '../shared/workspace-layout.js'

export class WorkspaceLayoutStore {
  private layout: PersistedLayout

  constructor(
    private readonly io: Server,
    private readonly layoutFilePath: string,
    private readonly listSessionIds: () => string[],
  ) {
    this.layout = repairLayout(this.loadLayout(), this.listSessionIds())
    this.persist()
  }

  getLayout() {
    return this.layout
  }

  syncSessions() {
    this.applyLayout(repairLayout(this.layout, this.listSessionIds()))
  }

  createWorkspace(name?: string, workspaceId?: string) {
    const result = createWorkspace(this.layout, name, workspaceId)
    this.applyLayout(result.layout)
    return result.workspaceId
  }

  renameWorkspace(workspaceId: string, name: string) {
    this.applyLayout(renameWorkspace(this.layout, workspaceId, name))
  }

  deleteWorkspace(workspaceId: string) {
    this.applyLayout(deleteWorkspace(this.layout, workspaceId))
  }

  setActiveWorkspace(workspaceId: string) {
    this.applyLayout(setActiveWorkspace(this.layout, workspaceId))
  }

  addSessionToWorkspace(
    sessionId: string,
    workspaceId?: string,
    options?: { open?: boolean; focus?: boolean },
  ) {
    this.applyLayout(addSessionToWorkspace(this.layout, sessionId, workspaceId, options))
  }

  removeSession(sessionId: string) {
    this.applyLayout(removeSession(this.layout, sessionId))
  }

  closeTab(sessionId: string) {
    this.applyLayout(closeTab(this.layout, sessionId))
  }

  setActiveSession(sessionId: string) {
    this.applyLayout(setActiveSession(this.layout, sessionId))
  }

  moveSessionToWorkspace(sessionId: string, targetWorkspaceId: string, atIndex?: number) {
    this.applyLayout(moveSessionToWorkspace(this.layout, sessionId, targetWorkspaceId, atIndex))
  }

  reorderSessionsInWorkspace(workspaceId: string, newSessionIds: string[]) {
    this.applyLayout(reorderSessionsInWorkspace(this.layout, workspaceId, newSessionIds))
  }

  reorderOpenTabs(workspaceId: string, newOpenSessionIds: string[]) {
    this.applyLayout(reorderOpenTabs(this.layout, workspaceId, newOpenSessionIds))
  }

  reorderWorkspaces(newWorkspaceIds: string[]) {
    this.applyLayout(reorderWorkspaces(this.layout, newWorkspaceIds))
  }

  private applyLayout(nextLayout: PersistedLayout) {
    this.layout = repairLayout(nextLayout, this.listSessionIds())
    this.persist()
    this.io.emit('layout-sync', {
      layout: this.layout,
    })
  }

  private loadLayout() {
    try {
      const raw = fs.readFileSync(this.layoutFilePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<PersistedLayout>

      if (
        parsed.version === 3 &&
        Array.isArray(parsed.workspaces) &&
        typeof parsed.lastActiveSessionPerWorkspace === 'object' &&
        parsed.lastActiveSessionPerWorkspace !== null
      ) {
        return parsed as PersistedLayout
      }
    } catch {
      return defaultLayout()
    }

    return defaultLayout()
  }

  private persist() {
    fs.mkdirSync(path.dirname(this.layoutFilePath), { recursive: true })
    fs.writeFileSync(this.layoutFilePath, JSON.stringify(this.layout, null, 2), 'utf8')
  }
}
