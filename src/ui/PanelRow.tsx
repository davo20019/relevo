import { Box, useStdout } from "ink";
import { useEffect, useState } from "react";
import { AgentPanel } from "./AgentPanel.js";
import type { AgentRunState } from "../run.js";

// Side-by-side layout for parallel runs (live or completed) so comparison
// stays intact when the last agent finishes. Each side-by-side child gets an
// explicit width so Ink doesn't have to infer one through flex math — flex
// inference breaks inside `<Static>` (no measured parent width) and collapses
// children to their min content, mangling text. Falls back to column on
// narrow terminals or single-agent dispatches.
const MIN_WIDTH_PER_PANEL = 60;

export function PanelRow({
  runs,
  tick,
  keyPrefix,
}: {
  runs: AgentRunState[];
  tick: number;
  keyPrefix: string;
}) {
  const cols = useTerminalColumns();
  if (runs.length === 0) return null;

  const rowFits = runs.length >= 2 && cols >= runs.length * MIN_WIDTH_PER_PANEL;
  const direction = rowFits ? "row" : "column";
  const perPanelWidth = rowFits ? Math.floor((cols - runs.length) / runs.length) : undefined;

  return (
    <Box flexDirection={direction}>
      {runs.map((r) => (
        <Box
          key={`${keyPrefix}-${r.agentName}`}
          width={perPanelWidth}
          flexDirection="column"
          marginRight={rowFits ? 1 : 0}
        >
          <AgentPanel run={r} tick={tick} />
        </Box>
      ))}
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
