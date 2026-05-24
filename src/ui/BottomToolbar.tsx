import { Box, Text } from "ink";
import os from "node:os";
import { projectDir } from "../paths.js";
import {
  AgentStatusChips,
  agentStatusRowFits,
  agentStatusRowText,
  type AgentStatus,
} from "./AgentStatusRow.js";

export type ToolbarState = {
  lastAgent: string | null;
  lastStatus: string | null;
  lastElapsed: number;
  verbose: boolean;
  defaultAgent: string | null;
  readyCount: number;
  offCount: number;
  runningCount: number;
};

export function formatAgentStatus(ready: number, off: number, running: number): string {
  const parts: string[] = [];
  if (running > 0) {
    parts.push(`${running} running`);
    const idle = Math.max(0, ready - running);
    if (idle > 0) parts.push(`${idle} idle`);
  } else {
    parts.push(`${ready} ready`);
  }
  if (off > 0) parts.push(`${off} off`);
  return `agents: ${parts.join(" · ")}`;
}

export function formatToolbarRightRows({
  metaParts,
  agentStatusText,
  aggregateText,
}: {
  metaParts: string[];
  agentStatusText: string | null;
  aggregateText: string;
}): string[] {
  const right = agentStatusText ?? aggregateText;
  const tail = metaParts.length > 0 ? `  ·  ${metaParts.join("  ·  ")}` : "";
  return [`${right}${tail}`];
}

export function bottomStatusJustifyContent(): "flex-end" {
  return "flex-end";
}

export function BottomToolbar({
  state,
  cols,
  perAgentStatuses = [],
  tick = 0,
  colorMap = {},
}: {
  state: ToolbarState;
  cols: number;
  perAgentStatuses?: AgentStatus[];
  tick?: number;
  colorMap?: Record<string, string>;
}) {
  const left = `cwd: ${shortenPath(projectDir())}`;
  const metaParts: string[] = [];
  if (state.verbose) metaParts.push("verbose");
  const aggregate = formatAgentStatus(state.readyCount, state.offCount, state.runningCount);
  const reserved = left.length + 4 + (metaParts.length > 0 ? metaParts.join("  ·  ").length + 4 : 0);
  const showChips =
    perAgentStatuses.length > 0 && agentStatusRowFits(perAgentStatuses, cols, reserved);
  const metaSuffix = metaParts.length > 0 ? `  ·  ${metaParts.join("  ·  ")}` : "";

  const rule = "┄".repeat(Math.max(0, cols));

  return (
    <Box flexDirection="column">
      <Text dimColor>{rule}</Text>
      <Box flexDirection="row">
        <Box flexGrow={1}>
          <Text dimColor>{left}</Text>
        </Box>
        <Box flexDirection="row">
          {showChips ? (
            <AgentStatusChips
              statuses={perAgentStatuses}
              tick={tick}
              colorMap={colorMap}
              defaultAgent={state.defaultAgent}
            />
          ) : (
            <Text dimColor>{aggregate}</Text>
          )}
          {metaSuffix ? <Text dimColor>{metaSuffix}</Text> : null}
        </Box>
      </Box>
    </Box>
  );
}

function shortenPath(p: string): string {
  const home = os.homedir();
  return home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
}
