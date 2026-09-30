import type { JobsOptions } from "bullmq";
import { LANE_PRIORITY } from "@/worker/queues";
import { webQueueProducer, withProducerDeadline } from "@/lib/queue-producer";
import type { EmailPayload } from "./index";

// ---------------------------------------------------------------------------
// The web-side enqueue door for transactional email (D-07/D-08, EML-02).
// Routes render { to, subject, html } at request time and enqueue it here;
// the worker's email lane transports the bytes through the selected
// provider. The web process NEVER opens an SMTP socket — an SMTP outage
// can no longer 500 a request; Redis-down surfaces as a fast add() rejection
// the routes map to a loud 503 (bounded producer profile, D-29).
//
// NO jobId on email jobs, ever (Pitfall 3 — BullMQ 6 rejects colon ids that
// are not exactly 3 segments, twice-learned): auto-generated ids are the
// correct form, and at-least-once redelivery of a verification link is
// harmless. Attempts 5 + backoff { type: "custom" } pair with the worker's
// settings.backoffStrategy table (D-09: 30s/2m/8m/30m/2h, EMAIL_BACKOFF_MS
// in src/worker/queues.ts — the built-in exponential yields 30s/1m/2m/4m/8m
// and fails the D-09 reach, Pitfall 2).
// ---------------------------------------------------------------------------

/** What the enqueue path needs from the email queue (injectable for tests). */
export interface EmailQueueClient {
  add(name: string, data: unknown, opts?: JobsOptions): Promise<unknown>;
}

/**
 * Email job options — the enqueue contract (mirrors the sibling lanes'
 * retention-by-age forms: completed sends age out after 1 h, dead-lettered
 * failures after 14 d like the checks lane's DLQ, WR-06).
 */
export const EMAIL_JOB_OPTIONS = {
  priority: LANE_PRIORITY.email,
  attempts: 5,
  backoff: { type: "custom" },
  removeOnComplete: { age: 3600 },
  removeOnFail: { age: 14 * 24 * 3600 },
} as const;

/**
 * Enqueues one rendered transactional email onto the email lane
 * (QUEUE_NAMES.email via the bounded web producer). Injectable queue for
 * tests — the (opts, deps?) shape of enqueueMaintenance/enqueueManualCheck.
 */
export async function enqueueTransactionalEmail(
  payload: EmailPayload,
  deps: { emailQueue?: EmailQueueClient } = {}
): Promise<{ job: unknown }> {
  const queue = deps.emailQueue ?? webQueueProducer().email;
  // 06-06 gap 2: the add rides the producer-side deadline — a silently
  // unreachable Redis rejects by the bound (the Better Auth hooks'
  // sendVerificationEmail/sendResetPasswordEmail path is bounded through this
  // door; their existing error surfacing is unchanged).
  const job = await withProducerDeadline(queue.add("send", payload, { ...EMAIL_JOB_OPTIONS }));
  return { job };
}
