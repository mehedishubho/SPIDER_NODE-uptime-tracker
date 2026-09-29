import { and, asc, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { isoRow } from "@/lib/serialize";
import { db } from "@/db";
import { incidents, monitors, users } from "@/db/schema";

interface RouteParams {
  params: Promise<{ userId: string }>;
}

// ----------------------------------------------------
// PUBLIC STATUS PAGE DATA (no auth required)
// GET /api/status/[userId]
//
// 07-08 deletion release (DRZ-07): the Prisma-era reads are ported to the
// ONE Drizzle client with identical projections — the { id, name } user row
// (404 when missing), the ACTIVE-only monitor list (createdAt-asc), and the
// 10 newest ONGOING incidents scoped through the monitor relation with the
// monitor { name } projection.
// 07-10 (G-07-63/CR-01): monitor lastChecked and incident
// startedAt/resolvedAt normalize through the ONE serialize seam — ISO-8601
// UTC Z on the wire.
// ----------------------------------------------------
export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { userId } = await params;

    const [user] = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(eq(users.id, userId));

    if (!user) {
      return NextResponse.json({ error: "Page not found" }, { status: 404 });
    }

    const monitorRows = await db
      .select({
        id: monitors.id,
        name: monitors.name,
        url: monitors.url,
        status: monitors.status,
        uptimePercent: monitors.uptimePercent,
        responseTime: monitors.responseTime,
        lastChecked: monitors.lastChecked,
        interval: monitors.interval,
      })
      .from(monitors)
      .where(and(eq(monitors.userId, userId), eq(monitors.isActive, true)))
      .orderBy(asc(monitors.createdAt));

    // The most recent ONGOING incidents across the user's monitors.
    const recentIncidents = await db
      .select({
        id: incidents.id,
        monitorId: incidents.monitorId,
        status: incidents.status,
        description: incidents.description,
        startedAt: incidents.startedAt,
        resolvedAt: incidents.resolvedAt,
        monitor: { name: monitors.name },
      })
      .from(incidents)
      .innerJoin(monitors, eq(incidents.monitorId, monitors.id))
      .where(and(eq(monitors.userId, userId), eq(incidents.status, "ONGOING")))
      .orderBy(desc(incidents.startedAt))
      .limit(10);

    return NextResponse.json(
      {
        user,
        monitors: monitorRows.map((row) => isoRow(row, ["lastChecked"])),
        recentIncidents: recentIncidents.map((row) => isoRow(row, ["startedAt", "resolvedAt"])),
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("Public Status API Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch status data" },
      { status: 500 },
    );
  }
}
