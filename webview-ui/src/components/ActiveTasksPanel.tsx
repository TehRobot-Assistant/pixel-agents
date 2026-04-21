import { useEffect, useMemo, useState } from 'react';

import { getCharacterSprites } from '../office/sprites/spriteData.js';
import type { Character, ToolActivity } from '../office/types.js';
import { Direction } from '../office/types.js';

const COLLAPSED_KEY = 'pixel-agents:task-panel-collapsed';

interface ActiveTasksPanelProps {
  agents: number[];
  agentTools: Record<number, ToolActivity[]>;
  agentStatuses: Record<number, string>;
  characters: Map<number, Character>;
  onSelect: (id: number) => void;
}

/** Get the display label for an agent (mirrors the canvas label logic). */
function getAgentLabel(id: number, ch: Character | undefined): string {
  if (ch?.agentName) return ch.agentName;
  if (ch?.teamName && ch.isTeamLead) return `${ch.teamName} LEAD`;
  return `Agent #${id}`;
}

/**
 * Derive a representative CSS color for the agent's character palette by
 * sampling a visible shirt/torso pixel from the DOWN-facing walk frame.
 * Falls back to a muted border colour if the sprites haven't loaded yet.
 */
function getPaletteColor(palette: number, hueShift: number): string {
  try {
    const sprites = getCharacterSprites(palette, hueShift);
    const frame = sprites.walk[Direction.DOWN][0];
    if (!frame || frame.length === 0) return 'var(--color-border)';
    // Scan the torso region (roughly rows 14-20, cols 5-10) for the first
    // opaque pixel. These character sprites are 16 wide, torso sits midway.
    const rows = frame.length;
    const rowStart = Math.min(14, rows - 4);
    const rowEnd = Math.min(20, rows);
    for (let r = rowStart; r < rowEnd; r++) {
      const row = frame[r];
      if (!row) continue;
      for (let c = 5; c <= 10 && c < row.length; c++) {
        const px = row[c];
        if (px && px.length >= 7 && px.startsWith('#')) {
          // Drop any alpha suffix for CSS usage
          return px.slice(0, 7);
        }
      }
    }
  } catch {
    /* fall through */
  }
  return 'var(--color-border)';
}

/**
 * Describe what the agent is doing right now. Prefer the latest non-done
 * tool's status string. Returns null when the agent has no active tools.
 */
function describeActiveTools(tools: ToolActivity[] | undefined): ToolActivity[] {
  if (!tools || tools.length === 0) return [];
  return tools.filter((t) => !t.done);
}

