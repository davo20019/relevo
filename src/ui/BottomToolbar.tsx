import { Box, Text } from "ink";
import os from "node:os";
import { projectDir } from "../paths.js";
import { getActiveTask } from "../tasks.js";

export type ToolbarState = {
  lastAgent: string | null;
  lastStatus: string | null;
  lastElapsed: number;
  verbose: boolean;
  focusAgent: string | null;
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

export function BottomToolbar({ state, cols }: { state: ToolbarState; cols: number }) {
  const left = `task: ${getActiveTask() ?? "(no active task)"}  ·  cwd: ${shortenPath(projectDir())}`;
  const rightParts: string[] = [];
  if (state.lastAgent) {
    rightParts.push(
      `last: @${state.lastAgent} ${state.lastStatus ?? ""} ${state.lastElapsed.toFixed(0)}s`.trim(),
    );
  }
  rightParts.push(formatAgentStatus(state.readyCount, state.offCount, state.runningCount));
  if (state.focusAgent) rightParts.push(`focus: @${state.focusAgent}`);
  if (state.verbose) rightParts.push("verbose");
  const right = rightParts.join("  ·  ");

  // A thin dashed rule visually severs the toolbar from the input area above.
  const rule = "┄".repeat(Math.max(0, cols));

  return (
    <Box flexDirection="column">
      <Text dimColor>{rule}</Text>
      <Box>
        <Box flexGrow={1}>
          <Text dimColor>{left}</Text>
        </Box>
        <Text dimColor>{right}</Text>
      </Box>
    </Box>
  );
}

function shortenPath(p: string): string {
  const home = os.homedir();
  return home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
}
