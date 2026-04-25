#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'

const SCRIPT_COMMANDS = new Map([
  ['dev', 'dev'],
  ['build', 'build'],
  ['lint', 'lint'],
  ['start', 'start'],
  ['start-background', 'start:background'],
  ['stop-background', 'stop:background'],
  ['build-start', 'build:start'],
  ['build-start-background', 'build:start:background'],
])

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'WebTerm command failed.')
  process.exit(1)
})

async function main() {
  const { args, json, help, server } = consumeGlobalOptions(process.argv.slice(2))
  const [command, ...rest] = args

  if (!command || help || command === 'help') {
    printHelp()
    return
  }

  const scriptName = SCRIPT_COMMANDS.get(command)
  if (scriptName) {
    await runScript(scriptName, rest)
    return
  }

  const baseUrl = await resolveServerBaseUrl(server)

  switch (command) {
    case 'status':
      await handleStatus(baseUrl, json)
      return
    case 'state':
      await printMaybeJson(json, await apiRequest(baseUrl, '/api/state'))
      return
    case 'shells':
      await handleShells(baseUrl, json)
      return
    case 'workspaces':
    case 'workspace':
      await handleWorkspaces(baseUrl, rest, json)
      return
    case 'sessions':
    case 'session':
      await handleSessions(baseUrl, rest, json)
      return
    default:
      throw new Error(`Unknown command: ${command}`)
  }
}

function consumeGlobalOptions(argv) {
  const args = []
  let json = false
  let help = false
  let server

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]

    if (value === '--json' || value === '-j') {
      json = true
      continue
    }

    if (value === '--help' || value === '-h') {
      help = true
      continue
    }

    if (value === '--server') {
      server = argv[index + 1]
      index += 1
      continue
    }

    args.push(value)
  }

  return { args, json, help, server }
}

async function handleStatus(baseUrl, json) {
  const health = await apiRequest(baseUrl, '/api/health')

  if (json) {
    printJson({
      ...health,
      url: `http://${health.host}:${health.port}`,
    })
    return
  }

  console.log(`WebTerm is running at http://${health.host}:${health.port}`)
}

async function handleShells(baseUrl, json) {
  const payload = await apiRequest(baseUrl, '/api/shells')

  if (json) {
    printJson(payload)
    return
  }

  for (const shell of payload.shells) {
    console.log(`${shell.kind}\t${shell.label}`)
  }
}

async function handleWorkspaces(baseUrl, argv, json) {
  const [subcommand, ...rest] = argv

  switch (subcommand) {
    case 'list':
    case undefined: {
      const state = await apiRequest(baseUrl, '/api/state')

      if (json) {
        printJson(state.layout)
        return
      }

      for (const workspace of state.layout.workspaces) {
        const marker = workspace.id === state.layout.activeWorkspaceId ? '*' : ' '
        console.log(
          `${marker} ${workspace.id}\t${workspace.name}\t${workspace.openSessionIds.length}/${workspace.sessionIds.length} open`,
        )
      }
      return
    }
    case 'create': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          activate: { type: 'boolean' },
        },
        allowPositionals: true,
      })
      const name = positionals.join(' ') || undefined
      const payload = await apiRequest(baseUrl, '/api/workspaces', {
        method: 'POST',
        body: { name, activate: values.activate === true },
      })

      if (json) {
        printJson(payload)
        return
      }

      console.log(`Created workspace ${payload.workspaceId}`)
      return
    }
    case 'rename': {
      const [workspaceToken, ...nameParts] = rest
      if (!workspaceToken || nameParts.length === 0) {
        throw new Error('Usage: webterm workspaces rename <workspace> <name>')
      }

      const state = await apiRequest(baseUrl, '/api/state')
      const workspaceId = resolveWorkspaceId(state.layout, workspaceToken)
      const payload = await apiRequest(baseUrl, `/api/workspaces/${encodeURIComponent(workspaceId)}`, {
        method: 'PATCH',
        body: { name: nameParts.join(' ') },
      })

      if (json) {
        printJson(payload)
        return
      }

      console.log(`Renamed workspace ${workspaceId}`)
      return
    }
    case 'delete': {
      const [workspaceToken] = rest
      if (!workspaceToken) {
        throw new Error('Usage: webterm workspaces delete <workspace>')
      }

      const state = await apiRequest(baseUrl, '/api/state')
      const workspaceId = resolveWorkspaceId(state.layout, workspaceToken)
      const payload = await apiRequest(baseUrl, `/api/workspaces/${encodeURIComponent(workspaceId)}`, {
        method: 'DELETE',
      })

      if (json) {
        printJson(payload)
        return
      }

      console.log(`Deleted workspace ${workspaceId}`)
      return
    }
    case 'activate': {
      const [workspaceToken] = rest
      if (!workspaceToken) {
        throw new Error('Usage: webterm workspaces activate <workspace>')
      }

      const state = await apiRequest(baseUrl, '/api/state')
      const workspaceId = resolveWorkspaceId(state.layout, workspaceToken)
      const payload = await apiRequest(baseUrl, `/api/workspaces/${encodeURIComponent(workspaceId)}`, {
        method: 'PATCH',
        body: { activate: true },
      })

      if (json) {
        printJson(payload)
        return
      }

      console.log(`Activated workspace ${workspaceId}`)
      return
    }
    case 'reorder': {
      if (rest.length === 0) {
        throw new Error('Usage: webterm workspaces reorder <workspace> <workspace> ...')
      }

      const state = await apiRequest(baseUrl, '/api/state')
      const workspaceIds = rest.map((workspaceToken) =>
        resolveWorkspaceId(state.layout, workspaceToken),
      )
      const payload = await apiRequest(baseUrl, '/api/workspaces/reorder', {
        method: 'POST',
        body: { workspaceIds },
      })

      if (json) {
        printJson(payload)
        return
      }

      console.log('Reordered workspaces')
      return
    }
    default:
      throw new Error(
        'Usage: webterm workspaces [list|create|rename|delete|activate|reorder] ...',
      )
  }
}

