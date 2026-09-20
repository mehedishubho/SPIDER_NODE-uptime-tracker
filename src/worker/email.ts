import { UnrecoverableError } from "bullmq";
import type { Logger } from "pino";
import { getEmailProvider } from "@/lib/email";
import type { EmailPayload, EmailProvider } from "@/lib/email";
import { buildLogger } from "./logger";
import { noteEmailFailure, QUEUE_NAMES } from "./queues";
import type { LaneJob } from "./queues";

// ---------------------------------------------------------------------------
// The email-lane processor (06-02 Task 2, EML-02/EML-03). Routes render the
// { to, subject, html } payload at REQUEST time (D-07 render-at-enqueue) and
// the web process enqueues it; this worker-side consumer transports the bytes
// through the env-selected provider (D-11: smtp default, console opt-in) —
// the SMTP socket lives ONLY here, never in a request.
//
// Typed error split (EML-03, research A1 "conservative taxonomy"):
//   PERMANENT -> UnrecoverableError (BullMQ moves the job to the failed set
//               immediately — no retry can fix a bad envelope) + the
//               in-process failure counter (D-10/D-34 metric) + an
//               error-level log line.
//   TRANSIENT -> the ORIGINAL error rethrows; BullMQ retries per D-09's
//               exact table (EMAIL_BACKOFF_MS in queues.ts).
// Only the OBVIOUS permanents dead-letter: EAUTH/EENVELOPE/EMESSAGE and
// responseCode >= 500. Timeouts, socket errors, 4xx and everything unknown
// stay retryable — a false "permanent" silently drops a user's verification
// email, while a false "transient" only burns retries.
// ---------------------------------------------------------------------------

/** The obvious permanents (EML-03 A1) — auth, envelope, and message-shape SMTP failures. */
const PERMANENT_SMTP_CODES = new Set(["EAUTH", "EENVELOPE", "EMESSAGE"]);

/** Is this send error one retry can never fix? (A1: when unsure, NO.) */
export function isPermanentEmailError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (typeof code === "string" && PERMANENT_SMTP_CODES.has(code)) return true;
  const responseCode = (err as { responseCode?: unknown }).responseCode;
  if (typeof responseCode === "number" && responseCode >= 500) return true;
  return false;
}

/** Parses job data into a sendable payload, or null when malformed. */
function parseEmailPayload(data: unknown): EmailPayload | null {
  if (typeof data !== "object" || data === null) return null;
  const { to, subject, html } = data as Record<string, unknown>;
  if (typeof to !== "string" || to === "") return null;
  if (typeof subject !== "string" || subject === "") return null;
  if (typeof html !== "string" || html === "") return null;
  return { to, subject, html };
}

export interface EmailJobDeps {
  /** Overrides the provider (tests inject fakes — never real SMTP). */
  provider?: EmailProvider;
  /** Overrides the logger (structural pino.error subset). */
  logger?: Pick<Logger, "error">;
}

/**
 * Processes one email-lane job: validate the rendered payload, transport it
 * through the provider, and apply the EML-03 typed error split. Returns
 * `{ to, sent: true }` on success.
 */
export async function processEmailJob(
  job: LaneJob,
  deps: EmailJobDeps = {}
): Promise<{ to: string; sent: true }> {
  const logger = deps.logger ?? buildLogger();
  const provider = deps.provider ?? getEmailProvider();

  if (job.name !== "send") {
    // Contract violation — a retry can never fix a job of the wrong shape.
    noteEmailFailure(QUEUE_NAMES.email);
    logger.error(
      { jobId: job.id, jobName: job.name, queueName: QUEUE_NAMES.email },
      "email job name is not 'send' — dead-lettering as malformed (EML-03)"
    );
    throw new UnrecoverableError(`unknown email job name: ${job.name}`);
  }

  const payload = parseEmailPayload(job.data);
  if (!payload) {
    noteEmailFailure(QUEUE_NAMES.email);
    logger.error(
      { jobId: job.id, queueName: QUEUE_NAMES.email },
      "email job payload malformed (needs non-empty to/subject/html) — dead-lettering (EML-03)"
    );
    throw new UnrecoverableError("email job payload must carry non-empty to/subject/html");
  }

  try {
    await provider.send(payload);
  } catch (err) {
    if (isPermanentEmailError(err)) {
      // D-10/D-34: permanent failure is log + metric only — BullMQ's failed
      // set retains the job for DLQ inspection; no user-facing surface.
      noteEmailFailure(QUEUE_NAMES.email);
      logger.error(
        {
          jobId: job.id,
          to: payload.to,
          queueName: QUEUE_NAMES.email,
          err: err instanceof Error ? err.message : String(err),
        },
        "email send PERMANENT failure — dead-lettering (EML-03 / D-10 / D-34)"
      );
      throw new UnrecoverableError(
        `permanent email failure for ${payload.to}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    // Transient (ETIMEOUT/ECONNECTION/ESOCKET/4xx/unknown — A1 default):
    // rethrow the ORIGINAL error so BullMQ schedules the next D-09 retry.
    throw err;
  }
  return { to: payload.to, sent: true };
}
