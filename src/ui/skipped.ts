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

  const row: SkippedLine = [
    { kind: "text", text: `@all → ${skipped.length} skipped (` },
  ];
  let firstGroup = true;
  for (const [reason, names] of groups) {
    if (!firstGroup) row.push({ kind: "text", text: ", " });
    firstGroup = false;
    row.push({ kind: "text", text: reason });
    names.forEach((name, idx) => {
      row.push({ kind: "text", text: idx === 0 ? " " : ", " });
      row.push({ kind: "agent", agent: name });
    });
  }
  row.push({ kind: "text", text: ")" });
  if (anyDisabled) {
    row.push({ kind: "hint", text: " · /agents enable <name>" });
  }
  return [row];
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
