import { Box, Text } from "ink";
import {
  activitySuffix,
  displayText,
  elapsedSeconds,
  hiddenLines,
  idleSeconds,
  lastActivityPreview,
  type AgentRunState,
} from "../run.js";
import { renderMarkdown } from "./markdown.js";

// Quarter-segment rotation. Crisp at small sizes and distinct from the
// ubiquitous braille spinner.
const SPINNER_FRAMES = ["◜", "◝", "◞", "◟"];

// 4-frame dot cycle for active labels. Padded so the line width doesn't jitter
// as the dots grow.
const DOT_FRAMES = ["   ", ".  ", ".. ", "..."];
const WAITING_PHRASES = ["thinking", "working", "checking", "reading"];

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

const STATUS_COLOR: Record<Status, string> = {
  running: "cyan", // overridden by agent color below
  done: "green",
  error: "red",
  cancelled: "yellow",
  interrupted: "yellow",
};

export function AgentPanel({
  run,
  width,
}: {
  run: AgentRunState;
  tick?: number;
  width?: number;
}) {
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

  const borderColor = run.color;
  const glyphColor = isRunning ? run.color : STATUS_COLOR[status];

  const statusLabel = STATUS_LABEL[status];
  const elapsedStr = `${elapsed.toFixed(0)}s`;
  // Header text laid into the top border line. Spaces around the title give
  // it breathing room from the corner chars.
  // Visible width: " " + glyph + " @" + name + "  " + status + "  " + elapsed + suffix + " "
  const titleVisible =
    1 + 1 + 2 + run.agentName.length + 2 + statusLabel.length + 2 + elapsedStr.length + suffix.length + 1;
  // Top: ╭─{title}{filler}─╮ → overhead = 2 (╭─) + 2 (─╮) = 4
  const overhead = 4;
  const fillerCount = Math.max(0, (width ?? overhead + titleVisible) - overhead - titleVisible);

  return (
    <Box flexDirection="column" width={width}>
      <Box flexDirection="row">
        <Text color={borderColor}>╭─</Text>
        <Text> </Text>
        <Text color={glyphColor} bold>
          {glyph}
        </Text>
        <Text color={run.color} bold>
          {" @"}
          {run.agentName}
        </Text>
        <Text dimColor>
          {"  "}
          {statusLabel}
          {"  "}
          {elapsedStr}
          {suffix}
          {" "}
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
        {hidden > 0 && (
          <Text dimColor italic>
            ⋮ {hidden} earlier line{hidden === 1 ? "" : "s"} hidden
          </Text>
        )}
        <Box flexDirection="column">
          {hasContent ? (
            renderMarkdown(text, width !== undefined ? Math.max(1, width - 4) : undefined)
          ) : isRunning ? (
            <WaitingLine run={run} elapsed={elapsed} width={width} />
          ) : (
            <Text dimColor>(no output)</Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}

// Idle threshold (s) before we flag the run as quiet. Two minutes is long
// enough to avoid flapping for normal tool latency but short enough that a
// genuinely wedged process gets surfaced before the user has to wonder.
const IDLE_QUIET_SECONDS = 120;

export function formatWaitingStatus(elapsed: number): string {
  const phrase = WAITING_PHRASES[Math.floor(elapsed / 6) % WAITING_PHRASES.length]!;
  const dots = DOT_FRAMES[Math.floor(elapsed * 3) % DOT_FRAMES.length]!;
  return `${phrase}${dots}`;
}

function WaitingLine({
  run,
  elapsed,
  width,
}: {
  run: AgentRunState;
  elapsed: number;
  width: number | undefined;
}) {
  const preview = lastActivityPreview(run);
  const idle = idleSeconds(run);
  const waitingStatus = formatWaitingStatus(elapsed);
  const maxPreviewWidth = width !== undefined ? Math.max(10, width - 4) : 200;

  if (!preview) {
    return (
      <Text dimColor>
        {waitingStatus}
        {idle >= IDLE_QUIET_SECONDS && (
          <Text color="yellow"> · idle {idle.toFixed(0)}s</Text>
        )}
      </Text>
    );
  }

  const shown = preview.length <= maxPreviewWidth
    ? preview
    : preview.slice(0, maxPreviewWidth - 1) + "…";

  return (
    <>
      <Text dimColor>{shown}</Text>
      <Text dimColor>
        ...{waitingStatus.trimEnd()}
        {idle >= IDLE_QUIET_SECONDS && (
          <Text color="yellow"> · idle {idle.toFixed(0)}s</Text>
        )}
      </Text>
    </>
  );
}
