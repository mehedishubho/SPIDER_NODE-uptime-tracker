import { and, asc, eq } from "drizzle-orm";
import { getAuthSession } from "@/lib/session";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { monitors, users } from "@/db/schema";

// ----------------------------------------------------
// PUBLIC STATUS DATA — for the logged-in user's status page
// GET /api/status — returns all monitors (no auth needed)
// But we need a userId to scope it. We use a slug/userId approach.
//
// 07-08 deletion release (DRZ-07): the Prisma-era reads are ported to the
// ONE Drizzle client with identical projections — the { id, name } user row
// (null when missing, as Prisma's findUnique returned) and the ACTIVE-only
// monitor list with the status-page select shape, createdAt-asc.
// ----------------------------------------------------
export async function GET() {
  try {
    const session = await getAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [user] = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(eq(users.id, session.user.id));

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
      .where(and(eq(monitors.userId, session.user.id), eq(monitors.isActive, true)))
      .orderBy(asc(monitors.createdAt));

    return NextResponse.json({ user: user ?? null, monitors: monitorRows }, { status: 200 });
  } catch (error) {
    console.error("Status API Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch status data" },
      { status: 500 },
    );
  }
}
