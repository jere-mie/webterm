import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'

const projectRoot = process.cwd()
const pidFile = path.join(projectRoot, 'logs', 'webterm-server.pid')

if (!existsSync(pidFile)) {
  console.log('No background WebTerm process was found.')
  process.exit(0)
}

const pid = Number(readFileSync(pidFile, 'utf8').trim())

if (!Number.isInteger(pid) || pid < 1) {
  rmSync(pidFile, { force: true })
  console.error('The background pid file is invalid and has been removed.')
  process.exit(1)
}

try {
  process.kill(pid)
  rmSync(pidFile, { force: true })
  console.log(`Stopped WebTerm background process (pid ${pid}).`)
} catch (error) {
  rmSync(pidFile, { force: true })

  if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
    console.log('The background WebTerm process was already gone; the pid file was removed.')
    process.exit(0)
  }

  console.error(error instanceof Error ? error.message : 'Failed to stop WebTerm.')
  process.exit(1)
}
