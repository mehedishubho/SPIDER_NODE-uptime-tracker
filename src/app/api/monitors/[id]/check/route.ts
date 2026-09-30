import { and, eq, sql } from "drizzle-orm";
import { getAuthSession } from "@/lib/session";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { rateLimit } from "@/lib/rate-limit";
import { webQueueProducer, withProducerDeadline } from "@/lib/queue-producer";
import { db } from "@/db";
import { monitors } from "@/db/schema";
import { enqueueManualCheck } from "@/worker/queues";

// ---------------------------------------------------------------------------
// Manual check = ENQUEUE (API-01, rules 4-6): this route NEVER dials the
// monitor target. Admission ladder -> one-interval next_check_at advance ->
// priority-1 job on the checks lane -> 202 { jobId, queuedAt }; the client
// polls the monitor read until lastChecked advances past queuedAt (D-01).
// ---------------------------------------------------------------------------

interface RouteParams {
    params: Promise<{ id: string }>
}

export async function POST(req: Request, { params }: RouteParams) {
    try {
        const session = await getAuthSession();
        const { id } = await params;

        if (!session?.user?.id) {
            return apiError(401, "Unauthorized");
        }

        const monitorId = parseInt(id, 10);
        if (isNaN(monitorId)) {
            return apiError(400, "Invalid monitor ID");
        }

        // Ownership scoping IS the defense (D-17 form): a foreign id resolves
        // to not-found, never to a readable distinction. (07-08: the Prisma
        // findFirst became the equivalent compound-predicate Drizzle select.)
        const [monitor] = await db
            .select()
            .from(monitors)
            .where(and(eq(monitors.id, monitorId), eq(monitors.userId, session.user.id)))
            .limit(1);

        if (!monitor) {
            return apiError(404, "Monitor not found or unauthorized");
        }

        // D-28: mirror the legacy force-path admission for inactive monitors —
        // the old in-request engine filtered isActive:false out of its force
        // query and the route still answered a success-shaped 200 with an
        // empty result. Zero new policy in a modernization phase: no enqueue,
        // and the limiter is never consumed for a paused monitor.
        if (!monitor.isActive) {
            return NextResponse.json(
                { message: "Monitor checked successfully", result: [] },
                { status: 200 }
            );
        }

        // SEC-05 / D-06: the two ratified manual-check buckets — one check per
        // monitor per 30s, six checks per user per minute. Identifiers carry
        // the bucket name; rateLimit prefixes the shared rl: keyspace.
        const perMonitor = await rateLimit(
            `manual_${session.user.id}_${monitorId}`,
            { limit: 1, windowMs: 30_000 },
        );
        const perUser = await rateLimit(
            `manual-user_${session.user.id}`,
            { limit: 6, windowMs: 60_000 },
        );
        const blocked = !perMonitor.success
            ? perMonitor
            : !perUser.success
                ? perUser
                : null;
        if (blocked) {
            return NextResponse.json(
                { error: "You're checking too often — try again shortly." },
                { status: 429, headers: { "Retry-After": String(blocked.resetSeconds ?? 0) } },
            );
        }

        // Pitfall 8 (01-08): advance next_check_at one interval AT ENQUEUE so
        // a scheduler tick firing while the manual job is in flight cannot
        // double-claim the monitor. The GREATEST-capped one-interval form
        // mirrors src/worker/claim.ts (D-50 catch-up-safe advance) over the
        // shared web pool via the src/db drizzle client. Ownership + isActive
        // are restated in the WHERE: a row that vanished, moved, or paused
        // between the read and this UPDATE claims nothing -> 404.
        //
        // 06-06 gap 1 (VERIFICATION truth 12): the advance CAPTURES the
        // pre-advance value via a prior CTE — RETURNING cannot see pre-update
        // values on this Postgres, so the CTE reference is the capture
        // mechanism. On success the capture is simply unused; on an enqueue
        // failure the catch below restores it so a failed request never
        // silently postpones the monitor's next scheduled check.
        const advanced = await db.execute(sql`
            WITH prior AS (
                SELECT m.id, m.next_check_at
                  FROM monitors m
                 WHERE m.id = ${monitorId}
                   AND m."userId" = ${session.user.id}
                   AND m."isActive"
                   FOR UPDATE
            )
            UPDATE monitors m
               SET next_check_at = GREATEST(
                    now() + (m.interval * interval '1 minute'),
                    prior.next_check_at + (m.interval * interval '1 minute')
                   )
              FROM prior
             WHERE m.id = prior.id
            RETURNING m.id, prior.next_check_at AS prior_next_check_at, m.next_check_at AS advanced_next_check_at
        `);
        const claimedRows = advanced.rows as Array<{
            id: number;
            prior_next_check_at: Date | string;
            advanced_next_check_at: Date | string;
        }>;
        if (claimedRows.length === 0) {
            return apiError(404, "Monitor not found or unauthorized");
        }
        const { prior_next_check_at: priorNextCheckAt, advanced_next_check_at: advancedNextCheckAt } =
            claimedRows[0];

        // D-05: queuedAt is captured BEFORE the enqueue call — the client's
        // poll completion test (lastChecked > queuedAt) must bound the job,
        // not the response write.
        const queuedAt = Date.now();
        try {
            // 06-06 gap 2: the enqueue rides the producer-side deadline —
            // the wrap bounds the await so a SILENTLY-unreachable
            // Redis (firewall drop: neither resolve nor reject) still answers
            // in bounded time instead of hanging the request forever.
            const { jobId } = await withProducerDeadline(
                enqueueManualCheck(monitorId, {
                    checksQueue: webQueueProducer().checks,
                }),
            );
            return NextResponse.json({ jobId, queuedAt }, { status: 202 });
        } catch (error) {
            // API-02: every enqueue-path failure maps to a LOUD 503 —
            // BreakerOpenError (the Postgres breaker's enqueue-side refusal;
            // inert in the web process today but correct if ever wired), any
            // add() rejection, and ProducerDeadlineError (the 3s silent-mode
            // backstop): the bounded producer profile (maxRetriesPerRequest
            // 1, 1s connect/command timeouts) rejects FAST when Redis is
            // unreachable, and the deadline catches the never-settling mode —
            // never a hang, never a silent no-op. Tradeoff: when the deadline
            // fires but the underlying add() later succeeds (Redis recovering
            // mid-flight), the late job may still run once — bounded by the
            // per-enqueue-unique jobId (check-manual:{id}:{epochMs}) and
            // Tier-1 dedup (DAT-04 evidence-only duplicate); fail-loud with a
            // possible late delivery strictly beats an indefinite hang.
            console.error("Check Monitor Error:", error);
            // 06-06 gap 1 (VERIFICATION truth 12): the advance above already
            // committed, and src/worker/claim.ts claims on
            // `next_check_at IS NULL OR next_check_at <= now()` — leaving the
            // advanced value standing would silently postpone the monitor's
            // next scheduled check by up to one interval per failed attempt
            // (the GREATEST form compounds on 503-invited retries).
            // Compensate BEFORE answering 503: restore the captured
            // pre-advance value, guarded so a concurrent writer that has
            // since moved the row is NEVER clobbered — the WHERE restates
            // ownership (id + userId) AND requires next_check_at to still
            // equal THIS request's advanced value; a foreign, moved, or
            // concurrently-written row matches zero rows and stands.
            //
            // Envelope alternatives considered and REJECTED (06-VERIFICATION
            // gap 1 — both reopen the in-flight double-claim window the
            // Pitfall 8 ordering closes):
            //  (a) enqueue-before-advance reorder — breaks the pinned
            //      advance-before-enqueue ordering, letting a scheduler tick
            //      claim the monitor while the manual job is in flight;
            //  (b) one Postgres transaction spanning the Redis enqueue — a
            //      commit-after-enqueue failure leaves an enqueued job with
            //      an UN-advanced next_check_at (the same double-claim
            //      window, inverted) and holds a web-pool transaction across
            //      Redis I/O. Compensation keeps the pinned ordering intact.
            try {
                const restored = await db.execute(sql`
                    UPDATE monitors
                       SET next_check_at = ${priorNextCheckAt}
                     WHERE id = ${monitorId}
                       AND "userId" = ${session.user.id}
                       AND next_check_at = ${advancedNextCheckAt}
                    RETURNING id
                `);
                const restoredCount = (restored.rows as Array<{ id: number }>).length;
                const priorLabel =
                    priorNextCheckAt instanceof Date
                        ? priorNextCheckAt.toISOString()
                        : String(priorNextCheckAt);
                console.error(
                    `[check-route-compensate] monitorId=${monitorId} ` +
                        (restoredCount > 0
                            ? `restored next_check_at to its pre-advance value (prior=${priorLabel})`
                            : "guard miss — a concurrent writer moved the row; their value stands"),
                );
            } catch (restoreError) {
                // The restore is compensation, never a NEW failure mode: log
                // loudly with its own marker + message (never the Redis URL —
                // message only, producer error-listener convention), and the
                // 503 below still answers. A failed restore leaves the
                // advanced slot in place — self-healing at that slot, never a
                // silent success.
                console.error(
                    "[check-route-compensate] compensating restore itself failed:",
                    restoreError instanceof Error ? restoreError.message : restoreError,
                );
            }
            return apiError(503, "Service temporarily unavailable — try again shortly");
        }
    } catch (error) {
        console.error("Check Monitor Error:", error);
        return NextResponse.json(
            { error: "Failed to check monitor" },
            { status: 500 }
        );
    }
}
