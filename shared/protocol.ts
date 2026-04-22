export type ShellKind = 'powershell' | 'bash' | 'zsh'

export type SessionState = 'live' | 'detached' | 'exited'

export interface SessionSnapshot {
  id: string
  title: string
  cwd: string
  shell: ShellKind
  shellLabel: string
  createdAt: number
  lastActiveAt: number
  state: SessionState
  attachedClients: number
  pid: number
  cols: number
  rows: number
  exitCode: number | null
  signal: number | null
}

export interface SpawnSessionPayload {
  shell?: ShellKind
  cwd?: string
  title?: string
}

export interface AttachSessionPayload {
  sessionId: string
}

export interface CloseSessionPayload {
  sessionId: string
}

export interface RestartSessionPayload {
  sessionId: string
}

export interface ResizeSessionPayload {
  sessionId: string
  cols: number
  rows: number
}

export interface SessionInputPayload {
  sessionId: string
  data: string
}

export interface SessionListPayload {
  sessions: SessionSnapshot[]
}

export interface SessionMetaPayload {
  session: SessionSnapshot
}

export interface SessionOutputPayload {
  sessionId: string
  data: string
}

export interface SessionBufferPayload {
  sessionId: string
  data: string
}

export interface SessionResetPayload {
  sessionId: string
}

export interface SessionRemovedPayload {
  sessionId: string
}

export interface SessionExitPayload {
  sessionId: string
  exitCode: number | null
  signal: number | null
}

export interface HealthPayload {
  ok: true
  host: string
  port: number
}

export interface AckSuccess<T> {
  ok: true
  data: T
}

export interface AckFailure {
  ok: false
  error: string
}

export type SocketAck<T> = AckSuccess<T> | AckFailure