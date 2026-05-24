import { Box, Text } from "ink";

export type AgentStatus = {
  agent: string;
  running: boolean;
  elapsedSeconds?: number;
};

export type AgentStatusCellParts = {
  label: string;
  elapsed: string | null;
  running: boolean;
};

const SEP = " · ";

export function agentStatusCellParts(status: AgentStatus): AgentStatusCellParts {
  const elapsed =
    status.running && status.elapsedSeconds !== undefined
      ? `${Math.floor(status.elapsedSeconds)}s`
      : null;
  return {
    label: `@${status.agent}`,
    elapsed,
    running: status.running,
  };
}

export function formatAgentStatusCell(status: AgentStatus): string {
  const { label, elapsed } = agentStatusCellParts(status);
  return `${label}${elapsed ? ` ${elapsed}` : ""}`;
}

export function agentStatusRowText(statuses: AgentStatus[]): string {
  return statuses.map(formatAgentStatusCell).join(SEP);
}

/** Reserve space for left toolbar (task/cwd) and right meta (verbose). */
export function agentStatusRowFits(
  statuses: AgentStatus[],
  cols: number,
  reserved: number,
): boolean {
  if (statuses.length === 0) return false;
  return cols >= agentStatusRowText(statuses).length + reserved;
}

export function AgentStatusChips({
  statuses,
  tick = 0,
  colorMap = {},
  defaultAgent = null,
}: {
  statuses: AgentStatus[];
  tick?: number;
  colorMap?: Record<string, string>;
  defaultAgent?: string | null;
}) {
  if (statuses.length === 0) return null;
  return (
    <Box flexDirection="row">
      {statuses.map((s, i) => {
        const parts = agentStatusCellParts(s);
        const isDefault = defaultAgent === s.agent;
        return (
          <Box key={s.agent} flexDirection="row">
            {i > 0 ? <Text dimColor>{SEP}</Text> : null}
            <AnimatedLabel
              label={parts.label}
              running={parts.running}
              tick={tick}
              color={colorMap[s.agent]}
              isDefault={isDefault}
            />
            {parts.elapsed ? (
              <Text dimColor={!isDefault} bold={isDefault}>
                {" " + parts.elapsed}
              </Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

function AnimatedLabel({
  label,
  running,
  tick,
  color,
  isDefault = false,
}: {
  label: string;
  running: boolean;
  tick: number;
  color?: string;
  isDefault?: boolean;
}) {
  if (!running)
    return (
      <Text dimColor={!isDefault} bold={isDefault}>
        {label}
      </Text>
    );
  // Wave: one character at a time brightens with the agent's color, sweeping
  // left-to-right. A short tail of empty positions pauses the wave between
  // sweeps so it reads as a pass rather than a strobing loop.
  const cycle = label.length + 3;
  // Step every 2 ticks (~200ms) so the wave feels deliberate, not strobing.
  const pos = Math.floor(tick / 2) % cycle;
  return (
    <Box flexDirection="row">
      {[...label].map((ch, idx) => {
        const active = idx === pos;
        return (
          <Text
            key={idx}
            dimColor={!active && !isDefault}
            bold={isDefault}
            color={active ? color : undefined}
          >
            {ch}
          </Text>
        );
      })}
    </Box>
  );
}
