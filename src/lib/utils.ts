import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

const relativeTimeFormatter = new Intl.RelativeTimeFormat('en', {
  numeric: 'auto',
})

const clockFormatter = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
})
const isMacPlatform =
  typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatRelativeTime(timestamp: number) {
  const deltaMs = timestamp - Date.now()
  const deltaMinutes = Math.round(deltaMs / 60_000)

  if (Math.abs(deltaMinutes) < 1) {
    return 'just now'
  }

  if (Math.abs(deltaMinutes) < 60) {
    return relativeTimeFormatter.format(deltaMinutes, 'minute')
  }

  const deltaHours = Math.round(deltaMinutes / 60)

  if (Math.abs(deltaHours) < 24) {
    return relativeTimeFormatter.format(deltaHours, 'hour')
  }

  const deltaDays = Math.round(deltaHours / 24)

  return relativeTimeFormatter.format(deltaDays, 'day')
}

export function formatClock(timestamp: number) {
  return clockFormatter.format(timestamp)
}

export function compactId(id: string) {
  return id.slice(0, 8).toUpperCase()
}

export function formatShortcut(parts: string[]) {
  return parts
    .map((part) =>
      part.toLowerCase() === 'alt' && isMacPlatform ? 'Option' : part,
    )
    .join(' ')
}
