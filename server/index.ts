import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'

import express from 'express'
import { createServer as createHttpServer } from 'node:http'
import { Server } from 'socket.io'

import type {
  AttachSessionPayload,
  CloseSessionPayload,
  HealthPayload,
  LayoutSyncPayload,
  RenameSessionPayload,
  ResizeSessionPayload,
  RestartSessionPayload,
  SessionInputPayload,
  SocketAck,
  SpawnSessionPayload,
} from '../shared/protocol.js'
import { SessionManager } from './session-manager.js'
import { listAvailableShells } from './shell.js'
import { WorkspaceLayoutStore } from './workspace-layout-store.js'

const projectRoot = process.cwd()
const host = '127.0.0.1'
const defaultPort = resolvePort(process.env.WEBTERM_PORT ?? process.env.PORT ?? '3001')
const logsDir = path.resolve(projectRoot, 'logs')
const layoutFilePath = path.join(logsDir, 'webterm-layout.json')
const runtimeStateFilePath = path.join(logsDir, 'webterm-server-state.json')

const app = express()
const httpServer = createHttpServer(app)
const io = new Server(httpServer, {
  cors: {
    origin: `http://${host}`,
  },
})

const layoutStoreRef: { current: WorkspaceLayoutStore | null } = {
  current: null,
}
const sessionManager = new SessionManager(io, {
  onSessionClosed: (sessionId) => {
    layoutStoreRef.current?.removeSession(sessionId)
  },
})
const layoutStore = new WorkspaceLayoutStore(
  io,
  layoutFilePath,
  () => sessionManager.listSessions().map((session) => session.id),
)
layoutStoreRef.current = layoutStore

app.use(express.json())

const port = await findAvailablePort(defaultPort, host)

const healthPayload: HealthPayload = {
  ok: true,
  host,
  port,
}

app.get('/api/health', (_request, response) => {
  response.json(healthPayload)
})

app.get('/api/shells', (_request, response) => {
  response.json({ shells: listAvailableShells() })
})

app.get('/api/layout', (_request, response) => {
  response.json({ layout: layoutStore.getLayout() })
})

app.get('/api/sessions', (_request, response) => {
  response.json({ sessions: sessionManager.listSessions() })
})

app.get('/api/state', (_request, response) => {
  response.json({
    layout: layoutStore.getLayout(),
    sessions: sessionManager.listSessions(),
  })
})

app.post('/api/workspaces', (request, response) => {
  try {
    const body = asRecord(request.body)
    const name = optionalString(body.name)
    const workspaceId = optionalString(body.workspaceId)
    const activate = body.activate === true
    const createdWorkspaceId = layoutStore.createWorkspace(name, workspaceId)

    if (activate) {
      layoutStore.setActiveWorkspace(createdWorkspaceId)
    }

    response.status(201).json({
      workspaceId: createdWorkspaceId,
      layout: layoutStore.getLayout(),
    })
  } catch (error) {
    sendApiError(response, error)
  }
})

app.patch('/api/workspaces/:workspaceId', (request, response) => {
  try {
    const body = asRecord(request.body)
    const { workspaceId } = request.params
    const name = optionalString(body.name)

    if (name !== undefined) {
      const trimmedName = name.trim()
      if (!trimmedName) {
        throw new Error('Workspace name cannot be empty.')
      }

      layoutStore.renameWorkspace(workspaceId, trimmedName)
    }

    if (body.activate === true) {
      layoutStore.setActiveWorkspace(workspaceId)
    }

    response.json({ layout: layoutStore.getLayout() })
  } catch (error) {
    sendApiError(response, error)
  }
})

app.delete('/api/workspaces/:workspaceId', (request, response) => {
  try {
    layoutStore.deleteWorkspace(request.params.workspaceId)
    response.json({ layout: layoutStore.getLayout() })
  } catch (error) {
    sendApiError(response, error)
  }
})

app.post('/api/workspaces/reorder', (request, response) => {
  try {
    const body = asRecord(request.body)
    layoutStore.reorderWorkspaces(requiredStringArray(body.workspaceIds, 'workspaceIds'))
    response.json({ layout: layoutStore.getLayout() })
  } catch (error) {
    sendApiError(response, error)
  }
})

app.post('/api/workspaces/:workspaceId/sessions/reorder', (request, response) => {
  try {
    const body = asRecord(request.body)
    layoutStore.reorderSessionsInWorkspace(
      request.params.workspaceId,
      requiredStringArray(body.sessionIds, 'sessionIds'),
    )
    response.json({ layout: layoutStore.getLayout() })
  } catch (error) {
    sendApiError(response, error)
  }
})

