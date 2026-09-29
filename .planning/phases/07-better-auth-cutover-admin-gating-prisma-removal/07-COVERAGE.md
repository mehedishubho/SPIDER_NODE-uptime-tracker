# API Coverage — Google & GitHub OAuth (via Better Auth `socialProviders`)

> Full coverage by default. Opt-outs are explicit, reasoned decisions.
> The phase's only external-API integration is the existing Google + GitHub OAuth surface,
> re-cut over from NextAuth v4 to Better Auth 1.7.5 (`socialProviders`) at parity (D-26).
> Better Auth, Bull Board, and hono are npm libraries, not external APIs; the SMTP/console
> email surface was covered by Phase 6 (EML-01..05).

| capability | decision | reason |
|---|---|---|
| google sign-in (authorize redirect + callback exchange) | INTEGRATE | parity cutover — callback path `/api/auth/callback/google` unchanged, no provider-console edit (RESEARCH Runtime State Inventory) |
| github sign-in (authorize redirect + callback exchange) | INTEGRATE | parity cutover — same callback path contract |
| userinfo / identity fields (email, name, image) | INTEGRATE | Better Auth populates `user` from the provider profile; existing users table columns reused (AUTH-03) |
| access/refresh token persistence on `account` rows | INTEGRATE | AUTH-05 — reshape preserves tokens; D-40 proves no re-consent post-flip |
| automatic token refresh via engine helpers | INTEGRATE | Better Auth refresh support replaces NextAuth's implicit behavior; tokens preserved so refresh works |
| same-email cross-provider account linking | OPT-OUT | deliberate non-goal — `disableImplicitLinking: true` reproduces NextAuth's `OAuthAccountNotLinked` refusal (D-26) |
| provider-side revoke flows | OPT-OUT | not used today; no revocation surface exists in the legacy app; out of scope per "no new capability" phase boundary |
| Better Auth admin-plugin endpoints (ban/unban, impersonate, user list) | OPT-OUT | not an external API but recorded here too — plugin enabled for the role primitive only (D-13); endpoints stay unused |
