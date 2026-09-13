import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLogger, jobLogger } from "@/worker/logger";

// ---------------------------------------------------------------------------
// Worker logger suite (OBS-02, D-14): pins the three behaviors every later
// phase-4 lane leans on —
//   1. buildLogger emits PARSEABLE JSON lines to stdout (one object/line)
//   2. child loggers merge monitorId/jobId bindings into EVERY line
//   3. level honors WORKER_LOG_LEVEL (default "info")
//
// pino 10 writes through process.stdout on a pipe, so a write spy captures
// the lines (verified empirically on this platform). No console noise is
// emitted while the spy is active — captured chunks are the ONLY writes.
// ---------------------------------------------------------------------------

/** Captures process.stdout into parsed JSON lines until restored. */
function captureStdoutLines(): { jsonLines: () => Record<string, unknown>[]; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(((chunk: string | Uint8Array, encoding?: unknown, cb?: unknown) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      if (typeof encoding === "function") (encoding as () => void)();
      if (typeof cb === "function") (cb as () => void)();
      return true;
    }) as typeof process.stdout.write);
  return {
    jsonLines: () =>
      chunks
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    restore: () => spy.mockRestore(),
  };
}

const ORIGINAL_LEVEL = process.env.WORKER_LOG_LEVEL;

afterEach(() => {
  if (ORIGINAL_LEVEL === undefined) delete process.env.WORKER_LOG_LEVEL;
  else process.env.WORKER_LOG_LEVEL = ORIGINAL_LEVEL;
  vi.restoreAllMocks();
});

describe("worker logger — pino stdout JSON (OBS-02, D-14)", () => {
  it("1. buildLogger emits parseable JSON lines to stdout carrying level/time/msg", () => {
    const capture = captureStdoutLines();
    try {
      const logger = buildLogger();
      logger.info({ statusCode: 200, responseTimeMs: 42 }, "check complete");
    } finally {
      capture.restore();
    }
    const lines = capture.jsonLines();
    expect(lines.length).toBe(1);
    const line = lines[0];
    expect(line.level).toBe(30); // info
    expect(line.msg).toBe("check complete");
    expect(line.statusCode).toBe(200);
    expect(line.responseTimeMs).toBe(42);
    expect(typeof line.time).toBe("number");
  });

  it("2. child loggers merge monitorId AND jobId bindings into every line they emit", () => {
    const capture = captureStdoutLines();
    try {
      const base = buildLogger();
      const log = jobLogger(base, { monitorId: 42, jobId: "check:42:1700000000" });
      log.info({ statusCode: 500 }, "first line");
      log.warn("second line");
    } finally {
      capture.restore();
    }
    const lines = capture.jsonLines();
    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect(line.monitorId).toBe(42);
      expect(line.jobId).toBe("check:42:1700000000");
    }
    expect(lines[0].statusCode).toBe(500);
  });

  it("3. monitorId-only bindings omit jobId (optional field), and level honors WORKER_LOG_LEVEL", () => {
    const capture = captureStdoutLines();
    try {
      process.env.WORKER_LOG_LEVEL = "debug";
      const debugLogger = buildLogger();
      expect(debugLogger.level).toBe("debug");

      const base = buildLogger();
      const log = jobLogger(base, { monitorId: 7 });
      log.info("no job id line");
    } finally {
      capture.restore();
    }
    const lines = capture.jsonLines();
    expect(lines.length).toBe(1);
    expect(lines[0].monitorId).toBe(7);
    expect(lines[0].jobId).toBeUndefined();
  });

  it("4. default level is info when WORKER_LOG_LEVEL is unset", () => {
    delete process.env.WORKER_LOG_LEVEL;
    expect(buildLogger().level).toBe("info");
  });
});
