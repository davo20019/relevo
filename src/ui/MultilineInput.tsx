import { Box, Text, useInput } from "ink";
import path from "node:path";
import { useEffect, useMemo, useRef, useState } from "react";
import { IMAGE_TOKEN } from "../images.js";
import {
  applySuggestion,
  filterSuggestions,
  SLASH_COMMAND_DESCRIPTIONS,
  tokenUnderCursor,
} from "./autocomplete.js";

// 4-frame dot cycle matching AgentPanel's "waiting" animation cadence.
const RUNNING_DOT_FRAMES = ["   ", ".  ", ".. ", "..."];
const PASTE_COMPACT_THRESHOLD = 200;

type Props = {
  value: string;
  onChange: (next: string) => void;
  onSubmit: (value: string) => void;
  disabled: boolean;
  slashCommands: readonly string[];
  agents: readonly string[];
  history: readonly string[];
};

// A multi-line input with a visible cursor, emacs-style shortcuts, and an
// inline autocomplete dropdown for /commands and @mentions.
//
// Submit rules:
//   Enter       — submit the buffer
//   Ctrl+J      — insert newline (works in every terminal)
//   Esc+Enter   — insert newline (when the terminal sends \x1b\r)
//   trailing \  — continues to the next line: backslash is replaced with \n
//
// When the autocomplete dropdown is open:
//   Up / Down   — change selection
//   Tab / Enter — accept the selection
//   Esc         — dismiss
export function MultilineInput({
  value,
  onChange,
  onSubmit,
  disabled,
  slashCommands,
  agents,
  history,
}: Props) {
  const [cursor, setCursor] = useState(value.length);
  const [selected, setSelected] = useState(0);
  const [acDismissed, setAcDismissed] = useState(false);
  const [runningFrame, setRunningFrame] = useState(0);
  // Position in `history` while walking with Up/Down. null = live draft.
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  // The live buffer the user was typing before entering history mode, restored
  // when they walk past the most recent entry with Down.
  const [draft, setDraft] = useState("");
  const pastedTextByPlaceholder = useRef(new Map<string, string>());
  const pastedTextCounter = useRef(0);

  useEffect(() => {
    if (!disabled) return;
    const id = setInterval(
      () => setRunningFrame((f) => (f + 1) % RUNNING_DOT_FRAMES.length),
      300,
    );
    return () => clearInterval(id);
  }, [disabled]);

  const token = useMemo(() => tokenUnderCursor(value, cursor), [value, cursor]);
  const suggestions = useMemo(
    () => (token && !acDismissed ? filterSuggestions(token, slashCommands, agents) : []),
    [token, acDismissed, slashCommands, agents],
  );
  const acOpen = suggestions.length > 0;

  const safeCursor = Math.min(Math.max(cursor, 0), value.length);
  const safeSelected = Math.min(Math.max(selected, 0), Math.max(suggestions.length - 1, 0));

  const setText = (next: string, nextCursor: number) => {
    setAcDismissed(false);
    setSelected(0);
    setHistoryIndex(null);
    setDraft("");
    // Drop map entries whose placeholder no longer appears intact in the
    // buffer (e.g. after Ctrl+W chopped through one). Otherwise stale entries
    // would linger and the user might see a half-eaten `[Pasted ...` fragment
    // that no expansion can fix.
    for (const key of Array.from(pastedTextByPlaceholder.current.keys())) {
      if (!next.includes(key)) pastedTextByPlaceholder.current.delete(key);
    }
    onChange(next);
    setCursor(nextCursor);
  };

  const recallHistoryEntry = (index: number, savedDraft: string | null) => {
    if (index < 0 || index >= history.length) return;
    const entry = history[index]!;
    if (savedDraft !== null) setDraft(savedDraft);
    setHistoryIndex(index);
    setAcDismissed(true);
    setSelected(0);
    onChange(entry);
    setCursor(entry.length);
  };

  const exitHistoryToDraft = () => {
    setHistoryIndex(null);
    setAcDismissed(false);
    setSelected(0);
    onChange(draft);
    setCursor(draft.length);
    setDraft("");
  };

  const insertText = (inserted: string) => {
    // Snap to the placeholder's right edge so typing inside a paste token
    // pushes characters to its end rather than splitting `[Pasted ...]` into
    // a fragment that expansion can never restore.
    const inside = findPlaceholderAtCursor(
      value,
      safeCursor,
      pastedTextByPlaceholder.current.keys(),
    );
    const pos = inside ? inside.end : safeCursor;
    const next = value.slice(0, pos) + inserted + value.slice(pos);
    setText(next, pos + inserted.length);
  };

  const acceptSuggestion = () => {
    if (!token || !suggestions[safeSelected]) return;
    const { value: next, cursor: nextCursor } = applySuggestion(
      value,
      token,
      suggestions[safeSelected]!,
    );
    setText(next, nextCursor);
  };

  useInput(
    (rawInput, key) => {
      if (rawInput && !key.ctrl && !key.meta) {
        // Drag-and-dropped image paths usually arrive as one rawInput chunk
        // that's well under PASTE_COMPACT_THRESHOLD, so the generic paste
        // compactor leaves them in the buffer verbatim. The long path then
        // soft-wraps as the user types and the live area drifts downward on
        // each redraw. Detect the path on insert and swap it for a short
        // placeholder; expansion at submit feeds the original back to
        // extractImagePaths as if nothing changed.
        const asImage = compactDroppedImageInput(rawInput, pastedTextCounter.current + 1);
        if (asImage) {
          pastedTextCounter.current += 1;
          pastedTextByPlaceholder.current.set(asImage.placeholder, asImage.original);
          insertText(asImage.placeholder);
          return;
        }
        const compacted = compactPastedInput(rawInput, pastedTextCounter.current + 1);
        if (compacted) {
          pastedTextCounter.current += 1;
          pastedTextByPlaceholder.current.set(compacted.placeholder, compacted.original);
          insertText(compacted.placeholder);
          return;
        }
      }

      if (acOpen) {
        if (key.upArrow) {
          setSelected((s) => (s - 1 + suggestions.length) % suggestions.length);
          return;
        }
        if (key.downArrow) {
          setSelected((s) => (s + 1) % suggestions.length);
          return;
        }
        if (key.tab) {
          acceptSuggestion();
          return;
        }
        if (key.return && !key.meta) {
          acceptSuggestion();
          return;
        }
        if (key.escape) {
          setAcDismissed(true);
          return;
        }
      } else if (key.escape) {
        pastedTextByPlaceholder.current.clear();
        setText("", 0);
        return;
      }

      if (key.return) {
        if (key.meta) {
          setText(value.slice(0, safeCursor) + "\n" + value.slice(safeCursor), safeCursor + 1);
          return;
        }
        if (safeCursor > 0 && value[safeCursor - 1] === "\\") {
          const next = value.slice(0, safeCursor - 1) + "\n" + value.slice(safeCursor);
          setText(next, safeCursor);
          return;
        }
        if (!value.trim()) return;
        onSubmit(expandPastedPlaceholders(value, pastedTextByPlaceholder.current.entries()));
        pastedTextByPlaceholder.current.clear();
        setCursor(0);
        setSelected(0);
        setAcDismissed(false);
        setHistoryIndex(null);
        setDraft("");
        return;
      }

      if (key.ctrl && rawInput === "j") {
        setText(value.slice(0, safeCursor) + "\n" + value.slice(safeCursor), safeCursor + 1);
        return;
      }

      if (key.leftArrow) {
        setCursor((c) => {
          if (c === 0) return 0;
          const inside = findPlaceholderAtCursor(
            value,
            c - 1,
            pastedTextByPlaceholder.current.keys(),
          );
          return inside ? inside.start : c - 1;
        });
        return;
      }
      if (key.rightArrow) {
        setCursor((c) => {
          if (c >= value.length) return value.length;
          const inside = findPlaceholderAtCursor(
            value,
            c + 1,
            pastedTextByPlaceholder.current.keys(),
          );
          return inside ? inside.end : c + 1;
        });
        return;
      }
      if (key.upArrow) {
        // Shell-style history recall: on the first line of the buffer, Up
        // walks backward through previously submitted prompts. Anywhere else
        // it moves the cursor up a visual line as usual.
        if (lineStart(value, safeCursor) === 0 && history.length > 0) {
          if (historyIndex === null) {
            recallHistoryEntry(history.length - 1, value);
          } else if (historyIndex > 0) {
            recallHistoryEntry(historyIndex - 1, null);
          }
          return;
        }
        setCursor((c) => moveLine(value, c, -1));
        return;
      }
      if (key.downArrow) {
        // Symmetric to Up: on the last line, Down walks forward through
        // history, eventually restoring the live draft the user was typing.
        if (historyIndex !== null && lineEnd(value, safeCursor) === value.length) {
          if (historyIndex < history.length - 1) {
            recallHistoryEntry(historyIndex + 1, null);
          } else {
            exitHistoryToDraft();
          }
          return;
        }
        setCursor((c) => moveLine(value, c, +1));
        return;
      }
      if (key.ctrl && rawInput === "a") {
        setCursor((c) => lineStart(value, c));
        return;
      }
      if (key.ctrl && rawInput === "e") {
        setCursor((c) => lineEnd(value, c));
        return;
      }

      if (key.backspace || key.delete) {
        if (safeCursor === 0) return;
        const deletedPlaceholder = deletePastedPlaceholderBackward(
          value,
          safeCursor,
          pastedTextByPlaceholder.current.keys(),
        );
        if (deletedPlaceholder) {
          pastedTextByPlaceholder.current.delete(deletedPlaceholder.placeholder);
          setText(deletedPlaceholder.value, deletedPlaceholder.cursor);
          return;
        }
        const next = value.slice(0, safeCursor - 1) + value.slice(safeCursor);
        setText(next, safeCursor - 1);
        return;
      }
      if (key.ctrl && rawInput === "u") {
        const start = lineStart(value, safeCursor);
        setText(value.slice(0, start) + value.slice(safeCursor), start);
        return;
      }
      if (key.ctrl && rawInput === "k") {
        const end = lineEnd(value, safeCursor);
        setText(value.slice(0, safeCursor) + value.slice(end), safeCursor);
        return;
      }
      if (key.ctrl && rawInput === "w") {
        let i = safeCursor;
        while (i > 0 && /\s/.test(value[i - 1]!)) i--;
        while (i > 0 && !/\s/.test(value[i - 1]!)) i--;
        setText(value.slice(0, i) + value.slice(safeCursor), i);
        return;
      }

      if (rawInput && !key.ctrl && !key.meta) {
        insertText(rawInput);
        return;
      }
    },
  );

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color="cyan" bold>
          ❯{" "}
        </Text>
        <Box flexDirection="column">
          {renderBuffer(value, safeCursor, disabled, runningFrame)}
        </Box>
      </Box>
      {acOpen && (
        <Box
          marginLeft={2}
          flexDirection="column"
          borderStyle="single"
          borderColor="gray"
          paddingX={1}
        >
          {suggestions.map((s, i) => {
            const isSelected = i === safeSelected;
            const desc = SLASH_COMMAND_DESCRIPTIONS[s];
            return (
              <Text
                key={s}
                color={isSelected ? "black" : undefined}
                backgroundColor={isSelected ? "cyan" : undefined}
              >
                {s}
                {desc ? (
                  <Text
                    color={isSelected ? "black" : "gray"}
                    backgroundColor={isSelected ? "cyan" : undefined}
                  >
                    {"  "}
                    {desc}
                  </Text>
                ) : null}
              </Text>
            );
          })}
        </Box>
      )}
    </Box>
  );
}

