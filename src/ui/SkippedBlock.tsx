import { Fragment } from "react";
import { Text } from "ink";
import type { SkippedLine } from "./skipped.js";

// Renders a structured skipped block. Surrounding text in the warn color
// (yellow), each @agent mention in its per-agent color, trailing hint dim.
export function SkippedBlock({
  lines,
  agentColor,
}: {
  lines: SkippedLine[];
  agentColor: Record<string, string>;
}) {
  return (
    <Text color="yellow">
      {lines.map((line, lineIdx) => {
        const isLast = lineIdx === lines.length - 1;
        return (
          <Fragment key={lineIdx}>
            {line.map((seg, segIdx) => {
              if (seg.kind === "agent") {
                return (
                  <Text key={segIdx} color={agentColor[seg.agent] ?? "yellow"} bold>
                    @{seg.agent}
                  </Text>
                );
              }
              if (seg.kind === "hint") {
                return (
                  <Text key={segIdx} dimColor>
                    {seg.text}
                  </Text>
                );
              }
              return <Fragment key={segIdx}>{seg.text}</Fragment>;
            })}
            {!isLast && "\n"}
          </Fragment>
        );
      })}
    </Text>
  );
}
