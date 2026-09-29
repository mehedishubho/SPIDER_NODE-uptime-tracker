import { desc, eq, and } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { getAuthSession } from '@/lib/session';
import { db } from '@/db';
import { incidents, monitors, pings } from '@/db/schema';

// 07-08 deletion release (DRZ-07): the Prisma-era findFirst with the
// pings/incidents `include` is ported to the ONE Drizzle client as the same
// three queries the relation load performed — the ownership-scoped monitor
// row, then its 100 newest pings (createdAt desc) and 20 newest incidents
// (startedAt desc) — assembled into the identical response shape.

export async function GET(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const session = await getAuthSession();

        if (!session || !session.user || !session.user.id) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { id } = await params;
        const monitorId = parseInt(id);

        if (isNaN(monitorId)) {
            return NextResponse.json({ error: 'Invalid monitor ID' }, { status: 400 });
        }

        const [monitor] = await db
            .select()
            .from(monitors)
            .where(and(eq(monitors.id, monitorId), eq(monitors.userId, session.user.id)))
            .limit(1);

        if (!monitor) {
            return NextResponse.json({ error: 'Monitor not found' }, { status: 404 });
        }

        const monitorPings = await db
            .select()
            .from(pings)
            .where(eq(pings.monitorId, monitorId))
            .orderBy(desc(pings.createdAt))
            .limit(100);

        const monitorIncidents = await db
            .select()
            .from(incidents)
            .where(eq(incidents.monitorId, monitorId))
            .orderBy(desc(incidents.startedAt))
            .limit(20);

        return NextResponse.json(
            { monitor: { ...monitor, pings: monitorPings, incidents: monitorIncidents } },
            { status: 200 },
        );

    } catch (error) {
        console.error('Error fetching monitor details:', error);
        return NextResponse.json(
            { error: 'Internal Server Error' },
            { status: 500 }
        );
    }
}
