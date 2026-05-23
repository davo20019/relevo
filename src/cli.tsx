#!/usr/bin/env node
import { render } from "ink";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { createElement } from "react";
import { App } from "./ui/App.js";
import { ensureDirs, ensureDirsSync } from "./paths.js";
import { loadConfig } from "./config.js";
import { buildHelpText } from "./help.js";
import { cleanupStagedImageCache } from "./images.js";

// React/Ink emit performance.mark/measure entries on every render. Over a long
// TUI session that fills Node's 1M global perf-entry buffer and triggers
// MaxPerformanceEntryBufferExceededWarning. Drain it as entries arrive.
const perfObserver = new PerformanceObserver(() => {
  performance.clearMarks();
  performance.clearMeasures();
});
perfObserver.observe({ entryTypes: ["measure", "mark"], buffered: false });

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.some((a) => a === "-h" || a === "--help")) {
    ensureDirsSync();
    const config = loadConfig();
    process.stdout.write(buildHelpText(config));
    return 0;
  }
  if (argv.length > 0) {
    process.stderr.write(`unknown argument: ${argv[0]}\nusage: relevo [--help]\n`);
    return 2;
  }
  if (!process.stdin.isTTY) {
    process.stderr.write(
      "relevo requires an interactive terminal. Use `relevo` in Terminal, or `relevo --help` for usage.\n",
    );
    return 2;
  }

  await ensureDirs();
  cleanupStagedImageCache();
  const config = loadConfig((msg) => process.stderr.write(msg + "\n"));

  const { waitUntilExit } = render(createElement(App, { initialConfig: config }), {
    exitOnCtrlC: false,
  });
  await waitUntilExit();
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`relevo: ${err?.stack || err}\n`);
    process.exit(1);
  },
);
