import {
  Command as CommandIcon,
  Copy,
  Eraser,
  PanelLeft,
  Plus,
  RefreshCw,
  Search,
  X,
} from 'lucide-react'

import type { SessionSnapshot } from '../../shared/protocol'
import { compactId, formatClock, formatRelativeTime } from '../lib/utils'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from './ui/command'

export type PaletteAction =
  | 'new-session'
  | 'duplicate-session'
  | 'restart-session'
  | 'clear-terminal'
  | 'hide-from-workspace'
  | 'kill-session'
  | 'toggle-sidebar'
  | 'focus-terminal'

interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessions: SessionSnapshot[]
  activeSessionId: string | null
  onSelectSession: (sessionId: string) => void
  onAction: (action: PaletteAction) => void
}

export function CommandPalette({
  open,
  onOpenChange,
  sessions,
  activeSessionId,
  onSelectSession,
  onAction,
}: CommandPaletteProps) {
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null

  function runAction(action: PaletteAction) {
    onAction(action)
    onOpenChange(false)
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <Command>
        <CommandInput placeholder="Jump to a tab, clear the deck, or relaunch a shell..." />
        <CommandList>
          <CommandEmpty>No matching terminal operations.</CommandEmpty>
          <CommandGroup heading="Actions">
            <CommandItem onSelect={() => runAction('new-session')}>
              <Plus data-slot="command-icon" className="h-4 w-4" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-medium text-[var(--text-strong)]">Spawn new tab</span>
                <span className="text-xs text-[var(--muted-strong)]">
                  Launch a fresh localhost shell session.
                </span>
              </div>
              <span className="shortcut-chip">Alt N</span>
            </CommandItem>
            <CommandItem
              disabled={!activeSession}
              onSelect={() => runAction('duplicate-session')}
            >
              <Copy data-slot="command-icon" className="h-4 w-4" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-medium text-[var(--text-strong)]">Duplicate active tab</span>
                <span className="text-xs text-[var(--muted-strong)]">
                  Clone the current shell in the same directory.
                </span>
              </div>
            </CommandItem>
            <CommandItem
              disabled={!activeSession}
              onSelect={() => runAction('restart-session')}
            >
              <RefreshCw data-slot="command-icon" className="h-4 w-4" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-medium text-[var(--text-strong)]">Restart active shell</span>
                <span className="text-xs text-[var(--muted-strong)]">
                  Respawn the PTY while keeping the tab identity.
                </span>
              </div>
            </CommandItem>
            <CommandItem disabled={!activeSession} onSelect={() => runAction('clear-terminal')}>
              <Eraser data-slot="command-icon" className="h-4 w-4" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-medium text-[var(--text-strong)]">Clear current viewport</span>
                <span className="text-xs text-[var(--muted-strong)]">
                  Keep the shell running and wipe the local terminal canvas.
                </span>
              </div>
            </CommandItem>
            <CommandItem disabled={!activeSession} onSelect={() => runAction('focus-terminal')}>
              <CommandIcon data-slot="command-icon" className="h-4 w-4" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-medium text-[var(--text-strong)]">Focus terminal input</span>
                <span className="text-xs text-[var(--muted-strong)]">
                  Return keyboard control to the active shell immediately.
                </span>
              </div>
            </CommandItem>
            <CommandItem onSelect={() => runAction('toggle-sidebar')}>
              <PanelLeft data-slot="command-icon" className="h-4 w-4" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-medium text-[var(--text-strong)]">Toggle session history</span>
                <span className="text-xs text-[var(--muted-strong)]">
                  Collapse or reveal the observatory sidebar.
                </span>
              </div>
            </CommandItem>
            <CommandItem disabled={!activeSession} onSelect={() => runAction('hide-from-workspace')}>
              <X data-slot="command-icon" className="h-4 w-4" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-medium text-[var(--text-strong)]">Hide from workspace</span>
                <span className="text-xs text-[var(--muted-strong)]">
                  Remove from current workspace; PTY keeps running in the background.
                </span>
              </div>
              <span className="shortcut-chip">Ctrl W</span>
            </CommandItem>
            <CommandItem disabled={!activeSession} onSelect={() => runAction('kill-session')}>
              <X data-slot="command-icon" className="h-4 w-4" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-medium text-[var(--text-strong)]">Kill session (PTY)</span>
                <span className="text-xs text-[var(--muted-strong)]">
                  Terminate the PTY process and remove the session from memory.
                </span>
              </div>
            </CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Sessions">
            {sessions.map((session) => {
              const isActive = session.id === activeSessionId

              return (
                <CommandItem
                  key={session.id}
                  onSelect={() => {
                    onSelectSession(session.id)
                    onOpenChange(false)
                  }}
                >
                  <Search data-slot="command-icon" className="h-4 w-4" />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate font-medium text-[var(--text-strong)]">
                      {session.title}
                    </span>
                    <span className="truncate text-xs text-[var(--muted-strong)]">
                      {session.cwd}
                    </span>
                  </div>
                  <div className="flex flex-col items-end gap-1 text-right text-[0.68rem] uppercase tracking-[0.24em] text-[var(--muted)]">
                    <span>{isActive ? 'Active' : session.state}</span>
                    <span>{compactId(session.id)}</span>
                    <span>{formatRelativeTime(session.lastActiveAt)}</span>
                    <span>{formatClock(session.lastActiveAt)}</span>
                  </div>
                </CommandItem>
              )
            })}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  )
}