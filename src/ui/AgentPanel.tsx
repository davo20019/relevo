import { Box, Text } from "ink";
import {
  activitySuffix,
  displayText,
  elapsedSeconds,
  hiddenLines,
  type AgentRunState,
} from "../run.js";

// Quarter-segment rotation. Crisp at small sizes and distinct from the
// ubiquitous braille spinner.
const SPINNER_FRAMES = ["◜", "◝", "◞", "◟"];

type Status = "running" | "done" | "error" | "cancelled" | "interrupted";

function statusOf(run: AgentRunState): Status {
  if (run.running) return "running";
  if (run.cancelled) return "cancelled";
  if (run.interrupted) return "interrupted";
  if (run.finalStatus === "done") return "done";
  return "error";
}

const STATUS_GLYPH: Record<Status, string> = {
  running: "●",
  done: "✓",
  error: "✗",
  cancelled: "⊘",
  interrupted: "⊘",
};

const STATUS_LABEL: Record<Status, string> = {
  running: "running",
  done: "done",
  error: "error",
  cancelled: "cancelled",
  interrupted: "interrupted",
};

const BORDER_STYLE: Record<Status, "round" | "single" | "double" | "bold"> = {
  running: "round",
  done: "single",
  error: "double",
  cancelled: "single",
  interrupted: "single",
};

const STATUS_COLOR: Record<Status, string> = {
  running: "cyan", // overridden by agent color below
  done: "green",
  error: "red",
  cancelled: "yellow",
  interrupted: "yellow",
};

export function AgentPanel({ run }: { run: AgentRunState; tick?: number }) {
  const elapsed = elapsedSeconds(run);
  const status = statusOf(run);
  const isRunning = status === "running";
  const glyph = isRunning
    ? SPINNER_FRAMES[Math.floor(elapsed * 4) % SPINNER_FRAMES.length]!
    : STATUS_GLYPH[status];
  const suffix = activitySuffix(run);
  const text = displayText(run);
  const hidden = hiddenLines(run);
  const hasContent = text.trim().length > 0;

  const borderColor = isRunning ? run.color : status === "error" ? "red" : "gray";
  const glyphColor = isRunning ? run.color : STATUS_COLOR[status];

  return (
    <Box
      borderStyle={BORDER_STYLE[status]}
      borderColor={borderColor}
      flexDirection="column"
      paddingX={1}
    >
      <Box>
        <Text color={glyphColor} bold>
          {glyph}{" "}
        </Text>
        <Text color={run.color} bold>
          @{run.agentName}
        </Text>
        <Text dimColor>
          {"  "}
          {STATUS_LABEL[status]}
          {"  "}
          {elapsed.toFixed(0)}s{suffix}
        </Text>
      </Box>
      {hidden > 0 && (
        <Text dimColor italic>
          ⋮ {hidden} earlier line{hidden === 1 ? "" : "s"} hidden
        </Text>
      )}
      <Box marginTop={hasContent || hidden > 0 ? 0 : 0}>
        <Text dimColor={!hasContent}>
          {hasContent ? text : isRunning ? "waiting…" : "(no output)"}
        </Text>
      </Box>
    </Box>
  );
}
