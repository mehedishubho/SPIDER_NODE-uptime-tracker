import { eq } from "drizzle-orm";
import { sendTelegramAlert } from "@/lib/telegram";
import { getAuthSession } from "@/lib/session";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";

export async function POST() {
    try {
        const session = await getAuthSession();

        if (!session?.user?.id) {
            return NextResponse.json(
                { error: 'Unauthorized' },
                { status: 401 }
            )
        }

        // check user telegram id (07-08 DRZ-07: the Prisma select became the
        // equivalent one-row Drizzle projection — undefined when absent,
        // falsy like Prisma's null)
        const [user] = await db
            .select({ telegramChatId: users.telegramChatId, name: users.name })
            .from(users)
            .where(eq(users.id, session.user.id));


        if (!user?.telegramChatId) {
            return NextResponse.json(
                { error: 'Telegram Chat ID is not configured in your profile' },
                { status: 400 }
            );
        }

        const message = `
🚀 <b>Test Notification</b>

Hello <b>${user.name || 'User'}</b>! 
Your Telegram notification setup is working perfectly. You will receive real-time alerts whenever your websites go down or recover!
    `.trim();

        const isSent = await sendTelegramAlert(user.telegramChatId, message);

        if (!isSent) {
            return NextResponse.json(
                { error: 'Failed to send message. Please verify your Telegram Chat ID.' },
                { status: 400 }
            );
        }

        return NextResponse.json(
            { message: 'Test alert sent successfully to your Telegram!' },
            { status: 200 }
        );

    } catch (error) {
        console.error('Test Telegram Error:', error);
        return NextResponse.json(
            { error: 'Internal Server Error' },
            { status: 500 }
        );
    }
}