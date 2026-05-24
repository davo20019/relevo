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
import {
  extractImagePaths,
  formatPromptForAgentImages,
  formatPromptWithImages,
  IMAGE_EXTS,
  IMAGE_TOKEN,
  pasteClipboardImage,
  stageImagePaths,
} from "../images.js";
import { openInNewTerminal } from "../openWindow.js";
import {
  ensureTask,
  projectDir,
} from "../paths.js";
import { clearAgentSession, loadSessions } from "../sessions.js";
import { appendTurn, readLastTurns } from "../transcripts.js";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  ALL_TOKEN,
  expandAll,
  parseAfterCommand,
  parseLine,
  parseMulti,
  prepareDispatchLine,
  requestedPeerAgents,
} from "../routing.js";
import {
  computeLiveMaxLines,
  finalizeLivePreview,
  newRun,
  prepareCommand,
  resetRunForRetry,
  spawnProc,
  streamToRun,
  cancelRuns,
  captureDirSession,
  elapsedSeconds,
  type AgentRunState,
} from "../run.js";
import {
  classifySubmit,
  dependencySatisfied,
  formatQueuePreview,
  pruneDeliveredBatches,
  queuedLines,
  recordCompletedRunKey,
  resolveAfterTarget,
  shouldDisablePromptInput,
  type PromptQueueBatch,
} from "../queue.js";
import { appendPromptHistory, loadPromptHistory } from "../prompt-history.js";
import {
  defaultClearMessage,
  defaultSetMessage,
  formatDefaultStatus,
  loadPersistedDefault,
  loadGlobalSettings,
  loadProjectSettings,
  parseDefaultCommand,
  resolveEffectiveDefault,
  saveGlobalDefaultAgent,
  saveProjectDefaultAgent,
  type PersistedDefault,
} from "../settings.js";
import { BottomToolbar } from "./BottomToolbar.js";
import { MultilineInput } from "./MultilineInput.js";
import { colorizeAgentMentions } from "./colorizeAgents.js";
import { PanelRow } from "./PanelRow.js";
import { Separator } from "./Separator.js";
import { buildSkippedBlock, type SkippedLine } from "./skipped.js";
import { SkippedBlock } from "./SkippedBlock.js";
import { buildCompactDisplayPrompt, displayPromptFromDispatch } from "./promptDisplay.js";
import { UserPrompt } from "./UserPrompt.js";
import { clearTaskContext } from "../taskCleanup.js";
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
  const [input, setInput] = useState("");
  const inputRef = useRef(input);
  inputRef.current = input;
  const lastCtrlCRef = useRef(0);
  const [sessionDefaultOverride, setSessionDefaultOverride] = useState<string | null>(null);
  const [persistedDefault, setPersistedDefault] = useState<PersistedDefault>(() => loadPersistedDefault());
  // Submitted-prompt history for the input's Up/Down recall. Loaded once from
  // disk on mount; appended whenever a non-empty line is submitted.
  const [promptHistory, setPromptHistory] = useState<string[]>(() => loadPromptHistory());
  // Set of agents currently mid-dispatch. We allow concurrent dispatches so a
  // queued prompt can fire on an agent the moment it idles, even if other
  // agents in a prior @all batch are still running. The ref is the source of
  // truth read synchronously from event handlers (queue drain, Esc) so a
  // newly-started dispatch is observable on the same tick; the state copy is
  // what triggers re-renders / effects.
  const [inFlight, setInFlight] = useState<Set<string>>(() => new Set());
  const inFlightRef = useRef<Set<string>>(new Set());
  const [queuedPreview, setQueuedPreview] = useState<string[]>([]);
  const [queueVersion, setQueueVersion] = useState(0);
  // Synchronous counter for "a queue-branch submission is mid-flight." Set
  // before any await inside the queue branch so a second submit's
  // classifySubmit observes the in-progress work even if React hasn't
  // re-rendered the new `preparing` state yet. Without it, a queued submit
  // whose awaits straddle the moment the last in-flight agent finishes would
  // see busy=false on the next submit and take the immediate-dispatch path,
  // racing the first submission.
  const queueBranchActiveRef = useRef(0);
  // Queue holds pre-resolved per-agent dispatch plans plus the set of agents
  // that have already received each plan. Drain visits each target as it idles
  // and stops re-firing once it's in `delivered`. Pre-resolution at queue time
  // means image attachments and pendingPrompt fold-ins are captured against the
  // state at submission, not re-derived later when state may have shifted.
  type QueuedItem = {
    agent: string;
    cleaned: string;
    peerAgents: string[];
    imagePaths: string[];
    displayPrompt: string;
    spec: AgentSpec;
    dependsOn?: { agent: string; runId: string };
  };
  const queuedRef = useRef<PromptQueueBatch<QueuedItem>[]>([]);
  // Tracks every run that has reached any terminal state, keyed by
  // `${agentName}:${run.id}`. The drain loop consults this when an item has a
  // `dependsOn` (set by `/after`) to know whether the upstream run is finished.
  // Bounded to 256 entries via a parallel order list so a long session can't
  // grow this unboundedly.
  const completedRunKeysRef = useRef<Set<string>>(new Set());
  const completedRunOrderRef = useRef<string[]>([]);
  const recordCompletedRun = useCallback((agent: string, runId: string) => {
    recordCompletedRunKey(
      completedRunKeysRef.current,
      completedRunOrderRef.current,
      `${agent}:${runId}`,
    );
  }, []);
  // True while handleSubmit is in its synchronous parse/setup window before
  // any agent has been marked in-flight. Without this gate, a second submit
  // in the same tick could race past classifySubmit because busy is still
  // false. Treated as part of `busy` for classification.
  const [preparing, setPreparing] = useState(false);
  const [tick, setTick] = useState(0);

  const setInFlightFromRef = useCallback(() => {
    setInFlight(new Set(inFlightRef.current));
  }, []);
  const markInFlight = useCallback(
    (name: string) => {
      inFlightRef.current.add(name);
      setInFlightFromRef();
    },
    [setInFlightFromRef],
  );
  const clearInFlight = useCallback(
    (name: string) => {
      inFlightRef.current.delete(name);
      setInFlightFromRef();
    },
    [setInFlightFromRef],
  );
  const refreshQueuedPreview = useCallback(() => {
    setQueuedPreview(queuedLines(queuedRef.current));
    setQueueVersion((v) => v + 1);
  }, []);

  const sessionStateRef = useRef({
    lastAgent: null as string | null,
    lastStatus: null as string | null,
    lastElapsed: 0,
    verbose: false,
    pendingImages: [] as string[],
    pendingPrompt: null as string | null,
  });
  const activeProcsRef = useRef<
    Array<{ agent: string; spawn: ReturnType<typeof spawnProc> }>
  >([]);
  const autoRenameCandidateRef = useRef<string | null>(null);
  const migrationNoticeShownRef = useRef(false);

  const agents = useMemo(() => Object.keys(config.agents), [config]);
  const availableAgents = useMemo(() => availableAgentNames(config.agents), [config.agents]);
  const readyCount = availableAgents.length;
  const defaultAgent = useMemo(
    () => resolveEffectiveDefault(sessionDefaultOverride, persistedDefault, availableAgents),
    [sessionDefaultOverride, persistedDefault, availableAgents],
  );
  const agentColor = useMemo(() => {
    const m: Record<string, string> = {};
    agents.forEach((n, i) => (m[n] = AGENT_COLORS[i % AGENT_COLORS.length]!));
    return m;
  }, [agents]);
  const liveAgentsSet = useMemo(() => new Set(availableAgents), [availableAgents]);

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

  const log = useCallback((text: string, level: LogLevel = "info") => {
    setHistory((h) => [...h, { kind: "log", line: { id: nextId(), text, level } }]);
  }, []);

  useInput((rawInput, key) => {
    if (key.ctrl && rawInput === "c") {
      const now = Date.now();
      if (now - lastCtrlCRef.current < 2000) {
        exit();
        return;
      }
      lastCtrlCRef.current = now;
      if (!inputRef.current.trim()) {
        log("Press Ctrl+C again to exit.", "info");
      }
      return;
    }
    if (!key.escape) return;
    // Esc clears any queued prompt first, then cancels active runs. Doing
    // both in one keystroke matches the "abort everything" mental model;
    // letting Esc leave a queued prompt around would surprise the user the
    // moment the cancel completes and the queue immediately dispatches.
    if (queuedRef.current.length > 0) {
      queuedRef.current = [];
      refreshQueuedPreview();
    }
    if (activeRuns.length > 0) {
      const procs = activeProcsRef.current
        .map((r) => (r.spawn && "proc" in r.spawn ? r.spawn.proc : null))
        .filter((p): p is NonNullable<typeof p> => Boolean(p));
      cancelRuns(activeRuns, procs);
    }
  });

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
    async (
      agentName: string,
      spec: AgentSpec,
      userPrompt: string,
      fullPrompt: string,
      displayPrompt: string,
      background?: boolean,
    ) => {
      // Default rule: a dispatch is background iff something else is already
      // in flight. Callers may pre-compute and pass an explicit value when
      // the agent has already been added to inFlight by the caller (e.g. the
      // queue drain) so the "is self in the set?" question can't be answered
      // by counting here.
      const bg = background ?? inFlightRef.current.size > 0;
      const run = newRun(
        agentName,
        agentColor[agentName] ?? "cyan",
        displayPrompt,
        computeLiveMaxLines(),
        bg,
      );
      markInFlight(agentName);
      setActiveRuns((prev) => [...prev, run]);
      // Outer try/finally guarantees we always remove `run` from activeRuns
      // and clear inFlight, even if prepareCommand, streamToRun, the recovery
      // retry, or captureDirSession throws. Without this, a thrown error on
      // any of those paths leaves the run "live" in the UI forever and pins
      // activeRunCountRef > 0, blocking the deferred-resize flow.
      try {
        const prep = await prepareCommand(agentName, spec, fullPrompt);
        const spawned = spawnProc(prep.args, prep.viaStdin, fullPrompt);
        if (spawned.error) {
          log(spawned.error, "error");
          return null;
        }
        const proc = spawned.proc!;
        activeProcsRef.current = [
          ...activeProcsRef.current,
          { agent: agentName, spawn: spawned },
        ];
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
              activeProcsRef.current = activeProcsRef.current.map((p) =>
                p.spawn === spawned ? { ...p, spawn: retrySpawned } : p,
              );
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
          activeProcsRef.current = activeProcsRef.current.filter(
            (p) =>
              p.spawn !== spawned &&
              (!("proc" in p.spawn) || p.spawn.proc !== proc),
          );
        }
        if (!run.cancelled && !run.interrupted && run.finalStatus === "done") {
          await captureDirSession(agentName, spec, activePrep.dirSnapshot);
        }
        sessionStateRef.current.lastAgent = agentName;
        sessionStateRef.current.lastElapsed = (run.end! - run.start) / 1000;
        sessionStateRef.current.lastStatus =
          run.cancelled ? "cancelled" : run.interrupted ? "interrupted" : run.finalStatus ?? "?";

        finalizeLivePreview(run, spec.parser);

        const completed: CompletedTurn = {
          id: nextId(),
          prompt: displayPrompt,
          runs: [run],
          task: safeCurrentTask(),
          at: new Date(run.start),
        };
        setHistory((h) => [...h, { kind: "turn", turn: completed }]);
        if (run.cancelled || run.interrupted) return null;
        return run.responseChunks.join("");
      } finally {
        setActiveRuns((prev) => prev.filter((r) => r !== run));
        recordCompletedRun(agentName, run.id);
        if (run.background) {
          const elapsed = Math.floor(((run.end ?? Date.now()) - run.start) / 1000);
          log(`@${agentName} background task done in ${elapsed}s`);
        }
        clearInFlight(agentName);
      }
    },
    [agentColor, clearInFlight, log, markInFlight, recordCompletedRun],
  );

  const dispatchParallel = useCallback(
    async (
      agentNames: string[],
      userPrompt: string,
      perAgentFullPrompts: Record<string, string>,
      displayPrompt: string,
    ) => {
      const liveMax = computeLiveMaxLines();
      // First prepared entry is foreground; the rest of the batch is
      // background. If another agent is already running before the batch
      // starts, every entry (including the first) is background.
      const priorInFlight = inFlightRef.current.size > 0;
      const runs = agentNames.map((n, i) =>
        newRun(n, agentColor[n] ?? "cyan", displayPrompt, liveMax, priorInFlight || i > 0),
      );
      for (const n of agentNames) inFlightRef.current.add(n);
      setInFlightFromRef();
      setActiveRuns((prev) => [...prev, ...runs]);

      // Outer try/finally guarantees the live runs are evicted and any still
      // in-flight agents cleared, even if prepareCommand/streamToRun/the
      // recovery retry/captureDirSession throws somewhere mid-batch. The
      // inner per-agent finally already clears each agent's inFlight; this
      // outer finally is a safety net for the post-batch captureDirSession
      // loop and any other paths that come after.
      try {
      const prepared = await Promise.all(
        agentNames.map(async (name, i) => {
          const spec = config.agents[name]!;
          const fullPrompt = perAgentFullPrompts[name]!;
          const prep = await prepareCommand(name, spec, fullPrompt);
          const spawned = spawnProc(prep.args, prep.viaStdin, fullPrompt);
          return { name, spec, prep, spawned, run: runs[i]! };
        }),
      );

      activeProcsRef.current = [
        ...activeProcsRef.current,
        ...prepared.map((p) => ({ agent: p.name, spawn: p.spawned })),
      ];

      await Promise.all(
        prepared.map(async (p) => {
          try {
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
            const originalSpawned = p.spawned;
            p.spawned = retrySpawned;
            p.prep = retryPrep;
            activeProcsRef.current = activeProcsRef.current.map((sp) =>
              sp.spawn === originalSpawned ? { ...sp, spawn: retrySpawned } : sp,
            );
            await streamToRun({
              run: p.run,
              proc: retrySpawned.proc!,
              parser: retryPrep.parser,
              agentName: p.name,
              preGen: retryPrep.preGen,
              sessionId: retryPrep.sessionId,
              verbose: sessionStateRef.current.verbose,
            });
          } finally {
            // Free this agent for the queue drain the moment it idles, even
            // though the parallel batch's CompletedTurn isn't committed yet
            // (we wait for siblings). The panel stays visible in activeRuns
            // until the whole batch commits below; clearInFlight just lets
            // the next queued prompt fire on this agent in the meantime.
            // Record completion early too, so a queued /after on this run can drain
            // immediately rather than waiting for the slowest sibling.
            recordCompletedRun(p.name, p.run.id);
            if (p.run.background) {
              const elapsed = Math.floor(((p.run.end ?? Date.now()) - p.run.start) / 1000);
              log(`@${p.name} background task done in ${elapsed}s`);
            }
            clearInFlight(p.name);
          }
        }),
      );

      for (const p of prepared) finalizeLivePreview(p.run, p.spec.parser);
      const ourSpawns = new Set(prepared.map((p) => p.spawned));
      activeProcsRef.current = activeProcsRef.current.filter(
        (sp) => !ourSpawns.has(sp.spawn),
      );

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

      // Mutate before the turn is committed: Ink's <Static> caches the
      // rendered tree once, so a later mutation wouldn't show up. Each
      const completed: CompletedTurn = {
        id: nextId(),
        prompt: displayPrompt,
        runs,
        task: safeCurrentTask(),
        at: new Date(runs[0]!.start),
      };
      setHistory((h) => [...h, { kind: "turn", turn: completed }]);
      const ourRuns = new Set(runs);
      setActiveRuns((prev) => prev.filter((r) => !ourRuns.has(r)));

      for (const p of prepared) {
        if (!p.spawned.error && !p.run.cancelled && !p.run.interrupted) {
          await appendTurn(p.name, userPrompt, p.run.responseChunks.join(""));
        }
      }
      } finally {
        const ourRunsCleanup = new Set(runs);
        setActiveRuns((prev) => prev.filter((r) => !ourRunsCleanup.has(r)));
        for (const n of agentNames) inFlightRef.current.delete(n);
        setInFlightFromRef();
      }
    },
    [agentColor, clearInFlight, config.agents, log, recordCompletedRun, setInFlightFromRef],
  );

  const resetVisibleTaskState = useCallback((message: string): void => {
    setActiveRuns([]);
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
    // Defer the "started task" log until maybeAutoRenameProvisional settles
    // on a final name, so the user sees one tidy line instead of a provisional
    // slug followed immediately by a rename arrow.
    autoRenameCandidateRef.current = name;
    return name;
  }, []);

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
      // Active task changed underneath us (e.g. /task new, /resume) — that
      // path already logged something meaningful, don't double-announce.
      if (current !== candidate) return;
      const slug = slugFromPrompt(firstPrompt);
      let finalName = candidate;
      if (slug) {
        const tasksRoot = path.join(projectDir(), ".relay", "tasks");
        try {
          finalName = renameTask(tasksRoot, current, slug);
          setActiveTask(finalName);
        } catch (e: any) {
          log(`could not rename task: ${e?.message ?? e}`, "warn");
          finalName = candidate;
        }
      }
      log(`started task: ${finalName}`);
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
        clearTaskContext();
        log(`cleared transcripts and sessions for task ${safeCurrentTask()}`);
        return true;
      }
      if (trimmed === "/cancel" || trimmed.startsWith("/cancel ")) {
        const m = trimmed.match(/^\/cancel\s+@?([A-Za-z0-9_\-]+)\s*$/);
        if (!m) {
          log("usage: /cancel @<agent>  (Esc still cancels every active run)", "warn");
          return true;
        }
        const name = m[1]!;
        if (!config.agents[name]) {
          log(`unknown agent: @${name} (try /agents)`, "error");
          return true;
        }
        const matchingProcs = activeProcsRef.current
          .filter((entry) => entry.agent === name)
          .map((entry) =>
            entry.spawn && "proc" in entry.spawn ? entry.spawn.proc : null,
          )
          .filter((p): p is NonNullable<typeof p> => Boolean(p));
        const matchingRuns = activeRuns.filter(
          (r) => r.agentName === name && r.running,
        );
        if (matchingRuns.length === 0 && matchingProcs.length === 0) {
          log(`no active @${name} run`);
          return true;
        }
        cancelRuns(matchingRuns, matchingProcs);
        log(`cancelled @${name} (${matchingRuns.length} run(s))`);
        return true;
      }
      if (trimmed === "/reset") {
        if (!getActiveTask()) {
          log("no active task yet. type a prompt to start one.", "warn");
          return true;
        }
        clearTaskContext();
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
      const defaultCmd = parseDefaultCommand(trimmed);
      if (defaultCmd) {
        const assertAgent = (name: string): boolean => {
          if (!config.agents[name]) {
            log(`unknown agent: @${name} (try /agents)`, "error");
            return false;
          }
          if (!availableAgents.includes(name)) {
            log(`@${name} is not available on PATH (try /agents)`, "warn");
          }
          return true;
        };
        if (defaultCmd.kind === "show") {
          const globalAgent = loadGlobalSettings().default_agent ?? null;
          const localAgent = loadProjectSettings().default_agent ?? null;
          log(
            formatDefaultStatus({
              effective: defaultAgent,
              sessionOverride: sessionDefaultOverride,
              globalAgent,
              localAgent,
            }),
          );
          return true;
        }
        if (defaultCmd.kind === "clear") {
          if (defaultCmd.scope === "session") {
            setSessionDefaultOverride(null);
            log(defaultClearMessage("session"));
            return true;
          }
          if (defaultCmd.scope === "global") {
            saveGlobalDefaultAgent(null);
            setPersistedDefault(loadPersistedDefault());
            setSessionDefaultOverride(null);
            log(defaultClearMessage("global"));
            return true;
          }
          saveProjectDefaultAgent(null);
          setPersistedDefault(loadPersistedDefault());
          setSessionDefaultOverride(null);
          log(defaultClearMessage("local"));
          return true;
        }
        if (!assertAgent(defaultCmd.agent)) return true;
        if (defaultCmd.scope === "session") {
          setSessionDefaultOverride(defaultCmd.agent);
          log(defaultSetMessage("session", defaultCmd.agent));
          return true;
        }
        if (defaultCmd.scope === "global") {
          saveGlobalDefaultAgent(defaultCmd.agent);
          setPersistedDefault(loadPersistedDefault());
          setSessionDefaultOverride(null);
          log(defaultSetMessage("global", defaultCmd.agent));
          return true;
        }
        saveProjectDefaultAgent(defaultCmd.agent);
        setPersistedDefault(loadPersistedDefault());
        setSessionDefaultOverride(null);
        log(defaultSetMessage("local", defaultCmd.agent));
        return true;
      }
      if (trimmed === "/after" || trimmed.startsWith("/after ")) {
        const parsed = parseAfterCommand(trimmed);
        if (!parsed) {
          log("usage: /after @<agent>: <prompt>", "warn");
          return true;
        }
        const { targetAgent, body } = parsed;
        if (!config.agents[targetAgent]) {
          log(`unknown agent: @${targetAgent} (try /agents)`, "error");
          return true;
        }
        const target = resolveAfterTarget(
          targetAgent,
          activeRuns,
          completedRunOrderRef.current,
        );
        if (target === null) {
          log(`no running or recent @${targetAgent} run to wait for`, "warn");
          return true;
        }
        const runId = target.runId;
        if (target.ambiguous) {
          const n = activeRuns.filter(
            (r) => r.agentName === targetAgent && r.running,
          ).length;
          log(
            `@${targetAgent} has ${n} in-flight runs; waiting on the most recent`,
          );
        }
        const items = await parseLineToItems(body, body, [], null);
        if (items === null || items.length === 0) return true;
        const dep = { agent: targetAgent, runId };
        const itemsWithDep = items.map((it) => ({ ...it, dependsOn: dep }));
        queuedRef.current.push({
          line: trimmed,
          items: itemsWithDep,
          delivered: new Set(),
        });
        refreshQueuedPreview();
        log(`queued after @${targetAgent}: ${body}`);
        return true;
      }
      if (trimmed === "/sync" || trimmed.startsWith("/sync ")) {
        log(
          "/sync is reserved for task-state rebroadcasting, but it is not implemented yet.",
          "warn",
        );
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
          try {
            if (!getActiveTask()) {
              log("no active task yet. type a prompt to start one before queuing an image.", "warn");
              continue;
            }
            const [staged] = await stageImagePaths([abs]);
            if (!staged) throw new Error(`image staging returned no path for: ${abs}`);
            state.pendingImages.push(staged);
            added++;
            log(staged === abs ? `queued: ${staged}` : `queued (copied into task): ${staged}`);
          } catch (e: any) {
            log(`could not queue image: ${e?.message ?? e}`, "error");
          }
        }
        if (added === 0 && tokens.length)
          log("usage: /image <path> | /image paste | /image list | /image clear");
      }
    },
    // Note: parseLineToItems is declared after handleSlash; we deliberately
    // rely on closure capture rather than adding it as a dep (a forward
    // reference in the deps array would TDZ at first render).
    [
      activeRuns,
      availableAgents,
      config,
      defaultAgent,
      log,
      refreshQueuedPreview,
      resetVisibleTaskState,
      sessionDefaultOverride,
    ],
  );

  // Dispatch a single pre-resolved queued item. Mirrors the single-agent tail
  // of the main dispatch path: ensure task → buildContext against the latest
  // transcripts → dispatchSingle → appendTurn. Drained per-agent so each
  // queued target fires the instant its agent idles, regardless of siblings.
  const dispatchQueuedItem = useCallback(
    async (item: QueuedItem, background: boolean) => {
      try {
        await ensureActiveTask();
        const userPrompt = formatPromptForAgentImages(item.agent, item.cleaned, item.imagePaths);
        await maybeAutoRenameProvisional(userPrompt);
        const ctx = buildContext(item.agent, config.agents, config.context_turns ?? 3, {
          peerAgents: item.peerAgents,
          contextCompaction: config.context_compaction,
        });
        const fullPrompt = ctx ? ctx + userPrompt : userPrompt;
        const response = await dispatchSingle(
          item.agent,
          item.spec,
          userPrompt,
          fullPrompt,
          item.displayPrompt,
          background,
        );
        if (response !== null) {
          await appendTurn(item.agent, userPrompt, response);
        }
      } catch (e: any) {
        clearInFlight(item.agent);
        log(`@${item.agent} queued dispatch failed: ${e?.message ?? e}`, "error");
      }
    },
    [
      clearInFlight,
      config.agents,
      config.context_turns,
      dispatchSingle,
      ensureActiveTask,
      log,
      maybeAutoRenameProvisional,
    ],
  );

  // Parse a line into per-agent dispatch items. Same routing/multi/@all
  // semantics as the main dispatch path; centralized here so the queue stores
  // a stable plan (image paths pinned into the prompt, pendingPrompt folded,
  // agent list pinned) and the drain doesn't have to re-derive.
  //
  // Image / pending-prompt ownership is passed in by the caller rather than
  // read from sessionStateRef so two queue-branch submissions racing through
  // their own awaits can't observe each other's mid-flight mutations. The
  // caller transfers ownership synchronously before any await; this function
  // operates on the transferred snapshot only.
  //
  // Returns null when nothing dispatchable (already logged the reason).
  const parseLineToItems = useCallback(
    async (
      compactLine: string,
      expandedLine: string,
      ownedImages: string[],
      ownedPrompt: string | null,
    ): Promise<QueuedItem[] | null> => {
      let expanded = expandedLine;
      let carriedPrompt = ownedPrompt;
      if (ALL_TOKEN.test(expandedLine.trimStart())) {
        const available = availableAgentNames(config.agents);
        const unavail = unavailableAgentReasons(config.agents);
        const skipped = agents.filter((n) => unavail[n]);
        if (skipped.length) pushSkipped(skipped, unavail);
        if (available.length === 0) {
          log("no available CLI agents for @all", "warn");
          return null;
        }
        const allBody = expandedLine.trimStart().replace(ALL_TOKEN, "").trim();
        let lineForExpand = expandedLine;
        if (!allBody && carriedPrompt) {
          lineForExpand = `@all ${carriedPrompt}`;
        }
        carriedPrompt = null;
        expanded = expandAll(lineForExpand, available);
      } else {
        expanded = expandAll(expandedLine, agents);
      }

      const multi = parseMulti(expanded, agents);
      if (multi && multi.body) {
        const { images: extracted, cleaned } = extractImagePaths(multi.body);
        let allImages = [...ownedImages, ...extracted];
        if (allImages.length) {
          try {
            allImages = await stageImagePaths(allImages);
          } catch (e: any) {
            log(`could not copy image for dispatch: ${e?.message ?? e}`, "error");
            return null;
          }
          log(
            `attaching ${allImages.length} image(s) to ${multi.agents.map((a) => "@" + a).join(", ")}`,
          );
        }
        const displayPrompt = buildCompactDisplayPrompt(compactLine, agents, defaultAgent);
        return multi.agents
          .filter((a) => config.agents[a] && agentIsEnabled(config.agents[a]!))
          .map((a) => ({
            agent: a,
            cleaned,
            peerAgents: requestedPeerAgents(cleaned, a, agents),
            imagePaths: allImages,
            displayPrompt,
            spec: config.agents[a]!,
          }));
      }
      if (multi && !multi.body) {
        log("multi-dispatch needs a prompt after the agent list");
        return null;
      }

      const routingState = {
        get pendingPrompt() {
          return carriedPrompt;
        },
        set pendingPrompt(v: string | null) {
          carriedPrompt = v;
        },
      };
      const routed = prepareDispatchLine(expanded, agents, routingState, defaultAgent);
      if (routed === null) {
        const choices = agents.map((n) => "@" + n).join(" ");
        const suffix = carriedPrompt ? " Type one of those tags to send it." : "";
        log(
          `no agent tagged. Pick one: ${choices}.${suffix} Use /default <agent> for a default.`,
          "warn",
        );
        // The user typed a bare prompt with no agent; remember it so the next
        // @<agent> submit folds it in. Restore the carried prompt back into
        // session state — ownership transfer is reversed only on this path.
        if (carriedPrompt !== null) sessionStateRef.current.pendingPrompt = carriedPrompt;
        return null;
      }
      const parsed = parseLine(routed);
      if (parsed.kind === "empty") return null;
      if (parsed.kind === "command") {
        // Slash commands are rejected upstream when busy; if we got here,
        // the caller should run handleSlash itself. Queue path doesn't reach.
        return null;
      }
      if (parsed.kind === "untagged") {
        const choices = agents.map((n) => "@" + n).join(" ");
        log(`no agent tagged. Pick one: ${choices}.`, "warn");
        return null;
      }
      const agent = parsed.agent;
      if (!config.agents[agent]) {
        log(`unknown agent: @${agent} (try /agents)`, "error");
        return null;
      }
      if (!agentIsEnabled(config.agents[agent]!)) {
        log(`@${agent} is disabled. Run /agents enable ${agent} to use it.`, "warn");
        return null;
      }
      const { images: extracted, cleaned } = extractImagePaths(parsed.content);
      let allImages = [...ownedImages, ...extracted];
      if (!cleaned.trim() && allImages.length === 0) {
        log("empty prompt");
        return null;
      }
      if (allImages.length) {
        try {
          allImages = await stageImagePaths(allImages);
        } catch (e: any) {
          log(`could not copy image for dispatch: ${e?.message ?? e}`, "error");
          return null;
        }
        log(`attaching ${allImages.length} image(s) to @${agent}`);
      }
      const displayPrompt = displayPromptFromDispatch(
        compactLine,
        routed,
        agents,
        defaultAgent,
      );
      return [
        {
          agent,
          cleaned,
          peerAgents: requestedPeerAgents(cleaned, agent, agents),
          imagePaths: allImages,
          displayPrompt,
          spec: config.agents[agent]!,
        },
      ];
    },
    [agents, config.agents, defaultAgent, log, pushSkipped],
  );

  const handleSubmit = useCallback(
    async (compactLine: string, expandedLine: string) => {
      try {
      if (!compactLine.trim()) {
        setInput("");
        return;
      }
      // Record in prompt history before any routing decision so even queued or
      // rejected lines are recallable. Dedup against the most recent entry so
      // accidental double-submits don't clutter the file.
      setPromptHistory((prev) =>
        prev[prev.length - 1] === compactLine ? prev : [...prev, compactLine],
      );
      appendPromptHistory(compactLine);
      const decision = classifySubmit(
        expandedLine,
        inFlightRef.current.size > 0 || preparing || queueBranchActiveRef.current > 0,
      );
      if (decision === "reject-slash") {
        log(
          "can't run a slash command while a dispatch is in flight. press Esc to cancel the run first.",
          "warn",
        );
        return;
      }
      if (decision === "queue") {
        setInput("");
        // Synchronously take ownership of pendingImages/pendingPrompt and mark
        // this queue branch active before any await — two concurrent queue
        // submits must not race on the shared sessionStateRef.pendingImages
        // bucket, and a third submit landing during our awaits must observe
        // queueBranchActiveRef and route to "queue" too.
        queueBranchActiveRef.current++;
        const state = sessionStateRef.current;
        const ownedImages = state.pendingImages;
        state.pendingImages = [];
        const ownedPrompt = state.pendingPrompt;
        state.pendingPrompt = null;
        try {
          if (ownedImages.length > 0 || IMAGE_TOKEN.test(expandedLine)) {
            await ensureActiveTask();
          }
          const items = await parseLineToItems(
            compactLine,
            expandedLine,
            ownedImages,
            ownedPrompt,
          );
          if (items === null || items.length === 0) return;
          queuedRef.current.push({ line: compactLine, items, delivered: new Set() });
          refreshQueuedPreview();
        } finally {
          queueBranchActiveRef.current--;
        }
        return;
      }
      setInput("");
      setPreparing(true);
      try {
        const stateForImages = sessionStateRef.current;
        if (stateForImages.pendingImages.length > 0 || IMAGE_TOKEN.test(expandedLine)) {
          await ensureActiveTask();
          if (stateForImages.pendingImages.length > 0) {
            try {
              stateForImages.pendingImages = await stageImagePaths(stateForImages.pendingImages);
            } catch (e: any) {
              log(`could not copy queued image: ${e?.message ?? e}`, "error");
              return;
            }
          }
        }
        let expanded = expandedLine;
        if (ALL_TOKEN.test(expandedLine.trimStart())) {
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
          // Mirror prepareDispatchLine's pending-prompt merge: if the user
          // typed a bare `@all` after a "no agent tagged" warning, fold the
          // saved prompt into the @all body. Either way (bare or with body),
          // clear pendingPrompt now that @all is being dispatched.
          const allState = sessionStateRef.current;
          const allBody = expandedLine.trimStart().replace(ALL_TOKEN, "").trim();
          let lineForExpand = expandedLine;
          if (!allBody && allState.pendingPrompt) {
            lineForExpand = `@all ${allState.pendingPrompt}`;
          }
          allState.pendingPrompt = null;
          expanded = expandAll(lineForExpand, available);
        } else {
          expanded = expandAll(expandedLine, agents);
        }

        const state = sessionStateRef.current;

        const multi = parseMulti(expanded, agents);
        if (multi && multi.body) {
          const { images: extracted, cleaned } = extractImagePaths(multi.body);
          let allImages = [...state.pendingImages, ...extracted];
          if (allImages.length) {
            try {
              allImages = await stageImagePaths(allImages);
            } catch (e: any) {
              log(`could not copy image for dispatch: ${e?.message ?? e}`, "error");
              return;
            }
            log(
              `attaching ${allImages.length} image(s) to ${multi.agents.map((a) => "@" + a).join(", ")}`,
            );
          }
          await ensureActiveTask();
          const userPrompt = formatPromptWithImages(cleaned, allImages);
          await maybeAutoRenameProvisional(userPrompt);
          const perAgent: Record<string, string> = {};
          for (const name of multi.agents) {
            const ctx = buildContext(name, config.agents, config.context_turns ?? 3, {
              peerAgents: requestedPeerAgents(cleaned, name, agents),
              contextCompaction: config.context_compaction,
            });
            perAgent[name] = ctx ? ctx + userPrompt : userPrompt;
          }
          const displayPrompt = buildCompactDisplayPrompt(compactLine, agents, defaultAgent);
          await dispatchParallel(multi.agents, userPrompt, perAgent, displayPrompt);
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
        const routed = prepareDispatchLine(expanded, agents, routingState, defaultAgent);
        if (routed === null) {
          const choices = agents.map((n) => "@" + n).join(" ");
          const suffix = state.pendingPrompt ? " Type one of those tags to send it." : "";
          log(
            `no agent tagged. Pick one: ${choices}.${suffix} Use /default <agent> for a default.`,
            "warn",
          );
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
        let allImages = [...state.pendingImages, ...extracted];
        if (!cleaned.trim() && allImages.length === 0) {
          log("empty prompt");
          return;
        }
        if (allImages.length) {
          try {
            allImages = await stageImagePaths(allImages);
          } catch (e: any) {
            log(`could not copy image for dispatch: ${e?.message ?? e}`, "error");
            return;
          }
          log(`attaching ${allImages.length} image(s) to @${agent}`);
        }

        await ensureActiveTask();
        const userPrompt = formatPromptForAgentImages(agent, cleaned, allImages);
        await maybeAutoRenameProvisional(userPrompt);
        const ctx = buildContext(agent, config.agents, config.context_turns ?? 3, {
          peerAgents: requestedPeerAgents(cleaned, agent, agents),
          contextCompaction: config.context_compaction,
        });
        const fullPrompt = ctx ? ctx + userPrompt : userPrompt;
        const displayPrompt = displayPromptFromDispatch(
          compactLine,
          routed,
          agents,
          defaultAgent,
        );
        const response = await dispatchSingle(
          agent,
          config.agents[agent]!,
          userPrompt,
          fullPrompt,
          displayPrompt,
        );
        state.pendingImages = [];
        if (response !== null) {
          await appendTurn(agent, userPrompt, response);
        }
      } finally {
        setPreparing(false);
      }
      } catch (e: any) {
        // Last-resort guard: dispatchSingle / dispatchParallel are now
        // self-healing on internal throws (activeRuns + inFlight cleaned via
        // their outer try/finally) but a thrown error still propagates here.
        // Without this catch the rejection escapes to React's async boundary
        // and bubbles up as an unhandled promise rejection / TUI crash.
        log(`dispatch failed: ${e?.message ?? e}`, "error");
      }
    },
    [
      agents,
      config,
      defaultAgent,
      dispatchParallel,
      dispatchSingle,
      ensureActiveTask,
      exit,
      handleSlash,
      log,
      maybeAutoRenameProvisional,
      parseLineToItems,
      preparing,
      pushSkipped,
      refreshQueuedPreview,
    ],
  );

  // Drain queued batches per-agent. A fresh queueVersion considers new input
  // immediately; inFlight changes let waiting same-agent items advance as runs
  // finish. Mark in-flight before kicking off async dispatch so queued work is
  // observable before dispatchQueuedItem reaches its own awaits.
  useEffect(() => {
    let changed = false;
    for (const q of queuedRef.current) {
      for (const item of q.items) {
        if (q.delivered.has(item.agent)) continue;
        // `continue` (not `break`) so unrelated agents in the same batch can
        // still drain when only one item is blocked on a dependency.
        if (!dependencySatisfied(item.dependsOn, completedRunKeysRef.current)) continue;
        if (inFlightRef.current.has(item.agent)) continue;
        markInFlight(item.agent);
        q.delivered.add(item.agent);
        changed = true;
        // After markInFlight the set contains this agent. >1 means another
        // dispatch is still running alongside us — treat this as background.
        // A queued item dispatched after every parent has finished (set size
        // exactly 1, just us) is foreground.
        const background = inFlightRef.current.size > 1;
        void dispatchQueuedItem(item, background);
      }
    }
    const before = queuedRef.current.length;
    pruneDeliveredBatches(queuedRef.current);
    if (changed || queuedRef.current.length !== before) {
      refreshQueuedPreview();
    }
  }, [inFlight, queueVersion, dispatchQueuedItem, markInFlight, refreshQueuedPreview]);

  const toolbarState = {
    lastAgent: sessionStateRef.current.lastAgent,
    lastStatus: sessionStateRef.current.lastStatus,
    lastElapsed: sessionStateRef.current.lastElapsed,
    verbose: sessionStateRef.current.verbose,
    defaultAgent,
    readyCount,
    offCount: Math.max(0, agents.length - readyCount),
    runningCount: inFlight.size,
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
                : colorizeAgentMentions(item.line.text, agentColor, liveAgentsSet);
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
              {sepKind !== "none" && <Separator kind={sepKind} label={label} cols={cols} />}
              <UserPrompt prompt={item.turn.prompt} cols={cols} />
              <PanelRow runs={item.turn.runs} tick={0} keyPrefix={item.turn.id} cols={cols} />
            </Box>
          );
        }}
      </Static>
      {(() => {
        // Group consecutive runs that share a prompt so the live area renders
        // one UserPrompt header per concurrent dispatch. The normal single
        // dispatch and the unstaggered @all case collapse to a single group
        // (matches the prior single-header look); a staggered queued dispatch
        // gets its own header beneath the still-running prior group.
        if (activeRuns.length === 0) return null;
        const groups: Array<{ prompt: string; runs: AgentRunState[] }> = [];
        for (const r of activeRuns) {
          const last = groups[groups.length - 1];
          if (last && last.prompt === r.prompt) {
            last.runs.push(r);
          } else {
            groups.push({ prompt: r.prompt, runs: [r] });
          }
        }
        // Render a separator above each live group so the timestamp/task
        // marker appears the moment the prompt is dispatched, not only when
        // the run finishes and commits to history.
        let lastCommittedTurn: CompletedTurn | null = null;
        for (let i = history.length - 1; i >= 0; i--) {
          const it = history[i];
          if (it && it.kind === "turn") {
            lastCommittedTurn = it.turn;
            break;
          }
        }
        const currentTask = safeCurrentTask();
        return groups.map((g, i) => {
          const startMs = g.runs[0]!.start;
          const prevTask =
            i === 0 ? lastCommittedTurn?.task ?? null : currentTask;
          const sepKind: "none" | "single" | "double" =
            i === 0 && !lastCommittedTurn
              ? "none"
              : prevTask !== currentTask
                ? "double"
                : "single";
          const label = formatClockLabel({ at: new Date(startMs), task: currentTask });
          return (
            <Box key={`live-group-${i}`} flexDirection="column">
              {sepKind !== "none" && (
                <Separator kind={sepKind} label={label} cols={cols} />
              )}
              <UserPrompt prompt={g.prompt} cols={cols} />
              <PanelRow runs={g.runs} tick={tick} keyPrefix={`live-${i}`} cols={cols} />
            </Box>
          );
        });
      })()}
      {queuedPreview.length > 0 && (
        <Box flexDirection="column">
          {(() => {
            // Show every queued batch so the user can confirm rapid submits
            // landed. The first batch gets a "queued:" prefix; later batches
            // get a numbered marker. The hint about Esc only appears on the
            // very last printed line of the very last batch.
            const headPrefix = "  queued: ";
            const continuation = " ".repeat(headPrefix.length);
            const hint = "  (Esc to clear all)";
            const previewWidth = Math.max(1, cols - headPrefix.length - hint.length);
            const nodes: Array<{ key: string; text: string }> = [];
            queuedPreview.forEach((line, batchIdx) => {
              const isFirstBatch = batchIdx === 0;
              const prefix = isFirstBatch
                ? headPrefix
                : `  ${String(batchIdx + 1).padStart(headPrefix.length - 4, " ")}. `;
              const lines = formatQueuePreview(line, previewWidth);
              lines.forEach((wrapped, lineIdx) => {
                nodes.push({
                  key: `${batchIdx}-${lineIdx}`,
                  text: `${lineIdx === 0 ? prefix : continuation}${wrapped}`,
                });
              });
            });
            return nodes.map((n, i) => {
              const isLast = i === nodes.length - 1;
              return (
                <Text key={n.key} dimColor>
                  {`${n.text}${isLast ? hint : ""}`}
                </Text>
              );
            });
          })()}
        </Box>
      )}
      <Box marginTop={1}>
        <MultilineInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          disabled={shouldDisablePromptInput(preparing, inFlight.size)}
          slashCommands={SLASH_COMMANDS}
          agents={agents}
          history={promptHistory}
        />
      </Box>
      <BottomToolbar
        state={toolbarState}
        cols={cols}
        tick={tick}
        colorMap={agentColor}
        perAgentStatuses={availableAgents.map((agent) => {
          const run = activeRuns.find((r) => r.agentName === agent && r.running);
          return {
            agent,
            running: Boolean(run),
            elapsedSeconds: run ? elapsedSeconds(run) : undefined,
          };
        })}
      />
    </Box>
  );
}
