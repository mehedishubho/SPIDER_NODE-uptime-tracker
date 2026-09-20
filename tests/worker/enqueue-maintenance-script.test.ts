import { spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// enqueue-maintenance.mjs — bounded failure against an unreachable Redis
// (WR-01 / D-15, plan 06-04).
//
// The script is a PRODUCER (it never blocks on the queue), so it must NOT
// keep the worker connection profile (maxRetriesPerRequest: null — commands
// never reject, so queue.add() hangs FOREVER against an unreachable Redis,
// the exact WR-01 defect). The bounded web-producer profile (06-01's
// queue-producer.ts: maxRetriesPerRequest 1, connectTimeout/commandTimeout
// 1 s) rejects in seconds; the rejection maps to a loud non-zero exit.
//
// Pinned by shelling the REAL script against a dead loopback port with a
// hard watchdog: the process must exit non-zero ON ITS OWN — a watchdog
// kill is the failing (RED) outcome. Flags preserved (D-14): --help still
// documents the manual dry-run/apply intent.
// ---------------------------------------------------------------------------

const SCRIPT = path.resolve("scripts/enqueue-maintenance.mjs");
// Nothing listens on loopback :59999 — the refusal is immediate, so the
// bounded profile rejects within seconds while the unbounded one hangs.
const UNREACHABLE_REDIS = "redis://127.0.0.1:59999";

const WATCHDOG_MS = 15_000;

interface ScriptRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
  killedByWatchdog: boolean;
}

function runScript(args: string[], watchdogMs = WATCHDOG_MS): Promise<ScriptRun> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killedByWatchdog = false;
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    const watchdog = setTimeout(() => {
      killedByWatchdog = true;
      child.kill();
    }, watchdogMs);
    child.on("close", (code, signal) => {
      clearTimeout(watchdog);
      resolve({ code, signal, stdout, stderr, elapsedMs: Date.now() - started, killedByWatchdog });
    });
  });
}

describe("enqueue-maintenance.mjs — WR-01/D-15 bounded failure profile", () => {
  it(
    "1. dry-run enqueue against an unreachable Redis exits non-zero ON ITS OWN within the bounded budget",
    async () => {
      const result = await runScript(["--redis", UNREACHABLE_REDIS]);
      expect(result.killedByWatchdog).toBe(false); // NOT killed by the watchdog (the WR-01 hang)
      expect(result.code).not.toBe(0); // fail-LOUD, per the script's own contract
      expect(result.elapsedMs).toBeLessThan(WATCHDOG_MS);
      expect(result.stderr).toContain("enqueue failed");
    },
    30_000
  );

  it(
    "2. --apply against an unreachable Redis is equally bounded and loud (the real-deletes flag never changes failure semantics)",
    async () => {
      const result = await runScript(["--apply", "--redis", UNREACHABLE_REDIS]);
      expect(result.killedByWatchdog).toBe(false);
      expect(result.code).not.toBe(0);
      expect(result.elapsedMs).toBeLessThan(WATCHDOG_MS);
      expect(result.stderr).toContain("enqueue failed");
    },
    30_000
  );

  it(
    "3. flags preserved (D-14): --help exits 0 and still documents the manual dry-run/apply intent",
    async () => {
      const result = await runScript(["--help"]);
      expect(result.killedByWatchdog).toBe(false);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("--apply");
      expect(result.stdout).toContain("--wait");
      expect(result.stdout).toContain("--redis");
    },
    15_000
  );
});
