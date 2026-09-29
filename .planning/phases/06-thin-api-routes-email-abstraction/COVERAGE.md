# Phase 06 — API Coverage Decision Matrix

Produced during the 06 gap-closure planning run (`/gsd-plan-phase 06 --gaps`). The
api-coverage detector fired on the executed phase scope (Telegram Bot API `setWebhook`
signals in 06-04/06-05 plan bodies). Full-coverage-by-default applies: every capability
of every integrated external API is INTEGRATE unless a one-line OPT-OUT reason is given.

## Integrated external APIs (executed phase surface)

### Telegram Bot API

| Capability | Decision | Where / Reason |
|------------|----------|----------------|
| setWebhook (register webhook endpoint with secret_token) | INTEGRATE | Executed in 06-05 Task 1 cutover; operator-minted production secret; evidence in 06-DEPLOY-RECORD.md §12 |
| sendMessage (outbound alert delivery) | INTEGRATE | Worker outbox relay (Phase 4/5-built, retained); escaped renders per D-16/IN-04, D-48 payload byte-parity pins |
| getUpdates (long-polling mode) | OPT-OUT | Webhook mode is the authenticated design (D-20); polling would add an unauthenticated surface retired by SEC-03 |
| deleteWebhook / getWebhookInfo | OPT-OUT | One-time registration + rotation is a documented runbook step; no runtime code path needs these |
| File/media endpoints (sendPhoto/sendDocument/getFile) | OPT-OUT | Alert contract is text-only (D-48 payload shape); no product requirement names media |

### SMTP (via nodemailer behind the D-11 provider interface)

| Capability | Decision | Where / Reason |
|------------|----------|----------------|
| Send transactional email (verification, password reset) | INTEGRATE | Worker email lane, EML-02; render-at-enqueue payloads (D-07), D-09 backoff table, EML-03 typed dead-lettering |
| Auth + TLS transporter config | INTEGRATE | src/lib/email/providers/smtp.ts (lazy transporter, identical host/port/secure/auth config) |
| Attachments / inline images | OPT-OUT | EML-05 pins the existing HTML template byte-verbatim; no attachment requirement exists |

### Not external APIs

| Surface | Decision | Reason |
|---------|----------|--------|
| console email provider | OPT-OUT | Local stdout transport (D-12) — no external API exists to integrate |
| Redis / BullMQ | OPT-OUT | Process-internal infrastructure dependency (bounded producer profile), not an external product API |

## Gap-closure plans (06-06)

06-06 integrates no external API: it modifies failure-path semantics of the EXISTING Redis/BullMQ
enqueue (compensating next_check_at restore + producer-side deadline) and adds no new external
API, SDK, or capability. All rows above belong to the executed plans 06-01..06-05.
