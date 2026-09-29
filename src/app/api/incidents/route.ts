import { desc, eq } from "drizzle-orm";
import { getAuthSession } from "@/lib/session";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { incidents, monitors } from "@/db/schema";

// ----------------------------------------------------
// GET ALL INCIDENTS FOR LOGGED-IN USER
//
// 07-08 deletion release (DRZ-07): the Prisma-era relation-scoped read
// (where.monitor.userId + the monitor { id, name, url, status } include) is
// ported to the equivalent Drizzle join, preserving the projection shape,
// the startedAt-desc ordering, and the take-100 bound.
// ----------------------------------------------------
export async function GET() {
  try {
    const session = await getAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const incidentRows = await db
      .select({
        id: incidents.id,
        monitorId: incidents.monitorId,
        status: incidents.status,
        description: incidents.description,
        startedAt: incidents.startedAt,
        resolvedAt: incidents.resolvedAt,
        monitor: { id: monitors.id, name: monitors.name, url: monitors.url, status: monitors.status },
      })
      .from(incidents)
      .innerJoin(monitors, eq(incidents.monitorId, monitors.id))
      .where(eq(monitors.userId, session.user.id))
      .orderBy(desc(incidents.startedAt))
      .limit(100);

    return NextResponse.json({ incidents: incidentRows }, { status: 200 });
  } catch (error) {
    console.error("Fetch Incidents Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch incidents" },
      { status: 500 },
    );
  }
}
