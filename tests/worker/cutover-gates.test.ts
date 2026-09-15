import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Cutover gate suite (D-14 / WRK-11): proves scripts/gate-cutover.mjs — the
// one typed command that evaluates the 7-gate window checklist (D-13) over
// captured snapshots — against FIXTURE snapshot directories, in
// --offline-fixtures mode: no docker, no network, no DB (the plan's
// prohibition 4). The build-gate.test.ts pattern: execFile the script,
// assert exit codes and named output lines.
//
// Seven gates (D-13):
//   1 heartbeat steady (D-17 — hc.io flips, zero down-flips in window)
//   2 queue health (D-19 — age bound 120 s + depth-0 drain)
//   3 alert parity (D-48 bytes + exactly one relayed alert per incident)
//   4 counter gates (D-02 pings-vs-counters + D-37 recompute drift)
//   5 continuity gap-scan (interval + 120 s tolerance)
//   6 zero duplicate ONGOING incidents
//   7 legacy-path disposition (every observation dispositioned)
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

const GATE_SCRIPT = path.join("scripts", "gate-cutover.mjs");

// A fixed 4 h window (exactly the D-16 minimum — green must hold at the
// boundary). All fixture timestamps derive from these epochs.
const W_START = 1757952000; // 2025-09-15T12:00:00Z
const W_END = W_START + 4 * 3600;
const iso = (epoch: number) => new Date(epoch * 1000).toISOString();

/** One healthy /metrics exposition sample (subset — the families gate 2 parses). */
function expositionSample(opts: { checkAge: number; checkWait: number; checkPrioritized: number }): string {
  return [
    "# HELP spidernode_queue_depth Jobs per BullMQ lane by state",
    "# TYPE spidernode_queue_depth gauge",
    `spidernode_queue_depth{queue="monitor-scheduler",state="wait"} 0`,
    `spidernode_queue_depth{queue="monitor-checks",state="wait"} ${opts.checkWait}`,
    `spidernode_queue_depth{queue="monitor-checks",state="prioritized"} ${opts.checkPrioritized}`,
    `spidernode_queue_depth{queue="monitor-checks",state="delayed"} 0`,
    `spidernode_queue_depth{queue="monitor-checks",state="active"} 3`,
    "# HELP spidernode_queue_oldest_job_age_seconds Age of the oldest pending job per lane",
    "# TYPE spidernode_queue_oldest_job_age_seconds gauge",
    `spidernode_queue_oldest_job_age_seconds{queue="monitor-checks"} ${opts.checkAge}`,
    `spidernode_queue_oldest_job_age_seconds{queue="alerts"} 2`,
    "",
  ].join("\n");
}

/** The green fixture's file set — the snapshot contract 05-06/05-08 produce. */
interface FixtureFiles {
  "samples/sample-0.txt": string;
  "samples/sample-1.txt": string;
  "samples/sample-2.txt": string;
  "recompute-report.json": string;
  "parity-evidence.json": string;
  "flips-heartbeat.json": string;
  "legacy-observations.json": string;
  "disposition.md": string;
  "db-evidence.json": string;
}

