import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { rateLimit, getIP } from "@/lib/rate-limit";
import { apiError } from "@/lib/api-error";
import { assertUrlAllowed, UrlNotAllowedError } from "@/lib/ssrf";
// ----------------------------------------------------
// 1. GET ALL MONITORS FOR LOGGED-IN USER (GET)
// ----------------------------------------------------
export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const monitors = await prisma.monitor.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({ monitors }, { status: 200 });
  } catch (error) {
    console.error("Featch Monitors Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch monitors" },
      { status: 500 }
    )
  }
}

// ----------------------------------------------------
// 2. CREATE A NEW MONITOR (POST)
// ----------------------------------------------------

export async function POST(req: Request) {
  try {
    const ip = getIP(req);
    // Max 20 monitor creation attempts per minute per IP
    const { success, remaining } = await rateLimit(`monitors_${ip}`, { limit: 20, windowMs: 60000 });
    if (!success) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers: { "X-RateLimit-Remaining": remaining.toString() } }
      );
    }

    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      // 06-03/D-17: the "Unauthirized" typo fixed WITH its flipped pin.
      return apiError(401, "Unauthorized");
    }

    // Check Monitor Limit
    const currentMonitorsCount = await prisma.monitor.count({
      where: { userId: session.user.id }
    });

    if (currentMonitorsCount >= 10) {
      return NextResponse.json(
        { error: "Monitor limit reached. You can only create up to 10 monitors on the free tier." },
        { status: 403 }
      );
    }

    const body = await req.json();
    const { name, url, interval } = body;

    // Field Validation
    if (!name || !url) {
      return NextResponse.json(
        { error: "Name and URL are required" },
        { status: 400 }
      )
    }

    // URL Format Validation

    try {
      new URL(url);
    } catch (_) {
      return NextResponse.json(
        { error: 'Invalid URL format (e.g., https://example.com)' },
        { status: 400 }
      )
    }

    // SSRF admission (06-03/D-23): DNS-only validation on the TRIMMED url —
    // the exact string that gets stored. Target refusals (private range,
    // forbidden scheme, NXDOMAIN) answer 400 with the typed message verbatim
    // (D-32); infrastructure failures propagate to the catch below → 500 —
    // admission fails closed, never a silent accept.
    try {
      await assertUrlAllowed(url.trim());
    } catch (error) {
      if (error instanceof UrlNotAllowedError) {
        return apiError(400, error.message);
      }
      throw error;
    }

    const newMonitor = await prisma.monitor.create({
      data: {
        name: name.trim(),
        url: url.trim(),
        interval: interval ? parseInt(interval) : 5,
        userId: session.user.id,
        status: "PENDING"
      }
    })

    return NextResponse.json(
      { message: "Monitor listed successfully", monitor: newMonitor },
      { status: 201 }
    )

  } catch (error) {
    console.error("Create Monitor Error", error);
    return apiError(500, "Failed to create monitor");
  }

}