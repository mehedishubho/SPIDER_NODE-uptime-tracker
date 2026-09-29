import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getAuthSession } from "@/lib/session";
import { isoRow } from "@/lib/serialize";
import { db } from "@/db";
import { feedbacks, users } from "@/db/schema";
import { apiError } from "@/lib/api-error";
import { getIP } from "@/lib/rate-limit";

// 07-03 Task 2 (SEC-04 / R17 / D-14 / D-16): GET becomes ADMIN-ONLY — today
// any authenticated user can read every user's name/email (the R17 leak).
// POST stays authenticated-for-all (D-14). The admin gate is the Better Auth
// admin plugin's role primitive (D-13) seeded on users.role (07-01), read
// through the ONE session door (getAuthSession). Every admin-surface hit —
// allowed OR refused — logs ONE structured line (userId, route, IP, timestamp)
// per D-16 (web-side console JSON per the route-file logging convention).
//
// GET's read is the equivalent Drizzle join (07-03), keeping the
// user: { name, email, image } projection shape and the status filter +
// createdAt-desc ordering. 07-08 (deletion release, DRZ-07): POST's create
// leaves Prisma for the ONE Drizzle client — the text PK has no DB default
// (Prisma supplied a client-side cuid), so the insert generates a UUID.
// 07-10 (G-07-63/CR-01): GET rows and the POST returning row normalize
// createdAt/updatedAt through the ONE serialize seam — ISO-8601 UTC Z on
// the wire.

/** D-16: one structured audit line per admin-surface hit (allowed or refused). */
function logAdminSurfaceAccess(userId: string, route: string, ip: string): void {
  console.log(
    JSON.stringify({
      event: "admin_surface_access",
      userId,
      route,
      ip,
      timestamp: new Date().toISOString(),
    })
  );
}

export async function POST(req: NextRequest) {
  try {
    const session = await getAuthSession();
    if (!session || !session.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { type, title, description } = body;

    if (!title || !description || !type) {
      return NextResponse.json(
        { error: "Missing required fields: title, description, and type are required" },
        { status: 400 }
      );
    }

    const [feedback] = await db
      .insert(feedbacks)
      .values({
        id: crypto.randomUUID(),
        userId: session.user.id,
        type,
        title,
        description,
        updatedAt: new Date().toISOString(),
      })
      .returning();

    return NextResponse.json(
      isoRow(feedback, ["createdAt", "updatedAt"]),
      { status: 201 }
    );
  } catch (error) {
    console.error("Failed to create feedback:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  try {
    const session = await getAuthSession();
    if (!session || !session.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // D-16: the audit line fires BEFORE the role decision so refused hits
    // are recorded too.
    logAdminSurfaceAccess(session.user.id, "/api/feedback", getIP(req) ?? "unknown");

    // D-14/R17: the admin gate sits AFTER the 401 — non-admins get 403.
    if (session.user.role !== "admin") {
      return apiError(403, "Forbidden");
    }

    // Optional: Extract status from query parameters to filter
    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status");

    // Drizzle join (07-03): equivalent read preserving the Prisma-era
    // projection shape — each feedback row carries user: { name, email, image }.
    const rows = await db
      .select({
        id: feedbacks.id,
        userId: feedbacks.userId,
        type: feedbacks.type,
        title: feedbacks.title,
        description: feedbacks.description,
        status: feedbacks.status,
        upvotes: feedbacks.upvotes,
        createdAt: feedbacks.createdAt,
        updatedAt: feedbacks.updatedAt,
        user: { name: users.name, email: users.email, image: users.image },
      })
      .from(feedbacks)
      .innerJoin(users, eq(feedbacks.userId, users.id))
      .where(status ? eq(feedbacks.status, status) : undefined)
      .orderBy(desc(feedbacks.createdAt));

    return NextResponse.json(
      rows.map((row) => isoRow(row, ["createdAt", "updatedAt"])),
      { status: 200 },
    );
  } catch (error) {
    console.error("Failed to fetch feedback:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