function greenFixture(): FixtureFiles {
  return {
    // Sample 0/2 catch transient depth; sample 1 proves the depth-0 drain
    // between claim cycles (D-19). All ages well under the 120 s bound.
    "samples/sample-0.txt": expositionSample({ checkAge: 45, checkWait: 2, checkPrioritized: 1 }),
    "samples/sample-1.txt": expositionSample({ checkAge: 10, checkWait: 0, checkPrioritized: 0 }),
    "samples/sample-2.txt": expositionSample({ checkAge: 30, checkWait: 1, checkPrioritized: 0 }),
    // D-37 dry-run recompute captured during the window: zero discrepancies.
    "recompute-report.json": JSON.stringify(
      { checked: 3, discrepancies: [] },
      null,
      2
    ),
    // D-11 induced-incident relay evidence: relayed bytes match the D-48 pins.
    "parity-evidence.json": JSON.stringify(
      {
        induced: {
          incidentId: "inc-induced-1",
          eventType: "incident.down",
          relayedText: "🔴 Down: example.com is DOWN",
          expectedText: "🔴 Down: example.com is DOWN",
        },
        byteMatch: true,
        extraTransientAlerts: [],
      },
      null,
      2
    ),
    // hc.io flips cache (D-17): only up-flips inside the window.
    "flips-heartbeat.json": JSON.stringify(
      {
        flips: [
          { timestamp: iso(W_START + 90), up: 1 },
          { timestamp: iso(W_START + 3600), up: 1 },
          { timestamp: iso(W_START + 7200), up: 1 },
        ],
      },
      null,
      2
    ),
    // Cron-originated observations captured during the window (gate 7 input).
    "legacy-observations.json": JSON.stringify(
      [
        {
          id: "LO-1",
          kind: "cron-direct-alert",
          observed: "takeover-minute duplicate DOWN alert on monitor 7 (cron direct send)",
        },
      ],
      null,
      2
    ),
    "disposition.md": [
      "# Window dispositions (operator)",
      "",
      "LO-1: expected takeover-minute duplicate, cron direct-send observed once — acknowledged, no action (D-05)",
      "",
    ].join("\n"),
    // The offline stand-in for the gate script's parameterized pg queries —
    // the SAME evidence shape the online queries produce (see script header).
    "db-evidence.json": JSON.stringify(
      {
        parity: {
          incidents: [
            { incidentId: "inc-induced-1", monitorId: 7, downRows: 1, recoveredRows: 1 },
          ],
        },
        counters: [
          { monitorId: 7, intervalSeconds: 300, pingsInWindow: 48, totalCountDelta: 48 },
        ],
        continuity: [
          {
            monitorId: 7,
            intervalSeconds: 300,
            maxGapSeconds: 312,
            pingsInWindow: 48,
            createdInWindow: false,
          },
        ],
        duplicateOngoing: [],
      },
      null,
      2
    ),
  };
}

