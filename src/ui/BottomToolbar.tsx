import { Box, Text, useStdout } from "ink";
import { useEffect, useState } from "react";
import os from "node:os";
import { projectDir } from "../paths.js";
import { getActiveTask } from "../tasks.js";

export type ToolbarState = {
  lastAgent: string | null;
  lastStatus: string | null;
  lastElapsed: number;
  verbose: boolean;
  agentCount: number;
};

export function BottomToolbar({ state }: { state: ToolbarState }) {
  const cols = useTerminalColumns();
  const left = `task: ${getActiveTask() ?? "(no active task)"}  ·  cwd: ${shortenPath(projectDir())}`;
  const rightParts: string[] = [];
  if (state.lastAgent) {
    rightParts.push(
      `last: @${state.lastAgent} ${state.lastStatus ?? ""} ${state.lastElapsed.toFixed(0)}s`.trim(),
    );
  }
  rightParts.push(`${state.agentCount} agents`);
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

function useTerminalColumns(): number {
  const { stdout } = useStdout();
  const [cols, setCols] = useState<number>(stdout?.columns ?? 80);
  useEffect(() => {
    if (!stdout) return;
    const update = () => setCols(stdout.columns ?? 80);
    stdout.on("resize", update);
    return () => {
      stdout.off("resize", update);
    };
  }, [stdout]);
  return cols;
}
