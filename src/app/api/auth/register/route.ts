import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { rateLimit, getIP } from "@/lib/rate-limit";
import { generateVerificationToken } from "@/lib/tokens";
import { renderVerificationEmail } from "@/lib/email/render";
import { enqueueTransactionalEmail } from "@/lib/email/enqueue";
import { webQueueProducer } from "@/lib/queue-producer";
import { apiError } from "@/lib/api-error";

export async function POST(req: Request) {
    try {
        // 06-02 (D-29 / Pitfall 6): bounded pre-flight liveness probe. An
        // unreachable Redis fails FAST here — BEFORE the durable user write —
        // because without the queue there is no verification email, and an
        // unverifiable account would be stranded. A 503 "try again shortly"
        // is the honest answer. The residual race between this ping and the
        // enqueue below (Redis dropping mid-request) is accepted and
        // documented: Redis-down already pages via the dead-man's switch,
        // and forgot-password re-requests enqueue a fresh email once Redis
        // returns.
        try {
            await webQueueProducer().ping();
        } catch {
            return apiError(503, "Service temporarily unavailable — try again shortly");
        }

        const ip = getIP(req);
        // Max 5 registration attempts per IP per hour (3600000 ms)
        const { success, remaining } = await rateLimit(`register_${ip}`, { limit: 5, windowMs: 3600000 });
        if (!success) {
            return NextResponse.json(
                { error: "Too many registration attempts. Please try again later." },
                { status: 429, headers: { "X-RateLimit-Remaining": remaining.toString() } }
            );
        }
        const body = await req.json();
        const { name, email, password } = body;

        // Validation Check
        if (!email || !password) {
            return NextResponse.json(
                { error: "Email and password are required" },
                { status: 400 }
            );
        }

        if (password.length < 6) {
            return NextResponse.json(
                { error: 'Password must be at least 6 characters long' },
                { status: 400 }
            );
        }

        // Normalize email
        const normalizedEmail = email.toLowerCase().trim();

        // Check if user already exists
        const existingUser = await prisma.user.findUnique({
            where: { email: normalizedEmail },
        });

        if (existingUser) {
            return NextResponse.json(
                { error: "An account with this email already exists" },
                { status: 409 }
            );
        }
        // create new user and hash password
        const hashPassword = await bcrypt.hash(password, 10);
        // new user
        const newUser = await prisma.user.create({
            data: {
                name: name ? name.trim() : null,
                email: normalizedEmail,
                password: hashPassword,
            },
            select: {
                id: true,
                name: true,
                email: true,
                image: true,
                createdAt: true
            }
        });

        // 06-02 (D-07 render-at-enqueue): render the verification email here
        // and enqueue it — the SMTP socket lives ONLY in the worker process,
        // so an SMTP outage can no longer fail this request. A Redis-side
        // enqueue rejection surfaces as a loud 503 (never a silent no-op).
        const verificationToken = await generateVerificationToken(normalizedEmail);
        const emailPayload = renderVerificationEmail(verificationToken.email, verificationToken.token);
        try {
            await enqueueTransactionalEmail(emailPayload);
        } catch (error) {
            console.error("Registration email enqueue error:", error)
            return apiError(503, "Service temporarily unavailable — try again shortly")
        }

        return NextResponse.json(
            {
                message: "User registered. Please check your email to verify your account.",
                user: newUser
            },
            { status: 201 }
        )
    } catch (error) {
        console.log("Registration error:", error)
        return NextResponse.json(
            { error: "Something went wrong during registration" },
            { status: 500 }
        )

    }
}
