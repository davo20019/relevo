import { Box, Text, useStdout } from "ink";
import { useEffect, useState } from "react";

// Bordered "you" panel that mirrors the agent-panel chrome (top border with a
// baked-in title, rounded box below) so the transcript reads as a back-and-
// forth instead of agent-only output with hidden interjections. White stays
// distinct from the colored agent borders so "you" never gets confused with
// an agent turn.
export function UserPrompt({ prompt }: { prompt: string }) {
  const cols = useTerminalColumns();
  const shown = prompt.trim() ? prompt : "(empty)";

  const borderColor = "white";
  // Top border layout: ╭─ › you ───╮
  // visible = 1 (space) + 1 (›) + 1 (space) + 3 (you) + 1 (space) = 7
  const titleVisible = 7;
  const overhead = 4; // ╭─ … ─╮
  const fillerCount = Math.max(0, cols - overhead - titleVisible);

  return (
    <Box flexDirection="column" marginTop={1} width={cols}>
      <Box flexDirection="row">
        <Text color={borderColor}>╭─</Text>
        <Text> </Text>
        <Text color={borderColor} bold>
          ›
        </Text>
        <Text color={borderColor} bold>
          {" you "}
        </Text>
        <Text color={borderColor}>
          {"─".repeat(fillerCount)}
          ─╮
        </Text>
      </Box>
      <Box
        borderStyle="round"
        borderColor={borderColor}
        borderTop={false}
        flexDirection="column"
        paddingX={1}
      >
        <Text bold>{shown}</Text>
      </Box>
    </Box>
  );
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