/** Materialize a fixture snapshot dir; `mutate` tweaks entries (red cases). */
function writeFixture(
  mutate?: (files: FixtureFiles) => void
): string {
  const files = greenFixture();
  mutate?.(files);
  const dir = mkdtempSync(path.join(tmpdir(), "cutover-gates-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return dir;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the gate script in offline-fixture mode with a scrubbed env. */
async function runGate(dir: string, extraArgs: string[] = []): Promise<RunResult> {
  const env = { ...process.env };
  // Gate 1 must be deterministic in tests: never let an ambient operator key
  // turn a missing-flips case into a live hc.io fetch.
  delete env.HC_READ_ONLY_API_KEY;
  delete env.WORKER_HC_PING_URL;
  const result = await execFileAsync(
    "node",
    [GATE_SCRIPT, "--offline-fixtures", "--snapshots", dir, "--start", String(W_START), "--end", String(W_END), ...extraArgs],
    { env }
  ).then(
    (ok: { stdout?: string; stderr?: string }) => ({ code: 0, stdout: ok.stdout ?? "", stderr: ok.stderr ?? "" }),
    (error: NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string }) => ({
      code: Number(error.code) || 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    })
  );
  return result;
}

/** The green-path helper: resolves the success stdout (rejects on non-zero). */
async function runGateStdout(dir: string, extraArgs: string[] = []): Promise<string> {
  const result = await runGate(dir, extraArgs);
  if (result.code !== 0) {
    throw new Error(`gate script exited ${result.code}: ${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

const GATE_LINES = [
  "GATE 1 (heartbeat steady",
  "GATE 2 (queue health",
  "GATE 3 (alert parity",
  "GATE 4 (counter gates",
  "GATE 5 (continuity gap-scan",
  "GATE 6 (duplicate ONGOING",
  "GATE 7 (legacy-path disposition",
] as const;

/** Assert exactly one gate line is FAIL and every other gate is PASS. */
function expectOnlyGateFailed(result: RunResult, gateIndex: number) {
  expect(result.code).not.toBe(0);
  GATE_LINES.forEach((line, index) => {
    if (index === gateIndex) {
      expect(result.stdout).toContain(`${line}): FAIL`);
    } else {
      expect(result.stdout).toContain(`${line}): PASS`);
    }
  });
}

describe("cutover gate evaluator — scripts/gate-cutover.mjs (D-14, WRK-11)", () => {
  it("1. green fixture: all 7 gates PASS and exit code is 0", async () => {
    const dir = writeFixture();
    try {
      const stdout = await runGateStdout(dir);
      for (const line of GATE_LINES) {
        expect(stdout).toContain(`${line}): PASS`);
      }
      expect(stdout).toContain("VERDICT: PASS (7/7)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("2. red gate 1: an up:0 flip inside the window fails only gate 1 (D-17)", async () => {
    const dir = writeFixture((files) => {
      files["flips-heartbeat.json"] = JSON.stringify({
        flips: [
          { timestamp: iso(W_START + 90), up: 1 },
          { timestamp: iso(W_START + 1800), up: 0 },
          { timestamp: iso(W_START + 3600), up: 1 },
        ],
      });
    });
    try {
      expectOnlyGateFailed(await runGate(dir), 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("2b. gate 1 ignores a down flip OUTSIDE the window bounds", async () => {
    const dir = writeFixture((files) => {
      files["flips-heartbeat.json"] = JSON.stringify({
        flips: [
          { timestamp: iso(W_START - 86400), up: 0 }, // yesterday's incident
          { timestamp: iso(W_START + 90), up: 1 },
        ],
      });
    });
    try {
      const stdout = await runGateStdout(dir);
      expect(stdout).toContain("GATE 1 (heartbeat steady): PASS");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("3. red gate 2a: a check-lane job older than 120 s fails only gate 2 (D-19)", async () => {
    const dir = writeFixture((files) => {
      files["samples/sample-1.txt"] = expositionSample({ checkAge: 150, checkWait: 0, checkPrioritized: 0 });
    });
    try {
      const result = await runGate(dir);
      expectOnlyGateFailed(result, 1);
      expect(result.stdout).toContain("150");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("3b. red gate 2b: depth never returning to 0 fails only gate 2 (D-19 drain)", async () => {
    const dir = writeFixture((files) => {
      files["samples/sample-1.txt"] = expositionSample({ checkAge: 20, checkWait: 0, checkPrioritized: 2 });
    });
    try {
      expectOnlyGateFailed(await runGate(dir), 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("4. red gate 3: a duplicate relayed alert per incident fails only gate 3", async () => {
    const dir = writeFixture((files) => {
      files["db-evidence.json"] = JSON.stringify({
        parity: {
          incidents: [
            { incidentId: "inc-induced-1", monitorId: 7, downRows: 2, recoveredRows: 0 },
          ],
        },
        counters: [
          { monitorId: 7, intervalSeconds: 300, pingsInWindow: 48, totalCountDelta: 48 },
        ],
        continuity: [
          { monitorId: 7, intervalSeconds: 300, maxGapSeconds: 312, pingsInWindow: 48, createdInWindow: false },
        ],
        duplicateOngoing: [],
      });
    });
    try {
      expectOnlyGateFailed(await runGate(dir), 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("4b. red gate 3: relayed bytes disagreeing with the D-48 pins fails only gate 3", async () => {
    const dir = writeFixture((files) => {
      const parity = JSON.parse(files["parity-evidence.json"]);
      parity.induced.relayedText = "🔴 Down: example.com is DOWN "; // trailing space = byte drift
      parity.byteMatch = false;
      files["parity-evidence.json"] = JSON.stringify(parity, null, 2);
    });
    try {
      const result = await runGate(dir);
      expectOnlyGateFailed(result, 2);
      expect(result.stdout).toContain("byteMatch");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("5. red gate 4: D-02 blind spot — pings vs total_count delta disagree while the recompute stays clean", async () => {
    const dir = writeFixture((files) => {
      // uptime_percent stays SELF-CONSISTENT (recompute-report.json has zero
      // discrepancies) — only the pings-vs-counters reconcile sees the
      // clobbered counter (05-CONTEXT D-02, research Pitfall 2).
      files["db-evidence.json"] = JSON.stringify({
        parity: {
          incidents: [
            { incidentId: "inc-induced-1", monitorId: 7, downRows: 1, recoveredRows: 1 },
          ],
        },
        counters: [
          { monitorId: 7, intervalSeconds: 300, pingsInWindow: 40, totalCountDelta: 48 },
        ],
        continuity: [
          { monitorId: 7, intervalSeconds: 300, maxGapSeconds: 312, pingsInWindow: 40, createdInWindow: false },
        ],
        duplicateOngoing: [],
      });
    });
    try {
      const result = await runGate(dir);
      expectOnlyGateFailed(result, 3);
      expect(result.stdout).toContain("D-02");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("5b. red gate 4: a non-zero D-37 recompute drift fails only gate 4", async () => {
    const dir = writeFixture((files) => {
      files["recompute-report.json"] = JSON.stringify(
        {
          checked: 3,
          discrepancies: [
            { monitorId: 7, stored: 98.76, derived: 97.92, delta: 0.84 },
          ],
        },
        null,
        2
      );
    });
    try {
      const result = await runGate(dir);
      expectOnlyGateFailed(result, 3);
      expect(result.stdout).toContain("D-37");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("6. red gate 5: a per-monitor ping gap over interval + 120 s fails only gate 5", async () => {
    const dir = writeFixture((files) => {
      files["db-evidence.json"] = JSON.stringify({
        parity: {
          incidents: [
            { incidentId: "inc-induced-1", monitorId: 7, downRows: 1, recoveredRows: 1 },
          ],
        },
        counters: [
          { monitorId: 7, intervalSeconds: 300, pingsInWindow: 48, totalCountDelta: 48 },
        ],
        continuity: [
          // 600 s gap with a 300 s interval — 180 s over the tolerance.
          { monitorId: 7, intervalSeconds: 300, maxGapSeconds: 600, pingsInWindow: 48, createdInWindow: false },
        ],
        duplicateOngoing: [],
      });
    });
    try {
      const result = await runGate(dir);
      expectOnlyGateFailed(result, 4);
      expect(result.stdout).toContain("600");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("7. red gate 6: a duplicate ONGOING incident per monitor fails only gate 6", async () => {
    const dir = writeFixture((files) => {
      files["db-evidence.json"] = JSON.stringify({
        parity: {
          incidents: [
            { incidentId: "inc-induced-1", monitorId: 7, downRows: 1, recoveredRows: 1 },
          ],
        },
        counters: [
          { monitorId: 7, intervalSeconds: 300, pingsInWindow: 48, totalCountDelta: 48 },
        ],
        continuity: [
          { monitorId: 7, intervalSeconds: 300, maxGapSeconds: 312, pingsInWindow: 48, createdInWindow: false },
        ],
        duplicateOngoing: [{ monitorId: 7, ongoing: 2 }],
      });
    });
    try {
      const result = await runGate(dir);
      expectOnlyGateFailed(result, 5);
      expect(result.stdout).toContain("monitor 7");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("8. red gate 7: a legacy-path observation with no disposition entry fails only gate 7", async () => {
    const dir = writeFixture((files) => {
      files["legacy-observations.json"] = JSON.stringify(
        [
          {
            id: "LO-1",
            kind: "cron-direct-alert",
            observed: "takeover-minute duplicate DOWN alert on monitor 7 (cron direct send)",
          },
          {
            id: "LO-2",
            kind: "cron-counter-clobber",
            observed: "legacy batcher read-modify-write raced a Tier-2 flush on monitor 9",
          },
        ],
        null,
        2
      );
      // disposition.md still only carries the LO-1 line.
    });
    try {
      const result = await runGate(dir);
      expectOnlyGateFailed(result, 6);
      expect(result.stdout).toContain("LO-2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("9. sub-4h window: immediate FAIL with the D-16 clock-reset reason BEFORE any gate runs", async () => {
    const dir = writeFixture();
    try {
      const env = { ...process.env };
      delete env.HC_READ_ONLY_API_KEY;
      delete env.WORKER_HC_PING_URL;
      const error = await execFileAsync(
        "node",
        [
          GATE_SCRIPT,
          "--offline-fixtures",
          "--snapshots",
          dir,
          "--start",
          String(W_START),
          "--end",
          String(W_START + 3 * 3600), // 3 h — under the 14400 s minimum
        ],
        { env }
      ).then(
        () => null,
        (error: NodeJS.ErrnoException & { code?: number | string; stdout?: string }) => error
      );
      expect(error).not.toBeNull();
      expect(Number(error!.code)).not.toBe(0);
      const out = error!.stdout ?? "";
      expect(out).toContain("14400");
      expect(out).toContain("D-16");
      // No gate may run across an interruption gap — not one gate line.
      for (const line of GATE_LINES) {
        expect(out).not.toContain(line);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("10. evidence writer: appends a markdown block with per-gate verdicts to the record path", async () => {
    const dir = writeFixture();
    const recordDir = mkdtempSync(path.join(tmpdir(), "cutover-record-"));
    const recordPath = path.join(recordDir, "05-DEPLOY-RECORD.md");
    try {
      const stdout = await runGateStdout(dir, ["--record", recordPath]);
      expect(stdout).toContain("recorded"); // confirmation the block was written
      expect(existsSync(recordPath)).toBe(true);
      const record = readFileSync(recordPath, "utf8");
      expect(record).toContain("Cutover gate evaluation");
      expect(record).toContain("PASS (7/7)");
      for (const line of GATE_LINES) {
        expect(record).toContain(`${line}): PASS`); // per-gate verdicts, verbatim
      }
      expect(record).toContain(iso(W_START));
      // T-05-05-01: evidence carries verdicts and counts — never keys or URLs.
      expect(record).not.toContain("hc-ping.com");
      expect(record).not.toContain("X-Api-Key");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(recordDir, { recursive: true, force: true });
    }
  });

  it("11. online mode with an unreachable DB degrades gates 3-6 to FAIL-with-reason (never crash)", async () => {
    const dir = writeFixture((files) => {
      // No db-evidence.json: online mode queries the (unreachable) DB.
      delete (files as unknown as Record<string, string | undefined>)["db-evidence.json"];
    });
    const recordDir = mkdtempSync(path.join(tmpdir(), "cutover-record-"));
    try {
      const env = { ...process.env };
      delete env.HC_READ_ONLY_API_KEY;
      delete env.WORKER_HC_PING_URL;
      const error = await execFileAsync(
        "node",
        [
          GATE_SCRIPT,
          "--snapshots",
          dir,
          "--start",
          String(W_START),
          "--end",
          String(W_END),
          "--record",
          path.join(recordDir, "record.md"), // keep the default repo record out of the test
          "--db",
          "postgresql://127.0.0.1:1/gate-unreachable", // nothing listens on port 1
        ],
        { env }
      ).then(
        () => null,
        (error: NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string }) => error
      );
      expect(error).not.toBeNull();
      expect(Number(error!.code)).not.toBe(0);
      const out = error!.stdout ?? "";
      // Degrade, never crash: every DB-backed gate FAILs with a reason; the
      // snapshot-driven gates (1, 2, 7) still evaluate and pass.
      expect(out).toContain("GATE 1 (heartbeat steady): PASS");
      expect(out).toContain("GATE 2 (queue health): PASS");
      expect(out).toContain("GATE 7 (legacy-path disposition): PASS");
      for (const gate of ["GATE 3", "GATE 4", "GATE 5", "GATE 6"]) {
        expect(out).toContain(gate);
      }
      expect(out).toContain("database");
      expect(out.toLowerCase()).not.toContain("throw");
      expect((error!.stderr ?? "")).not.toContain("Error:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(recordDir, { recursive: true, force: true });
    }
  });

  it("12. --help prints usage and exits 0 without touching network or DB", async () => {
    const { stdout } = await execFileAsync("node", [GATE_SCRIPT, "--help"]);
    expect(stdout).toContain("Usage");
    expect(stdout).toContain("--snapshots");
    expect(stdout).toContain("--offline-fixtures");
  });

  it("13. rejects non-integer window bounds at entry (V5 input validation, T-05-05-02)", async () => {
    const dir = writeFixture();
    try {
      const env = { ...process.env };
      const error = await execFileAsync(
        "node",
        [GATE_SCRIPT, "--offline-fixtures", "--snapshots", dir, "--start", "not-a-number", "--end", String(W_END)],
        { env }
      ).then(
        () => null,
        (error: NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string }) => error
      );
      expect(error).not.toBeNull();
      expect(Number(error!.code)).not.toBe(0);
      // The usage error must state the integer-epochs contract (fail loud,
      // not a generic crash — also keeps this case honest against a missing
      // script, whose stack trace never says "integer").
      expect(`${error!.stdout ?? ""}${error!.stderr ?? ""}`).toContain("integer");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
