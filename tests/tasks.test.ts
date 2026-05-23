import {
  existsSync as existsSyncForTest,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearActiveTaskForTest,
  createTaskDir,
  getActiveTask,
  listRecentTasks,
  provisionalTaskName,
  renameTask,
  setActiveTask,
  slugFromPrompt,
  validateTaskName,
} from "../src/tasks.js";

const tempRoots: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relevo-tasks-"));
  tempRoots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
  clearActiveTaskForTest();
});

describe("slugFromPrompt", () => {
  it("hyphenates the first words of a normal prompt", () => {
    expect(slugFromPrompt("Fix the auth bug I saw yesterday")).toBe("fix-the-auth-bug-saw");
  });

  it("strips punctuation and lowercases", () => {
    expect(slugFromPrompt("Refactor: storage/IO layer!")).toBe("refactor-storage-io-layer");
  });

  it("drops single-letter filler tokens but keeps numerics", () => {
    expect(slugFromPrompt("a b c2 d3 hello world")).toBe("c2-d3-hello-world");
  });

  it("returns null for empty input", () => {
    expect(slugFromPrompt("")).toBeNull();
    expect(slugFromPrompt("   ")).toBeNull();
  });

  it("returns null when nothing slug-worthy survives normalization", () => {
    expect(slugFromPrompt("!!! ??? ...")).toBeNull();
  });

  it("clamps slug length to 60 chars", () => {
    const long = "antidisestablishmentarianism ".repeat(40);
    const out = slugFromPrompt(long, { maxWords: 100 })!;
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out).toMatch(/^[a-z0-9-]+$/);
    expect(out.endsWith("-")).toBe(false);
  });

  it("honors a custom maxWords", () => {
    expect(slugFromPrompt("one two three four five six", { maxWords: 3 })).toBe(
      "one-two-three",
    );
  });

  it("strips leading hyphens so the slug always starts with [a-z0-9]", () => {
    expect(slugFromPrompt("-foo bar")).toBe("foo-bar");
    expect(slugFromPrompt("--- foo bar")).toBe("foo-bar");
    expect(slugFromPrompt("-foo-bar baz")).toBe("foo-bar-baz");
  });

  it("returns null when the slug collapses to only hyphens", () => {
    expect(slugFromPrompt("---- ----")).toBeNull();
  });
});

describe("provisionalTaskName", () => {
  it("formats the date as s-YYYYMMDD-HHMMSS-<pid>", () => {
    const d = new Date("2026-05-22T13:29:01");
    expect(provisionalTaskName(d, 42)).toBe("s-20260522-132901-42");
  });

  it("zero-pads single-digit fields", () => {
    const d = new Date("2026-01-02T03:04:05");
    expect(provisionalTaskName(d, 7)).toBe("s-20260102-030405-7");
  });

  it("defaults to process.pid when no pid is passed", () => {
    const d = new Date("2026-05-22T13:29:01");
    expect(provisionalTaskName(d)).toBe(`s-20260522-132901-${process.pid}`);
  });
});

describe("validateTaskName", () => {
  it("accepts simple kebab names", () => {
    expect(validateTaskName("fix-bug")).toBe("fix-bug");
    expect(validateTaskName("s-20260522-132901-42")).toBe("s-20260522-132901-42");
    expect(validateTaskName("v2_alpha")).toBe("v2_alpha");
  });

  it("rejects path separators and traversal", () => {
    expect(() => validateTaskName("../escape")).toThrow(/invalid task name/);
    expect(() => validateTaskName("foo/bar")).toThrow(/invalid task name/);
    expect(() => validateTaskName("/abs")).toThrow(/invalid task name/);
    expect(() => validateTaskName("foo\\bar")).toThrow(/invalid task name/);
  });

  it("rejects dot-only segments and leading dots", () => {
    expect(() => validateTaskName(".")).toThrow(/invalid task name/);
    expect(() => validateTaskName("..")).toThrow(/invalid task name/);
    expect(() => validateTaskName(".hidden")).toThrow(/invalid task name/);
  });

  it("rejects empty, whitespace-only, and over-long names", () => {
    expect(() => validateTaskName("")).toThrow(/invalid task name/);
    expect(() => validateTaskName("   ")).toThrow(/invalid task name/);
    expect(() => validateTaskName("a".repeat(61))).toThrow(/invalid task name/);
  });

  it("rejects disallowed characters", () => {
    expect(() => validateTaskName("hello world")).toThrow(/invalid task name/);
    expect(() => validateTaskName("a!b")).toThrow(/invalid task name/);
  });
});

describe("createTaskDir", () => {
  it("creates the candidate directory and returns its name", () => {
    const root = tempDir();
    expect(createTaskDir(root, "fix-bug")).toBe("fix-bug");
    expect(existsSyncForTest(path.join(root, "fix-bug"))).toBe(true);
  });

  it("appends -2, -3 on collision, creating each in turn atomically", () => {
    const root = tempDir();
    expect(createTaskDir(root, "fix-bug")).toBe("fix-bug");
    expect(createTaskDir(root, "fix-bug")).toBe("fix-bug-2");
    expect(createTaskDir(root, "fix-bug")).toBe("fix-bug-3");
    expect(existsSyncForTest(path.join(root, "fix-bug-3"))).toBe(true);
  });

  it("creates the tasks root if it does not exist yet", () => {
    const root = path.join(tempDir(), "missing");
    expect(createTaskDir(root, "fix-bug")).toBe("fix-bug");
    expect(existsSyncForTest(path.join(root, "fix-bug"))).toBe(true);
  });

  it("validates the candidate name", () => {
    const root = tempDir();
    expect(() => createTaskDir(root, "../escape")).toThrow(/invalid task name/);
  });
});

