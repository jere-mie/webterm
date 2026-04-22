import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

import type { ShellInfo, ShellKind } from '../shared/protocol.js'

const CWD_MARKER_PREFIX = '\u001b]633;CurrentDir='
const CWD_MARKER_SUFFIX = '\u0007'
const CWD_MARKER_PATTERN = new RegExp(
  String.raw`\u001b\]633;CurrentDir=([^\u0007\u001b]+)(?:\u0007|\u001b\\)`,
  'g',
)

const OSC_TITLE_PATTERN = new RegExp(
  String.raw`\u001b\](?:0|1|2);([^\u0007\u001b]*)(?:\u0007|\u001b\\)`,
  'g',
)

export interface ShellProfile {
  kind: ShellKind
  label: string
  command: string
  args: string[]
  initCommands: string[]
}

export interface MarkerParseResult {
  cleanChunk: string
  cwd: string | null
  title: string | null
  pendingChunk: string
}

export function resolveShell(requestedKind?: ShellKind): ShellProfile {
  if (process.platform === 'win32') {
    return resolveWindowsShell(requestedKind)
  }

  return resolveUnixShell(requestedKind)
}

export function parseShellMarkers(
  chunk: string,
  pendingChunk: string,
): MarkerParseResult {
  const compositeChunk = `${pendingChunk}${chunk}`
  let midChunk = ''
  let cwd: string | null = null
  let lastIndex = 0

  // Pass 1: strip and extract CurrentDir markers
  for (const match of compositeChunk.matchAll(CWD_MARKER_PATTERN)) {
    if (match.index === undefined) {
      continue
    }

    midChunk += compositeChunk.slice(lastIndex, match.index)
    cwd = decodeMarkerValue(match[1])
    lastIndex = match.index + match[0].length
  }

  midChunk += compositeChunk.slice(lastIndex)

  // Check for an unfinished CWD marker that may complete in the next chunk
  const unfinishedMarkerIndex = midChunk.lastIndexOf(CWD_MARKER_PREFIX)
  let trimmedMid = midChunk
  let newPendingChunk = ''

  if (unfinishedMarkerIndex !== -1) {
    const unfinishedMarker = midChunk.slice(unfinishedMarkerIndex)
    const hasTerminator = unfinishedMarker.includes(CWD_MARKER_SUFFIX)
    const hasEscTerminator = unfinishedMarker.includes('\u001b\\')

    if (!hasTerminator && !hasEscTerminator) {
      trimmedMid = midChunk.slice(0, unfinishedMarkerIndex)
      newPendingChunk = unfinishedMarker
    }
  }

  // Pass 2: strip and extract OSC 0/1/2 title sequences
  let cleanChunk = ''
  let title: string | null = null
  let titleLastIndex = 0

  for (const match of trimmedMid.matchAll(OSC_TITLE_PATTERN)) {
    if (match.index === undefined) {
      continue
    }

    cleanChunk += trimmedMid.slice(titleLastIndex, match.index)
    title = match[1]
    titleLastIndex = match.index + match[0].length
  }

  cleanChunk += trimmedMid.slice(titleLastIndex)

  return {
    cleanChunk,
    cwd,
    title,
    pendingChunk: newPendingChunk,
  }
}

