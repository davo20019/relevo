import { Box, Text } from "ink";

// Full-width horizontal rule, optionally with a label embedded near the left:
//   ─── 10:53:14 ─────────────────────────────────────
// Single `─` between turns in the same task, double `═` across task
// boundaries so they pop louder than turn boundaries.
export function Separator({
  kind = "single",
  label,
  cols,
}: {
  kind?: "single" | "double";
  label?: string;
  cols: number;
}) {
  const char = kind === "double" ? "═" : "─";
  const total = Math.max(0, cols);

  if (!label) {
    return (
      <Box marginTop={1} marginBottom={1}>
        <Text dimColor>{char.repeat(total)}</Text>
      </Box>
    );
  }

  const labelPart = ` ${label} `;
  const leftPad = Math.max(3, Math.floor((total - labelPart.length) / 2));
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
