import { isBrowserRuntime, isWebsocketRuntime } from './runtime';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

type PostMessageFn = (msg: unknown) => void;

interface WebsocketBridge {
  postMessage: PostMessageFn;
}

/**
 * Standalone WebSocket bridge. Connects to ws(s)://<host>/events?token=...
 * Re-dispatches inbound JSON as a `window` MessageEvent so the existing
 * useExtensionMessages listener picks it up unchanged.
 * Outbound postMessage sends JSON frames back to the server.
 * Auto-reconnects with capped exponential backoff.
 */
function createWebsocketBridge(): WebsocketBridge {
  let ws: WebSocket | null = null;
  let isOpen = false;
  let backoffMs = 500;
  const queue: unknown[] = [];

  function wsUrl(): string {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const token = window.__PA_TOKEN__ ?? '';
    return `${protocol}//${host}/events?token=${encodeURIComponent(token)}`;
  }

  function connect(): void {
    try {
      ws = new WebSocket(wsUrl());
    } catch (err) {
      console.warn('[PA-WS] Failed to construct WebSocket:', err);
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      isOpen = true;
      backoffMs = 500;
      console.log('[PA-WS] Connected');
      // Flush any queued postMessages
      while (queue.length > 0) {
        try {
          ws!.send(JSON.stringify(queue.shift()));
        } catch (err) {
          console.warn('[PA-WS] Failed to flush:', err);
          break;
        }
      }
      // Note: the React app emits its own `webviewReady` via useExtensionMessages
      // when the window message handler is mounted — no need to send it here.
    };

    ws.onmessage = (ev) => {
      try {
        const data: unknown = JSON.parse(ev.data as string);
        window.dispatchEvent(new MessageEvent('message', { data }));
      } catch {
        /* ignore malformed */
      }
    };

    ws.onclose = () => {
      isOpen = false;
      ws = null;
      scheduleReconnect();
    };

    ws.onerror = () => {
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    };
  }

  function scheduleReconnect(): void {
    const delay = Math.min(backoffMs, 10_000);
    backoffMs = Math.min(backoffMs * 2, 10_000);
    console.log(`[PA-WS] Reconnecting in ${delay}ms`);
    setTimeout(connect, delay);
  }

  connect();

  return {
    postMessage(msg: unknown): void {
      if (isOpen && ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify(msg));
        } catch (err) {
          console.warn('[PA-WS] send failed, queueing:', err);
          queue.push(msg);
        }
      } else {
        queue.push(msg);
      }
    },
  };
}

function resolveApi(): { postMessage: PostMessageFn } {
  if (isWebsocketRuntime) {
    return createWebsocketBridge();
  }
  if (isBrowserRuntime) {
    return { postMessage: (msg: unknown) => console.log('[vscode.postMessage]', msg) };
  }
  return acquireVsCodeApi() as { postMessage: PostMessageFn };
}

export const vscode: { postMessage: PostMessageFn } = resolveApi();
