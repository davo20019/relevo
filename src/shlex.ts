// Minimal POSIX-ish shlex.split for the argv templates relevo uses.
// Supports double-quoted, single-quoted, backslash escapes, and bare tokens.
// Throws on unterminated quotes (mirrors Python shlex behavior).
export function shlexSplit(s: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i]!;
    if (c === " " || c === "\t" || c === "\n") {
      i++;
      continue;
    }
    let token = "";
    let inSingle = false;
    let inDouble = false;
    while (i < n) {
      const ch = s[i]!;
      if (!inSingle && !inDouble && (ch === " " || ch === "\t" || ch === "\n")) break;
      if (inSingle) {
        if (ch === "'") {
          inSingle = false;
          i++;
          continue;
        }
        token += ch;
        i++;
        continue;
      }
      if (inDouble) {
        if (ch === "\\" && i + 1 < n) {
          const nx = s[i + 1]!;
          // In POSIX double quotes, only $, `, ", \, and newline are escaped.
          if (nx === "$" || nx === "`" || nx === '"' || nx === "\\" || nx === "\n") {
            token += nx;
            i += 2;
            continue;
          }
          token += ch;
          i++;
          continue;
        }
        if (ch === '"') {
          inDouble = false;
          i++;
          continue;
        }
        token += ch;
        i++;
        continue;
      }
      if (ch === "'") {
        inSingle = true;
        i++;
        continue;
      }
      if (ch === '"') {
        inDouble = true;
        i++;
        continue;
      }
      if (ch === "\\" && i + 1 < n) {
        token += s[i + 1];
        i += 2;
        continue;
      }
      token += ch;
      i++;
    }
    if (inSingle || inDouble) {
      throw new Error("No closing quotation");
    }
    tokens.push(token);
  }
  return tokens;
}