describe("renameTask", () => {
  it("renames a task directory and returns the new name", () => {
    const root = tempDir();
    mkdirSync(path.join(root, "old"));
    writeFileSync(path.join(root, "old", "marker.txt"), "hi");

    const finalName = renameTask(root, "old", "new");
    expect(finalName).toBe("new");
    expect(existsSyncForTest(path.join(root, "new", "marker.txt"))).toBe(true);
    expect(existsSyncForTest(path.join(root, "old"))).toBe(false);
  });

  it("resolves collisions by suffixing", () => {
    const root = tempDir();
    mkdirSync(path.join(root, "src"));
    mkdirSync(path.join(root, "target"));
    const finalName = renameTask(root, "src", "target");
    expect(finalName).toBe("target-2");
    expect(existsSyncForTest(path.join(root, "target-2"))).toBe(true);
    expect(existsSyncForTest(path.join(root, "src"))).toBe(false);
  });

  it("returns the same name and no-ops when from === to", () => {
    const root = tempDir();
    mkdirSync(path.join(root, "same"));
    expect(renameTask(root, "same", "same")).toBe("same");
    expect(existsSyncForTest(path.join(root, "same"))).toBe(true);
  });

  it("throws when the source does not exist", () => {
    const root = tempDir();
    expect(() => renameTask(root, "ghost", "alive")).toThrow(/does not exist/);
  });

  it("validates the target name", () => {
    const root = tempDir();
    mkdirSync(path.join(root, "src"));
    expect(() => renameTask(root, "src", "../escape")).toThrow(/invalid task name/);
    expect(existsSyncForTest(path.join(root, "src"))).toBe(true);
  });
});

describe("listRecentTasks", () => {
  it("returns an empty list when the tasks root is missing", () => {
    const root = path.join(tempDir(), "missing");
    expect(listRecentTasks(root)).toEqual([]);
  });

  it("lists tasks newest-first using sessions.json mtime", () => {
    const root = tempDir();
    mkdirSync(path.join(root, "old"), { recursive: true });
    mkdirSync(path.join(root, "new"), { recursive: true });
    writeFileSync(path.join(root, "old", "sessions.json"), "{}");
    writeFileSync(path.join(root, "new", "sessions.json"), "{}");
    const oldTime = new Date("2026-01-01T00:00:00Z");
    const newTime = new Date("2026-05-01T00:00:00Z");
    utimesSync(path.join(root, "old", "sessions.json"), oldTime, oldTime);
    utimesSync(path.join(root, "new", "sessions.json"), newTime, newTime);

    const list = listRecentTasks(root);
    expect(list.map((t) => t.name)).toEqual(["new", "old"]);
  });

  it("surfaces agents from sessions.json and a first-prompt snippet", () => {
    const root = tempDir();
    const t = path.join(root, "fixme");
    mkdirSync(path.join(t, "transcripts"), { recursive: true });
    writeFileSync(path.join(t, "sessions.json"), JSON.stringify({ claude: "abc", codex: "def" }));
    writeFileSync(
      path.join(t, "transcripts", "claude.md"),
      "\n## Turn 2026-05-22T13:29:01\n\n### Prompt\nFix the auth bug today\n\n### Response\nok\n",
    );

    const [entry] = listRecentTasks(root);
    expect(entry?.name).toBe("fixme");
    expect(entry?.agents.sort()).toEqual(["claude", "codex"]);
    expect(entry?.firstPrompt).toBe("Fix the auth bug today");
  });

  it("uses transcript file mtimes for recency", () => {
    const root = tempDir();
    mkdirSync(path.join(root, "stale-dir", "transcripts"), { recursive: true });
    mkdirSync(path.join(root, "older-session"), { recursive: true });
    writeFileSync(path.join(root, "older-session", "sessions.json"), "{}");
    writeFileSync(path.join(root, "stale-dir", "transcripts", "claude.md"), "hi");
    const older = new Date("2026-01-01T00:00:00Z");
    const newer = new Date("2026-05-01T00:00:00Z");
    utimesSync(path.join(root, "older-session", "sessions.json"), older, older);
    utimesSync(path.join(root, "stale-dir", "transcripts"), older, older);
    utimesSync(path.join(root, "stale-dir", "transcripts", "claude.md"), newer, newer);

    expect(listRecentTasks(root).map((t) => t.name)).toEqual(["stale-dir", "older-session"]);
  });

  it("extracts a multiline first-prompt snippet", () => {
    const root = tempDir();
    const t = path.join(root, "multiline");
    mkdirSync(path.join(t, "transcripts"), { recursive: true });
    writeFileSync(
      path.join(t, "transcripts", "claude.md"),
      "\n## Turn 2026-05-22T13:29:01\n\n### Prompt\nLine one\nLine two\n\n### Response\nok\n",
    );

    const [entry] = listRecentTasks(root);
    expect(entry?.firstPrompt).toBe("Line one Line two");
  });

  it("ignores non-directory entries", () => {
    const root = tempDir();
    mkdirSync(path.join(root, "real"));
    writeFileSync(path.join(root, "stray.txt"), "hi");
    expect(listRecentTasks(root).map((t) => t.name)).toEqual(["real"]);
  });
});

describe("active task state", () => {
  it("is null by default", () => {
    clearActiveTaskForTest();
    expect(getActiveTask()).toBeNull();
  });

  it("round-trips through setActiveTask", () => {
    clearActiveTaskForTest();
    setActiveTask("my-task");
    expect(getActiveTask()).toBe("my-task");
  });

  it("clearActiveTaskForTest resets to null", () => {
    setActiveTask("something");
    clearActiveTaskForTest();
    expect(getActiveTask()).toBeNull();
  });
});
