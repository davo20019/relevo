import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { PanelRow } from "../src/ui/PanelRow.js";
import { newRun } from "../src/run.js";

function run(agentName: string) {
  return newRun(agentName, "cyan", "do work");
}

function asElement(value: unknown): ReactElement<Record<string, unknown>> {
  return value as ReactElement<Record<string, unknown>>;
}

function childrenOf(element: ReactElement<Record<string, unknown>>) {
  const children = element.props.children;
  return Array.isArray(children)
    ? children.map(asElement)
    : [asElement(children)];
}

describe("PanelRow", () => {
  it("renders nothing for an empty run list", () => {
    expect(PanelRow({ runs: [], tick: 0, keyPrefix: "empty", cols: 120 })).toBeNull();
  });

  it("renders one run as a full-width single column with terminal-wrap margin", () => {
    const element = asElement(
      PanelRow({ runs: [run("claude")], tick: 0, keyPrefix: "one", cols: 100 }),
    );
    const rows = childrenOf(element);
    const panels = childrenOf(rows[0]!);

    expect(element.props.flexDirection).toBe("column");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.props.flexDirection).toBe("column");
    expect(panels).toHaveLength(1);
    expect(panels[0]!.props.width).toBe(99);
    expect(panels[0]!.props.marginRight).toBe(0);
    expect(asElement(panels[0]!.props.children).props.width).toBe(99);
  });

  it("renders two runs side-by-side when the terminal is wide enough", () => {
    const element = asElement(
      PanelRow({
        runs: [run("claude"), run("codex")],
        tick: 0,
        keyPrefix: "two-wide",
        cols: 140,
      }),
    );
    const rows = childrenOf(element);
    const panels = childrenOf(rows[0]!);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.props.flexDirection).toBe("row");
    expect(panels).toHaveLength(2);
    expect(panels.map((p) => p.props.width)).toEqual([69, 69]);
    expect(panels.map((p) => p.props.marginRight)).toEqual([1, 1]);
    expect(panels.map((p) => asElement(p.props.children).props.width)).toEqual([69, 69]);
  });

  it("stacks two runs when the terminal is narrow", () => {
    const element = asElement(
      PanelRow({
        runs: [run("claude"), run("codex")],
        tick: 0,
        keyPrefix: "two-narrow",
        cols: 119,
      }),
    );
    const rows = childrenOf(element);

    // panelsPerRow falls to 1, so each run lives in its own row and the
    // outer column flex stacks them vertically.
    expect(element.props.flexDirection).toBe("column");
    expect(rows).toHaveLength(2);
    const allPanels = rows.flatMap((r) => childrenOf(r));
    expect(allPanels).toHaveLength(2);
    expect(allPanels.map((p) => p.props.width)).toEqual([118, 118]);
    expect(allPanels.map((p) => p.props.marginRight)).toEqual([0, 0]);
  });

  it("renders three runs side-by-side when the terminal can fit them all", () => {
    const element = asElement(
      PanelRow({
        runs: [run("claude"), run("codex"), run("cursor")],
        tick: 0,
        keyPrefix: "three-wide",
        cols: 240,
      }),
    );
    const rows = childrenOf(element);
    const panels = childrenOf(rows[0]!);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.props.flexDirection).toBe("row");
    expect(panels).toHaveLength(3);
    expect(panels.map((p) => p.props.width)).toEqual([79, 79, 79]);
    expect(panels.map((p) => p.props.marginRight)).toEqual([1, 1, 1]);
  });

  it("wraps three runs into two rows when only two fit per row, orphan goes full width", () => {
    const element = asElement(
      PanelRow({
        runs: [run("claude"), run("codex"), run("cursor")],
        tick: 0,
        keyPrefix: "three-narrow",
        cols: 140,
      }),
    );
    const rows = childrenOf(element);

    expect(rows).toHaveLength(2);
    expect(rows[0]!.props.flexDirection).toBe("row");
    const firstRowPanels = childrenOf(rows[0]!);
    expect(firstRowPanels).toHaveLength(2);
    expect(firstRowPanels.map((p) => p.props.width)).toEqual([69, 69]);

    // Orphan row stretches to full width (minus the wrap-margin column) so
    // the third panel doesn't leave a dead gutter beside it.
    expect(rows[1]!.props.flexDirection).toBe("column");
    const secondRowPanels = childrenOf(rows[1]!);
    expect(secondRowPanels).toHaveLength(1);
    expect(secondRowPanels[0]!.props.width).toBe(139);
    expect(secondRowPanels[0]!.props.marginRight).toBe(0);
  });
});
