

import { eq } from "drizzle-orm";
import { getAuthSession } from "@/lib/session";
import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { v2 as cloudinary } from 'cloudinary';
import bcrypt from "bcryptjs";
import { isoRow } from "@/lib/serialize";
import { db } from "@/db";
import { users } from "@/db/schema";

// 07-08 deletion release (DRZ-07): the Prisma-era user reads/writes are
// ported to the ONE Drizzle client with identical projections and wire
// contracts. GET keeps the Prisma-era select list (the hash is read only to
// derive hasPassword and is stripped from the response); PATCH's write keeps
// the vanished-row 500 Prisma's P2025 rejection produced; DELETE keeps the
// DB-side cascade semantics Prisma relied on.
// 07-10 (G-07-63/CR-01): GET/returning rows normalize createdAt/updatedAt
// through the ONE serialize seam — ISO-8601 UTC Z on the wire; the PATCH
// write rides WR-01 (updatedAt advances).
// WINDOWS #4 closure (2026-10-02): the PATCH password branch used to verify
// against and write ONLY the legacy inert users.password copy, so a
// profile-set password never changed the real login password (account.password,
// the Better Auth engine copy since the Phase-7 flip). The branch now
// delegates to auth.api.changePassword on the one createAuth() instance — the
// engine validates the current password against account.password and writes
// it (revoking other sessions, D-28 posture) — and then keeps the legacy
// users.password copy in sync (the 07-08 both-copies discipline).

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
                    ...isoRow(userData, ["createdAt", "updatedAt"]),
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
        // PASSWORD UPDATE LOGIC (WINDOWS #4 closure)
        // ------------------------------------------------

        if (newPassword) {
            if (newPassword.length < 6) {
                return NextResponse.json(
                    { error: "New password must be at least 6 characters long" },
                    { status: 400 }
                )
            }

            // If the user already has a password, the engine requires the
            // current one (checked here for the stable client-facing message;
            // the engine re-checks against the authoritative account.password).
            if (existingUser.password && !currentPassword) {
                return NextResponse.json(
                    { error: "Current password is required to set a new password" },
                    { status: 400 }
                )
            }

            // The engine owns the real credential (account.password): it
            // validates the current password and writes the new hash,
            // revoking every OTHER session (D-28 posture — the same
            // semantics the operator's 2026-09-30 change used). Any engine
            // rejection here maps to the route's long-standing 400 contract.
            try {
                await auth.api.changePassword({
                    body: {
                        currentPassword: currentPassword ?? "",
                        newPassword,
                        revokeOtherSessions: true,
                    },
                    headers: req.headers,
                });
            } catch {
                return NextResponse.json(
                    { error: "Invalid current password" },
                    { status: 400 }
                )
            }

            // Keep the legacy users.password copy in sync with the engine
            // copy (07-08 both-copies discipline — independent salt is fine,
            // the copies never compare against each other).
            updateData.password = await bcrypt.hash(newPassword, 10);
        }

        if (Object.keys(updateData).length === 0) {
            return NextResponse.json(
                { error: "No fields provided for update" },
                { status: 400 }
            )
        }

        const [updatedUser] = await db
            .update(users)
            // `updatedAt` is supplied explicitly on update (WR-01, 07-10):
            // the column is NOT NULL with no DB default and Prisma's
            // client-side @updatedAt no longer exists — without it every
            // PATCH silently kept the stale value.
            .set({ ...updateData, updatedAt: new Date().toISOString() })
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
                user: isoRow(updatedUser, ["updatedAt"])
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
