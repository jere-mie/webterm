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
  RenameSessionPayload,
  ResizeSessionPayload,
  RestartSessionPayload,
  SessionInputPayload,
  SocketAck,
  SpawnSessionPayload,
} from '../shared/protocol.js'
import { SessionManager } from './session-manager.js'
import { listAvailableShells } from './shell.js'

const projectRoot = process.cwd()
const host = '127.0.0.1'
const defaultPort = resolvePort(process.env.WEBTERM_PORT ?? process.env.PORT ?? '3001')

const app = express()
const httpServer = createHttpServer(app)
const io = new Server(httpServer, {
  cors: {
    origin: `http://${host}`,
  },
})

const sessionManager = new SessionManager(io)

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

  socket.on(
    'spawn',
    (payload: SpawnSessionPayload | undefined, respond?: (ack: SocketAck<unknown>) => void) => {
      withAck(respond, () => sessionManager.createSession(payload))
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
  console.log(`WebTerm listening on http://${host}:${port}`)
})

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
