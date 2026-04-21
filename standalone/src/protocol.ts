/**
 * Shared type definitions for the webview protocol.
 *
 * These shapes mirror a minimal, curated subset of the messages that
 * `PixelAgentsViewProvider` posts to the VS Code webview via
 * `webview.postMessage(...)`. We deliberately do NOT re-export every
 * extension message — just what's needed to render characters and tool
 * activity in the browser. Agent management (create/close/focus) is a
 * one-way affair here: the server decides from JSONL, and the browser
 * user cannot spawn or terminate agents from the standalone viewer.
 */

// --------------- Outbound (server → browser) ---------------

export type OutMsg =
  | { type: 'characterSpritesLoaded'; characters: unknown }
  | { type: 'floorTilesLoaded'; sprites: unknown }
  | { type: 'wallTilesLoaded'; sets: unknown }
  | {
      type: 'furnitureAssetsLoaded';
      catalog: unknown;
      sprites: Record<string, unknown>;
    }
  | { type: 'layoutLoaded'; layout: unknown }
  | {
      type: 'settingsLoaded';
      soundEnabled: boolean;
      extensionVersion: string;
      lastSeenVersion: string;
      hooksInfoShown: boolean;
      hooksEnabled: boolean;
      alwaysShowLabels: boolean;
      externalAssetDirectories: string[];
      watchAllSessions: boolean;
    }
  | { type: 'workspaceFolders'; folders: string[] }
  | { type: 'existingAgents'; agents: AgentSummary[] }
  | { type: 'agentCreated'; id: number; terminalIndex: number; skipSpawnEffect?: boolean }
  | { type: 'agentClosed'; id: number }
  | { type: 'agentStatus'; id: number; status: 'active' | 'waiting' }
  | {
      type: 'agentToolStart';
      id: number;
      toolId: string;
      status: string;
      toolName?: string;
      permissionActive?: boolean;
      runInBackground?: boolean;
    }
  | { type: 'agentToolDone'; id: number; toolId: string }
  | { type: 'agentToolsClear'; id: number }
  | { type: 'subagentToolStart'; id: number; parentToolId: string; toolId: string; status: string }
  | { type: 'subagentToolDone'; id: number; parentToolId: string; toolId: string }
  | { type: 'subagentClear'; id: number; parentToolId: string };

export interface AgentSummary {
  id: number;
  terminalIndex: number;
  seatId?: string;
  palette?: number;
  hueShift?: number;
  teamName?: string;
  agentName?: string | null;
  isTeamLead?: boolean;
  leadAgentId?: number;
}

// --------------- Inbound (browser → server) ---------------

export type InMsg =
  | { type: 'webviewReady' }
  | { type: 'saveLayout'; layout: unknown }
  | { type: 'saveAgentSeats'; seats: unknown }
  // No-ops in standalone mode — we accept & ignore:
  | { type: 'focusAgent'; id: number }
  | { type: 'closeAgent'; id: number }
  | { type: 'openClaude'; cwd?: string }
  | { type: string; [k: string]: unknown };
