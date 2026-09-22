import { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { PrismaAdapter } from "@auth/prisma-adapter";
import GoogleProvider from "next-auth/providers/google";
import GithubProvider from "next-auth/providers/github";

// ---------------------------------------------------------------------------
// LEGACY NextAuth options — the INTERIM half of the expand/contract cutover
// (D-29 release 1: Better Auth live, NextAuth still installed and serving).
//
// 07-01 rewrote src/lib/auth.ts as the minimal Better Auth core (worker-safe:
// zero next-auth imports in that module's graph). The routes below still run
// on NextAuth sessions until 07-03/07-04 swap them, so authOptions moved here
// VERBATIM (byte-identical config, same behavior) to keep them compiling and
// serving unchanged:
//   feedback, incidents, monitors (all), status, telegram, user/profile,
//   and the [...nextauth] handler route.
//
// DELETION SCHEDULE: this module dies at the Phase-7 deletion release
// (07-08) together with next-auth, @auth/prisma-adapter and the [...nextauth]
// route — the D-41 remnant gate keeps it out afterwards. Do not extend it.
// ---------------------------------------------------------------------------

export const authOptions: NextAuthOptions = {
    adapter: PrismaAdapter(prisma),
    session: {
        strategy: "jwt",
    },
    providers: [
        // google login
        GoogleProvider({
            clientId: process.env.GOOGLE_CLIENT_ID || "",
            clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
        }),
        GithubProvider({
            clientId: process.env.GITHUB_CLIENT_ID || "",
            clientSecret: process.env.GITHUB_CLIENT_SECRET || "",
        }),

        // credentials login
        CredentialsProvider({
            name: "Credentials",
            credentials: {
                email: { label: "Email", type: "email" },
                password: { label: "Password", type: "password" },
            },
            async authorize(credentials) {
                if (!credentials?.email || !credentials.password) {
                    throw new Error("Email and password required");
                }
                const normalizedEmail = credentials.email.toLowerCase().trim();

                // Check if User Exists
                const user = await prisma.user.findUnique({
                    where: { email: normalizedEmail },
                });

                if (!user || !user.password) {
                    throw new Error("No user found with this email");
                }

                if (!user.emailVerified) {
                    throw new Error("Please verify your email address before logging in.");
                }

                // compare password hash
                const isPasswordValid = await bcrypt.compare(
                    credentials.password,
                    user.password
                );

                if (!isPasswordValid) {
                    throw new Error("Invalid Password");
                }

                // if login success
                return {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    image: user.image,
                };
            },
        }),
    ],
    callbacks: {
        async jwt({ token, user, trigger, session }) {
            if (user) {
                token.id = user.id;
            }

            // Handle session update
            if (trigger === "update" && session) {
                if (session.image !== undefined) {
                    token.picture = session.image; // NextAuth uses 'picture' internally for image
                }
                if (session.name !== undefined) {
                    token.name = session.name;
                }
            }
            return token;
        },
        async session({ session, token }) {
            if (session.user) {
                session.user.id = token.id as string;
                if (token.picture) session.user.image = token.picture;
                if (token.name) session.user.name = token.name;
            }
            return session;
        },
    },
    secret: process.env.NEXTAUTH_SECRET,
};
