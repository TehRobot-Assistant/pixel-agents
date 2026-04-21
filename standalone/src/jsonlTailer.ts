import { promises as fsp } from 'node:fs';
import { createReadStream } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';

import type { OutMsg } from './protocol.js';

const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');
const POLL_INTERVAL_MS = 2000;

/** Tools that don't require an implicit permission prompt */
const PERMISSION_EXEMPT = new Set(['Task', 'Agent', 'AskUserQuestion']);

/** Bash command display length cap */
const BASH_CMD_MAX = 80;

export interface TailerEmitter {
  /** Called for every translated outbound message; tailer does NOT hold refs. */
  emit(msg: OutMsg): void;
}

interface TrackedFile {
  file: string;
  agentId: number;
  terminalIndex: number;
  offset: number;
  /** Incomplete line buffer when a read stops mid-line (append-only files). */
  lineBuffer: string;
  /** Which tool ids are currently "active" — open tool_use blocks. */
  activeTools: Map<string, { name: string; status: string }>;
  /** For each parent Task/Agent tool id, the set of live sub-tool ids. */
  activeSubTools: Map<string, Set<string>>;
  /** Which sub-tool ids map to which names (parent id → subToolId → name). */
  activeSubToolNames: Map<string, Map<string, string>>;
  /** Last time the file had new bytes — used for stale-agent cleanup. */
  lastActivity: number;
  /** True once we've emitted agentCreated for this session. */
  spawned: boolean;
  /** `firstPassComplete` is true after the initial seed read finishes. Before
   * that, `activeTools` reflects the tail state but we SKIP emitting start/done
   * events for lines in the history — we only care about live activity. */
  firstPassComplete: boolean;
  hadToolsInTurn: boolean;
}

function fmtToolStatus(name: string, input: Record<string, unknown> | undefined): string {
  const inp = input ?? {};
  const base = (p: unknown): string => (typeof p === 'string' ? path.basename(p) : '');
  switch (name) {
    case 'Read':
      return `Reading ${base(inp.file_path)}`;
    case 'Edit':
      return `Editing ${base(inp.file_path)}`;
    case 'Write':
      return `Writing ${base(inp.file_path)}`;
    case 'Bash': {
      const cmd = typeof inp.command === 'string' ? inp.command : '';
      return `Running: ${cmd.length > BASH_CMD_MAX ? cmd.slice(0, BASH_CMD_MAX) + '\u2026' : cmd}`;
    }
    case 'Glob':
      return 'Searching files';
    case 'Grep':
      return 'Searching code';
    case 'WebFetch':
      return 'Fetching web content';
    case 'WebSearch':
      return 'Searching the web';
    case 'Task':
    case 'Agent': {
      const d = typeof inp.description === 'string' ? inp.description : '';
      return d ? `Subtask: ${d.length > 80 ? d.slice(0, 80) + '\u2026' : d}` : 'Running subtask';
    }
    case 'AskUserQuestion':
      return 'Waiting for your answer';
    default:
      return `Using ${name}`;
  }
}

export class JsonlTailer {
  private readonly emitter: TailerEmitter;
  private readonly tracked = new Map<string, TrackedFile>();
  /** Monotonic agent id, starts at 1. */
  private nextAgentId = 1;
  private nextTerminalIndex = 1;
  private poller: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  /** Only consider sessions modified within this window (24h by default). */
  private readonly staleCutoffMs = 24 * 60 * 60 * 1000;

  constructor(emitter: TailerEmitter) {
    this.emitter = emitter;
  }

