import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

import type { ShellKind } from '../shared/protocol.js'

const CWD_MARKER_PREFIX = '\u001b]633;CurrentDir='
const CWD_MARKER_SUFFIX = '\u0007'
const CWD_MARKER_PATTERN = new RegExp(
  String.raw`\u001b\]633;CurrentDir=([^\u0007\u001b]+)(?:\u0007|\u001b\\)`,
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
  let cleanChunk = ''
  let cwd: string | null = null
  let lastIndex = 0

  for (const match of compositeChunk.matchAll(CWD_MARKER_PATTERN)) {
    if (match.index === undefined) {
      continue
    }

    cleanChunk += compositeChunk.slice(lastIndex, match.index)
    cwd = decodeMarkerValue(match[1])
    lastIndex = match.index + match[0].length
  }

  cleanChunk += compositeChunk.slice(lastIndex)

  const unfinishedMarkerIndex = cleanChunk.lastIndexOf(CWD_MARKER_PREFIX)

  if (unfinishedMarkerIndex === -1) {
    return {
      cleanChunk,
      cwd,
      pendingChunk: '',
    }
  }

  const unfinishedMarker = cleanChunk.slice(unfinishedMarkerIndex)
  const hasTerminator = unfinishedMarker.includes(CWD_MARKER_SUFFIX)
  const hasEscTerminator = unfinishedMarker.includes('\u001b\\')

  if (hasTerminator || hasEscTerminator) {
    return {
      cleanChunk,
      cwd,
      pendingChunk: '',
    }
  }

  return {
    cleanChunk: cleanChunk.slice(0, unfinishedMarkerIndex),
    cwd,
    pendingChunk: unfinishedMarker,
  }
}

function resolveWindowsShell(requestedKind?: ShellKind): ShellProfile {
  if (requestedKind && requestedKind !== 'powershell') {
    throw new Error(`Shell ${requestedKind} is not available on Windows.`)
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
      '$host.UI.RawUI.WindowTitle = "WebTerm"',
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
  switch (kind) {
    case 'bash':
      return [
        { kind, path: process.env.SHELL ?? '' },
        { kind, path: '/bin/bash' },
        { kind, path: '/usr/bin/bash' },
        { kind, path: 'bash' },
      ]
    case 'zsh':
      return [
        { kind, path: process.env.SHELL ?? '' },
        { kind, path: '/bin/zsh' },
        { kind, path: '/usr/bin/zsh' },
        { kind, path: 'zsh' },
      ]
    case 'powershell':
      return [{ kind, path: 'pwsh.exe' }, { kind, path: 'powershell.exe' }]
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