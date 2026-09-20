import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type { EmailPayload, EmailProvider } from "../index";

// ---------------------------------------------------------------------------
// The smtp provider (EML-01) — the IDENTICAL nodemailer transporter
// configuration the legacy src/lib/mail.ts built at module scope (host
// SMTP_HOST, port Number(SMTP_PORT), secure port===465, auth
// SMTP_USER/SMTP_PASS), relocated behind send() with ONE change: the
// transporter is created LAZILY on first send, so importing this module (or
// resolving the provider at worker boot) never opens a socket.
//
// WORKER-SIDE ONLY by contract: nothing under src/app imports this module —
// the web process enqueues rendered payloads and never transports (D-07/
// D-08). The from header lives HERE (byte-identical to the legacy form).
// ---------------------------------------------------------------------------

export function createSmtpEmailProvider(): EmailProvider {
  let transporter: Transporter | undefined;

  const getTransporter = (): Transporter => {
    if (!transporter) {
      transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT),
        secure: Number(process.env.SMTP_PORT) === 465,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });
    }
    return transporter;
  };

  return {
    name: "smtp",
    async send(payload: EmailPayload): Promise<void> {
      await getTransporter().sendMail({
        from: `"SpiderNode" <${process.env.SMTP_USER}>`,
        to: payload.to,
        subject: payload.subject,
        html: payload.html,
      });
    },
  };
}
