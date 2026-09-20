import type { EmailPayload, EmailProvider } from "../index";

// ---------------------------------------------------------------------------
// The console provider (EML-01 / D-12) — an explicit DEV opt-in
// (EMAIL_PROVIDER=console) that prints the email it would have sent: ONE
// structured stdout line (the repo's bracketed-prefix logging convention,
// "[redis] ..." style) carrying the recipient, the subject, and the fully
// rendered HTML. Selected via D-11; production selects smtp.
//
// No secrets are involved: the payload is exactly what the smtp provider
// would hand the transporter (T-06-02-05 accepted).
// ---------------------------------------------------------------------------

export function createConsoleEmailProvider(): EmailProvider {
  return {
    name: "console",
    async send(payload: EmailPayload): Promise<void> {
      // JSON.stringify keeps this ONE line — the HTML's own newlines escape.
      console.log(
        `[email-console] ${JSON.stringify({ to: payload.to, subject: payload.subject, html: payload.html })}`
      );
    },
  };
}