export function compactPastedInput(
  rawInput: string,
  id: number,
): { placeholder: string; original: string } | null {
  const lineBreaks = rawInput.match(/\r\n|\r|\n/g);
  if (!lineBreaks && rawInput.length <= PASTE_COMPACT_THRESHOLD) return null;

  const summary = lineBreaks
    ? `${lineBreaks.length + 1} lines`
    : `${rawInput.length} chars`;

  return {
    placeholder: `[Pasted #${id}, ${summary}]`,
    original: rawInput,
  };
}

export function compactDroppedImageInput(
  rawInput: string,
  id: number,
): { placeholder: string; original: string } | null {
  const names: string[] = [];
  for (const m of rawInput.matchAll(IMAGE_TOKEN)) {
    const raw = m[1] ?? m[2] ?? m[3];
    if (!raw) continue;
    const unescaped = raw.replace(/\\(.)/g, "$1");
    names.push(path.basename(unescaped));
  }
  if (names.length === 0) return null;

  const summary = names.length === 1 ? names[0]! : `${names.length} images`;
  return {
    placeholder: `[Image #${id}, ${summary}]`,
    original: rawInput,
  };
}

export function expandPastedPlaceholders(
  value: string,
  pastedTextEntries: Iterable<readonly [string, string]>,
): string {
  let expanded = value;
  for (const [placeholder, original] of pastedTextEntries) {
    expanded = expanded.split(placeholder).join(original);
  }
  return expanded;
}

