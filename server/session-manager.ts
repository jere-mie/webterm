import { randomUUID } from 'node:crypto'

import { spawn } from 'node-pty'
import type { IPty, IDisposable } from 'node-pty'
import type { Server, Socket } from 'socket.io'

import type {
  CloseSessionPayload,
  RenameSessionPayload,
  ResizeSessionPayload,
  SessionExitPayload,
  SessionInputPayload,
  SessionSnapshot,
  SessionState,
  SpawnSessionPayload,
} from '../shared/protocol.js'
import { parseShellMarkers, resolveShell, type ShellProfile } from './shell.js'

const SESSION_BUFFER_LIMIT = 240_000
const DETACH_TIMEOUT_MS = 15 * 60 * 1000
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 34

interface SessionRecord {
  id: string
  title: string
  customTitle: boolean
  cwd: string
  shell: ShellProfile
  state: SessionState
  createdAt: number
  lastActiveAt: number
  attachedSockets: Set<string>
  pty: IPty
  cols: number
  rows: number
  exitCode: number | null
  signal: number | null
  buffer: string
  pendingChunk: string
  subscriptions: IDisposable[]
  detachTimer: NodeJS.Timeout | null
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>()

  constructor(private readonly io: Server) {}

  listSessions() {
    return [...this.sessions.values()]
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((session) => this.toSnapshot(session))
  }

  createSession(options: SpawnSessionPayload = {}) {
    const shell = resolveShell(options.shell)
    const cwd = normalizeCwd(options.cwd ?? defaultWorkingDirectory())
    const now = Date.now()
    const id = randomUUID()
    const customTitle = !!(options.title?.trim())
    const title = customTitle ? options.title!.trim() : shell.label
    const session = this.spawnSessionRecord({
      id,
      cwd,
      shell,
      title,
      customTitle,
      createdAt: now,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
    })

    this.sessions.set(id, session)
    this.emitSessionList()

    return this.toSnapshot(session)
  }

  attachSession(sessionId: string, socket: Socket) {
    const session = this.requireSession(sessionId)

    if (session.detachTimer) {
      clearTimeout(session.detachTimer)
      session.detachTimer = null
    }

    session.attachedSockets.add(socket.id)
    socket.join(roomName(session.id))

    if (session.state === 'detached') {
      session.state = 'live'
    }

    socket.emit('session-buffer', {
      sessionId: session.id,
      data: session.buffer,
    })
    socket.emit('session-meta', {
      session: this.toSnapshot(session),
    })

    this.emitSessionList()

    return this.toSnapshot(session)
  }

  detachSocket(socketId: string) {
    for (const session of this.sessions.values()) {
      if (!session.attachedSockets.delete(socketId)) {
        continue
      }

      if (session.attachedSockets.size === 0 && session.state === 'live') {
        session.state = 'detached'
        session.detachTimer = setTimeout(() => {
          const activeSession = this.sessions.get(session.id)

          if (!activeSession || activeSession.attachedSockets.size > 0) {
            return
          }

          this.closeSession({ sessionId: session.id })
        }, DETACH_TIMEOUT_MS)
      }

      this.emitSessionMeta(session)
    }

    this.emitSessionList()
  }

  writeInput(payload: SessionInputPayload) {
    const session = this.requireSession(payload.sessionId)

    if (session.state === 'exited') {
      return
    }

    session.lastActiveAt = Date.now()
    session.pty.write(payload.data)
  }

  resizeSession(payload: ResizeSessionPayload) {
    const session = this.requireSession(payload.sessionId)

    session.cols = Math.max(40, payload.cols)
    session.rows = Math.max(12, payload.rows)

    if (session.state !== 'exited') {
      session.pty.resize(session.cols, session.rows)
    }

    this.emitSessionMeta(session)
  }

  restartSession(sessionId: string) {
    const session = this.requireSession(sessionId)
    const nextShell = resolveShell(session.shell.kind)
    const cwd = normalizeCwd(session.cwd)

    this.disposeSessionRuntime(session)
    session.buffer = ''
    session.pendingChunk = ''
    session.shell = nextShell
    session.title = nextShell.label
    session.customTitle = false
    session.cwd = cwd
    session.state = session.attachedSockets.size > 0 ? 'live' : 'detached'
    session.exitCode = null
    session.signal = null
    session.lastActiveAt = Date.now()
    this.io.to(roomName(session.id)).emit('session-reset', {
      sessionId: session.id,
    })
    this.hydrateRuntime(session)
    this.emitSessionMeta(session)
    this.emitSessionList()

    return this.toSnapshot(session)
  }

  closeSession(payload: CloseSessionPayload) {
    const session = this.sessions.get(payload.sessionId)

    if (!session) {
      return
    }

    this.sessions.delete(session.id)
    this.disposeSessionRuntime(session)
    this.io.emit('session-removed', {
      sessionId: session.id,
    })
    this.emitSessionList()
  }

