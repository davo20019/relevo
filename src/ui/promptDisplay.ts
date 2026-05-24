import { ALL_TOKEN, expandAll, parseLine, parseMulti, prepareDispatchLine } from "../routing.js";

const readOnlyPending = {
  get pendingPrompt() {
    return null;
  },
  set pendingPrompt(_: string | null) {},
};

/** @-prefixed prompt for the "you" panel — keeps [Pasted #n, …] / [Image #n, …] tokens. */
export function buildCompactDisplayPrompt(
  compactLine: string,
  knownAgents: string[],
  defaultAgent: string | null,
): string {
  const trimmed = compactLine.trim();
  if (!trimmed) return "";

  const line = ALL_TOKEN.test(compactLine.trimStart())
    ? expandAll(compactLine, knownAgents)
    : expandAll(compactLine, knownAgents);

  const multi = parseMulti(line, knownAgents);
  if (multi) {
    const tag = multi.agents.map((a) => `@${a}`).join(" ");
    return multi.body ? `${tag} ${multi.body}` : tag;
  }

  const routed = prepareDispatchLine(line, knownAgents, readOnlyPending, defaultAgent);
  if (!routed) return trimmed;
  const parsed = parseLine(routed);
  if (parsed.kind === "agent") {
    const body = parsed.content.trim();
    return body ? `@${parsed.agent} ${body}` : `@${parsed.agent}`;
  }
  return trimmed;
}

/** Prefer compact buffer text; fall back to merged routing when pending folded in. */
export function displayPromptFromDispatch(
  compactLine: string,
  routedExpanded: string,
  knownAgents: string[],
  defaultAgent: string | null,
): string {
  const compact = buildCompactDisplayPrompt(compactLine, knownAgents, defaultAgent);
  const parsed = parseLine(routedExpanded);
  if (parsed.kind !== "agent") return compact;
  const mergedBody = parsed.content.trim();
  if (!mergedBody) return compact;
  const compactBody = compact.replace(/^@\S+\s*/, "").trim();
  if (compactBody) return compact;
  return `@${parsed.agent} ${mergedBody}`;
}
