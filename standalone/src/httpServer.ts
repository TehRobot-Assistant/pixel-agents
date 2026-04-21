import { createReadStream, promises as fsp } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { URL } from 'node:url';

import { AUTH_COOKIE_NAME, checkToken } from './auth.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (!k) continue;
    out[k] = rest.join('=');
  }
  return out;
}

export interface HttpServerOptions {
  staticRoot: string;
  expectedToken: string;
  /** Host:port string for display / redirect. */
  publicHost: string;
  /** Bound to the resulting http server. Must be attached BEFORE listen. */
  attachUpgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void;
  /** Optional debug snapshot producer for /debug endpoint. */
  debugSnapshot?: () => unknown;
}

export function createHttpServer(opts: HttpServerOptions) {
  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res, opts);
    } catch (err) {
      console.error('[PA-HTTP] handler error:', err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('internal error');
      }
    }
  });

  server.on('upgrade', (req, socket, head) => {
    try {
      opts.attachUpgrade(req, socket, head);
    } catch (err) {
      console.warn('[PA-HTTP] upgrade failed:', err);
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    }
  });

  return server;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: HttpServerOptions,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? opts.publicHost}`);

  // --- Health: unauthed ---
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, clients: 'use /debug', time: Date.now() }));
    return;
  }

  // --- Auth endpoint: ?token=... sets cookie and redirects to / ---
  if (url.pathname === '/auth') {
    const token = url.searchParams.get('token') ?? '';
    if (!checkToken(opts.expectedToken, token)) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('Invalid or missing token.');
      return;
    }
    // Set a session cookie. HttpOnly to keep it out of JS; SameSite=Lax so it
    // survives the redirect back to '/'.
    const cookie = `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`;
    res.writeHead(302, { 'set-cookie': cookie, location: '/' });
    res.end();
    return;
  }

  // --- Everything else requires auth via cookie or query string ---
  const cookies = parseCookies(req.headers.cookie);
  const qToken = url.searchParams.get('token');
  const hasToken =
    checkToken(opts.expectedToken, cookies[AUTH_COOKIE_NAME]) ||
    (qToken != null && checkToken(opts.expectedToken, qToken));

  if (!hasToken) {
    // For the root, provide a tiny landing page with a form rather than a
    // bare 401 so non-technical users know what to do.
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
      res.end(AUTH_LANDING_HTML);
      return;
    }
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('Unauthorized. Use /auth?token=...');
    return;
  }

  // If the request came in with ?token=..., drop a cookie + redirect so the
  // token leaves the URL bar and subsequent asset loads reuse the cookie.
  if (qToken != null && !checkToken(opts.expectedToken, cookies[AUTH_COOKIE_NAME])) {
    const cookie = `${AUTH_COOKIE_NAME}=${encodeURIComponent(qToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`;
    res.writeHead(302, { 'set-cookie': cookie, location: url.pathname });
    res.end();
    return;
  }

  // --- Debug snapshot (authed) ---
  if (url.pathname === '/debug') {
    const payload = opts.debugSnapshot?.() ?? { note: 'no snapshot available' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload, null, 2));
    return;
  }

  // --- Static serving ---
  let rel = url.pathname;
  if (rel === '/') rel = '/index.html';

  // Prevent path traversal.
  const fullPath = path.join(opts.staticRoot, rel);
  if (!fullPath.startsWith(path.resolve(opts.staticRoot))) {
    res.writeHead(400);
    res.end('bad path');
    return;
  }

  try {
    const st = await fsp.stat(fullPath);
    if (!st.isFile()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }

    // Inject runtime bootstrap into index.html
    if (rel === '/index.html') {
      const html = await fsp.readFile(fullPath, 'utf8');
      const injected = injectBootstrap(html, opts.expectedToken);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(injected);
      return;
    }

    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': rel.startsWith('/assets/') ? 'public, max-age=3600' : 'no-store',
    });
    await pipeline(createReadStream(fullPath), res);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}

function injectBootstrap(html: string, token: string): string {
  const tokenJson = JSON.stringify(token);
  const bootstrap = `
  <script>
    window.__PA_RUNTIME__ = 'websocket';
    window.__PA_TOKEN__ = ${tokenJson};
  </script>`;
  // Prefer injecting BEFORE </head> so the globals exist before module scripts run.
  if (html.includes('</head>')) {
    return html.replace('</head>', `${bootstrap}\n</head>`);
  }
  return bootstrap + html;
}

const AUTH_LANDING_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Pixel Agents — Auth</title>
<style>
  body { font: 14px/1.4 system-ui, sans-serif; max-width: 420px; margin: 6rem auto; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.25rem; margin-bottom: 0.5rem; }
  input[type=text] { width: 100%; padding: 0.5rem; box-sizing: border-box; font-family: monospace; }
  button { margin-top: 0.5rem; padding: 0.5rem 1rem; cursor: pointer; }
  .hint { color: #666; font-size: 0.85rem; margin-top: 1rem; }
</style></head>
<body>
  <h1>Pixel Agents — Authentication</h1>
  <p>This viewer needs a bearer token. Paste the one printed by the standalone server on startup.</p>
  <form method="get" action="/auth">
    <input name="token" type="text" placeholder="bearer token" autofocus required>
    <button type="submit">Enter</button>
  </form>
  <p class="hint">The token rotates on every server restart.</p>
</body></html>`;
