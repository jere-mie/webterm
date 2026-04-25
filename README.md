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
npm exec -- webterm dev
```

Open the port reported by the server. The default is `http://127.0.0.1:3001`, or whatever `WEBTERM_PORT` is set to.
If you want a bare `webterm ...` command on your PATH, run `npm link` once from the repo root.

---

## Build & run (production)

```bash
npm exec -- webterm build-start
```

The production server serves the compiled frontend from `dist/` and exposes the same API/socket endpoints.
For a detached run, use `npm exec -- webterm build-start-background`; it prints the app URL after startup, and you can later use `npm exec -- webterm stop-background`.

---

## CLI

The repo exposes a `webterm` CLI. It mirrors the existing script workflows and can also control a running app over the local WebTerm API.

```bash
npm exec -- webterm status
npm exec -- webterm workspaces create "Release Debugging" --activate
npm exec -- webterm sessions create --workspace "Release Debugging" --title "Server logs" --cwd "C:\path\to\repo" --command "Set-Location .\server"
```

If you run `npm link`, the same commands become:

```bash
webterm status
webterm workspaces create "Release Debugging" --activate
webterm sessions create --workspace "Release Debugging" --title "Server logs" --cwd "C:\path\to\repo" --command "Set-Location .\server"
```

### Script commands

| Command | Description |
|---|---|
| `webterm dev` | Dev server with Vite HMR on port 3001+ |
| `webterm build` | Compile frontend + server TypeScript |
| `webterm lint` | Run the repo lint command |
| `webterm start` | Run the compiled production server |
| `webterm start-background` | Run the compiled production server as a detached process |
| `webterm stop-background` | Stop the detached background process |
| `webterm build-start` | Build first, then run the compiled production server |
| `webterm build-start-background` | Build first, then start the compiled production server in the background |

### App control commands

| Command | Description |
|---|---|
| `webterm status` | Resolve the active local WebTerm server URL |
| `webterm shells` | List the available shell profiles |
| `webterm state --json` | Print the full workspace/session state snapshot |
| `webterm workspaces list` | List workspaces and open-tab counts |
| `webterm workspaces create <name>` | Create a workspace |
| `webterm workspaces rename <workspace> <name>` | Rename a workspace by ID or exact name |
| `webterm workspaces delete <workspace>` | Delete a workspace |
| `webterm workspaces activate <workspace>` | Make a workspace active in the UI |
| `webterm sessions list [--workspace <workspace>]` | List sessions, optionally scoped to a workspace |
| `webterm sessions create ...` | Create a session, place it in a workspace, and optionally run a startup command after shell init |
| `webterm sessions activate <sessionId>` | Focus a session and surface its tab |
| `webterm sessions hide <sessionId>` | Hide a session from the active workspace tab strip without killing it |
| `webterm sessions move <sessionId> <workspace>` | Move a session to another workspace |
| `webterm sessions rename <sessionId> <title>` | Rename a session |
| `webterm sessions kill <sessionId>` | Terminate a PTY session |
| `webterm sessions restart <sessionId>` | Restart a PTY session |
| `webterm sessions input <sessionId> <text>` | Send raw input to a session |
| `webterm sessions run <sessionId> <command>` | Run a command in an existing session |

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
| `npm run dev` | Equivalent to `webterm dev` |
| `npm run build` | Equivalent to `webterm build` |
| `npm run build:start` | Equivalent to `webterm build-start` |
| `npm run build:start:background` | Equivalent to `webterm build-start-background` |
| `npm start` | Equivalent to `webterm start` |
| `npm run stop:background` | Equivalent to `webterm stop-background` |

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
- Workspace layout is now server-managed and persisted in `logs/webterm-layout.json`, so CLI mutations and open browser clients stay in sync.
- The server runs Vite in middleware mode during development so HMR works alongside `/api` and `/socket.io`.
- All `TerminalSurface` components remain mounted regardless of visibility to keep PTY sockets attached and prevent the 15-minute detach timeout from killing background sessions.
- `server/session-manager.ts` repairs execute permissions on node-pty's Unix `spawn-helper` at startup when needed so PTY creation works on macOS/Linux installs with missing execute bits.
- When changing protocol types, update `shared/protocol.ts` and verify both client and server builds pass.
