import { and, eq } from "drizzle-orm";
import { getAuthSession } from "@/lib/session";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { assertUrlAllowed, UrlNotAllowedError } from "@/lib/ssrf";
import { isoRow } from "@/lib/serialize";
import { db } from "@/db";
import { monitors } from "@/db/schema";

// 07-08 deletion release (DRZ-07): the Prisma-era queries are ported to the
// ONE Drizzle client. The 06-03/D-17 ownership scoping (id AND userId in the
// WHERE — findFirst semantics, not a unique lookup) carries over verbatim as
// the compound `and(eq(id), eq(userId))` predicate; the PATCH/DELETE
// pre-checks keep their not-found paths, and the write paths keep Prisma's
// vanished-row behavior (an empty RETURNING maps to the same 500 the Prisma
// P2025 rejection produced).
// 07-10 (G-07-63/CR-01): GET/PATCH response rows normalize their timestamps
// through the ONE serialize seam (ISO-8601 UTC Z — the Prisma-era wire
// contract); the PATCH write rides WR-01 (updatedAt advances) and WR-02 (an
// empty update set is the Prisma-equivalent 200 no-op, never a .set({}) 500).

interface RouteParams {
    params: Promise<{ id: string }>
}

// ----------------------------------------------------
// 1. GET SINGLE MONITOR DETAILS (GET)
// ----------------------------------------------------

export async function GET(req: Request, { params }: RouteParams) {
    try {
        const session = await getAuthSession();
        const { id } = await params;

        if (!session?.user?.id) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        const monitorId = parseInt(id, 10);
        if (isNaN(monitorId)) {
            return NextResponse.json({ error: "Invalid monitor ID" }, { status: 400 });
        }

        // 06-03/D-17: the compound { id, userId } scope is not a unique
        // lookup; the ownership WHERE clause IS the defense.
        const [monitor] = await db
            .select()
            .from(monitors)
            .where(and(eq(monitors.id, monitorId), eq(monitors.userId, session.user.id)))
            .limit(1);

        if (!monitor) {
            return NextResponse.json({ error: "Monitor not found" }, { status: 404 })
        }

        return NextResponse.json(
            { monitor: isoRow(monitor, ["lastChecked", "createdAt", "updatedAt", "nextCheckAt"]) },
            { status: 200 },
        )
    } catch (error) {
        console.error("Get Single Monitor Error:", error);
        return NextResponse.json(
            { error: "Failed to fetch monitor" },
            { status: 500 }
        )
    }
}

// ----------------------------------------------------
// 2. UPDATE MONITOR (PATCH)
// ----------------------------------------------------

