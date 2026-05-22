import { Box, Text } from "ink";
import { activitySuffix, displayText, elapsedSeconds, type AgentRunState } from "../run.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function AgentPanel({ run, tick }: { run: AgentRunState; tick: number }) {
  const elapsed = elapsedSeconds(run);
  const frame = SPINNER_FRAMES[Math.floor(elapsed * 10) % SPINNER_FRAMES.length]!;
  const title = run.running
    ? `@${run.agentName} · ${frame} running  ${elapsed.toFixed(0)}s${activitySuffix(run)}   (esc to cancel)`
    : `@${run.agentName} · ${run.finalStatus}  ${elapsed.toFixed(0)}s${activitySuffix(run)}`;
  const text = displayText(run);
  const body = text.trim()
    ? text
    : run.running
      ? "waiting..."
      : "(no output)";

  return (
    <Box
      borderStyle="round"
      borderColor={run.color}
      flexDirection="column"
      paddingX={1}
      // tick reference keeps the spinner re-rendering even when content doesn't change
      key={`${run.agentName}-${tick}`}
    >
      <Text bold color={run.color}>
        {title}
      </Text>
      <Text dimColor={!text.trim()}>{body}</Text>
    </Box>
  );
}