export function findPlaceholderAtCursor(
  value: string,
  cursor: number,
  placeholders: Iterable<string>,
): { start: number; end: number; placeholder: string } | null {
  for (const placeholder of placeholders) {
    let start = value.indexOf(placeholder);
    while (start !== -1) {
      const end = start + placeholder.length;
      if (cursor > start && cursor < end) {
        return { start, end, placeholder };
      }
      start = value.indexOf(placeholder, end);
    }
  }
  return null;
}

export function deletePastedPlaceholderBackward(
  value: string,
  cursor: number,
  placeholders: Iterable<string>,
): { value: string; cursor: number; placeholder: string } | null {
  for (const placeholder of placeholders) {
    let start = value.indexOf(placeholder);
    while (start !== -1) {
      const end = start + placeholder.length;
      if (cursor > start && cursor <= end) {
        return {
          value: value.slice(0, start) + value.slice(end),
          cursor: start,
          placeholder,
        };
      }
      start = value.indexOf(placeholder, end);
    }
  }
  return null;
}

function renderBuffer(value: string, cursor: number, disabled: boolean, runningFrame: number) {
  // While a dispatch is in flight and the buffer is empty, show a dim
  // "(running...)" placeholder so the user knows agents are still working.
  // Once they start typing, the placeholder yields to their text (which the
  // queue hint above the input labels as "queued").
  if (disabled && value.length === 0) {
    const dots = RUNNING_DOT_FRAMES[runningFrame % RUNNING_DOT_FRAMES.length]!;
    return <Text dimColor>{`(running${dots})`}</Text>;
  }
  const lines = value.length === 0 ? [""] : value.split("\n");

  let lineIdx = 0;
  let col = cursor;
  for (let i = 0; i < lines.length; i++) {
    if (col <= lines[i]!.length) {
      lineIdx = i;
      break;
    }
    col -= lines[i]!.length + 1;
  }

  return lines.map((line, idx) => {
    if (idx !== lineIdx) {
      return <Text key={idx}>{line || " "}</Text>;
    }
    const pre = line.slice(0, col);
    const at = line.slice(col, col + 1) || " ";
    const post = line.slice(col + 1);
    return (
      <Text key={idx}>
        {pre}
        <Text inverse>{at}</Text>
        {post}
      </Text>
    );
  });
}

function lineStart(value: string, cursor: number): number {
  return value.lastIndexOf("\n", cursor - 1) + 1;
}

function lineEnd(value: string, cursor: number): number {
  const idx = value.indexOf("\n", cursor);
  return idx === -1 ? value.length : idx;
}

function moveLine(value: string, cursor: number, direction: -1 | 1): number {
  const col = cursor - lineStart(value, cursor);
  if (direction === -1) {
    const prevEnd = lineStart(value, cursor) - 1;
    if (prevEnd < 0) return cursor;
    const prevStart = lineStart(value, prevEnd);
    const prevLen = prevEnd - prevStart;
    return prevStart + Math.min(col, prevLen);
  }
  const nextStart = lineEnd(value, cursor) + 1;
  if (nextStart > value.length) return cursor;
  const nextEnd = lineEnd(value, nextStart);
  const nextLen = nextEnd - nextStart;
  return nextStart + Math.min(col, nextLen);
}
