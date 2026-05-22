import { Box, Text, useStdout } from "ink";
import { useEffect, useState } from "react";

// Full-width horizontal rule, optionally with a label embedded near the left:
//   ─── 10:53:14 ─────────────────────────────────────
// Single `─` between turns in the same task, double `═` across task
// boundaries so they pop louder than turn boundaries.
export function Separator({
  kind = "single",
  label,
}: {
  kind?: "single" | "double";
  label?: string;
}) {
  const cols = useTerminalColumns();
  const char = kind === "double" ? "═" : "─";
  const total = Math.max(0, cols);

  if (!label) {
    return (
      <Box marginTop={1} marginBottom={1}>
        <Text dimColor>{char.repeat(total)}</Text>
      </Box>
    );
  }

  const leftPad = 3;
  const labelPart = ` ${label} `;
  const right = Math.max(0, total - leftPad - labelPart.length);
  return (
    <Box marginTop={1} marginBottom={1}>
      <Text dimColor>
        {char.repeat(leftPad)}
        {labelPart}
        {char.repeat(right)}
      </Text>
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