  renameSession(payload: RenameSessionPayload) {
    const session = this.requireSession(payload.sessionId)
    const trimmed = payload.title.trim()

    if (!trimmed) {
      return this.toSnapshot(session)
    }

    session.title = trimmed
    session.customTitle = true
    this.emitSessionMeta(session)
    this.emitSessionList()

    return this.toSnapshot(session)
  }

  private spawnSessionRecord(options: {
    id: string
    cwd: string
    shell: ShellProfile
    title: string
    customTitle: boolean
    createdAt: number
    cols: number
    rows: number
  }) {
    const initialPty = spawn(options.shell.command, options.shell.args, {
      name: 'xterm-256color',
      cwd: options.cwd,
      cols: options.cols,
      rows: options.rows,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
    })

    const session: SessionRecord = {
      id: options.id,
      title: options.title,
      customTitle: options.customTitle,
      cwd: options.cwd,
      shell: options.shell,
      state: 'detached',
      createdAt: options.createdAt,
      lastActiveAt: options.createdAt,
      attachedSockets: new Set<string>(),
      pty: initialPty,
      cols: options.cols,
      rows: options.rows,
      exitCode: null,
      signal: null,
      buffer: '',
      pendingChunk: '',
      subscriptions: [],
      detachTimer: null,
    }

    this.hydrateRuntime(session)

    return session
  }

  private hydrateRuntime(session: SessionRecord) {
    const outputSubscription = session.pty.onData((chunk) => {
      this.handleOutput(session, chunk)
    })

    const exitSubscription = session.pty.onExit(({ exitCode, signal }) => {
      session.state = 'exited'
      session.exitCode = exitCode ?? null
      session.signal = typeof signal === 'number' ? signal : null
      session.lastActiveAt = Date.now()

      const exitPayload: SessionExitPayload = {
        sessionId: session.id,
        exitCode: session.exitCode,
        signal: session.signal,
      }

      this.io.to(roomName(session.id)).emit('session-exit', exitPayload)
      this.emitSessionMeta(session)
      this.emitSessionList()
    })

    session.subscriptions = [outputSubscription, exitSubscription]

    const initScript = `${session.shell.initCommands.join('\r')}\r`
    setTimeout(() => {
      if (this.sessions.has(session.id) || session.state !== 'exited') {
        session.pty.write(initScript)
      }
    }, 40)
  }

  private disposeSessionRuntime(session: SessionRecord) {
    if (session.detachTimer) {
      clearTimeout(session.detachTimer)
      session.detachTimer = null
    }

    for (const subscription of session.subscriptions) {
      subscription.dispose()
    }

    session.subscriptions = []

    try {
      session.pty.kill()
    } catch {
      // Ignore shutdown races from already-exited PTYs.
    }
  }

  private handleOutput(session: SessionRecord, chunk: string) {
    const { cleanChunk, cwd, title, pendingChunk } = parseShellMarkers(
      chunk,
      session.pendingChunk,
    )

    session.pendingChunk = pendingChunk
    session.lastActiveAt = Date.now()

    let needsMeta = false

    if (title && !session.customTitle && title !== session.title) {
      session.title = title
      needsMeta = true
    }

    if (cwd && cwd !== session.cwd) {
      session.cwd = normalizeCwd(cwd)
      needsMeta = true
    }

    if (needsMeta) {
      this.emitSessionMeta(session)
      this.emitSessionList()
    }

    if (!cleanChunk) {
      return
    }

    session.buffer = appendChunk(session.buffer, cleanChunk)
    this.io.to(roomName(session.id)).emit('output', {
      sessionId: session.id,
      data: cleanChunk,
    })
  }

  private emitSessionMeta(session: SessionRecord) {
    this.io.emit('session-meta', {
      session: this.toSnapshot(session),
    })
  }

  private emitSessionList() {
    this.io.emit('session-list', {
      sessions: this.listSessions(),
    })
  }

  private requireSession(sessionId: string) {
    const session = this.sessions.get(sessionId)

    if (!session) {
      throw new Error(`Session ${sessionId} was not found.`)
    }

    return session
  }

  private toSnapshot(session: SessionRecord): SessionSnapshot {
    return {
      id: session.id,
      title: session.title,
      cwd: session.cwd,
      shell: session.shell.kind,
      shellLabel: session.shell.label,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
      state: session.state,
      attachedClients: session.attachedSockets.size,
      pid: session.pty.pid,
      cols: session.cols,
      rows: session.rows,
      exitCode: session.exitCode,
      signal: session.signal,
    }
  }
}

function appendChunk(buffer: string, chunk: string) {
  const nextBuffer = `${buffer}${chunk}`

  if (nextBuffer.length <= SESSION_BUFFER_LIMIT) {
    return nextBuffer
  }

  return nextBuffer.slice(nextBuffer.length - SESSION_BUFFER_LIMIT)
}

function defaultWorkingDirectory() {
  return process.env.HOME ?? process.env.USERPROFILE ?? process.cwd()
}

function normalizeCwd(cwd: string) {
  return cwd.replace(/[\\/]+$/, '') || cwd
}

function roomName(sessionId: string) {
  return `session:${sessionId}`
}