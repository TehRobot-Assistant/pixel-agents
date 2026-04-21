# Pixel Agents — Standalone Viewer

A minimal additive layer that serves the `pixel-agents` webview outside VS
Code by tailing Claude Code transcript JSONL files and broadcasting the
resulting events to browsers over a single WebSocket.

## What this adds

- **Static HTTP server** that serves the prebuilt `dist/webview/` bundle and
  injects a bootstrap `<script>` into `index.html` setting
  `window.__PA_RUNTIME__ = 'websocket'` and `window.__PA_TOKEN__ = '<bearer>'`.
- **WebSocket endpoint** at `/events?token=…` that broadcasts agent lifecycle
  messages to every connected client. The message shapes are exactly the
  ones the VS Code extension posts via `webview.postMessage(...)`, so the
  React webview code path is the same.
- **JSONL tailer** that polls `~/.claude/projects/**/*.jsonl` every 2s,
  tracks per-file byte offsets, and translates transcript records into
  `agentCreated`, `agentToolStart/Done/Clear`, `agentStatus`, `subagentToolStart/Done`,
  `subagentClear` messages.

The webview itself needed two small changes:

- `webview-ui/src/runtime.ts` — added a third runtime value `'websocket'`,
  detected via `window.__PA_RUNTIME__`.
- `webview-ui/src/vscodeApi.ts` — when the runtime is `websocket`, connect
  to `ws://host/events?token=…`, re-dispatch inbound JSON as window
  `MessageEvent`s (matching the VS Code contract), and flush outbound
  `vscode.postMessage` calls over the socket. Reconnects on close with
  capped exponential backoff.

## How to run

From the repo root:

```sh
npm install                           # root extension deps (needed for types)
cd webview-ui && npm install
npm run build                         # produces ../dist/webview

cd ../standalone
npm install
npm run build                         # compiles src/ → dist/
npm start -- --port 8087              # or: node dist/index.js --port 8087
```

The server prints a bearer token + browser URL on startup. Open the URL in
any modern browser; hitting the host without a token lands you on a small
token-entry form.

### CLI flags

```
--port <n>      HTTP/WebSocket port (default: 8087)
--host <ip>     Bind address (default: 0.0.0.0)
--assets <dir>  Directory served as webview root
                (default: ../dist/webview relative to this script)
--token <s>     Use a fixed bearer token (default: random per restart)
```

## Security notes

- **Read-only.** The tailer never writes to `~/.claude/` and the server
  ignores inbound `saveLayout`, `saveAgentSeats`, `focusAgent`, `closeAgent`,
  and similar messages. Clients can watch; they cannot mutate state.
- **Bearer token** required on every WebSocket connection and every HTTP
  request. The token is 24 random bytes (base64url), regenerated on every
  process start — no token persists to disk. The token is compared in
  constant time.
- **No hooks installed.** Unlike the VS Code extension, we do not touch
  `~/.claude/settings.json` — transcript polling is enough.
- **LAN exposure.** Binding to `0.0.0.0` exposes the port to anything that
  can route to this host. The bearer token is the only gate; use
  `--host 127.0.0.1` if you want to bind to loopback only, or put the
  service behind a reverse proxy.
- **Rate-limited poller.** Filesystem scans run every 2s, matching the
  design of fork PR #63.

## Design credits

Design ideas (not code) were harvested from three existing fork PRs against
`pablodelucca/pixel-agents` — none of that code is used, everything below
was reimplemented from scratch:

- **[PR #63 — TimpiaAI](https://github.com/pablodelucca/pixel-agents/pull/63)**
  shape of the CLI orchestrator + session scanner + 2s poll interval.
- **[PR #156 — ronilaukkarinen](https://github.com/pablodelucca/pixel-agents/pull/156)**
  runtime detection (try `acquireVsCodeApi`, fall back to WS) in
  `vscodeApi.ts`, and the `window.dispatchEvent(new MessageEvent(...))`
  trick to replay inbound WS frames as if they were VS Code postMessage.
- **[PR #166 — MikaelDDavidd](https://github.com/pablodelucca/pixel-agents/pull/166)**
  standalone-server directory layout and `build.js` index-html-injection
  concept.