export async function PATCH(req: Request, { params }: RouteParams) {
    try {
        const session = await getAuthSession();
        const { id } = await params;

        if (!session?.user?.id) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        const monitorId = parseInt(id, 10);
        if (isNaN(monitorId)) {
            // 06-03/D-17: the old bare `return` surfaced as a 500 over the
            // wire — a descriptive 400 instead.
            return apiError(400, "Invalid monitor ID");
        }

        let body: { name?: string; url?: string; interval?: string; isActive?: boolean } = {};
        try {
            body = await req.json();
        } catch (e) {
            // Ignore JSON parse error if body is empty (manual ping)
        }

        const { name, url, interval, isActive } = body;

        //check if the monitor exists and belong to the user
        const [existingMonitor] = await db
            .select()
            .from(monitors)
            .where(and(eq(monitors.id, monitorId), eq(monitors.userId, session.user.id)))
            .limit(1);

        if (!existingMonitor) {
            return NextResponse.json({ error: "Monitor not found" }, { status: 404 })
        }

        const updateData: { name?: string; url?: string; interval?: number; isActive?: boolean } = {};

        if (name !== undefined) updateData.name = name.trim();
        if (url !== undefined) {
            // 06-03/D-25: url re-validation is CONDITIONAL — only when the
            // request carries a url field. A name/interval-only patch never
            // re-validates the stored URL.
            try {
                new URL(url);
            } catch (_) {
                return NextResponse.json({ error: 'Invalid URL format' }, { status: 400 });
            }
            // SSRF admission (06-03/D-23): DNS-only check on the TRIMMED url —
            // the exact string that gets stored. Target refusals answer 400
            // with the typed message verbatim; infra failures propagate to the
            // catch below → 500 (fail closed).
            try {
                await assertUrlAllowed(url.trim());
            } catch (error) {
                if (error instanceof UrlNotAllowedError) {
                    return apiError(400, error.message);
                }
                throw error;
            }
            updateData.url = url.trim();
        }
        if (interval) updateData.interval = parseInt(interval);
        if (isActive !== undefined) updateData.isActive = Boolean(isActive);

        // WR-02 (07-10): an EMPTY update set is the explicitly-tolerated
        // empty-body shape above ("manual ping"). Drizzle's .set({}) throws
        // ("No values to set" → the catch's 500) where Prisma's
        // update({ data: {} }) was a no-op SUCCESS returning the row — answer
        // the Prisma-equivalent 200 with the existing monitor BEFORE any
        // UPDATE runs. The ownership 404 above already won, and the
        // vanished-row 500 below keeps its semantics for non-empty sets.
        if (Object.keys(updateData).length === 0) {
            return NextResponse.json(
                {
                    message: "Monitor updated successfully",
                    monitor: isoRow(existingMonitor, ["lastChecked", "createdAt", "updatedAt", "nextCheckAt"]),
                },
                { status: 200 }
            );
        }

        const [updatedMonitor] = await db
            .update(monitors)
            // `updatedAt` is supplied explicitly on update (WR-01, 07-10):
            // the column is NOT NULL with no DB default and Prisma's
            // client-side @updatedAt no longer exists — without it every
            // PATCH silently kept the stale value.
            .set({ ...updateData, updatedAt: new Date().toISOString() })
            .where(eq(monitors.id, monitorId))
            .returning();
        if (!updatedMonitor) {
            // The ownership pre-check passed, so this is the vanished-row race
            // only — the exact situation Prisma's P2025 rejection mapped to a
            // 500. Keep the wire contract identical.
            return NextResponse.json({ error: "Failed to update monitor" }, { status: 500 });
        }

        return NextResponse.json(
            {
                message: "Monitor updated successfully",
                monitor: isoRow(updatedMonitor, ["lastChecked", "createdAt", "updatedAt", "nextCheckAt"]),
            },
            { status: 200 }
        );
    } catch (error) {
        console.error("Update Monitor Error:", error);
        return NextResponse.json(
            { error: "Failed to update monitor" },
            { status: 500 }
        )

    }
}


// ----------------------------------------------------
// 3. DELETE MONITOR (DELETE)
// ----------------------------------------------------

export async function DELETE(req: Request, { params }: RouteParams) {
    try {
        const session = await getAuthSession();
        const { id } = await params;

        if (!session?.user?.id) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const monitorId = parseInt(id, 10);
        if (isNaN(monitorId)) {
            // 06-03/D-17: same fix as PATCH — descriptive 400, not a bare return.
            return apiError(400, "Invalid monitor ID");
        }

        const [existingMonitor] = await db
            .select()
            .from(monitors)
            .where(and(eq(monitors.id, monitorId), eq(monitors.userId, session.user.id)))
            .limit(1);

        if (!existingMonitor) {
            return NextResponse.json({ error: 'Monitor not found' }, { status: 404 });
        }

        const deleted = await db
            .delete(monitors)
            .where(eq(monitors.id, monitorId))
            .returning();
        if (deleted.length === 0) {
            // Vanished-row race — Prisma's P2025 mapped to this exact 500.
            return NextResponse.json({ error: 'Failed to delete monitor' }, { status: 500 });
        }

        return NextResponse.json(
            { message: 'Monitor deleted successfully' },
            { status: 200 }
        );
    } catch (error) {
        console.error('Delete Monitor Error:', error);
        return NextResponse.json(
            { error: 'Failed to delete monitor' },
            { status: 500 }
        );
    }
}
