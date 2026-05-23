import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AGENT_COLORS,
  agentIsEnabled,
  availableAgentNames,
  loadConfig,
  saveConfig,
  SLASH_COMMANDS,
  unavailableAgentReasons,
  type AgentConfig,
  type AgentSpec,
} from "../config.js";
import { buildContext } from "../context.js";
import { buildHelpText } from "../help.js";
import { extractImagePaths, formatPromptWithImages, IMAGE_EXTS, pasteClipboardImage } from "../images.js";
import { openInNewTerminal } from "../openWindow.js";
import {
  ensureTask,
  projectDir,
  transcriptDir,
} from "../paths.js";
import { clearAgentSession, clearSessions, loadSessions } from "../sessions.js";
import { appendTurn, readLastTurns } from "../transcripts.js";
import { existsSync, readdirSync, unlinkSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  ALL_TOKEN,
  expandAll,
  parseLine,
  parseMulti,
  prepareDispatchLine,
} from "../routing.js";
import {
  newRun,
  prepareCommand,
  resetRunForRetry,
  spawnProc,
  streamToRun,
  cancelRuns,
  captureDirSession,
  type AgentRunState,
} from "../run.js";
import { classifySubmit, formatQueuePreview } from "../queue.js";
import { BottomToolbar } from "./BottomToolbar.js";
import { MultilineInput } from "./MultilineInput.js";
import { colorizeAgentMentions } from "./colorizeAgents.js";
import { PanelRow } from "./PanelRow.js";
import { Separator } from "./Separator.js";
import { buildSkippedBlock, type SkippedLine } from "./skipped.js";
import { SkippedBlock } from "./SkippedBlock.js";
import { UserPrompt } from "./UserPrompt.js";
import {
  createTaskDir,
  getActiveTask,
  listRecentTasks,
  provisionalTaskName,
  renameTask,
  setActiveTask,
  slugFromPrompt,
  validateTaskName,
} from "../tasks.js";

function formatClockLabel(turn: { at: Date; task: string }): string {
  const hh = String(turn.at.getHours()).padStart(2, "0");
  const mm = String(turn.at.getMinutes()).padStart(2, "0");
  const ss = String(turn.at.getSeconds()).padStart(2, "0");
  // Include the task name on double separators implicitly through the heavier
  // rule; the timestamp alone is enough text in the rule.
  return `${hh}:${mm}:${ss}  ·  ${turn.task}`;
}

type LogLevel = "info" | "warn" | "error" | "raw";
type LogLine = { id: string; text: string; level: LogLevel };

// Visual treatment per log level. Gray for system info keeps it neutral so it
// doesn't collide with per-agent colors when log lines mention @agent (cyan
// agent slot was indistinguishable from a cyan-dim log line). Yellow for
// warnings, red for errors, and `raw` (no styling) for content we're replaying
// that already has its own formatting, like a transcript dump from /last or
// /tail.
const LEVEL_STYLE: Record<LogLevel, { color?: string; dim?: boolean }> = {
  info: { color: "gray" },
  warn: { color: "yellow" },
  error: { color: "red" },
  raw: {},
};
type CompletedTurn = {
  id: string;
  prompt: string;
  runs: AgentRunState[];
  task: string;
  at: Date;
};
type SkippedHistoryItem = {
  kind: "skipped";
  id: string;
  lines: SkippedLine[];
  agentColor: Record<string, string>;
};
type HistoryItem =
  | { kind: "log"; line: LogLine }
  | { kind: "skipped"; item: SkippedHistoryItem }
  | { kind: "turn"; turn: CompletedTurn };

let HIST_SEQ = 0;
const nextId = () => `h${++HIST_SEQ}`;