function resolveWindowsShell(requestedKind?: ShellKind): ShellProfile {
  if (requestedKind === 'cmd') {
    return {
      kind: 'cmd',
      label: 'Command Prompt',
      command: 'cmd.exe',
      args: [],
      initCommands: [
        // Emit CurrentDir marker on every prompt; $E=ESC, $E\\ =ST terminator
        'PROMPT=$E]633;CurrentDir=%CD%$E\\ $P$G',
        'cls',
      ],
    }
  }

  if (requestedKind === 'git-bash') {
    const gitBashPaths = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    ]
    const command = gitBashPaths.find((p) => existsSync(p)) ?? 'bash'

    return {
      kind: 'git-bash',
      label: 'Git Bash',
      command,
      args: ['--noprofile', '--norc', '-i'],
      initCommands: [
        'function __webterm_precmd(){ printf "\\033]633;CurrentDir=%s\\007" "$PWD"; }',
        'PROMPT_COMMAND=__webterm_precmd',
        'PS1="\\[\\e[38;5;214m\\]\\u@\\h\\[\\e[0m\\] \\[\\e[38;5;179m\\]\\w\\[\\e[0m\\] \\$ "',
        'clear',
      ],
    }
  }

  const hasPwsh = commandExists('pwsh.exe')
  const command = hasPwsh ? 'pwsh.exe' : 'powershell.exe'
  const label = hasPwsh ? 'PowerShell 7' : 'Windows PowerShell'

  return {
    kind: 'powershell',
    label,
    command,
    args: ['-NoLogo'],
    initCommands: [
      "$ErrorActionPreference = 'SilentlyContinue'",
      'if (Get-Command Set-PSReadLineOption -ErrorAction SilentlyContinue) { Set-PSReadLineOption -PredictionSource None }',
      'function global:prompt { $cwd = (Get-Location).Path; Write-Host "`e]633;CurrentDir=$cwd`a" -NoNewline; return "PS $cwd> " }',
      'Clear-Host',
    ],
  }
}

function resolveUnixShell(requestedKind?: ShellKind): ShellProfile {
  const envShell = process.env.SHELL ?? ''
  const candidates: Array<{ kind: ShellKind; path: string }> = []

  if (requestedKind) {
    candidates.push(...preferredCandidatesForKind(requestedKind))
  } else if (envShell.includes('zsh')) {
    candidates.push(...preferredCandidatesForKind('zsh'))
    candidates.push(...preferredCandidatesForKind('bash'))
  } else if (envShell.includes('bash')) {
    candidates.push(...preferredCandidatesForKind('bash'))
    candidates.push(...preferredCandidatesForKind('zsh'))
  } else if (process.platform === 'darwin') {
    // macOS default (Catalina+): prefer zsh when $SHELL is unset or unrecognised
    candidates.push(...preferredCandidatesForKind('zsh'))
    candidates.push(...preferredCandidatesForKind('bash'))
  } else {
    candidates.push(...preferredCandidatesForKind('bash'))
    candidates.push(...preferredCandidatesForKind('zsh'))
  }

  const resolvedCandidate = candidates.find((candidate) => {
    if (candidate.path.includes('/')) {
      return existsSync(candidate.path)
    }

    return commandExists(candidate.path)
  })

  if (!resolvedCandidate) {
    throw new Error('No supported shell was found on this system.')
  }

  if (resolvedCandidate.kind === 'zsh') {
    return {
      kind: 'zsh',
      label: 'Zsh',
      command: resolvedCandidate.path,
      args: ['-i'],
      initCommands: [
        'autoload -Uz add-zsh-hook',
        'function __webterm_precmd() { printf "\\033]633;CurrentDir=%s\\007" "$PWD" }',
        'add-zsh-hook precmd __webterm_precmd',
        'PROMPT="%F{214}%n@%m%f %F{179}%~%f %# "',
        'clear',
      ],
    }
  }

  return {
    kind: 'bash',
    label: 'Bash',
    command: resolvedCandidate.path,
    args: ['--noprofile', '--norc', '-i'],
    initCommands: [
      'function __webterm_precmd(){ printf "\\033]633;CurrentDir=%s\\007" "$PWD"; }',
      'PROMPT_COMMAND=__webterm_precmd',
      'PS1="\\[\\e[38;5;214m\\]\\u@\\h\\[\\e[0m\\] \\[\\e[38;5;179m\\]\\w\\[\\e[0m\\] \\$ "',
      'clear',
    ],
  }
}

function preferredCandidatesForKind(kind: ShellKind) {
  const envShell = process.env.SHELL ?? ''

  switch (kind) {
    case 'bash': {
      // Only use $SHELL if it actually points to bash, to avoid resolving bash → zsh
      const envCandidates = envShell.includes('bash') ? [{ kind, path: envShell }] : []
      return [...envCandidates, { kind, path: '/bin/bash' }, { kind, path: '/usr/bin/bash' }, { kind, path: 'bash' }]
    }
    case 'zsh': {
      // Only use $SHELL if it actually points to zsh
      const envCandidates = envShell.includes('zsh') ? [{ kind, path: envShell }] : []
      return [...envCandidates, { kind, path: '/bin/zsh' }, { kind, path: '/usr/bin/zsh' }, { kind, path: 'zsh' }]
    }
    case 'powershell':
      return [{ kind, path: 'pwsh.exe' }, { kind, path: 'powershell.exe' }]
    case 'cmd':
      return [{ kind, path: 'cmd.exe' }]
    case 'git-bash': {
      const gitBashPaths = [
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
      ]
      const found = gitBashPaths.find((p) => existsSync(p))
      return found ? [{ kind, path: found }] : [{ kind, path: 'bash' }]
    }
  }
}

