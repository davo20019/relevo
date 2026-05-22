import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import { applySuggestion, filterSuggestions, tokenUnderCursor } from "./autocomplete.js";

type Props = {
  value: string;
  onChange: (next: string) => void;
  onSubmit: (value: string) => void;
  disabled: boolean;
  slashCommands: readonly string[];
  agents: readonly string[];
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
}: Props) {
  const [cursor, setCursor] = useState(value.length);
  const [selected, setSelected] = useState(0);
  const [acDismissed, setAcDismissed] = useState(false);

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
    onChange(next);
    setCursor(nextCursor);
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
      if (disabled) return;

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
        onSubmit(value);
        setCursor(0);
        setSelected(0);
        setAcDismissed(false);
        return;
      }

      if (key.ctrl && rawInput === "j") {
        setText(value.slice(0, safeCursor) + "\n" + value.slice(safeCursor), safeCursor + 1);
        return;
      }

      if (key.leftArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor((c) => Math.min(value.length, c + 1));
        return;
      }
      if (key.upArrow) {
        setCursor((c) => moveLine(value, c, -1));
        return;
      }
      if (key.downArrow) {
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
        const next = value.slice(0, safeCursor) + rawInput + value.slice(safeCursor);
        setText(next, safeCursor + rawInput.length);
        return;
      }
    },
    { isActive: !disabled },
  );

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color="cyan" bold>
          ❯{" "}
        </Text>
        <Box flexDirection="column">{renderBuffer(value, safeCursor, disabled)}</Box>
      </Box>
      {acOpen && (
        <Box
          marginLeft={2}
          flexDirection="column"
          borderStyle="single"
          borderColor="gray"
          paddingX={1}
        >
          {suggestions.map((s, i) => (
            <Text
              key={s}
              color={i === safeSelected ? "black" : undefined}
              backgroundColor={i === safeSelected ? "cyan" : undefined}
            >
              {s}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

function renderBuffer(value: string, cursor: number, disabled: boolean) {
  if (disabled) {
    return <Text dimColor>{value || "(running...)"}</Text>;
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
