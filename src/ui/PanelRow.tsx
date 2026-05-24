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
  // Single-column rows leave one column free for the same reason as orphan
  // rows below: a box whose right border lands on the terminal's last column
  // triggers auto-wrap on many terminals, which eats the bottom ╰─...─╯ line
  // (and with it the token-usage label that lives on the bottom border).
  const perPanelWidth = sideBySide
    ? Math.floor((cols - panelsPerRow) / panelsPerRow)
    : Math.max(1, cols - 1);

  const rows: AgentRunState[][] = [];
  for (let i = 0; i < runs.length; i += panelsPerRow) {
    rows.push(runs.slice(i, i + panelsPerRow));
  }

  return (
    <Box flexDirection="column">
      {rows.map((row, rowIdx) => {
        const isLastRow = rowIdx === rows.length - 1;
        // When the last row has a single orphan panel, let it span the full
        // width instead of leaving a dead column next to it. Earlier rows
        // keep the uniform per-panel width so side-by-side comparison stays
        // aligned where it matters.
        const orphanFullWidth = sideBySide && isLastRow && row.length === 1;
        const rowSideBySide = sideBySide && !orphanFullWidth;
        // Orphan uses (cols - 1), not cols: a box whose right border lands on
        // the terminal's last column triggers auto-wrap on many terminals,
        // which eats the next line (the box's bottom ╰─...─╯). The side-by-side
        // rows already leave the last column free as a gutter, so matching
        // that margin keeps the bottom border intact.
        const widthForRow = orphanFullWidth ? Math.max(1, cols - 1) : perPanelWidth;
        return (
          <Box key={`${keyPrefix}-row-${rowIdx}`} flexDirection={rowSideBySide ? "row" : "column"}>
            {row.map((r) => (
              <Box
                key={`${keyPrefix}-${r.agentName}`}
                width={widthForRow}
                flexDirection="column"
                marginRight={rowSideBySide ? 1 : 0}
              >
                <AgentPanel run={r} tick={tick} width={widthForRow} />
              </Box>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}