  async start(): Promise<void> {
    // Seed pass: discover every existing session and read it to its tail so we
    // know the current tool state, but don't replay old events into the UI.
    await this.scan(true);
    this.poller = setInterval(() => {
      if (this.stopped) return;
      this.scan(false).catch((err) =>
        console.warn('[PA-tailer] scan failed:', err instanceof Error ? err.message : err),
      );
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.poller) {
      clearInterval(this.poller);
      this.poller = null;
    }
  }

  /** Diagnostic snapshot for debug endpoints. */
  debugSnapshot(): {
    tracked: number;
    agents: Array<{ agentId: number; file: string; activeTools: number; lastActivity: number }>;
  } {
    const agents = Array.from(this.tracked.values()).map((t) => ({
      agentId: t.agentId,
      file: t.file,
      activeTools: t.activeTools.size,
      lastActivity: t.lastActivity,
    }));
    return { tracked: this.tracked.size, agents };
  }

  private async scan(initial: boolean): Promise<void> {
    let projectDirs: string[] = [];
    try {
      projectDirs = await fsp.readdir(PROJECTS_ROOT);
    } catch {
      return; // Claude projects dir might not exist
    }

    const now = Date.now();
    const cutoff = now - this.staleCutoffMs;

    for (const dir of projectDirs) {
      const dirPath = path.join(PROJECTS_ROOT, dir);
      let st;
      try {
        st = await fsp.stat(dirPath);
        if (!st.isDirectory()) continue;
      } catch {
        continue;
      }

      let files: string[] = [];
      try {
        files = await fsp.readdir(dirPath);
      } catch {
        continue;
      }

      for (const fn of files) {
        if (!fn.endsWith('.jsonl')) continue;
        const full = path.join(dirPath, fn);
        let fst;
        try {
          fst = await fsp.stat(full);
        } catch {
          continue;
        }
        if (fst.mtimeMs < cutoff && !this.tracked.has(full)) {
          // too old to care about on first discovery
          continue;
        }

        let tf = this.tracked.get(full);
        if (!tf) {
          const agentId = this.nextAgentId++;
          const terminalIndex = this.nextTerminalIndex++;
          tf = {
            file: full,
            agentId,
            terminalIndex,
            offset: 0,
            lineBuffer: '',
            activeTools: new Map(),
            activeSubTools: new Map(),
            activeSubToolNames: new Map(),
            lastActivity: fst.mtimeMs,
            spawned: false,
            firstPassComplete: false,
            hadToolsInTurn: false,
          };
          this.tracked.set(full, tf);
        }

        if (fst.size > tf.offset) {
          await this.readNewBytes(tf, fst.size);
          tf.lastActivity = Date.now();
        }

        if (initial) {
          tf.firstPassComplete = true;
        } else if (!tf.firstPassComplete) {
          tf.firstPassComplete = true;
        }
      }
    }
  }

  private async readNewBytes(tf: TrackedFile, fileSize: number): Promise<void> {
    const start = tf.offset;
    const end = fileSize;
    if (end <= start) return;

    return new Promise((resolve, reject) => {
      const stream = createReadStream(tf.file, {
        start,
        end: end - 1,
        encoding: 'utf8',
      });
      let buffered = tf.lineBuffer;
      stream.on('data', (chunk) => {
        buffered += chunk;
      });
      stream.on('error', reject);
      stream.on('end', () => {
        const lines = buffered.split('\n');
        // Last element might be an incomplete line — carry it forward.
        tf.lineBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          this.handleLine(tf, line);
        }
        tf.offset = end;
        resolve();
      });
    });
  }

  private handleLine(tf: TrackedFile, line: string): void {
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      return; // malformed JSON — ignore
    }

    // Spawn the agent on first usable record we see.
    if (!tf.spawned) {
      // Defer the agentCreated emit to the caller so the protocol is: first
      // activity → spawn the character, then apply state. This matches the
      // VS Code behaviour where a character appears when its terminal opens.
      this.emitter.emit({
        type: 'agentCreated',
        id: tf.agentId,
        terminalIndex: tf.terminalIndex,
        skipSpawnEffect: !tf.firstPassComplete, // history replays are instant
      });
      tf.spawned = true;
    }

    const type = record.type;
    const content = record.message?.content ?? record.content;

