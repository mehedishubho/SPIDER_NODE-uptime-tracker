import pino from "pino";

// ---------------------------------------------------------------------------
// Worker structured logging (OBS-02, D-14).
//
// pino JSON lines on STDOUT ONLY — no transports, no file destination (the
// operator redirects to a file on the local stand-in; PM2 captures stdout
// on the future VPS). Level via WORKER_LOG_LEVEL, default "info".
//
// Secrets rule (T-04-03): bindings are restricted to ids/timings/status
// fields — never interpolate connection strings or tokens into a log line.
// Child loggers carry monitorId/jobId so the scheduler -> check -> persist
// -> alert path is correlated end to end.
// ---------------------------------------------------------------------------

/** Builds the worker's base pino logger (stdout JSON, level via env). */
export function buildLogger(): pino.Logger {
  return pino({
    level: process.env.WORKER_LOG_LEVEL ?? "info",
  });
}

/** Correlation fields every lane attaches to its lines (OBS-02). */
export interface JobLogFields {
  monitorId: number | string;
  jobId?: string;
}

/**
 * Child-logger helper: binds monitorId (and jobId when present) into every
 * line the returned logger emits, so one check's full path is greppable by
 * monitorId alone.
 */
export function jobLogger(base: pino.Logger, fields: JobLogFields): pino.Logger {
  const bindings: Record<string, unknown> = { monitorId: fields.monitorId };
  if (fields.jobId !== undefined) bindings.jobId = fields.jobId;
  return base.child(bindings);
}
