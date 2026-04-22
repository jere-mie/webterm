# WebTerm — Browser-Native Terminal Multiplexer

WebTerm is a terminal multiplexer that runs in your browser. It spawns real PTY sessions on your local machine via a Node.js server and gives you a Cmux-style workspace UI powered by React + xterm.js + socket.io.

**The core philosophy: Sessions live backstage, workspaces bring them front.**

---

## Features

- **Persistent PTY sessions** — closing a tab never kills the process. Sessions run until you explicitly kill them (or the server shuts down).
- **Workspace-based context switching** — group sessions into workspaces and switch between them instantly. Each workspace is an independent tab-set.
- **Hierarchical sidebar** — organize workspaces inside collapsible folders. Drag-and-drop to reorder.
- **Background sessions** — sessions not attached to any workspace stay alive in the background and appear in the sidebar's Background section.
- **Keyboard-centric workflow** — navigate without touching the mouse.
- **Nerd Font rendering** — uses JetBrainsMono Nerd Font for correct glyph rendering.

---

## Quick start

**Prerequisites:** Node.js 18+ and npm

```bash
npm install
npm run dev
```

Open: `http://127.0.0.1:3001`

---

## Build & run (production)

```bash
npm run build
npm start
```

The production server serves the compiled frontend from `dist/` and exposes the same API/socket endpoints.

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl K` / `⌘K` | Open command palette |
| `Shift T` | Spawn new terminal |
| `Ctrl W` / `⌘W` | Hide active tab from workspace (PTY keeps running) |
| `Alt ↑` / `Alt ↓` | Cycle through workspaces in sidebar order |
| `Alt ←` / `Alt →` | Cycle through tabs in the active workspace |

---

## Data model

```
sessions (flat map)          — running PTY processes, identified by session ID
workspaces                   — named groups of session IDs (the tab-set shown on stage)
sidebarItems                 — ordered list of top-level folders and workspace refs
lastActiveSessionPerWorkspace — remembers which tab was focused per workspace
```

Sessions and workspaces are deliberately decoupled. A session can:
- Be in exactly one workspace (visible as a tab)
- Be in no workspace (lives in the Background section of the sidebar)

Killing a session from the sidebar (✕ button on a session row) terminates the PTY. Closing a tab (✕ on the tab strip) only hides it from the workspace.

---

## Useful scripts

| Command | Description |
|---|---|
| `npm run dev` | Dev server with Vite HMR on port 3001+ |
| `npm run build` | Compile frontend + server TypeScript |
| `npm start` | Run compiled production server |

---

## Project layout

```
src/                   React frontend
  components/
    workspace-sidebar  Hierarchical sidebar (folders > workspaces > sessions)
    terminal-surface   xterm.js wrapper with PTY socket attachment
    command-palette    ⌘K command palette
  hooks/
    useAppState        Schema v2 layout & workspace state
server/                Node.js PTY server (express + socket.io + node-pty)
shared/protocol.ts     Socket API types (shared by client + server)
```

---

## Notes for contributors

- `server/index.ts` respects a `PORT` environment variable (falls back to 3001, auto-increments if busy).
- The server runs Vite in middleware mode during development so HMR works alongside `/api` and `/socket.io`.
- All `TerminalSurface` components remain mounted regardless of visibility to keep PTY sockets attached and prevent the 15-minute detach timeout from killing background sessions.
- When changing protocol types, update `shared/protocol.ts` and verify both client and server builds pass.