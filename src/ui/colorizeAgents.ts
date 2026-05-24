// Splits a system log line into segments so any @agent or `/open agent`
// mentions can be painted in their per-agent color. The leading text stays
// in whatever color the surrounding log line uses; only the agent name
// segment gets recolored (+ bold). Unknown agent names pass through plain
// so a future agent rename doesn't leave colored stragglers.

export type Segment = { text: string; color?: string; bold?: boolean };

// `@name` consumes the @ too; `/open name` only colors the name. Picked
// greedily left-to-right.
const MENTION_RE = /(\B@[A-Za-z0-9_-]+)|(\/open\s+)([A-Za-z0-9_-]+)/g;

export function colorizeAgentMentions(
  text: string,
  agentColor: Record<string, string>,
  liveAgents?: ReadonlySet<string> | null,
): Segment[] {
  const out: Segment[] = [];
  let lastIdx = 0;
  const isLive = (name: string) => !liveAgents || liveAgents.has(name);
  for (const m of text.matchAll(MENTION_RE)) {
    const matchStart = m.index ?? 0;
    const matchEnd = matchStart + m[0].length;
    if (m[1]) {
      const name = m[1].slice(1);
      const color = agentColor[name];
      if (color && isLive(name)) {
        if (matchStart > lastIdx) out.push({ text: text.slice(lastIdx, matchStart) });
        out.push({ text: m[1], color, bold: true });
        lastIdx = matchEnd;
      }
    } else if (m[2] && m[3]) {
      const cmd = m[2];
      const name = m[3];
      const color = agentColor[name];
      if (color && isLive(name)) {
        if (matchStart > lastIdx) out.push({ text: text.slice(lastIdx, matchStart) });
        out.push({ text: cmd });
        out.push({ text: name, color, bold: true });
        lastIdx = matchEnd;
      }
    }
  }
  if (lastIdx < text.length) out.push({ text: text.slice(lastIdx) });
  if (out.length === 0) out.push({ text });
  return mergePlain(out);
}

// Adjacent plain segments collapse into one. Keeps test assertions tight and
// avoids redundant nodes when nothing matched.
function mergePlain(segs: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segs) {
    const prev = out[out.length - 1];
    if (prev && prev.color === undefined && s.color === undefined && !prev.bold && !s.bold) {
      prev.text += s.text;
    } else {
      out.push({ ...s });
    }
  }
  return out;
}
