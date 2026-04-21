/**
 * Runtime detection, provider-agnostic
 *
 * Single source of truth for determining whether the webview is running
 * inside an IDE extension (VS Code, Cursor, Windsurf, etc.), standalone
 * in a browser (mock-assets demo), or driven by a standalone WebSocket
 * server (the `standalone/` CLI).
 */

declare function acquireVsCodeApi(): unknown;

declare global {
  interface Window {
    __PA_RUNTIME__?: Runtime;
    __PA_TOKEN__?: string;
  }
}

export type Runtime = 'vscode' | 'browser' | 'websocket';

function detect(): Runtime {
  // Explicit override from the standalone server's injected bootstrap.
  if (typeof window !== 'undefined' && window.__PA_RUNTIME__) {
    return window.__PA_RUNTIME__;
  }
  // VS Code webview exposes acquireVsCodeApi().
  if (typeof acquireVsCodeApi !== 'undefined') return 'vscode';
  return 'browser';
}

const runtime: Runtime = detect();

export const isBrowserRuntime = runtime === 'browser';
export const isWebsocketRuntime = runtime === 'websocket';
export const isVSCodeRuntime = runtime === 'vscode';
export const currentRuntime: Runtime = runtime;