async function handleSessions(baseUrl, argv, json) {
  const [subcommand, ...rest] = argv

  switch (subcommand) {
    case 'list':
    case undefined: {
      const { values } = parseArgs({
        args: rest,
        options: {
          workspace: { type: 'string' },
        },
        allowPositionals: true,
      })
      const state = await apiRequest(baseUrl, '/api/state')
      const sessions = values.workspace
        ? filterSessionsByWorkspace(state, values.workspace)
        : state.sessions.map((session) => ({
            ...session,
            workspace: findWorkspaceForSession(state.layout, session.id),
          }))

      if (json) {
        printJson({ sessions })
        return
      }

      for (const entry of sessions) {
        const workspace = entry.workspace
        console.log(
          `${entry.id}\t${entry.state}\t${workspace ? workspace.name : '-'}\t${entry.title}\t${entry.cwd}`,
        )
      }
      return
    }
    case 'create': {
      const { values } = parseArgs({
        args: rest,
        options: {
          workspace: { type: 'string' },
          title: { type: 'string' },
          cwd: { type: 'string' },
          shell: { type: 'string' },
          'custom-shell-path': { type: 'string' },
          command: { type: 'string' },
          'no-focus': { type: 'boolean' },
          closed: { type: 'boolean' },
        },
        allowPositionals: true,
      })
      const state = await apiRequest(baseUrl, '/api/state')
      const workspaceId = values.workspace
        ? resolveWorkspaceId(state.layout, values.workspace)
        : undefined
      const payload = await apiRequest(baseUrl, '/api/sessions', {
        method: 'POST',
        body: {
          workspaceId,
          title: values.title,
          cwd: values.cwd,
          shell: values.shell,
          customShellPath: values['custom-shell-path'],
          startupCommand: values.command,
          focus: values['no-focus'] === true ? false : undefined,
          open: values.closed === true ? false : undefined,
        },
      })

      if (json) {
        printJson(payload)
        return
      }

      console.log(`Created session ${payload.session.id}`)
      return
    }
    case 'rename': {
      const [sessionId, ...titleParts] = rest
      if (!sessionId || titleParts.length === 0) {
        throw new Error('Usage: webterm sessions rename <sessionId> <title>')
      }

      const payload = await apiRequest(baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'PATCH',
        body: { title: titleParts.join(' ') },
      })

      if (json) {
        printJson(payload)
        return
      }

      console.log(`Renamed session ${sessionId}`)
      return
    }
    case 'activate': {
      const [sessionId] = rest
      if (!sessionId) {
        throw new Error('Usage: webterm sessions activate <sessionId>')
      }

      const payload = await apiRequest(baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'PATCH',
        body: { activate: true },
      })

      if (json) {
        printJson(payload)
        return
      }

      console.log(`Activated session ${sessionId}`)
      return
    }
    case 'hide': {
      const [sessionId] = rest
      if (!sessionId) {
        throw new Error('Usage: webterm sessions hide <sessionId>')
      }

      const payload = await apiRequest(baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'PATCH',
        body: { open: false },
      })

      if (json) {
        printJson(payload)
        return
      }

      console.log(`Hid session ${sessionId}`)
      return
    }
    case 'move': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          index: { type: 'string' },
        },
        allowPositionals: true,
      })
      const [sessionId, workspaceToken] = positionals
      if (!sessionId || !workspaceToken) {
        throw new Error('Usage: webterm sessions move <sessionId> <workspace> [--index N]')
      }

      const state = await apiRequest(baseUrl, '/api/state')
      const workspaceId = resolveWorkspaceId(state.layout, workspaceToken)
      const atIndex = values.index === undefined ? undefined : Number.parseInt(values.index, 10)
      const payload = await apiRequest(baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'PATCH',
        body: { workspaceId, atIndex },
      })

      if (json) {
        printJson(payload)
        return
      }

      console.log(`Moved session ${sessionId} to workspace ${workspaceId}`)
      return
    }
    case 'kill': {
      const [sessionId] = rest
      if (!sessionId) {
        throw new Error('Usage: webterm sessions kill <sessionId>')
      }

      const payload = await apiRequest(baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
      })

      if (json) {
        printJson(payload)
        return
      }

      console.log(`Killed session ${sessionId}`)
      return
    }
    case 'restart': {
      const [sessionId] = rest
      if (!sessionId) {
        throw new Error('Usage: webterm sessions restart <sessionId>')
      }

      const payload = await apiRequest(
        baseUrl,
        `/api/sessions/${encodeURIComponent(sessionId)}/restart`,
        {
          method: 'POST',
        },
      )

      if (json) {
        printJson(payload)
        return
      }

      console.log(`Restarted session ${sessionId}`)
      return
    }
    case 'input': {
      const [sessionId, ...textParts] = rest
      if (!sessionId || textParts.length === 0) {
        throw new Error('Usage: webterm sessions input <sessionId> <text>')
      }

      const payload = await apiRequest(
        baseUrl,
        `/api/sessions/${encodeURIComponent(sessionId)}/input`,
        {
          method: 'POST',
          body: { data: textParts.join(' ') },
        },
      )

      if (json) {
        printJson(payload)
        return
      }

      console.log(`Sent input to ${sessionId}`)
      return
    }
    case 'run': {
      const [sessionId, ...commandParts] = rest
      if (!sessionId || commandParts.length === 0) {
        throw new Error('Usage: webterm sessions run <sessionId> <command>')
      }

      const payload = await apiRequest(
        baseUrl,
        `/api/sessions/${encodeURIComponent(sessionId)}/run`,
        {
          method: 'POST',
          body: { command: commandParts.join(' ') },
        },
      )

      if (json) {
        printJson(payload)
        return
      }

      console.log(`Ran command in ${sessionId}`)
      return
    }
    default:
      throw new Error(
        'Usage: webterm sessions [list|create|rename|activate|hide|move|kill|restart|input|run] ...',
      )
  }
}

