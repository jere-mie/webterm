# WebTerm — Browser-Native Terminal Multiplexer

WebTerm is a terminal multiplexer that runs in your browser. It spawns real PTY sessions on your local machine via a Node.js server and gives you a Cmux-style workspace UI powered by React + xterm.js + socket.io.

**The core philosophy: Sessions live backstage, workspaces bring them front.**

---

## Features

- **Persistent PTY sessions** — closing a tab never kills the process. Sessions run until you explicitly kill them (or the server shuts down).
- **Workspace-based context switching** — each workspace owns its own session list and visible tab strip.
- **Fast workspace creation** — new workspaces immediately spawn a session and open inline rename so you can name them right away.
- **Sidebar drag-and-drop** — reorder workspaces or move sessions between workspaces directly in the vertical sidebar.
- **Quick workspace actions** — hover a workspace to spawn a new session there without leaving the sidebar.
- **Keyboard-centric workflow** — navigate without touching the mouse.
- **Nerd Font rendering** — uses JetBrainsMono Nerd Font for correct glyph rendering.

---

## Quick start

**Prerequisites:** Node.js 18+ and npm

```bash
npm install
npm run dev
```

Open the port reported by the server. The default is `http://127.0.0.1:3001`, or whatever `WEBTERM_PORT` is set to.

---

## Build & run (production)

```bash
npm run build:start
```

The production server serves the compiled frontend from `dist/` and exposes the same API/socket endpoints.
For a detached run, use `npm run build:start:background`; it prints the app URL after startup, and you can later use `npm run stop:background`.

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Alt K` | Open command palette |
| `Alt N` | Spawn a new session in the active workspace |
| `Alt M` | Create a new workspace, create a session there, and start renaming it |
| `Alt W` | Hide the active tab from the tab strip |
| `Alt Shift W` | Kill the active PTY session |
| `Alt ↑` / `Alt ↓` | Cycle through workspaces in sidebar order |
| `Alt ←` / `Alt →` | Cycle through tabs in the active workspace |

On macOS, the UI labels `Alt` as `Option`.

---

## Data model

```
sessions                      — running PTY processes, identified by session ID
workspaces                    — named groups of session IDs shown in the sidebar
openSessionIds                — per-workspace subset currently visible as top tabs
lastActiveSessionPerWorkspace — remembers which tab was focused per workspace
```

Sessions and workspaces are deliberately decoupled. A session can:
- Belong to exactly one workspace in the sidebar
- Be open as a tab or hidden from the tab strip inside that workspace

Killing a session from the sidebar (✕ button on a session row) terminates the PTY. Closing a tab (✕ on the tab strip) only hides it from the workspace.

---

## Useful scripts

| Command | Description |
|---|---|
| `npm run dev` | Dev server with Vite HMR on port 3001+ |
| `npm run build` | Compile frontend + server TypeScript |
| `npm run build:start` | Build first, then run the compiled production server |
| `npm run build:start:background` | Start the compiled production server as a detached process |
| `npm start` | Run the compiled production server in the foreground |
| `npm run stop:background` | Stop the detached background process |

---

## Project layout

```
src/                   React frontend
  components/
    workspace-sidebar  Workspace/session sidebar with DnD and inline rename
    terminal-surface   xterm.js wrapper with PTY socket attachment
    command-palette    Alt+K command palette
  hooks/
    useAppState        Schema v3 workspace layout and tab visibility state
server/                Node.js PTY server (express + socket.io + node-pty)
shared/protocol.ts     Socket API types (shared by client + server)
```

---

## Notes for contributors

- `server/index.ts` respects `WEBTERM_PORT` (falls back to 3001, auto-increments if busy).
- The server runs Vite in middleware mode during development so HMR works alongside `/api` and `/socket.io`.
- All `TerminalSurface` components remain mounted regardless of visibility to keep PTY sockets attached and prevent the 15-minute detach timeout from killing background sessions.
- `server/session-manager.ts` repairs execute permissions on node-pty's Unix `spawn-helper` at startup when needed so PTY creation works on macOS/Linux installs with missing execute bits.
- When changing protocol types, update `shared/protocol.ts` and verify both client and server builds pass.
