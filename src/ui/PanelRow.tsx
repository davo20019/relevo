import { Box } from "ink";
import { AgentPanel } from "./AgentPanel.js";
import type { AgentRunState } from "../run.js";

// Side-by-side layout for parallel runs (live or completed) so comparison
// stays intact when the last agent finishes. Each side-by-side child gets an
// explicit width so Ink doesn't have to infer one through flex math, since
// flex inference breaks inside `<Static>` (no measured parent width) and
// collapses children to their min content, mangling text. When more agents
// are dispatched than fit on one row, wraps into multiple rows of equal-width
// panels. Falls back to single-column on narrow terminals.
const MIN_WIDTH_PER_PANEL = 60;

export function PanelRow({
  runs,
  tick,
  keyPrefix,
  cols,
}: {
  runs: AgentRunState[];
  tick: number;
  keyPrefix: string;
  cols: number;
}) {
  if (runs.length === 0) return null;

  const maxPerRow = Math.max(1, Math.floor(cols / MIN_WIDTH_PER_PANEL));
  const panelsPerRow = runs.length >= 2 ? Math.min(runs.length, maxPerRow) : 1;
  const sideBySide = panelsPerRow >= 2;
  const perPanelWidth = sideBySide ? Math.floor((cols - panelsPerRow) / panelsPerRow) : cols;

  const rows: AgentRunState[][] = [];
  for (let i = 0; i < runs.length; i += panelsPerRow) {
    rows.push(runs.slice(i, i + panelsPerRow));
  }

  return (
    <Box flexDirection="column">
      {rows.map((row, rowIdx) => (
        <Box key={`${keyPrefix}-row-${rowIdx}`} flexDirection={sideBySide ? "row" : "column"}>
          {row.map((r) => (
            <Box
              key={`${keyPrefix}-${r.agentName}`}
              width={perPanelWidth}
              flexDirection="column"
              marginRight={sideBySide ? 1 : 0}
            >
              <AgentPanel run={r} tick={tick} width={perPanelWidth} />
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}