app.post('/api/workspaces/:workspaceId/tabs/reorder', (request, response) => {
  try {
    const body = asRecord(request.body)
    layoutStore.reorderOpenTabs(
      request.params.workspaceId,
      requiredStringArray(body.sessionIds, 'sessionIds'),
    )
    response.json({ layout: layoutStore.getLayout() })
  } catch (error) {
    sendApiError(response, error)
  }
})

app.post('/api/sessions', (request, response) => {
  try {
    const payload = parseSpawnPayload(request.body)
    const session = createManagedSession(payload)
    response.status(201).json({
      session,
      layout: layoutStore.getLayout(),
    })
  } catch (error) {
    sendApiError(response, error)
  }
})

app.patch('/api/sessions/:sessionId', (request, response) => {
  try {
    const body = asRecord(request.body)
    const { sessionId } = request.params
    const title = optionalString(body.title)
    const workspaceId = optionalString(body.workspaceId)
    const atIndex = optionalNumber(body.atIndex)
    const open = optionalBoolean(body.open)
    const activate = body.activate === true

    if (title !== undefined) {
      sessionManager.renameSession({ sessionId, title })
    }

    if (workspaceId !== undefined) {
      layoutStore.moveSessionToWorkspace(sessionId, workspaceId, atIndex)
    }

    if (open === false) {
      layoutStore.closeTab(sessionId)
    } else if (open === true || activate) {
      layoutStore.setActiveSession(sessionId)
    }

    response.json({
      session: sessionManager.listSessions().find((session) => session.id === sessionId) ?? null,
      layout: layoutStore.getLayout(),
    })
  } catch (error) {
    sendApiError(response, error)
  }
})

app.post('/api/sessions/:sessionId/input', (request, response) => {
  try {
    const body = asRecord(request.body)
    const data = requiredString(body.data, 'data')
    sessionManager.writeInput({
      sessionId: request.params.sessionId,
      data,
    })
    response.json({ ok: true })
  } catch (error) {
    sendApiError(response, error)
  }
})

app.post('/api/sessions/:sessionId/run', (request, response) => {
  try {
    const body = asRecord(request.body)
    const command = requiredString(body.command, 'command')
    sessionManager.writeInput({
      sessionId: request.params.sessionId,
      data: `${command}\r`,
    })
    response.json({ ok: true })
  } catch (error) {
    sendApiError(response, error)
  }
})

app.post('/api/sessions/:sessionId/restart', (request, response) => {
  try {
    const session = sessionManager.restartSession(request.params.sessionId)
    response.json({ session })
  } catch (error) {
    sendApiError(response, error)
  }
})

app.delete('/api/sessions/:sessionId', (request, response) => {
  try {
    sessionManager.closeSession({ sessionId: request.params.sessionId })
    response.json({ ok: true, layout: layoutStore.getLayout() })
  } catch (error) {
    sendApiError(response, error)
  }
})

if (process.env.NODE_ENV === 'production') {
  const clientDist = path.resolve(projectRoot, 'dist')

  app.use(express.static(clientDist))
  app.use(async (request, response, next) => {
    if (request.path.startsWith('/api') || request.path.startsWith('/socket.io')) {
      next()
      return
    }

    response.sendFile(path.join(clientDist, 'index.html'))
  })
} else {
  const { createServer } = await import('vite')
  const vite = await createServer({
    root: projectRoot,
    appType: 'custom',
    server: {
      middlewareMode: true,
      hmr: {
        server: httpServer,
      },
    },
  })

  app.use(vite.middlewares)
  app.use(async (request, response, next) => {
    if (request.path.startsWith('/api') || request.path.startsWith('/socket.io')) {
      next()
      return
    }

    try {
      const indexTemplate = await fs.readFile(
        path.resolve(projectRoot, 'index.html'),
        'utf8',
      )
      const html = await vite.transformIndexHtml(request.originalUrl, indexTemplate)
      response.status(200).set({ 'Content-Type': 'text/html' }).end(html)
    } catch (error) {
      vite.ssrFixStacktrace(error as Error)
      next(error)
    }
  })
}