function commandExists(command: string) {
  if (!command) {
    return false
  }

  const lookupCommand = process.platform === 'win32' ? 'where' : 'which'
  const lookupResult = spawnSync(lookupCommand, [command], {
    stdio: 'ignore',
  })

  return lookupResult.status === 0
}

function decodeMarkerValue(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function resolveCustomShellPath(customPath: string): ShellProfile {
  const base = path.basename(customPath).toLowerCase().replace(/\.exe$/, '')

  if (base.includes('zsh')) {
    return {
      kind: 'zsh',
      label: customPath,
      command: customPath,
      args: ['-i'],
      initCommands: [
        'autoload -Uz add-zsh-hook',
        'function __webterm_precmd() { printf "\\033]633;CurrentDir=%s\\007" "$PWD" }',
        'add-zsh-hook precmd __webterm_precmd',
        'PROMPT="%F{214}%n@%m%f %F{179}%~%f %# "',
        'clear',
      ],
    }
  }

  if (base.includes('bash') || base === 'sh') {
    return {
      kind: 'bash',
      label: customPath,
      command: customPath,
      args: ['--noprofile', '--norc', '-i'],
      initCommands: [
        'function __webterm_precmd(){ printf "\\033]633;CurrentDir=%s\\007" "$PWD"; }',
        'PROMPT_COMMAND=__webterm_precmd',
        'PS1="\\[\\e[38;5;214m\\]\\u@\\h\\[\\e[0m\\] \\[\\e[38;5;179m\\]\\w\\[\\e[0m\\] \\$ "',
        'clear',
      ],
    }
  }

  if (base.includes('pwsh') || base.includes('powershell')) {
    return {
      kind: 'powershell',
      label: customPath,
      command: customPath,
      args: ['-NoLogo'],
      initCommands: [
        "$ErrorActionPreference = 'SilentlyContinue'",
        'if (Get-Command Set-PSReadLineOption -ErrorAction SilentlyContinue) { Set-PSReadLineOption -PredictionSource None }',
        'function global:prompt { $cwd = (Get-Location).Path; Write-Host "`e]633;CurrentDir=$cwd`a" -NoNewline; return "PS $cwd> " }',
        'Clear-Host',
      ],
    }
  }

  // Unknown shell — spawn with no special args or init commands
  return {
    kind: 'bash',
    label: customPath,
    command: customPath,
    args: [],
    initCommands: [],
  }
}

export function listAvailableShells(): ShellInfo[] {
  if (process.platform === 'win32') {
    return listWindowsShells()
  }

  return listUnixShells()
}

function listWindowsShells(): ShellInfo[] {
  const shells: ShellInfo[] = []

  const hasPwsh = commandExists('pwsh.exe')
  shells.push({ kind: 'powershell', label: hasPwsh ? 'PowerShell 7 (pwsh)' : 'Windows PowerShell' })
  shells.push({ kind: 'cmd', label: 'Command Prompt (cmd.exe)' })

  const gitBashPaths = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ]
  if (gitBashPaths.some((p) => existsSync(p)) || commandExists('bash')) {
    shells.push({ kind: 'git-bash', label: 'Git Bash' })
  }

  return shells
}

function listUnixShells(): ShellInfo[] {
  const shells: ShellInfo[] = []

  if (existsSync('/bin/zsh') || existsSync('/usr/bin/zsh') || commandExists('zsh')) {
    shells.push({ kind: 'zsh', label: 'Zsh' })
  }
  if (existsSync('/bin/bash') || existsSync('/usr/bin/bash') || commandExists('bash')) {
    shells.push({ kind: 'bash', label: 'Bash' })
  }

  return shells
}
