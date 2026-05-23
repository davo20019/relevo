// Structured representation of the `@all skipped` block. Each line is a
// sequence of segments so the React renderer can color @agent mentions with
// per-agent colors while keeping the surrounding text in the warn style and
// the trailing hint dim. The text-only renderer (skippedToText) is the
// single source of truth for layout/columns and is what the unit tests
// pin down.

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "agent"; agent: string }
  | { kind: "hint"; text: string };

export type SkippedLine = Segment[];

export function buildSkippedBlock(
  skipped: string[],
  reasons: Record<string, string | undefined>,
): SkippedLine[] {
  if (skipped.length === 0) return [];

  const groups = new Map<string, string[]>();
  for (const name of skipped) {
    const reason = reasons[name] ?? "unavailable";
    const arr = groups.get(reason) ?? [];
    arr.push(name);
    groups.set(reason, arr);
  }

  const anyDisabled = groups.has("disabled");
  const hintText = anyDisabled
    ? groups.size === 1
      ? "  enable with /agents enable <name>"
      : "  enable disabled agents with /agents enable <name>"
    : null;
  const hintLine: SkippedLine | null = hintText
    ? [{ kind: "hint", text: hintText }]
    : null;

  const lines: SkippedLine[] = [];

  if (groups.size === 1) {
    const [reason] = [...groups.keys()];
    const head: SkippedLine = [{ kind: "text", text: `@all → skipped (${reason}):` }];
    for (const name of skipped) {
      head.push({ kind: "text", text: " " });
      head.push({ kind: "agent", agent: name });
    }
    lines.push(head);
    if (hintLine) lines.push(hintLine);
    return lines;
  }

  lines.push([{ kind: "text", text: `@all → skipping ${skipped.length} agents` }]);
  const reasonWidth = Math.max(...[...groups.keys()].map((r) => r.length));
  for (const [reason, names] of groups) {
    const padded = reason.padEnd(reasonWidth);
    const row: SkippedLine = [{ kind: "text", text: `  ${padded}  ` }];
    names.forEach((name, idx) => {
      if (idx > 0) row.push({ kind: "text", text: " " });
      row.push({ kind: "agent", agent: name });
    });
    lines.push(row);
  }
  if (hintLine) lines.push(hintLine);
  return lines;
}

export function skippedToText(lines: SkippedLine[]): string {
  return lines
    .map((line) =>
      line
        .map((seg) => {
          if (seg.kind === "agent") return `@${seg.agent}`;
          return seg.text;
        })
        .join(""),
    )
    .join("\n");
}