function filterSessionsByWorkspace(state, workspaceToken) {
  const workspaceId = resolveWorkspaceId(state.layout, workspaceToken)
  const workspace = state.layout.workspaces.find((entry) => entry.id === workspaceId)

  return state.sessions
    .filter((session) => workspace?.sessionIds.includes(session.id))
    .map((session) => ({
      ...session,
      workspace,
    }))
}

function findWorkspaceForSession(layout, sessionId) {
  return layout.workspaces.find((workspace) => workspace.sessionIds.includes(sessionId))
}

function resolveWorkspaceId(layout, workspaceToken) {
  const byId = layout.workspaces.find((workspace) => workspace.id === workspaceToken)
  if (byId) {
    return byId.id
  }

  const byName = layout.workspaces.find((workspace) => workspace.name === workspaceToken)
  if (byName) {
    return byName.id
  }

  throw new Error(`Workspace "${workspaceToken}" was not found.`)
}

async function printMaybeJson(json, payload) {
  if (json) {
    printJson(payload)
    return
  }

  console.log(JSON.stringify(payload, null, 2))
}

async function apiRequest(baseUrl, pathname, init = {}) {
  const response = await fetch(new URL(pathname, withTrailingSlash(baseUrl)), {
    method: init.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const payload = await response.json()

  if (!response.ok) {
    throw new Error(
      payload && typeof payload.error === 'string'
        ? payload.error
        : `Request failed with status ${response.status}.`,
    )
  }

  return payload
}

async function resolveServerBaseUrl(serverOverride) {
  const candidates = []

  if (serverOverride) {
    candidates.push(serverOverride)
  }

  if (process.env.WEBTERM_URL) {
    candidates.push(process.env.WEBTERM_URL)
  }

  const runtimeStatePath = path.join(process.cwd(), 'logs', 'webterm-server-state.json')
  if (existsSync(runtimeStatePath)) {
    try {
      const runtimeState = JSON.parse(readFileSync(runtimeStatePath, 'utf8'))
      if (typeof runtimeState.url === 'string') {
        candidates.push(runtimeState.url)
      }
    } catch {
      // Ignore malformed runtime state files and fall back to the default URL.
    }
  }

  const defaultPort = process.env.WEBTERM_PORT ?? process.env.PORT ?? '3001'
  candidates.push(`http://127.0.0.1:${defaultPort}`)

  const uniqueCandidates = [...new Set(candidates.map(normalizeBaseUrl))]

  for (const candidate of uniqueCandidates) {
    if (await isHealthy(candidate)) {
      return candidate
    }
  }

  return uniqueCandidates[0]
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, '')
}

function withTrailingSlash(value) {
  return `${normalizeBaseUrl(value)}/`
}

async function isHealthy(baseUrl) {
  try {
    const response = await fetch(new URL('/api/health', withTrailingSlash(baseUrl)))
    return response.ok
  } catch {
    return false
  }
}

function runScript(scriptName, extraArgs) {
  return new Promise((resolve, reject) => {
    const child =
      process.platform === 'win32'
        ? spawn(
            process.env.ComSpec ?? 'cmd.exe',
            [
              '/d',
              '/s',
              '/c',
              [
                'npm',
                'run',
                scriptName,
                ...(extraArgs.length > 0 ? ['--', ...extraArgs.map(quoteForCmd)] : []),
              ].join(' '),
            ],
            {
              cwd: process.cwd(),
              stdio: 'inherit',
            },
          )
        : spawn(
            'npm',
            ['run', scriptName, ...(extraArgs.length > 0 ? ['--', ...extraArgs] : [])],
            {
              cwd: process.cwd(),
              stdio: 'inherit',
            },
          )

    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(`npm run ${scriptName} exited with code ${code ?? 1}.`))
    })
  })
}

