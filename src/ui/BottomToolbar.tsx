import { Box, Text } from "ink";
import { currentTask, projectDir } from "../paths.js";

export type ToolbarState = {
  lastAgent: string | null;
  lastStatus: string | null;
  lastElapsed: number;
  verbose: boolean;
  agentCount: number;
};

export function BottomToolbar({ state }: { state: ToolbarState }) {
  const parts: string[] = [`task: ${currentTask()}`];
  if (state.lastAgent) {
    parts.push(
      `last: @${state.lastAgent} ${state.lastStatus ?? ""} ${state.lastElapsed.toFixed(0)}s`.trim(),
    );
  }
  parts.push(`cwd: ${projectDir()}`);
  parts.push(`${state.agentCount} agents`);
  if (state.verbose) parts.push("verbose");
  return (
    <Box>
      <Text dimColor>{parts.join(" · ")}</Text>
    </Box>
  );
}
