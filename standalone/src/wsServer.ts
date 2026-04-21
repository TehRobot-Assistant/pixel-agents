import type { IncomingMessage } from 'node:http';

import { WebSocket, WebSocketServer } from 'ws';

import { checkToken } from './auth.js';
import type { OutMsg } from './protocol.js';

export interface WsServerOptions {
  expectedToken: string;
  path?: string;
  /** Called on client-first-connect so the caller can push initial state. */
  onClientReady?: (client: ClientHandle) => void;
  /** Called on every inbound JSON message (except pings). */
  onClientMessage?: (client: ClientHandle, msg: unknown) => void;
  /** Called when a client disconnects. */
  onClientClose?: (client: ClientHandle) => void;
}

export interface ClientHandle {
  readonly id: number;
  readonly remote: string;
  send(msg: OutMsg): void;
  close(): void;
}

export class AgentEventBus {
  private readonly sockets = new Set<WebSocket>();
  private readonly wss: WebSocketServer;
  private readonly opts: WsServerOptions;
  private nextClientId = 1;

  constructor(opts: WsServerOptions) {
    this.opts = opts;
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
  }

  /**
   * Called from the HTTP server's `upgrade` event. Returns true if we handled
   * the upgrade (matched our path + auth), false otherwise so the caller can
   * fall through to 401.
   */
  handleUpgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const expectedPath = this.opts.path ?? '/events';
    if (url.pathname !== expectedPath) return false;
    const token = url.searchParams.get('token');
    if (!checkToken(this.opts.expectedToken, token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return true;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req);
    });
    return true;
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    this.sockets.add(ws);
    const id = this.nextClientId++;
    const remote = req.socket.remoteAddress ?? 'unknown';

    const handle: ClientHandle = {
      id,
      remote,
      send: (msg) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.send(JSON.stringify(msg));
        } catch (err) {
          console.warn(`[PA-WS] send failed (client ${id}):`, err);
        }
      },
      close: () => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      },
    };

    console.log(`[PA-WS] client ${id} connected from ${remote}`);
    this.opts.onClientReady?.(handle);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.opts.onClientMessage?.(handle, msg);
      } catch {
        /* ignore malformed */
      }
    });

    ws.on('close', () => {
      this.sockets.delete(ws);
      console.log(`[PA-WS] client ${id} disconnected`);
      this.opts.onClientClose?.(handle);
    });
    ws.on('error', (err) => console.warn(`[PA-WS] client ${id} error:`, err.message));
  }

  /** Broadcast a message to every connected client. */
  broadcast(msg: OutMsg): void {
    const json = JSON.stringify(msg);
    for (const ws of this.sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.send(json);
      } catch (err) {
        console.warn('[PA-WS] broadcast send failed:', err);
      }
    }
  }

  get clientCount(): number {
    return this.sockets.size;
  }

  close(): void {
    for (const ws of this.sockets) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.wss.close();
  }
}