function quoteForCmd(value) {
  return value.replace(/(["^&|<>()%!])/g, '^$1')
}

function printJson(payload) {
  console.log(JSON.stringify(payload, null, 2))
}

function printHelp() {
  console.log(`webterm

Scripts:
  webterm dev
  webterm build
  webterm lint
  webterm start
  webterm start-background
  webterm stop-background
  webterm build-start
  webterm build-start-background

App control:
  webterm status
  webterm state [--json]
  webterm shells [--json]
  webterm workspaces list [--json]
  webterm workspaces create [name] [--activate]
  webterm workspaces rename <workspace> <name>
  webterm workspaces delete <workspace>
  webterm workspaces activate <workspace>
  webterm sessions list [--workspace <workspace>] [--json]
  webterm sessions create [--workspace <workspace>] [--title <title>] [--cwd <cwd>] [--shell <shell>] [--custom-shell-path <path>] [--command <command>] [--no-focus] [--closed]
  webterm sessions rename <sessionId> <title>
  webterm sessions activate <sessionId>
  webterm sessions hide <sessionId>
  webterm sessions move <sessionId> <workspace> [--index N]
  webterm sessions kill <sessionId>
  webterm sessions restart <sessionId>
  webterm sessions input <sessionId> <text>
  webterm sessions run <sessionId> <command>

Global options:
  --server <url>  Override the WebTerm server URL
  --json          Print JSON output
  --help          Show this message`)
}
