import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Command as CommandPrimitive } from 'cmdk'
import { Search } from 'lucide-react'

import { cn } from '../../lib/utils'

export function CommandDialog({
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return (
    <DialogPrimitive.Root {...props}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[rgba(0,0,0,0.75)]" />
        <DialogPrimitive.Content className="fixed left-1/2 top-[12vh] z-50 w-[min(680px,calc(100vw-1.5rem))] -translate-x-1/2 overflow-hidden rounded-[8px] border border-[rgba(255,255,255,0.1)] bg-[#141414] shadow-[0_24px_80px_rgba(0,0,0,0.6)] focus:outline-none">
          <DialogPrimitive.Title className="sr-only">
            WebTerm command deck
          </DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export const Command = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
  <CommandPrimitive
    className={cn(
      'flex h-full w-full flex-col overflow-hidden bg-transparent text-[var(--text-strong)]',
      className,
    )}
    ref={ref}
    {...props}
  />
))

Command.displayName = CommandPrimitive.displayName

export function CommandInput({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input>) {
  return (
    <div className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3 text-[var(--muted-strong)]">
      <Search className="h-4 w-4 shrink-0" />
      <CommandPrimitive.Input
        className={cn(
          'flex h-9 w-full bg-transparent text-sm outline-none placeholder:text-[var(--muted)]',
          className,
        )}
        {...props}
      />
    </div>
  )
}

export const CommandList = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.List
    className={cn('max-h-[65vh] overflow-y-auto p-3', className)}
    ref={ref}
    {...props}
  />
))

CommandList.displayName = CommandPrimitive.List.displayName

export const CommandEmpty = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Empty>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Empty
    className={cn(
      'px-4 py-10 text-center text-sm text-[var(--muted-strong)]',
      className,
    )}
    ref={ref}
    {...props}
  />
))

CommandEmpty.displayName = CommandPrimitive.Empty.displayName

export const CommandGroup = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Group
    className={cn(
      'overflow-hidden px-2 py-3 text-[var(--text)] [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-2 [&_[cmdk-group-heading]]:text-[0.68rem] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.28em] [&_[cmdk-group-heading]]:text-[var(--muted)]',
      className,
    )}
    ref={ref}
    {...props}
  />
))

CommandGroup.displayName = CommandPrimitive.Group.displayName

export const CommandSeparator = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Separator
    className={cn('mx-3 h-px bg-[var(--border)]', className)}
    ref={ref}
    {...props}
  />
))

CommandSeparator.displayName = CommandPrimitive.Separator.displayName

export const CommandItem = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Item
    className={cn(
      'relative flex cursor-default items-center gap-3 rounded-[5px] border border-transparent px-3 py-2.5 text-sm outline-none transition data-[selected=true]:border-[var(--accent-border)] data-[selected=true]:bg-[var(--accent-bg)] data-[selected=true]:text-[var(--text-strong)] [&_[data-slot=command-icon]]:text-[var(--muted-strong)]',
      className,
    )}
    ref={ref}
    {...props}
  />
))

CommandItem.displayName = CommandPrimitive.Item.displayName