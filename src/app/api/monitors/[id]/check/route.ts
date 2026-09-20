import { sql } from "drizzle-orm";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { rateLimit } from "@/lib/rate-limit";
import { webQueueProducer } from "@/lib/queue-producer";
import { db } from "@/db";
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
        const session = await getServerSession(authOptions);
        const { id } = await params;

        if (!session?.user?.id) {
            return apiError(401, "Unauthorized");
        }

        const monitorId = parseInt(id, 10);
        if (isNaN(monitorId)) {
            return apiError(400, "Invalid monitor ID");
        }

        // Ownership scoping IS the defense (D-17 form): a foreign id resolves
        // to not-found, never to a readable distinction.
        const monitor = await prisma.monitor.findFirst({ where: { id: monitorId, userId: session.user.id } });

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
        const advanced = await db.execute(sql`
            UPDATE monitors m
               SET next_check_at = GREATEST(
                    now() + (m.interval * interval '1 minute'),
                    m.next_check_at + (m.interval * interval '1 minute')
                   )
             WHERE m.id = ${monitorId}
               AND m."userId" = ${session.user.id}
               AND m."isActive"
            RETURNING m.id
        `);
        const claimedRows = advanced.rows as Array<{ id: number }>;
        if (claimedRows.length === 0) {
            return apiError(404, "Monitor not found or unauthorized");
        }

        // D-05: queuedAt is captured BEFORE the enqueue call — the client's
        // poll completion test (lastChecked > queuedAt) must bound the job,
        // not the response write.
        const queuedAt = Date.now();
        try {
            const { jobId } = await enqueueManualCheck(monitorId, {
                checksQueue: webQueueProducer().checks,
            });
            return NextResponse.json({ jobId, queuedAt }, { status: 202 });
        } catch (error) {
            // API-02: every enqueue-path failure maps to a LOUD 503 —
            // BreakerOpenError (the Postgres breaker's enqueue-side refusal;
            // inert in the web process today but correct if ever wired) and
            // any add() rejection: the bounded producer profile
            // (maxRetriesPerRequest 1, 1s connect/command timeouts) rejects
            // FAST when Redis is unreachable instead of hanging the request
            // or silently no-op'ing.
            console.error("Check Monitor Error:", error);
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
