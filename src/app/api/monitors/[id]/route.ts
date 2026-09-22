import { prisma } from "@/lib/prisma";
import { getAuthSession } from "@/lib/session";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { assertUrlAllowed, UrlNotAllowedError } from "@/lib/ssrf";


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

        // 06-03/D-17: findFirst — the compound { id, userId } scope is not a
        // unique lookup, and findUnique cannot express it; the ownership
        // WHERE clause IS the defense.
        const monitor = await prisma.monitor.findFirst({
            where: { id: monitorId, userId: session.user.id }
        });

        if (!monitor) {
            return NextResponse.json({ error: "Monitor not found" }, { status: 404 })
        }

        return NextResponse.json({ monitor }, { status: 200 })
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
        const existingMonitor = await prisma.monitor.findFirst({
            where: { id: monitorId, userId: session.user.id },
        })

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

        const updatedMonitor = await prisma.monitor.update({
            where: { id: monitorId },
            data: updateData,
        });

        return NextResponse.json(
            { message: "Monitor updated successfully", monitor: updatedMonitor },
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

        const existingMonitor = await prisma.monitor.findFirst({
            where: { id: monitorId, userId: session.user.id },
        });

        if (!existingMonitor) {
            return NextResponse.json({ error: 'Monitor not found' }, { status: 404 });
        }

        await prisma.monitor.delete({
            where: { id: monitorId },
        });

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