export function ActiveTasksPanel({
  agents,
  agentTools,
  agentStatuses,
  characters,
  onSelect,
}: ActiveTasksPanelProps) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch {
      /* ignore quota/storage issues */
    }
  }, [collapsed]);

  // Snapshot agents with active tools, in stable ID order.
  const activeAgents = useMemo(() => {
    const rows: Array<{
      id: number;
      label: string;
      color: string;
      tools: ToolActivity[];
      waiting: boolean;
    }> = [];
    for (const id of [...agents].sort((a, b) => a - b)) {
      const ch = characters.get(id);
      const active = describeActiveTools(agentTools[id]);
      const waiting = agentStatuses[id] === 'waiting';
      if (active.length === 0 && !waiting) continue;
      rows.push({
        id,
        label: getAgentLabel(id, ch),
        color: ch ? getPaletteColor(ch.palette, ch.hueShift) : 'var(--color-border)',
        tools: active,
        waiting,
      });
    }
    return rows;
  }, [agents, agentTools, agentStatuses, characters]);

  // Shared styles (pixel aesthetic — no rounded corners, 2px border, hard shadow)
  const panelBase: React.CSSProperties = {
    position: 'absolute',
    top: 8,
    right: 8,
    zIndex: 30,
    background: 'var(--color-bg)',
    border: '2px solid var(--color-border)',
    boxShadow: '2px 2px 0px var(--color-bg-dark)',
    borderRadius: 0,
    fontFamily: "'FS Pixel Sans', sans-serif",
    color: 'var(--color-text)',
    width: collapsed ? 'auto' : 240,
    maxHeight: 'calc(100vh - 120px)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  };

  const headerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '6px 10px',
    background: 'var(--color-bg-dark)',
    borderBottom: collapsed ? 'none' : '2px solid var(--color-border)',
    cursor: 'pointer',
    userSelect: 'none',
    fontSize: 18,
  };

  const bodyStyle: React.CSSProperties = {
    overflowY: 'auto',
    padding: 6,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  };

  return (
    <div style={panelBase}>
      <div
        style={headerStyle}
        onClick={() => setCollapsed((v) => !v)}
        role="button"
        aria-expanded={!collapsed}
        title={collapsed ? 'Expand active tasks' : 'Collapse active tasks'}
      >
        <span>Active tasks</span>
        <span
          aria-hidden="true"
          style={{
            display: 'inline-block',
            transform: collapsed ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 120ms',
            fontSize: 14,
          }}
        >
          {/* Chevron: points right when collapsed, down when expanded */}
          {collapsed ? '◀' : '▼'}
        </span>
      </div>

      {!collapsed && (
        <div style={bodyStyle}>
          {activeAgents.length === 0 ? (
            <div
              style={{
                padding: '14px 8px',
                textAlign: 'center',
                color: 'var(--color-text-muted)',
                fontSize: 18,
              }}
            >
              All agents idle
            </div>
          ) : (
            activeAgents.map((row) => (
              <div
                key={row.id}
                style={{
                  border: '2px solid var(--color-border)',
                  background: 'var(--color-bg-dark)',
                }}
              >
                <div
                  onClick={() => onSelect(row.id)}
                  role="button"
                  title={`Focus ${row.label}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '4px 8px',
                    cursor: 'pointer',
                    borderBottom: '1px solid var(--color-border)',
                    fontSize: 18,
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 8,
                      height: 8,
                      background: row.color,
                      border: '1px solid var(--color-border)',
                      display: 'inline-block',
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      flex: 1,
                    }}
                  >
                    {row.label}
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {row.tools.map((tool) => {
                    const statusText = tool.permissionWait ? 'Needs approval' : tool.status;
                    const dotColor = tool.permissionWait
                      ? 'var(--color-status-permission)'
                      : 'var(--color-status-active)';
                    return (
                      <div
                        key={tool.toolId}
                        onClick={() => onSelect(row.id)}
                        title={statusText}
                        role="button"
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '3px 8px',
                          cursor: 'pointer',
                          fontSize: 16,
                          color: 'var(--color-text)',
                        }}
                        onMouseEnter={(e) => {
                          (e.currentTarget as HTMLDivElement).style.background =
                            'var(--color-btn-hover)';
                        }}
                        onMouseLeave={(e) => {
                          (e.currentTarget as HTMLDivElement).style.background = 'transparent';
                        }}
                      >
                        <span
                          aria-hidden="true"
                          style={{
                            width: 6,
                            height: 6,
                            background: dotColor,
                            display: 'inline-block',
                            flexShrink: 0,
                          }}
                          className={tool.permissionWait ? '' : 'pixel-pulse'}
                        />
                        <span
                          style={{
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            flex: 1,
                          }}
                        >
                          {statusText}
                        </span>
                      </div>
                    );
                  })}
                  {row.tools.length === 0 && row.waiting && (
                    <div
                      onClick={() => onSelect(row.id)}
                      title="Might be waiting for input"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '3px 8px',
                        cursor: 'pointer',
                        fontSize: 16,
                        color: 'var(--color-text-muted)',
                      }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          width: 6,
                          height: 6,
                          background: 'var(--color-status-permission)',
                          display: 'inline-block',
                          flexShrink: 0,
                        }}
                      />
                      <span
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          flex: 1,
                        }}
                      >
                        Might be waiting for input
                      </span>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
