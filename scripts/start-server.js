import { spawn } from 'node:child_process'
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  openSync,
  statSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

const projectRoot = process.cwd()
const logsDir = path.join(projectRoot, 'logs')
const pidFile = path.join(logsDir, 'webterm-server.pid')
const stdoutLog = path.join(logsDir, 'webterm-server.log')
const stderrLog = path.join(logsDir, 'webterm-server.err.log')
const serverEntry = path.join(projectRoot, 'dist-server', 'server', 'index.js')
const isBackground = process.argv.includes('--background')
const port = resolvePort(process.env.WEBTERM_PORT ?? process.env.PORT ?? '3001')

assertBuildOutput()

if (isBackground) {
  await startInBackground()
} else {
  startInForeground()
}

function assertBuildOutput() {
  try {
    accessSync(serverEntry, fsConstants.R_OK)
  } catch {
    console.error('Build output is missing. Run "npm run build" before starting WebTerm.')
    process.exit(1)
  }
}

function resolvePort(rawPort) {
  const parsedPort = Number(rawPort)

  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    console.error(`Invalid WEBTERM_PORT value: ${rawPort}`)
    process.exit(1)
  }

  return String(parsedPort)
}

function startInForeground() {
  const child = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      WEBTERM_PORT: port,
    },
    stdio: 'inherit',
  })

  child.on('error', (error) => {
    console.error(error instanceof Error ? error.message : 'Failed to start WebTerm.')
    process.exit(1)
  })

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }

    process.exit(code ?? 0)
  })
}

async function startInBackground() {
  if (existsSync(pidFile)) {
    const existingPid = Number(readFileSync(pidFile, 'utf8').trim())

    if (Number.isInteger(existingPid) && isProcessRunning(existingPid)) {
      console.error(`WebTerm is already running in the background (pid ${existingPid}).`)
      process.exit(1)
    }

    rmSync(pidFile, { force: true })
  }

  mkdirSync(logsDir, { recursive: true })
  const initialLogSize = fileSize(stdoutLog)

  const stdoutFd = openSync(stdoutLog, 'a')
  const stderrFd = openSync(stderrLog, 'a')

  try {
    const child = spawn(process.execPath, [serverEntry], {
      detached: true,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        WEBTERM_PORT: port,
      },
      stdio: ['ignore', stdoutFd, stderrFd],
    })

    if (!child.pid) {
      throw new Error('Failed to start WebTerm in the background.')
    }

    child.unref()
    writeFileSync(pidFile, `${child.pid}\n`, 'utf8')
    console.log(`WebTerm started in the background (pid ${child.pid}).`)
    console.log(`App: ${await waitForAppUrl(stdoutLog, initialLogSize, child.pid)}`)
    console.log(`Logs: ${stdoutLog}`)
    console.log(`Errors: ${stderrLog}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Failed to start WebTerm.')
    process.exit(1)
  } finally {
    closeSync(stdoutFd)
    closeSync(stderrFd)
  }
}

function fileSize(filePath) {
  try {
    return statSync(filePath).size
  } catch {
    return 0
  }
}

async function waitForAppUrl(logPath, startSize, childPid) {
  const deadline = Date.now() + 10_000
  const listeningLine = /WebTerm listening on (http:\/\/127\.0\.0\.1:\d+)/

  while (Date.now() < deadline) {
    const output = readFileSync(logPath, 'utf8')
    const recentOutput = output.slice(startSize)
    const match = recentOutput.match(listeningLine)

    if (match) {
      return match[1]
    }

    if (!isProcessRunning(childPid)) {
      break
    }

    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  return `http://127.0.0.1:${port}`
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