    if (type === 'assistant' && Array.isArray(content)) {
      this.handleAssistant(tf, content);
    } else if (type === 'assistant' && typeof content === 'string') {
      // Text-only turn. We don't emit a text-idle timer here — too noisy.
    } else if (type === 'user') {
      this.handleUser(tf, content);
    } else if (type === 'progress') {
      this.handleProgress(tf, record);
    } else if (type === 'system' && record.subtype === 'turn_duration') {
      this.handleTurnEnd(tf);
    }
  }

  private handleAssistant(tf: TrackedFile, blocks: any[]): void {
    const toolBlocks = blocks.filter((b) => b && b.type === 'tool_use' && typeof b.id === 'string');
    if (toolBlocks.length === 0) return;

    tf.hadToolsInTurn = true;
    if (tf.firstPassComplete) {
      this.emitter.emit({ type: 'agentStatus', id: tf.agentId, status: 'active' });
    }

    for (const block of toolBlocks) {
      const name: string = block.name || '';
      const id: string = block.id;
      const status = fmtToolStatus(name, block.input);
      tf.activeTools.set(id, { name, status });

      if (tf.firstPassComplete) {
        const runInBackground =
          (name === 'Task' || name === 'Agent') && block.input?.run_in_background === true;
        this.emitter.emit({
          type: 'agentToolStart',
          id: tf.agentId,
          toolId: id,
          status,
          toolName: name,
          runInBackground,
        });
      }
    }
  }

  private handleUser(tf: TrackedFile, content: unknown): void {
    if (!Array.isArray(content)) {
      // New user text prompt — reset turn state.
      if (typeof content === 'string' && content.trim()) {
        tf.hadToolsInTurn = false;
      }
      return;
    }

    for (const block of content) {
      if (!block || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      const toolId: string = block.tool_use_id;
      const active = tf.activeTools.get(toolId);
      if (!active) continue;

      // If it's a Task/Agent completing, clear sub-agent tools for it.
      if (active.name === 'Task' || active.name === 'Agent') {
        tf.activeSubTools.delete(toolId);
        tf.activeSubToolNames.delete(toolId);
        if (tf.firstPassComplete) {
          this.emitter.emit({
            type: 'subagentClear',
            id: tf.agentId,
            parentToolId: toolId,
          });
        }
      }

      tf.activeTools.delete(toolId);
      if (tf.firstPassComplete) {
        this.emitter.emit({ type: 'agentToolDone', id: tf.agentId, toolId });
      }
    }

    if (tf.activeTools.size === 0) {
      tf.hadToolsInTurn = false;
    }
  }

  private handleProgress(tf: TrackedFile, record: any): void {
    const parentToolId: string | undefined = record.parentToolUseID;
    if (!parentToolId) return;
    const parent = tf.activeTools.get(parentToolId);
    if (!parent) return;

    const parentIsAgent = parent.name === 'Task' || parent.name === 'Agent';
    if (!parentIsAgent) return;

    const data = record.data;
    if (!data || typeof data !== 'object') return;
    const msg = data.message;
    if (!msg || typeof msg !== 'object') return;
    const innerContent = msg.message?.content;
    if (!Array.isArray(innerContent)) return;

    if (msg.type === 'assistant') {
      for (const block of innerContent) {
        if (block?.type !== 'tool_use' || typeof block.id !== 'string') continue;
        const subId: string = block.id;
        const subName: string = block.name || '';
        const status = fmtToolStatus(subName, block.input);

        let subSet = tf.activeSubTools.get(parentToolId);
        if (!subSet) {
          subSet = new Set();
          tf.activeSubTools.set(parentToolId, subSet);
        }
        subSet.add(subId);

        let nameMap = tf.activeSubToolNames.get(parentToolId);
        if (!nameMap) {
          nameMap = new Map();
          tf.activeSubToolNames.set(parentToolId, nameMap);
        }
        nameMap.set(subId, subName);

        if (tf.firstPassComplete) {
          this.emitter.emit({
            type: 'subagentToolStart',
            id: tf.agentId,
            parentToolId,
            toolId: subId,
            status,
          });
        }
      }
    } else if (msg.type === 'user') {
      for (const block of innerContent) {
        if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const subId: string = block.tool_use_id;
        const subSet = tf.activeSubTools.get(parentToolId);
        if (subSet) subSet.delete(subId);
        const nameMap = tf.activeSubToolNames.get(parentToolId);
        if (nameMap) nameMap.delete(subId);

        if (tf.firstPassComplete) {
          this.emitter.emit({
            type: 'subagentToolDone',
            id: tf.agentId,
            parentToolId,
            toolId: subId,
          });
        }
      }
    }
  }

  private handleTurnEnd(tf: TrackedFile): void {
    // Clear all stale tool state and mark the agent waiting.
    if (tf.activeTools.size > 0 && tf.firstPassComplete) {
      this.emitter.emit({ type: 'agentToolsClear', id: tf.agentId });
    }
    tf.activeTools.clear();
    tf.activeSubTools.clear();
    tf.activeSubToolNames.clear();
    tf.hadToolsInTurn = false;

    if (tf.firstPassComplete) {
      this.emitter.emit({ type: 'agentStatus', id: tf.agentId, status: 'waiting' });
    }
  }

  // ------ Snapshot state helpers (used when a new WS client connects) ------

  /** Build the list of currently-known agents for `existingAgents`. */
  getExistingAgents(): { id: number; terminalIndex: number }[] {
    const out: { id: number; terminalIndex: number }[] = [];
    for (const tf of this.tracked.values()) {
      if (!tf.spawned) continue;
      out.push({ id: tf.agentId, terminalIndex: tf.terminalIndex });
    }
    return out;
  }

  /** Emit replay messages to bring a freshly-connected client up to state. */
  replayStateFor(emit: (m: OutMsg) => void): void {
    for (const tf of this.tracked.values()) {
      if (!tf.spawned) continue;
      emit({
        type: 'agentCreated',
        id: tf.agentId,
        terminalIndex: tf.terminalIndex,
        skipSpawnEffect: true,
      });
      for (const [toolId, t] of tf.activeTools) {
        emit({
          type: 'agentToolStart',
          id: tf.agentId,
          toolId,
          status: t.status,
          toolName: t.name,
        });
      }
      // Mirror status: if we still have tools, active; otherwise waiting.
      emit({
        type: 'agentStatus',
        id: tf.agentId,
        status: tf.activeTools.size > 0 ? 'active' : 'waiting',
      });
    }
  }
}
