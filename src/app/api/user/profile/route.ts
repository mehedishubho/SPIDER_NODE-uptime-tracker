

import { eq } from "drizzle-orm";
import { getAuthSession } from "@/lib/session";
import { NextResponse } from "next/server";
import { v2 as cloudinary } from 'cloudinary';
import bcrypt from "bcryptjs";
import { db } from "@/db";
import { users } from "@/db/schema";

// 07-08 deletion release (DRZ-07): the Prisma-era user reads/writes are
// ported to the ONE Drizzle client with identical projections and wire
// contracts. GET keeps the Prisma-era select list (the hash is read only to
// derive hasPassword and is stripped from the response); PATCH's write keeps
// the vanished-row 500 Prisma's P2025 rejection produced; DELETE keeps the
// DB-side cascade semantics Prisma relied on.

// Cloudinary Configuration
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
})

// ----------------------------------------------------
// 1. GET CURRENT USER PROFILE (GET)
// ----------------------------------------------------
export async function GET() {
    try {
        const session = await getAuthSession();

        if (!session?.user?.id) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        const [user] = await db
            .select({
                id: users.id,
                name: users.name,
                email: users.email,
                image: users.image,
                telegramChatId: users.telegramChatId,
                timezone: users.timezone,
                password: users.password,
                createdAt: users.createdAt,
                updatedAt: users.updatedAt,
            })
            .from(users)
            .where(eq(users.id, session.user.id));
        if (!user) {
            return NextResponse.json({ error: "User not found" }, { status: 404 })
        }

        //password hash remove and flag add

        const { password, ...userData } = user;

        return NextResponse.json(
            {
                user: {
                    ...userData,
                    hasPassword: Boolean(password),
                },
            },
            { status: 200 },
        )
    } catch (error) {
        console.error('Get Profile Error:', error);
        return NextResponse.json(
            { error: 'Failed to fetch user profile' },
            { status: 500 }
        )

    }
}

// ----------------------------------------------------
// 2. UPDATE USER PROFILE & PASSWORD (PATCH)
// ----------------------------------------------------

export async function PATCH(req: Request) {
    try {
        const session = await getAuthSession();
        if (!session?.user?.id) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        //get user data
        const body = await req.json();
        const { name, telegramChatId, timezone, currentPassword, newPassword, image } = body;

        const [existingUser] = await db
            .select()
            .from(users)
            .where(eq(users.id, session.user.id));

        if (!existingUser) {
            return NextResponse.json({ error: "User not found" }, { status: 404 });

        }

        const updateData: { name?: string; telegramChatId?: string; timezone?: string; image?: string; password?: string } = {};
        if (name !== undefined) updateData.name = name.trim();
        if (telegramChatId !== undefined) updateData.telegramChatId = telegramChatId.trim();
        if (timezone !== undefined) updateData.timezone = timezone.trim();

        // ------------------------------------------------
        // CLOUDINARY IMAGE HANDLER
        // ------------------------------------------------
        if (image) {
            //new image /file Base64/DataUrl Format
            if (image.startsWith('data:image/')) {
                const uploadedResponse = await cloudinary.uploader.upload(image, {
                    folder: "uptime_tracker/user_profiles",
                    resource_type: "image"
                });
                updateData.image = uploadedResponse.secure_url;

            } else {
                updateData.image = image;
            }
        }

        // ------------------------------------------------
        // PASSWORD UPDATE LOGIC
        // ------------------------------------------------

        if (newPassword) {
            if (newPassword.length < 6) {
                return NextResponse.json(
                    { error: "New password must be at least 6 characters long" },
                    { status: 400 }
                )
            }

            // If the user already has a password, we must verify their current password
            if (existingUser.password) {
                if (!currentPassword) {
                    return NextResponse.json(
                        { error: "Current password is required to set a new password" },
                        { status: 400 }
                    )
                }

                const isCurrentPasswordValid = await bcrypt.compare(
                    currentPassword,
                    existingUser.password
                )

                if (!isCurrentPasswordValid) {
                    return NextResponse.json(
                        { error: "Invalid current password" },
                        { status: 400 }
                    )
                }
            }

            // Hash the new password and add to updateData
            const hashedPassword = await bcrypt.hash(newPassword, 10);
            updateData.password = hashedPassword;
        }

        if (Object.keys(updateData).length === 0) {
            return NextResponse.json(
                { error: "No fields provided for update" },
                { status: 400 }
            )
        }

        const [updatedUser] = await db
            .update(users)
            .set(updateData)
            .where(eq(users.id, session.user.id))
            .returning({
                id: users.id,
                name: users.name,
                email: users.email,
                image: users.image,
                telegramChatId: users.telegramChatId,
                timezone: users.timezone,
                updatedAt: users.updatedAt,
            });
        if (!updatedUser) {
            // The pre-check passed, so this is the vanished-row race only —
            // the exact situation Prisma's P2025 rejection mapped to a 500.
            return NextResponse.json({ error: "Internal server error" }, { status: 500 });
        }

        return NextResponse.json(
            {
                message: "Profile updated successfully",
                user: updatedUser
            },
            { status: 200 }
        )
    } catch (error) {
        console.error("Update Profile Error:", error);
        return NextResponse.json(
            { error: "Internal server error" },
            { status: 500 }
        );
    }
}

// ----------------------------------------------------
// 3. DELETE USER ACCOUNT (DELETE)
// ----------------------------------------------------
export async function DELETE() {
    try {
        const session = await getAuthSession();
        if (!session?.user?.id) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }
        const deleted = await db
            .delete(users)
            .where(eq(users.id, session.user.id))
            .returning({ id: users.id });
        if (deleted.length === 0) {
            // Vanished-row race — Prisma's P2025 mapped to this exact 500.
            return NextResponse.json({ error: "Internal server error" }, { status: 500 });
        }

        return NextResponse.json(
            { message: "User account and all associated data deleted successfully" },
            { status: 200 }
        )
    } catch (error) {
        console.error('Delete Profile Error:', error);
        return NextResponse.json(
            { error: "Internal server error" },
            { status: 500 }
        );
    }

}
