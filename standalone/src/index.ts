import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateToken } from './auth.js';
import { createHttpServer } from './httpServer.js';
import { JsonlTailer } from './jsonlTailer.js';
import type { OutMsg } from './protocol.js';
import { AgentEventBus } from './wsServer.js';

interface CliArgs {
  port: number;
  host: string;
  assets: string;
  token?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    port: 8087,
    host: '0.0.0.0',
    assets: defaultAssets(),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--port' && v) {
      out.port = parseInt(v, 10);
      i++;
    } else if (a === '--host' && v) {
      out.host = v;
      i++;
    } else if (a === '--assets' && v) {
      out.assets = path.resolve(v);
      i++;
    } else if (a === '--token' && v) {
      out.token = v;
      i++;
    } else if (a === '-h' || a === '--help') {
      console.log(usage());
      process.exit(0);
    }
  }
  return out;
}

function defaultAssets(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/index.js → ../../dist/webview (built webview lives at repo-root/dist/webview)
  return path.resolve(here, '..', '..', 'dist', 'webview');
}

function usage(): string {
  return `Usage: pixel-agents-standalone [options]

Options:
  --port <n>      HTTP/WebSocket port (default: 8087)
  --host <ip>     Bind address (default: 0.0.0.0)
  --assets <dir>  Directory to serve as webview root
                  (default: ../dist/webview relative to this script)
  --token <s>     Use a fixed bearer token (default: random per restart)
  -h, --help      Show this help
`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const token = args.token ?? generateToken();

  const tailer = new JsonlTailer({
    emit(msg: OutMsg) {
      bus.broadcast(msg);
    },
  });

  const bus = new AgentEventBus({
    expectedToken: token,
    path: '/events',
    onClientReady(client) {
      // Prime a fresh client with the existing agent lifecycle state so its
      // office populates immediately rather than waiting for the next event.
      tailer.replayStateFor((m) => client.send(m));
    },
    onClientMessage(_client, msg) {
      // We ONLY accept read-only client chatter in standalone mode. Layout
      // saves, seat persistence, focusAgent etc. are intentionally ignored:
      // the server never writes to ~/.claude or any file based on client input.
      const type = (msg as { type?: unknown })?.type;
      if (type === 'webviewReady') {
        // No state to send beyond what onClientReady did.
      }
      // else: silently drop.
    },
  });

  const http = createHttpServer({
    staticRoot: args.assets,
    expectedToken: token,
    publicHost: `${args.host}:${args.port}`,
    attachUpgrade(req, socket, head) {
      const handled = bus.handleUpgrade(req, socket, head);
      if (!handled) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
      }
    },
    debugSnapshot() {
      return {
        time: Date.now(),
        clients: bus.clientCount,
        assetsRoot: args.assets,
        tailer: tailer.debugSnapshot(),
      };
    },
  });

  await tailer.start();

  http.listen(args.port, args.host, () => {
    const host = args.host === '0.0.0.0' ? getLanHint() : args.host;
    const url = `http://${host}:${args.port}/?token=${encodeURIComponent(token)}`;
    console.log('─'.repeat(68));
    console.log(' Pixel Agents — standalone viewer');
    console.log('─'.repeat(68));
    console.log(` Bind:      ${args.host}:${args.port}`);
    console.log(` Assets:    ${args.assets}`);
    console.log(` Token:     ${token}`);
    console.log(` URL:       ${url}`);
    console.log(` Debug:     http://${host}:${args.port}/debug?token=${encodeURIComponent(token)}`);
    console.log('─'.repeat(68));
  });

  const shutdown = (signal: string) => {
    console.log(`\n[PA] received ${signal}, shutting down`);
    tailer.stop();
    bus.close();
    http.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function getLanHint(): string {
  // Best-effort: pick the first non-internal IPv4.
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const ifc of ifaces[name] ?? []) {
        if (ifc.family === 'IPv4' && !ifc.internal) return ifc.address;
      }
    }
  } catch {
    /* fall through */
  }
  return '127.0.0.1';
}

main().catch((err) => {
  console.error('[PA] fatal:', err);
  process.exit(1);
});
