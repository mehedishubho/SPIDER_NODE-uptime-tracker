#!/usr/bin/env node
// scrape-metrics.mjs — the D-27 THROWAWAY window scraper. Polls the worker's
// loopback /metrics endpoint on an interval through the overlap window,
// writing one timestamped sample file per scrape plus a running summary.md —
// exactly the samples/*.txt layout gate-cutover.mjs --snapshots expects
// (gate 2 parses the spidernode_queue_* families from these files). The
// snapshot dir this script produces IS the window's evidence set.
//
// THROWAWAY (D-27): deleted or archived after cutover — do not build on it.
// Dashboards and persistent scraping are deferred to the VPS era (D-28);
// this file + the evidence block in 05-DEPLOY-RECORD.md are Phase 5's whole
// consumption story.
//
// Pitfall 5: /metrics is loopback-bound (127.0.0.1) by design — run this on
// the same machine as the worker and do NOT "fix" a connection refusal by
// rebinding the health server to a wider interface.
//
// Fail-loud contract: after --max-consecutive-failures refused/failed
// scrapes the script exits non-zero — a dead worker must never silently
// produce an empty evidence set. SIGINT/SIGTERM close the current sample
// cleanly (summary flushed, partial bodies discarded) and exit 0.
//
// Main guard: the poll loop starts ONLY when this module is the Node entry
// point (import.meta.url vs resolved argv[1], tolerating relative
// invocation) or when --run is passed explicitly — a bare import() resolves
// the exports below and starts nothing (the verify step depends on this).
//
// Usage: node scripts/scrape-metrics.mjs [--url URL] [--interval SECONDS]
//            [--out DIR] [--max-consecutive-failures N] [--run]
//   --url      default http://127.0.0.1:${WORKER_HEALTH_PORT:-9090}/metrics
//   --interval scrape interval in seconds (default 15)
//   --out      snapshot dir (default .snapshots/gates-<run-timestamp>/)
//   --max-consecutive-failures  bail-out threshold (default 3)
//
// Zero dependencies: node:* + global fetch only.

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SCRIPT_NAME = "scrape-metrics.mjs";
const DEFAULT_PORT = 9090;
const DEFAULT_INTERVAL_SECONDS = 15;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

/** The loopback /metrics URL; WORKER_HEALTH_PORT overrides the port. */
export function defaultMetricsUrl(env = process.env) {
  const port = env.WORKER_HEALTH_PORT ? Number(env.WORKER_HEALTH_PORT) : DEFAULT_PORT;
  return `http://127.0.0.1:${port}/metrics`;
}

function usage() {
  return [
    `Usage: node scripts/${SCRIPT_NAME} [--url URL] [--interval SECONDS] [--out DIR]`,
    "            [--max-consecutive-failures N] [--run]",
    "",
    "THROWAWAY (D-27) window scraper: polls the worker's loopback /metrics and",
    "writes samples/sample-<n>.txt + summary.md into --out — the snapshot dir",
    "gate-cutover.mjs consumes. Deleted/archived after cutover; dashboards",
    "deferred to the VPS era (D-28). Loopback only (Pitfall 5).",
    "",
    "  --url                       default http://127.0.0.1:9090/metrics",
    "                              (port from WORKER_HEALTH_PORT)",
    "  --interval SECONDS          poll interval (default 15)",
    "  --out DIR                   snapshot dir (default .snapshots/gates-<ts>/)",
    "  --max-consecutive-failures  fail-loud bail-out (default 3)",
    "  --run                       start even when not the entry point",
    "  --help                      this usage text",
  ].join("\n");
}

/** CLI parse (flag vs --key value) — exported for the bare-import contract. */
export function parseArgs(argv) {
  const args = { flags: new Set(), values: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "--run") {
      args.flags.add(arg.slice(2));
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument "${arg}"`);
    }
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${key} requires a value`);
    }
    args.values[key] = value;
    i++;
  }
  return args;
}