io.on('connection', (socket) => {
  socket.emit('session-list', {
    sessions: sessionManager.listSessions(),
  })
  socket.emit('layout-sync', {
    layout: layoutStore.getLayout(),
  } satisfies LayoutSyncPayload)

  socket.on(
    'spawn',
    (payload: SpawnSessionPayload | undefined, respond?: (ack: SocketAck<unknown>) => void) => {
      withAck(respond, () => createManagedSession(payload ?? {}))
    },
  )

  socket.on(
    'attach',
    (
      payload: AttachSessionPayload,
      respond?: (ack: SocketAck<unknown>) => void,
    ) => {
      withAck(respond, () => sessionManager.attachSession(payload.sessionId, socket))
    },
  )

  socket.on('input', (payload: SessionInputPayload) => {
    try {
      sessionManager.writeInput(payload)
    } catch {
      // Ignore writes against sessions that were already removed.
    }
  })

  socket.on('resize', (payload: ResizeSessionPayload) => {
    try {
      sessionManager.resizeSession(payload)
    } catch {
      // Ignore resize events during reconnect churn.
    }
  })

  socket.on(
    'restart-session',
    (
      payload: RestartSessionPayload,
      respond?: (ack: SocketAck<unknown>) => void,
    ) => {
      withAck(respond, () => sessionManager.restartSession(payload.sessionId))
    },
  )

  socket.on(
    'rename-session',
    (
      payload: RenameSessionPayload,
      respond?: (ack: SocketAck<unknown>) => void,
    ) => {
      withAck(respond, () => sessionManager.renameSession(payload))
    },
  )

  socket.on(
    'close-session',
    (
      payload: CloseSessionPayload,
      respond?: (ack: SocketAck<unknown>) => void,
    ) => {
      withAck(respond, () => {
        sessionManager.closeSession(payload)
        return payload
      })
    },
  )

  socket.on('disconnect', () => {
    sessionManager.detachSocket(socket.id)
  })
})

httpServer.listen(port, host, () => {
  void writeRuntimeStateFile()
  console.log(`WebTerm listening on http://${host}:${port}`)
})

function createManagedSession(payload: SpawnSessionPayload) {
  const session = sessionManager.createSession(payload)
  layoutStore.addSessionToWorkspace(session.id, payload.workspaceId, {
    open: payload.open,
    focus: payload.focus,
  })
  return session
}

function withAck<T>(respond: ((ack: SocketAck<T>) => void) | undefined, action: () => T) {
  if (!respond) {
    action()
    return
  }

  try {
    const data = action()
    respond({
      ok: true,
      data,
    })
  } catch (error) {
    respond({
      ok: false,
      error: error instanceof Error ? error.message : 'Unexpected server error.',
    })
  }
}

function asRecord(value: unknown) {
  if (typeof value !== 'object' || value === null) {
    return {}
  }

  return value as Record<string, unknown>
}

function optionalString(value: unknown) {
  return typeof value === 'string' ? value : undefined
}

function optionalNumber(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function optionalBoolean(value: unknown) {
  return typeof value === 'boolean' ? value : undefined
}

function requiredString(value: unknown, field: string) {
  if (typeof value === 'string' && value.length > 0) {
    return value
  }

  throw new Error(`"${field}" must be a non-empty string.`)
}

function requiredStringArray(value: unknown, field: string) {
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value
  }

  throw new Error(`"${field}" must be an array of strings.`)
}

function parseSpawnPayload(value: unknown): SpawnSessionPayload {
  const payload = asRecord(value)

  return {
    shell: optionalShell(payload.shell),
    customShellPath: optionalString(payload.customShellPath),
    cwd: optionalString(payload.cwd),
    title: optionalString(payload.title),
    workspaceId: optionalString(payload.workspaceId),
    focus: optionalBoolean(payload.focus),
    open: optionalBoolean(payload.open),
    startupCommand: optionalString(payload.startupCommand),
  }
}

function optionalShell(value: unknown): SpawnSessionPayload['shell'] {
  if (
    value === 'powershell' ||
    value === 'bash' ||
    value === 'zsh' ||
    value === 'cmd' ||
    value === 'git-bash'
  ) {
    return value
  }

  return undefined
}

function sendApiError(
  response: express.Response,
  error: unknown,
) {
  response.status(400).json({
    error: error instanceof Error ? error.message : 'Unexpected server error.',
  })
}

async function writeRuntimeStateFile() {
  await fs.mkdir(logsDir, { recursive: true })
  await fs.writeFile(
    runtimeStateFilePath,
    JSON.stringify(
      {
        host,
        port,
        url: `http://${host}:${port}`,
        pid: process.pid,
      },
      null,
      2,
    ),
    'utf8',
  )
}

async function findAvailablePort(startPort: number, bindHost: string) {
  let currentPort = startPort

  while (!(await canBind(currentPort, bindHost))) {
    currentPort += 1
  }

  return currentPort
}

function canBind(portToTest: number, bindHost: string) {
  return new Promise<boolean>((resolve) => {
    const probeServer = net.createServer()

    probeServer.once('error', () => {
      resolve(false)
    })

    probeServer.once('listening', () => {
      probeServer.close(() => {
        resolve(true)
      })
    })

    probeServer.listen(portToTest, bindHost)
  })
}

function resolvePort(rawPort: string) {
  const parsedPort = Number(rawPort)

  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    throw new Error(`Invalid port value: ${rawPort}`)
  }

  return parsedPort
}
