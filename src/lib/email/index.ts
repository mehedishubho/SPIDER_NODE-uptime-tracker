import { createConsoleEmailProvider } from "./providers/console";
import { createSmtpEmailProvider } from "./providers/smtp";

// ---------------------------------------------------------------------------
// The D-13 lib/email module: the provider interface and EMAIL_PROVIDER
// selection for transactional email. The WEB process imports only render.ts
// and enqueue.ts (never a provider's send — no SMTP socket in a request);
// the WORKER process resolves the provider here at boot and transports
// rendered bytes (06-02).
//
// Selection (D-11, throw-early convention — src/lib/redis.ts precedent):
//   EMAIL_PROVIDER unset | "" | "smtp" -> smtp provider (a missing var can
//                                       never break email)
//   EMAIL_PROVIDER "console"           -> the dev stdout-dump provider (D-12)
//   anything else                      -> THROWS at worker boot (a typo like
//                                       "smtpp" never silently no-ops)
//
// The interface is the extension seam for a future Resend provider: add a
// provider module + one branch here — interface only, no stub file today.
// ---------------------------------------------------------------------------

/** The self-contained transactional-email payload (D-07 — render-at-enqueue). */
export interface EmailPayload {
  to: string;
  subject: string;
  html: string;
}

/** A transport behind the email lane (EML-01). */
export interface EmailProvider {
  /** Discriminator for logs/metrics ("smtp" | "console"; future providers add their own). */
  readonly name: string;
  send(payload: EmailPayload): Promise<void>;
}

let cachedProvider: EmailProvider | undefined;

/**
 * Resolves the EMAIL_PROVIDER selection (D-11). The selected provider is
 * cached per module instance (the smtp transporter is lazy — boot never
 * opens a socket); an unknown value throws on EVERY call until fixed.
 */
export function getEmailProvider(): EmailProvider {
  if (cachedProvider) {
    return cachedProvider;
  }
  const raw = process.env.EMAIL_PROVIDER;
  let provider: EmailProvider;
  if (raw === undefined || raw === "" || raw === "smtp") {
    provider = createSmtpEmailProvider();
  } else if (raw === "console") {
    provider = createConsoleEmailProvider();
  } else {
    throw new Error(
      `[lib/email] unknown EMAIL_PROVIDER '${raw}' — expected 'smtp' or 'console' ` +
        "(D-11 throw-early: unset defaults to smtp; a typo must fail loud, never silently no-op)"
    );
  }
  cachedProvider = provider;
  return provider;
}
