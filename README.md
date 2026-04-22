# WebTerm

WebTerm is a web-based terminal UI that runs a local Node server and a Vite-powered React frontend. It provides real-time terminal sessions in the browser using `node-pty` + `xterm.js` and `socket.io` for transport.

**Quick start**

- **Prerequisites:** Node.js 18+ and npm
- Install dependencies:

```bash
npm install
```

- Start development (runs the server which also mounts Vite in middleware mode):

```bash
npm run dev
```

- Open the app at `http://127.0.0.1:3001` (the server chooses the first free port starting at 3001).

**Build & run (production)**

```bash
npm run build
npm start
```

The production server serves the compiled frontend from `dist` and starts the same Node server on the production port.

**Useful scripts**

- `npm run dev` — run the server with Vite middleware for HMR
- `npm run build` — build the frontend and compile the server TypeScript
- `npm start` — run the compiled server from `dist-server`

**Project layout (important files)**

- `index.html` — Vite entry HTML
- `src/` — React frontend
- `server/` — server-side TypeScript (entry: `server/index.ts`)
- `shared/protocol.ts` — socket API types used by client and server

**Notes for contributors**

- The server runs Vite in middleware mode during development so HMR works while the server exposes the `/api` and `/socket.io` endpoints.
- When changing protocol types, update `shared/protocol.ts` and ensure both client and server builds succeed.