export function App({ initialConfig }: { initialConfig: AgentConfig }) {
  const { exit } = useApp();
  const [config, setConfig] = useState<AgentConfig>(initialConfig);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [activeRuns, setActiveRuns] = useState<AgentRunState[]>([]);
  const [activePromptText, setActivePromptText] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [queuedPrompt, setQueuedPrompt] = useState<string | null>(null);
  const queuedPromptRef = useRef<string | null>(null);
  const [tick, setTick] = useState(0);

  const sessionStateRef = useRef({
    lastAgent: null as string | null,
    lastStatus: null as string | null,
    lastElapsed: 0,
    verbose: false,
    pendingImages: [] as string[],
    pendingPrompt: null as string | null,
  });
  const activeProcsRef = useRef<Array<ReturnType<typeof spawnProc>>>([]);
  const autoRenameCandidateRef = useRef<string | null>(null);
  const migrationNoticeShownRef = useRef(false);

  const agents = useMemo(() => Object.keys(config.agents), [config]);
  const agentColor = useMemo(() => {
    const m: Record<string, string> = {};
    agents.forEach((n, i) => (m[n] = AGENT_COLORS[i % AGENT_COLORS.length]!));
    return m;
  }, [agents]);

  useEffect(() => {
    if (activeRuns.length === 0) return;
    const id = setInterval(() => setTick((t) => t + 1), 100);
    return () => clearInterval(id);
  }, [activeRuns.length]);

  // Re-emit history on terminal resize. Ink's <Static> writes each item to
  // scrollback at the width it had at render time; once the terminal shrinks,
  // those lines reflow and bordered panels get mangled (borders end up
  // mid-line). Bumping a key on <Static> remounts it so every completed turn
  // re-renders at the new width, and we clear the screen first so we don't
  // leave the mangled copy above the redraw.
  //
  // While a dispatch is streaming we defer the clear+remount: doing it
  // mid-stream blanks the live panel and re-emits every completed turn into
  // scrollback while the agent is still printing, creating duplicate output.
  // We remember that a resize happened and replay it once the run ends.
  const { stdout } = useStdout();
  const [cols, setCols] = useState<number>(stdout?.columns ?? 80);
  const activeRunCountRef = useRef(0);
  const deferredResizeRef = useRef(false);
  useEffect(() => {
    activeRunCountRef.current = activeRuns.length;
    if (activeRuns.length === 0 && deferredResizeRef.current && stdout) {
      deferredResizeRef.current = false;
      stdout.write("\x1b[2J\x1b[3J\x1b[H");
      setCols(stdout.columns ?? 80);
    }
  }, [activeRuns.length, stdout]);
  useEffect(() => {
    if (!stdout) return;
    const update = () => {
      if (activeRunCountRef.current > 0) {
        deferredResizeRef.current = true;
        return;
      }
      stdout.write("\x1b[2J\x1b[3J\x1b[H");
      setCols(stdout.columns ?? 80);
    };
    stdout.on("resize", update);
    return () => {
      stdout.off("resize", update);
    };
  }, [stdout]);

  useInput((_input, key) => {
    if (!key.escape) return;
    // Esc clears any queued prompt first, then cancels active runs. Doing
    // both in one keystroke matches the "abort everything" mental model;
    // letting Esc leave a queued prompt around would surprise the user the
    // moment the cancel completes and the queue immediately dispatches.
    if (queuedPromptRef.current !== null) {
      queuedPromptRef.current = null;
      setQueuedPrompt(null);
    }
    if (activeRuns.length > 0) {
      const procs = activeProcsRef.current
        .map((r) => (r && "proc" in r ? r.proc : null))
        .filter((p): p is NonNullable<typeof p> => Boolean(p));
      cancelRuns(activeRuns, procs);
    }
  });

  const log = useCallback((text: string, level: LogLevel = "info") => {
    setHistory((h) => [...h, { kind: "log", line: { id: nextId(), text, level } }]);
  }, []);

  useEffect(() => {
    if (migrationNoticeShownRef.current) return;
    if (getActiveTask()) return;
    const tasksRoot = path.join(projectDir(), ".relay", "tasks");
    if (listRecentTasks(tasksRoot).length === 0) return;
    migrationNoticeShownRef.current = true;
    log("relevo now starts a fresh task by default. type /resume to continue prior work.");
  }, [log]);

  function safeCurrentTask(): string {
    return getActiveTask() ?? "(no active task)";
  }

  const pushSkipped = useCallback(
    (skipped: string[], reasons: Record<string, string | undefined>) => {
      const lines = buildSkippedBlock(skipped, reasons);
      if (lines.length === 0) return;
      const snapshot = { ...agentColor };
      setHistory((h) => [
        ...h,
        { kind: "skipped", item: { kind: "skipped", id: nextId(), lines, agentColor: snapshot } },
      ]);
    },
    [agentColor],
  );

  const dispatchSingle = useCallback(
    async (agentName: string, spec: AgentSpec, userPrompt: string, fullPrompt: string) => {
      const run = newRun(agentName, agentColor[agentName] ?? "cyan");
      setActiveRuns([run]);
      setActivePromptText(userPrompt);
      const prep = await prepareCommand(agentName, spec, fullPrompt);
      const spawned = spawnProc(prep.args, prep.viaStdin, fullPrompt);
      if (spawned.error) {
        log(spawned.error, "error");
        setActiveRuns([]);
        setActivePromptText(null);
        return null;
      }
      const proc = spawned.proc!;
      activeProcsRef.current = [spawned];
      let activePrep = prep;
      try {
        const result = await streamToRun({
          run,
          proc,
          parser: prep.parser,
          agentName,
          preGen: prep.preGen,
          sessionId: prep.sessionId,
          verbose: sessionStateRef.current.verbose,
        });
        const recoverable =
          result.sessionInvalid &&
          result.exitCode !== 0 &&
          !run.cancelled &&
          !run.interrupted &&
          Boolean(spec.resume_template);
        if (recoverable) {
          await clearAgentSession(agentName);
          const retryPrep = await prepareCommand(agentName, spec, fullPrompt);
          const retrySpawned = spawnProc(retryPrep.args, retryPrep.viaStdin, fullPrompt);
          if (retrySpawned.error) {
            log(`@${agentName} session expired and retry failed: ${retrySpawned.error}`, "error");
          } else {
            log(`@${agentName} ↻ session expired, retrying with a fresh session`, "warn");
            resetRunForRetry(run, "");
            activeProcsRef.current = [retrySpawned];
            activePrep = retryPrep;
            await streamToRun({
              run,
              proc: retrySpawned.proc!,
              parser: retryPrep.parser,
              agentName,
              preGen: retryPrep.preGen,
              sessionId: retryPrep.sessionId,
              verbose: sessionStateRef.current.verbose,
            });
          }
        }
      } finally {
        activeProcsRef.current = [];
      }
      if (!run.cancelled && !run.interrupted && run.finalStatus === "done") {
        await captureDirSession(agentName, spec, activePrep.dirSnapshot);
      }
      sessionStateRef.current.lastAgent = agentName;
      sessionStateRef.current.lastElapsed = (run.end! - run.start) / 1000;
      sessionStateRef.current.lastStatus =
        run.cancelled ? "cancelled" : run.interrupted ? "interrupted" : run.finalStatus ?? "?";

      const completed: CompletedTurn = {
        id: nextId(),
        prompt: userPrompt,
        runs: [run],
        task: safeCurrentTask(),
        at: new Date(),
      };
      setHistory((h) => [...h, { kind: "turn", turn: completed }]);
      setActiveRuns([]);
      setActivePromptText(null);
      if (run.cancelled || run.interrupted) return null;
      return run.responseChunks.join("");
    },
    [agentColor, log],
  );

  const dispatchParallel = useCallback(
    async (
      agentNames: string[],
      userPrompt: string,
      perAgentFullPrompts: Record<string, string>,
    ) => {
      // Live preview height scales with terminal rows so tall windows show
      // more context per panel. Capped at 24 so very tall screens don't make
      // a single dispatch eat the whole transcript area.
      const rows = process.stdout.rows ?? 30;
      const liveMax = Math.max(8, Math.min(24, Math.floor(rows / 3)));
      const runs = agentNames.map((n) => newRun(n, agentColor[n] ?? "cyan", liveMax));
      setActiveRuns(runs);
      setActivePromptText(userPrompt);

      const prepared = await Promise.all(
        agentNames.map(async (name, i) => {
          const spec = config.agents[name]!;
          const fullPrompt = perAgentFullPrompts[name]!;
          const prep = await prepareCommand(name, spec, fullPrompt);
          const spawned = spawnProc(prep.args, prep.viaStdin, fullPrompt);
          return { name, spec, prep, spawned, run: runs[i]! };
        }),
      );

      activeProcsRef.current = prepared.map((p) => p.spawned);

      await Promise.all(
        prepared.map(async (p, i) => {
          if (p.spawned.error) {
            p.run.running = false;
            p.run.finalStatus = p.spawned.error;
            p.run.end = Date.now();
            return;
          }
          const result = await streamToRun({
            run: p.run,
            proc: p.spawned.proc!,
            parser: p.prep.parser,
            agentName: p.name,
            preGen: p.prep.preGen,
            sessionId: p.prep.sessionId,
            verbose: sessionStateRef.current.verbose,
          });
          const recoverable =
            result.sessionInvalid &&
            result.exitCode !== 0 &&
            !p.run.cancelled &&
            !p.run.interrupted &&
            Boolean(p.spec.resume_template);
          if (!recoverable) return;
          const fullPrompt = perAgentFullPrompts[p.name]!;
          await clearAgentSession(p.name);
          const retryPrep = await prepareCommand(p.name, p.spec, fullPrompt);
          const retrySpawned = spawnProc(retryPrep.args, retryPrep.viaStdin, fullPrompt);
          if (retrySpawned.error) {
            log(`@${p.name} session expired and retry failed: ${retrySpawned.error}`, "error");
            return;
          }
          log(`@${p.name} ↻ session expired, retrying with a fresh session`, "warn");
          resetRunForRetry(p.run, "");
          p.spawned = retrySpawned;
          p.prep = retryPrep;
          activeProcsRef.current[i] = retrySpawned;
          await streamToRun({
            run: p.run,
            proc: retrySpawned.proc!,
            parser: retryPrep.parser,
            agentName: p.name,
            preGen: retryPrep.preGen,
            sessionId: retryPrep.sessionId,
            verbose: sessionStateRef.current.verbose,
          });
        }),
      );

      // Uncap structured parsers (codex-json, cursor-json, raw with a clean
      // CLI) so their final answer renders fully. Keep the live-preview cap
      // on for noisy plain-text parsers (agy-text) so the panel doesn't
      // expand to dump the full intermediate transcript when the run ends.
      for (const p of prepared) {
        if (p.spec.parser !== "agy-text") p.run.liveMaxLines = null;
      }
      activeProcsRef.current = [];

      for (const p of prepared) {
        if (
          !p.spawned.error &&
          !p.run.cancelled &&
          !p.run.interrupted &&
          p.run.finalStatus === "done"
        ) {
          await captureDirSession(p.name, p.spec, p.prep.dirSnapshot);
        }
      }

      const elapsedMax = Math.max(...runs.map((r) => (r.end! - r.start) / 1000), 0);
      const okCount = prepared.filter(
        (p) =>
          !p.spawned.error &&
          !p.run.cancelled &&
          !p.run.interrupted &&
          p.run.finalStatus === "done",
      ).length;
      const total = prepared.length;
      sessionStateRef.current.lastAgent = agentNames.join("+");
      sessionStateRef.current.lastElapsed = elapsedMax;
      sessionStateRef.current.lastStatus =
        okCount === total ? `✓×${okCount}` : `${okCount}/${total} ok`;

      const completed: CompletedTurn = {
        id: nextId(),
        prompt: userPrompt,
        runs,
        task: safeCurrentTask(),
        at: new Date(),
      };
      setHistory((h) => [...h, { kind: "turn", turn: completed }]);
      setActiveRuns([]);
      setActivePromptText(null);

      for (const p of prepared) {
        if (!p.spawned.error && !p.run.cancelled && !p.run.interrupted) {
          await appendTurn(p.name, userPrompt, p.run.responseChunks.join(""));
        }
      }

      // One dim hint line for every agent in this fanout that completed cleanly
      // AND has an open_template (i.e. is actually resumable). Mirrors the
      // single-agent hint shape so the affordance discovery is consistent.
      const openable = prepared
        .filter(
          (p) =>
            !p.spawned.error &&
            !p.run.cancelled &&
            !p.run.interrupted &&
            p.run.finalStatus === "done" &&
            Boolean(p.spec.open_template),
        )
        .map((p) => `/open ${p.name}`);
      if (openable.length > 0) {
        log(`resume in agent's own CLI (new window):  ${openable.join("  ·  ")}`);
      }
    },
    [agentColor, config.agents, log],
  );

  const resetVisibleTaskState = useCallback((message: string): void => {
    setActiveRuns([]);
    setActivePromptText(null);
    const state = sessionStateRef.current;
    state.pendingPrompt = null;
    // pendingImages are intentionally preserved: they're a per-process queue
    // for the next dispatch, not a per-task attachment. Dropping them on
    // /task new or /resume silently loses what the user just queued.
    state.lastAgent = null;
    state.lastStatus = null;
    state.lastElapsed = 0;
    // History cannot shrink without breaking Ink's <Static>: it commits each
    // item once and never re-renders dropped or mutated entries. So we append
    // the status line instead of replacing history. The heavy ═ separator on
    // the next turn already visually marks the task switch.
    setHistory((h) => [...h, { kind: "log", line: { id: nextId(), level: "info", text: message } }]);
  }, []);

  const ensureActiveTask = useCallback(async (): Promise<string> => {
    const existing = getActiveTask();
    if (existing) return existing;
    const tasksRoot = path.join(projectDir(), ".relay", "tasks");
    const name = createTaskDir(tasksRoot, provisionalTaskName());
    await ensureTask(name);
    setActiveTask(name);
    autoRenameCandidateRef.current = name;
    log(`started new task: ${name}`);
    return name;
  }, [log]);

  // Called pre-dispatch, before any turn is committed to Ink's <Static>, so
  // the first turn's scrollback line is already labeled with the final slug.
  // Post-dispatch relabeling does not work: <Static> commits items once and
  // does not re-render them on subsequent setHistory calls.
  const maybeAutoRenameProvisional = useCallback(
    async (firstPrompt: string): Promise<void> => {
      const candidate = autoRenameCandidateRef.current;
      if (!candidate) return;
      // One-shot: clear the ref up front so a no-slug prompt doesn't leave the
      // task eligible for a mid-conversation rename when a later turn happens
      // to slug. Scrollback labels stay stable across the rest of the session.
      autoRenameCandidateRef.current = null;
      const current = getActiveTask();
      if (current !== candidate) return;
      const slug = slugFromPrompt(firstPrompt);
      if (!slug) return;
      const tasksRoot = path.join(projectDir(), ".relay", "tasks");
      let finalName: string;
      try {
        finalName = renameTask(tasksRoot, current, slug);
      } catch (e: any) {
        log(`could not rename task: ${e?.message ?? e}`, "warn");
        return;
      }
      setActiveTask(finalName);
      if (finalName !== current) {
        log(
          finalName === slug
            ? `renamed task: ${current} -> ${finalName}`
            : `renamed task: ${current} -> ${finalName} (name collision)`,
        );
      }
    },
    [log],
  );

  const handleSlash = useCallback(
    async (cmd: string): Promise<boolean> => {
      const trimmed = cmd.trim();
      if (trimmed === "/exit" || trimmed === "/quit" || trimmed === "/q") return false;
      if (trimmed === "/help" || trimmed === "/h" || trimmed === "/?") {
        log(buildHelpText(config));
        return true;
      }
      if (trimmed === "/verbose" || trimmed === "/v") {
        sessionStateRef.current.verbose = !sessionStateRef.current.verbose;
        log(`verbose mode: ${sessionStateRef.current.verbose ? "on" : "off"}`);
        return true;
      }
      if (trimmed === "/quiet") {
        sessionStateRef.current.verbose = false;
        log("verbose mode: off");
        return true;
      }
      if (trimmed === "/agents" || trimmed.startsWith("/agents ")) {
        await handleAgentsCommand(trimmed);
        return true;
      }
      if (trimmed === "/last" || trimmed.startsWith("/last ")) {
        if (!getActiveTask()) {
          log("no active task yet. type a prompt to start one, or /resume a prior task.", "warn");
          return true;
        }
        const parts = trimmed.split(/\s+/, 2);
        if (parts.length === 2) {
          const name = parts[1]!.replace(/^@/, "");
          const recent = readLastTurns(name, 1);
          if (recent.trim()) log(recent, "raw");
          else log(`no transcript yet for @${name}`);
        } else log("usage: /last <agent>");
        return true;
      }
      if (trimmed === "/tail" || trimmed.startsWith("/tail ")) {
        if (!getActiveTask()) {
          log("no active task yet. type a prompt to start one, or /resume a prior task.", "warn");
          return true;
        }
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 2) {
          const name = parts[1]!.replace(/^@/, "");
          const n = parts[2] ? parseInt(parts[2], 10) || 1 : 1;
          const recent = readLastTurns(name, n);
          if (recent.trim()) log(recent, "raw");
          else log(`no transcript yet for @${name}`);
        } else log("usage: /tail <agent> [n]");
        return true;
      }
      if (trimmed === "/clear") {
        if (!getActiveTask()) {
          log("no active task yet. type a prompt to start one.", "warn");
          return true;
        }
        const dir = transcriptDir();
        if (existsSync(dir)) {
          for (const f of readdirSync(dir)) {
            if (f.endsWith(".md")) unlinkSync(path.join(dir, f));
          }
        }
        log(`cleared transcripts for task ${safeCurrentTask()}`);
        return true;
      }
      if (trimmed === "/reset") {
        if (!getActiveTask()) {
          log("no active task yet. type a prompt to start one.", "warn");
          return true;
        }
        const dir = transcriptDir();
        if (existsSync(dir)) {
          for (const f of readdirSync(dir)) {
            if (f.endsWith(".md")) unlinkSync(path.join(dir, f));
          }
        }
        clearSessions();
        log(`reset task ${safeCurrentTask()}: transcripts and sessions cleared`);
        return true;
      }
      if (trimmed === "/task" || trimmed.startsWith("/task ")) {
        await handleTaskCommand(trimmed);
        return true;
      }
      if (trimmed === "/resume" || trimmed.startsWith("/resume ")) {
        await handleResumeCommand(trimmed);
        return true;
      }
      if (trimmed === "/cwd" || trimmed === "/pwd" || trimmed === "/workspace") {
        log(`  ${projectDir()}`);
        return true;
      }
      if (trimmed === "/open" || trimmed.startsWith("/open ")) {
        const rest = trimmed.replace(/^\/open\s*/, "");
        await handleOpenCommand(rest);
        return true;
      }
      if (trimmed === "/image" || trimmed.startsWith("/image ")) {
        await handleImageCommand(trimmed);
        return true;
      }
      log(`unknown command: ${trimmed} (try /help)`, "error");
      return true;

      async function handleAgentsCommand(cmd: string) {
        const parts = cmd.split(/\s+/);
        if (parts.length === 1) {
          const unavail = unavailableAgentReasons(config.agents);
          const out: string[] = [];
          for (const [name, spec] of Object.entries(config.agents)) {
            const reason = unavail[name];
            const status =
              reason === "disabled"
                ? "disabled"
                : reason
                  ? `unavailable (${reason})`
                  : "available";
            out.push(`  @${name}  ${status} · ${spec.cmd}`);
          }
          log(out.join("\n"));
          return;
        }
        if (parts.length !== 3 || (parts[1] !== "enable" && parts[1] !== "disable")) {
          log("usage: /agents | /agents enable <agent> | /agents disable <agent>");
          return;
        }
        const action = parts[1]!;
        const name = parts[2]!.replace(/^@/, "");
        const spec = config.agents[name];
        if (!spec) {
          log(`unknown agent: @${name} (try /agents)`, "error");
          return;
        }
        spec.enabled = action === "enable";
        saveConfig(config);
        setConfig({ ...config });
        log(`@${name} ${spec.enabled ? "enabled" : "disabled"}`);
      }

      async function handleTaskCommand(cmd: string) {
        const trimmed = cmd.trim();
        const match = /^\/task(?:\s+(\S+)(?:\s+([\s\S]+))?)?$/.exec(trimmed);
        const sub = match?.[1];
        const restRaw = match?.[2]?.trim() ?? "";
        if (!sub) {
          log(`  current task: ${safeCurrentTask()}`);
          return;
        }
        if (sub === "list") {
          const tasksRoot = path.join(projectDir(), ".relay", "tasks");
          const recent = listRecentTasks(tasksRoot);
          if (recent.length === 0) {
            log("no tasks yet in this project");
            return;
          }
          const cur = getActiveTask();
          const lines = recent.map((t) => (t.name === cur ? `* ${t.name}` : `  ${t.name}`));
          log(lines.join("\n"));
          return;
        }
        if (sub === "new") {
          if (!restRaw) {
            log("usage: /task new <name>");
            return;
          }
          let raw: string;
          try {
            raw = validateTaskName(restRaw.replace(/\s+/g, "-"));
          } catch (e: any) {
            log(`/task new: ${e?.message ?? e}`, "error");
            return;
          }
          const tasksRoot = path.join(projectDir(), ".relay", "tasks");
          // Refuse to silently shadow an existing task. The old behavior
          // created a sibling with a -2 suffix, which orphaned the original
          // and surprised users expecting `/task new <existing>` to continue.
          if (existsSync(path.join(tasksRoot, raw))) {
            log(
              `task '${raw}' already exists. use /resume to switch to it, or pick a different name.`,
              "warn",
            );
            return;
          }
          const name = createTaskDir(tasksRoot, raw);
          await ensureTask(name);
          setActiveTask(name);
          autoRenameCandidateRef.current = null;
          resetVisibleTaskState(`created and switched to task: ${name}`);
          return;
        }
        if (sub === "rename") {
          if (!restRaw) {
            log("usage: /task rename <new>");
            return;
          }
          const current = getActiveTask();
          if (!current) {
            log("no active task to rename. start one with a prompt, or /task new <name>.", "warn");
            return;
          }
          let target: string;
          try {
            target = validateTaskName(restRaw.replace(/\s+/g, "-"));
          } catch (e: any) {
            log(`/task rename: ${e?.message ?? e}`, "error");
            return;
          }
          const tasksRoot = path.join(projectDir(), ".relay", "tasks");
          try {
            const finalName = renameTask(tasksRoot, current, target);
            setActiveTask(finalName);
            autoRenameCandidateRef.current = null;
            resetVisibleTaskState(
              finalName === target
                ? `renamed task: ${current} -> ${finalName}`
                : `renamed task: ${current} -> ${finalName} (name collision)`,
            );
          } catch (e: any) {
            log(`rename failed: ${e?.message ?? e}`, "error");
          }
          return;
        }
        if (sub === "switch") {
          log(
            "/task switch is gone. use /resume to pick a prior task, or /task new <name> to start one.",
            "warn",
          );
          return;
        }
        if (sub === "end") {
          log(
            "/task end is gone. each relevo process holds its own task; quit the session or /resume another to switch.",
            "warn",
          );
          return;
        }
        log(`unknown /task subcommand: ${sub} (try list | new | rename, or /resume)`);
      }

      async function handleResumeCommand(cmd: string) {
        const parts = cmd.split(/\s+/, 2);
        const tasksRoot = path.join(projectDir(), ".relay", "tasks");
        const recent = listRecentTasks(tasksRoot);
        if (recent.length === 0) {
          log("no prior tasks in this project. type a prompt to start one.");
          return;
        }
        if (parts.length === 1) {
          const cur = getActiveTask();
          const shown = recent.slice(0, 12);
          const lines = shown.map((t, i) => {
            const idx = `[${i + 1}]`.padStart(4);
            const star = t.name === cur ? " *" : "  ";
            const when = formatRelative(t.lastActivity);
            const agents = t.agents.length ? `· ${t.agents.map((a) => "@" + a).join(" ")}` : "";
            const snippet = t.firstPrompt ? `· "${t.firstPrompt}"` : "";
            return `${idx}${star} ${t.name}  ${when}  ${agents}  ${snippet}`.trimEnd();
          });
          if (recent.length > shown.length) {
            lines.push(`... ${recent.length - shown.length} more (use /resume <name> to reach them, or /task list to see all)`);
          }
          log(["recent tasks (type /resume <n|name> to switch):", ...lines].join("\n"));
          return;
        }
        const arg = parts[1]!.trim();
        // If the argument matches an existing task by exact name, prefer that.
        // Otherwise treat as a 1-based index across the full recent list (not
        // capped at the 12 displayed, so older tasks remain reachable).
        const byName = recent.find((t) => t.name === arg);
        const picked = byName ?? (() => {
          const n = parseInt(arg, 10);
          if (!Number.isFinite(n) || n < 1 || n > recent.length) return null;
          return recent[n - 1] ?? null;
        })();
        if (!picked) {
          log(`/resume: no task matches '${arg}'. expected a number 1-${recent.length} or an exact task name.`, "warn");
          return;
        }
        setActiveTask(picked.name);
        autoRenameCandidateRef.current = null;
        resetVisibleTaskState(`resumed task: ${picked.name}`);
      }

      function formatRelative(when: Date): string {
        const deltaMs = Date.now() - when.getTime();
        const mins = Math.floor(deltaMs / 60_000);
        if (mins < 1) return "just now";
        if (mins < 60) return `${mins}m ago`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
      }

      async function handleOpenCommand(rest: string) {
        if (!getActiveTask()) {
          log("no active task yet. type a prompt to start one.", "warn");
          return;
        }
        const name = rest.replace(/^@/, "").trim();
        if (!name) return log("usage: /open <agent>");
        const spec = config.agents[name];
        if (!spec) return log(`unknown agent: @${name} (try /agents)`, "error");
        const tmpl = spec.open_template;
        if (!tmpl)
          return log(
            `@${name} has no open_template configured (only agents with native session support can be opened in a new window)`,
          );
        const sid = loadSessions()[name];
        if (!sid)
          return log(
            `no session yet for @${name} in task '${safeCurrentTask()}'. run @${name} at least once first.`,
            "warn",
          );
        const cmdToRun = tmpl.replace("{session_id}", sid);
        const { ok, error } = await openInNewTerminal(cmdToRun, projectDir());
        if (ok)
          log(
            `opened @${name} in a new Terminal window (session ${sid.slice(0, 8)}...); relevo still tracks this session; avoid using both at once`,
          );
        else log(`could not open new window: ${error}`, "error");
      }

      async function handleImageCommand(cmd: string) {
        const m = /^\/image\s*(.*)$/.exec(cmd);
        const rest = (m?.[1] ?? "").trim();
        const state = sessionStateRef.current;

        if (!rest || rest === "list") {
          if (state.pendingImages.length === 0) {
            log("no images queued. /image <path> or /image paste to add.");
          } else {
            log(
              `${state.pendingImages.length} queued for next dispatch:\n` +
                state.pendingImages.map((p) => "  " + p).join("\n"),
            );
          }
          return;
        }
        if (rest === "clear") {
          const n = state.pendingImages.length;
          state.pendingImages = [];
          log(`cleared ${n} pending image(s)`);
          return;
        }
        if (rest === "paste") {
          if (!getActiveTask()) {
            log("no active task yet. type a prompt to start one before pasting an image.", "warn");
            return;
          }
          const { path: p, error } = await pasteClipboardImage();
          if (error) return log(error, "error");
          state.pendingImages.push(p!);
          log(`queued from clipboard: ${p}`);
          return;
        }
        const tokens = rest
          .split(/\s+/)
          .map((t) => t.replace(/^"|"$/g, "").replace(/^'|'$/g, ""));
        let added = 0;
        for (const tok of tokens) {
          const resolved = tok.startsWith("~")
            ? path.join(os.homedir(), tok.slice(1))
            : tok;
          if (!existsSync(resolved) || !statSync(resolved).isFile()) {
            log(`not a file: ${tok}`, "error");
            continue;
          }
          if (!IMAGE_EXTS.has(path.extname(resolved).toLowerCase())) {
            log(`warning: ${path.extname(resolved)} is not a recognized image extension; queuing anyway`, "warn");
          }
          const abs = path.resolve(resolved);
          state.pendingImages.push(abs);
          added++;
          log(`queued: ${abs}`);
        }
        if (added === 0 && tokens.length)
          log("usage: /image <path> | /image paste | /image list | /image clear");
      }
    },
    [config, log, resetVisibleTaskState],
  );

  const handleSubmit = useCallback(
    async (line: string) => {
      if (!line.trim()) {
        setInput("");
        return;
      }
      const decision = classifySubmit(line, busy);
      if (decision === "reject-slash") {
        log(
          "can't run a slash command while a dispatch is in flight. press Esc to cancel the run first.",
          "warn",
        );
        return;
      }
      if (decision === "queue") {
        setInput("");
        queuedPromptRef.current = line;
        setQueuedPrompt(line);
        return;
      }
      setInput("");
      setBusy(true);
      try {
        let expanded = line;
        if (ALL_TOKEN.test(line.trimStart())) {
          const available = availableAgentNames(config.agents);
          const unavail = unavailableAgentReasons(config.agents);
          const skipped = agents.filter((n) => unavail[n]);
          if (skipped.length) {
            pushSkipped(skipped, unavail);
          }
          if (available.length === 0) {
            log("no available CLI agents for @all", "warn");
            return;
          }
          expanded = expandAll(line, available);
        } else {
          expanded = expandAll(line, agents);
        }

        const state = sessionStateRef.current;

        const multi = parseMulti(expanded, agents);
        if (multi && multi.body) {
          const { images: extracted, cleaned } = extractImagePaths(multi.body);
          const allImages = [...state.pendingImages, ...extracted];
          const userPrompt = formatPromptWithImages(cleaned, allImages);
          if (allImages.length) {
            log(
              `attaching ${allImages.length} image(s) to ${multi.agents.map((a) => "@" + a).join(", ")}`,
            );
          }
          await ensureActiveTask();
          await maybeAutoRenameProvisional(userPrompt);
          const perAgent: Record<string, string> = {};
          for (const name of multi.agents) {
            const ctx = buildContext(name, config.agents, config.context_turns ?? 3);
            perAgent[name] = ctx ? ctx + userPrompt : userPrompt;
          }
          await dispatchParallel(multi.agents, userPrompt, perAgent);
          state.pendingImages = [];
          return;
        }
        if (multi && !multi.body) {
          log("multi-dispatch needs a prompt after the agent list");
          return;
        }

        const routingState = {
          get pendingPrompt() {
            return state.pendingPrompt;
          },
          set pendingPrompt(v: string | null) {
            state.pendingPrompt = v;
          },
        };
        const routed = prepareDispatchLine(expanded, agents, routingState);
        if (routed === null) {
          const choices = agents.map((n) => "@" + n).join(" ");
          const suffix = state.pendingPrompt ? " Type one of those tags to send it." : "";
          log(`no agent tagged. Pick one: ${choices}.${suffix}`, "warn");
          return;
        }
        const parsed = parseLine(routed);
        if (parsed.kind === "empty") return;
        if (parsed.kind === "command") {
          const keep = await handleSlash(parsed.content);
          if (!keep) exit();
          return;
        }
        if (parsed.kind === "untagged") {
          const choices = agents.map((n) => "@" + n).join(" ");
          log(`no agent tagged. Pick one: ${choices}.`, "warn");
          return;
        }
        const agent = parsed.agent;
        if (!config.agents[agent]) {
          log(`unknown agent: @${agent} (try /agents)`, "error");
          return;
        }
        if (!agentIsEnabled(config.agents[agent]!)) {
          log(`@${agent} is disabled. Run /agents enable ${agent} to use it.`, "warn");
          return;
        }
        // If the user wrote other known @<agent> mentions in the prompt body
        // but they didn't shape it as multi-dispatch ("@a @b hi" / "@a and @b hi"),
        // surface a one-line hint so the silent single-dispatch isn't mistaken
        // for a parallel one. Catches things like
        //   "@claude please ask @codex about X"  →  routes to claude only.
        const otherMentions = new Set<string>();
        for (const m of parsed.content.matchAll(/@([A-Za-z0-9_\-]+)/g)) {
          const n = m[1]!;
          if (n !== agent && config.agents[n]) otherMentions.add(n);
        }
        if (otherMentions.size > 0) {
          const others = [...otherMentions].map((n) => `@${n}`).join(", ");
          log(
            `routing to @${agent}. ${others} also mentioned, use ` +
              `@${agent} ${[...otherMentions].map((n) => `@${n}`).join(" ")} <prompt> for parallel dispatch.`,
          );
        }
        const { images: extracted, cleaned } = extractImagePaths(parsed.content);
        const allImages = [...state.pendingImages, ...extracted];
        if (!cleaned.trim() && allImages.length === 0) {
          log("empty prompt");
          return;
        }
        const userPrompt = formatPromptWithImages(cleaned, allImages);
        if (allImages.length) log(`attaching ${allImages.length} image(s) to @${agent}`);

        await ensureActiveTask();
        await maybeAutoRenameProvisional(userPrompt);
        const ctx = buildContext(agent, config.agents, config.context_turns ?? 3);
        const fullPrompt = ctx ? ctx + userPrompt : userPrompt;
        const response = await dispatchSingle(agent, config.agents[agent]!, userPrompt, fullPrompt);
        state.pendingImages = [];
        if (response !== null) {
          await appendTurn(agent, userPrompt, response);
          const spec = config.agents[agent]!;
          if (spec.open_template && sessionStateRef.current.lastStatus === "done") {
            log(`/open ${agent} to resume in ${agent}'s own CLI (new window)`);
          }
        }
      } finally {
        setBusy(false);
      }
    },
    [
      agents,
      busy,
      config,
      dispatchParallel,
      dispatchSingle,
      ensureActiveTask,
      exit,
      handleSlash,
      log,
      maybeAutoRenameProvisional,
      pushSkipped,
    ],
  );

  // Drain the queue when the in-flight dispatch finishes. The ref is the
  // source of truth (cleared first) so a stale effect re-fire — for example
  // when handleSubmit's identity changes due to a config update — sees a
  // null queue and no-ops rather than dispatching the same prompt twice.
  useEffect(() => {
    if (busy) return;
    const pending = queuedPromptRef.current;
    if (pending === null) return;
    queuedPromptRef.current = null;
    setQueuedPrompt(null);
    void handleSubmit(pending);
  }, [busy, handleSubmit]);

  const toolbarState = {
    lastAgent: sessionStateRef.current.lastAgent,
    lastStatus: sessionStateRef.current.lastStatus,
    lastElapsed: sessionStateRef.current.lastElapsed,
    verbose: sessionStateRef.current.verbose,
    agentCount: agents.length,
  };

  return (
    <Box flexDirection="column">
      <Static key={`static-${cols}`} items={history}>
        {(item, index) => {
          if (item.kind === "log") {
            const style = LEVEL_STYLE[item.line.level];
            // `raw` is replayed agent content (transcripts) — leave its
            // text untouched so a stray "@something" inside the transcript
            // doesn't get recolored as if it were a system mention.
            const segments =
              item.line.level === "raw"
                ? [{ text: item.line.text }]
                : colorizeAgentMentions(item.line.text, agentColor);
            return (
              <Text key={item.line.id} color={style.color} dimColor={style.dim}>
                {segments.map((seg, i) =>
                  seg.color ? (
                    <Text key={i} color={seg.color} bold={seg.bold}>
                      {seg.text}
                    </Text>
                  ) : (
                    seg.text
                  ),
                )}
              </Text>
            );
          }
          if (item.kind === "skipped") {
            return (
              <SkippedBlock
                key={item.item.id}
                lines={item.item.lines}
                agentColor={item.item.agentColor}
              />
            );
          }
          // Determine if a separator belongs above this turn — and how heavy.
          // None for the very first turn ever, single `─` between turns in the
          // same task, double `═` when the task changed.
          let prevTurn: CompletedTurn | null = null;
          for (let i = index - 1; i >= 0; i--) {
            const it = history[i];
            if (it && it.kind === "turn") {
              prevTurn = it.turn;
              break;
            }
          }
          const sepKind: "none" | "single" | "double" = !prevTurn
            ? "none"
            : prevTurn.task !== item.turn.task
              ? "double"
              : "single";
          const label = formatClockLabel(item.turn);
          return (
            <Box key={item.turn.id} flexDirection="column">
              {sepKind !== "none" && <Separator kind={sepKind} label={label} />}
              <UserPrompt prompt={item.turn.prompt} />
              <PanelRow runs={item.turn.runs} tick={0} keyPrefix={item.turn.id} />
            </Box>
          );
        }}
      </Static>
      {activePromptText !== null && <UserPrompt prompt={activePromptText} />}
      <PanelRow runs={activeRuns} tick={tick} keyPrefix="live" />
      {queuedPrompt !== null && (
        <Text dimColor>
          {`  queued: ${formatQueuePreview(queuedPrompt, 60)}  (Esc to clear)`}
        </Text>
      )}
      <Box marginTop={1}>
        <MultilineInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          disabled={busy}
          slashCommands={SLASH_COMMANDS}
          agents={agents}
        />
      </Box>
      <BottomToolbar state={toolbarState} />
    </Box>
  );
}