/** One scrape attempt (exported for the bare-import contract). */
export async function scrapeOnce(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    const body = await response.text();
    return { ok: true, body };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function writeSample(outDir, index, body, epochMs) {
  const file = path.join(outDir, "samples", `sample-${index}.txt`);
  // First line is a # comment the Prometheus parser (and any human) reads;
  // the gate script ignores comment lines by format.
  const content = `# scraped_at ${new Date(epochMs).toISOString()} (${epochMs})\n${body}`;
  appendFileSync(file, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  return file;
}

function appendSummary(outDir, line) {
  appendFileSync(path.join(outDir, "summary.md"), `${line}\n`, "utf8");
}

/** Entry-point detection (import.meta.url vs resolved argv[1]). */
function isEntryPoint() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    const resolved = pathToFileURL(path.resolve(argv1)).href;
    const same = process.platform === "win32"
      ? resolved.toLowerCase() === import.meta.url.toLowerCase()
      : resolved === import.meta.url;
    return same;
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has("help")) {
    console.log(usage());
    return;
  }

  const url = args.values.url ?? defaultMetricsUrl();
  const intervalMs = Math.max(100, Number(args.values.interval ?? DEFAULT_INTERVAL_SECONDS) * 1000);
  const maxFailures = Number(
    args.values["max-consecutive-failures"] ?? DEFAULT_MAX_CONSECUTIVE_FAILURES
  );
  if (!Number.isFinite(intervalMs) || !Number.isFinite(maxFailures) || maxFailures < 1) {
    throw new Error("--interval and --max-consecutive-failures must be positive numbers");
  }
  const runStamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const outDir = args.values.out ?? path.join(".snapshots", `gates-${runStamp}`);

  mkdirSync(path.join(outDir, "samples"), { recursive: true });
  if (!existsSync(path.join(outDir, "summary.md"))) {
    appendSummary(outDir, `# Scrape run ${new Date().toISOString()} — url ${url}, interval ${intervalMs / 1000} s (D-27 throwaway)`);
  }
  console.log(`[${SCRIPT_NAME}] scraping ${url} every ${intervalMs / 1000} s -> ${path.join(outDir, "samples")}`);

  let sampleIndex = 0;
  let consecutiveFailures = 0;
  let stopped = false;
  let stopping = false;

  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    stopped = true;
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (!stopped) {
    const scrapedAt = Date.now();
    const attempt = sampleIndex;
    const result = await scrapeOnce(url);
    if (result.ok) {
      const file = writeSample(outDir, attempt, result.body, scrapedAt);
      const bytes = Buffer.byteLength(result.body, "utf8");
      appendSummary(outDir, `| ${attempt} | ${new Date(scrapedAt).toISOString()} | ok | ${bytes} bytes | ${path.basename(file)} |`);
      console.log(`[${SCRIPT_NAME}] sample ${attempt} ok (${bytes} bytes)`);
      sampleIndex += 1;
      consecutiveFailures = 0;
    } else {
      appendSummary(outDir, `| ${attempt} | ${new Date(scrapedAt).toISOString()} | FAILED | ${result.error} |`);
      console.error(`[${SCRIPT_NAME}] sample ${attempt} FAILED: ${result.error}`);
      consecutiveFailures += 1;
      if (consecutiveFailures >= maxFailures) {
        appendSummary(outDir, `\nABORTED: ${consecutiveFailures} consecutive scrape failure(s) — worker/metrics endpoint not answering (fail loud, D-27).`);
        console.error(
          `[${SCRIPT_NAME}] FAIL: ${consecutiveFailures} consecutive scrape failure(s) — the worker is not answering on ${url}; ` +
            "an empty evidence set must not stand (Pitfall 5: scrape co-located, loopback only)."
        );
        process.exit(1);
      }
    }
    // Sleep the interval, waking early-ish on stop signals (the in-flight
    // scrape above always completes first — a sample is never truncated).
    const deadline = Date.now() + intervalMs;
    while (!stopped && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(200, deadline - Date.now())));
    }
  }

  appendSummary(outDir, `\nStopped by signal after ${sampleIndex} sample(s) at ${new Date().toISOString()}.`);
  console.log(`[${SCRIPT_NAME}] stopped by signal after ${sampleIndex} sample(s); summary: ${path.join(outDir, "summary.md")}`);
  process.exit(0);
}

// The main guard: only the entry point (or an explicit --run) polls. A bare
// import() of this module resolves the exports and touches nothing.
if (isEntryPoint() || process.argv.slice(2).includes("--run")) {
  try {
    await main();
  } catch (error) {
    console.error(`[${SCRIPT_NAME}] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
